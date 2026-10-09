import {pageConversations} from './conversation-pages.mjs';
import express from 'express';
import {accountSnapshot} from './account.mjs';
import {accessContext,authorizeProduct} from './workspace.mjs';
import {planFor,assertWorkspaceCapacity,assertSubscriptionActive} from './plans.mjs';
import {billingConfiguration,createStripeClient,createBillingService,verifyStripeWebhook,stripeEventCustomerId,publicBillingState,refreshBillingCapacity} from './billing.mjs';
import {publicNotifications,setNotificationPreference,removeNotificationPreference,saveIntegration,removeIntegration,enqueueDueNotifications,expireNotificationLeases} from './notifications.mjs';
import {createDeliveryAdapters,deliverNotification} from './delivery.mjs';
import {buildReport,reportCSV,reportJSON} from './reports.mjs';

const error=(message,status=400,code='account_invalid')=>Object.assign(new Error(message),{status,code});
export function createAccountHTTP({platform,principalFor,env={},stripe:providedStripe,deliveryAdapters:providedAdapters}) {
  const config=billingConfiguration(env),adapters=providedAdapters||createDeliveryAdapters({env});
  let stripePromise;
  const stripe=()=>stripePromise ||= providedStripe?Promise.resolve(providedStripe):createStripeClient(config);
  const current=()=>{
    const context=platform.current();
    if(!context)throw error('Select a workspace.',409,'workspace_selection_required');
    return context;
  };
  const billing=async store=>createBillingService({store,stripe:await stripe(),config,onCustomerBound:async()=>platform.registry.bindCustomer((await store.snapshot()).workspace.id)});
  const principal=req=>{const value=principalFor(req);if(!value)throw error('Sign in to continue.',401,'identity_required');return value;};
  const billingSummary=data=>({...publicBillingState(data),configured:config.configured,livemode:config.livemode});
  // Mount before JSON parsing and before session/CSRF guards. The signature is
  // the sole authority on this exact endpoint, and binds the unmodified bytes.
  function mountWebhook(app) {
    app.post('/api/billing/webhook',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
      await platform.ready;
      const client=await stripe(),event=verifyStripeWebhook(client,config,req.body,req.get('Stripe-Signature'));
      const customer=stripeEventCustomerId(event);
      if(!customer)return res.json({received:true,ignored:true});
      let id=await platform.registry.customerWorkspace(customer,config.livemode);
      if(!id)return res.json({received:true,ignored:true});
      const store=await platform.resolve(id),state=await store.snapshot();
      if(state.billing?.customerId!==customer||state.billing.livemode!==config.livemode)throw error('Stripe customer binding changed.',409,'billing_binding_mismatch');
      const result=await createBillingService({store,stripe:client,config}).processEvent(event);
      res.json(result);
    });
  }
  async function runNotifications() {
    if(env.TRACKER_NOTIFICATIONS_ENABLED!=='true')return {status:'disabled',enqueued:0,delivered:0};
    const {rawStore:store}=current();
    const enqueued=await store.mutate(data=>{
      expireNotificationLeases(data,{});let count=0;
      for(const member of Object.values(data.workspace.members))if(member.status==='active'){
        try {const result=enqueueDueNotifications(data,{sub:member.sub,email:member.email});count+=Array.isArray(result)?result.length:result?.enqueued?.length||0;}
        catch(cause){if(![403,409].includes(cause.status))throw cause;}
      }
      return count;
    });
    const snapshot=await store.snapshot(),jobs=Object.values(snapshot.notificationOutbox?.jobs||{}).filter(job=>['queued','retry'].includes(job.status)).slice(0,10);
    let delivered=0;
    for(const job of jobs){
      const member=snapshot.workspace.members[job.memberSub];
      if(!member||member.status!=='active')continue;
      const result=await deliverNotification(store,{principal:{sub:member.sub,email:member.email},id:job.id,adapters});
      if(result?.status==='sent')delivered++;
    }
    return {status:'complete',enqueued,delivered};
  }
  function mount(app) {
    app.get('/api/workspaces',async(req,res)=>{await platform.ready;res.json({workspaces:await platform.registry.list(principal(req))});});
    app.post('/api/workspaces',async(req,res)=>{await platform.ready;const made=await platform.registry.create(principal(req),{name:req.body.name,requestId:req.body.requestId});res.status(201).json({id:made.id,account:made.account});});
    app.post('/api/workspaces/:id/invites/accept',async(req,res)=>{
      await platform.ready;const who=principal(req),store=await platform.resolve(req.params.id);
      await store.accountAction(who,'invite.accept',{token:req.body.token});await platform.registry.register(req.params.id,who);
      res.json({id:req.params.id,account:(await store.accountSnapshot(who)).account});
    });
    app.get('/api/conversations',async(req,res)=>{const context=current();res.json(pageConversations(await context.rawStore.snapshot(),context.principal,req.query));});
    app.get('/api/account',async(_req,res)=>{const context=current(),data=await context.rawStore.snapshot();const summary=accountSnapshot(data,context.principal),details=billingSummary(data);if(!summary.account.permissions.manage)delete details.overCapacity;res.json({...summary,billing:details});});
    app.post('/api/account/actions',async(req,res)=>{const context=current();if(req.body.action==='invite.accept')throw error('Use the workspace invitation link.');const result=await context.rawStore.accountAction(context.principal,req.body.action,req.body.input);res.json({result,account:(await context.rawStore.accountSnapshot(context.principal)).account});});
    app.patch('/api/reviews/:id',async(req,res)=>{const context=current();const result=await context.rawStore.accountAction(context.principal,'review.update',{itemId:req.params.id,expectedVersion:req.body.expectedVersion,patch:req.body.patch});res.json({result});});
    app.patch('/api/products/:id/archive',async(req,res)=>{
      if(typeof req.body.archived!=='boolean')throw error('Choose whether this product is archived.');
      const context=current();const product=await context.rawStore.mutate(data=>{
        accessContext(data,context.principal,{admin:true,write:true},planFor(data));authorizeProduct(data,context.principal,req.params.id,{write:true},planFor(data));const product=data.products.find(p=>p.id===req.params.id);
        product.archived=req.body.archived;if(!product.archived&&product.status==='archived')delete product.status;product.updatedAt=new Date().toISOString();
        if(!product.archived){assertSubscriptionActive(data);assertWorkspaceCapacity(data);}
        refreshBillingCapacity(data);return structuredClone(product);
      });res.json({product});
    });
    app.post('/api/billing/checkout',async(req,res)=>{const context=current();try{res.json(await (await billing(context.rawStore)).checkout(context.principal,{planId:req.body.planId}));}finally{await platform.registry.bindCustomer(context.workspaceId);}});
    app.post('/api/billing/portal',async(_req,res)=>{const context=current();res.json(await (await billing(context.rawStore)).portal(context.principal));});
    app.get('/api/notifications',async(_req,res)=>{const context=current();res.json({...publicNotifications(await context.rawStore.snapshot(),context.principal),delivery:{enabled:env.TRACKER_NOTIFICATIONS_ENABLED==='true',email:Boolean(adapters.email?.configured),slack:Boolean(adapters.slack?.configured),webhook:Boolean(adapters.webhook?.configured)}});});
    for(const [method,path,operation]of [['put','/api/notifications/preferences',setNotificationPreference],['delete','/api/notifications/preferences/:id',removeNotificationPreference],['put','/api/integrations',saveIntegration],['delete','/api/integrations/:id',removeIntegration]])app[method](path,async(req,res)=>{const context=current();const result=await context.rawStore.mutate(data=>operation(data,context.principal,{...req.body,...(req.params.id?{id:req.params.id}:{})}));res.json({result});});
    app.get('/api/reports',async(req,res)=>{
      const context=current(),report=buildReport(await context.rawStore.snapshot(),context.principal,{productIds:typeof req.query.productIds==='string'?req.query.productIds.split(','):undefined,clientId:req.query.clientId,from:req.query.from,to:req.query.to,dateField:req.query.dateField});
      const csv=req.query.format==='csv';res.type(csv?'text/csv':'application/json').set('Content-Disposition',`attachment; filename="hearwhispers-report.${csv?'csv':'json'}"`).send(csv?reportCSV(report):reportJSON(report));
    });
    app.get('/api/monitor/workspaces',async(_req,res)=>{await platform.ready;res.json({accountMode:true,ids:await platform.registry.serviceWorkspaces()});});
    app.post('/api/monitor/notifications',async(_req,res)=>res.json(await runNotifications()));
  }
  return {mount,mountWebhook,runNotifications,billingSummary,notificationsAvailable:env.TRACKER_NOTIFICATIONS_ENABLED==='true'};
}
