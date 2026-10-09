import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {bootstrapWorkspace,createInvite,acceptInvite} from '../workspace.mjs';
import {planFor,subscriptionState,preserveServerOwnedState} from '../plans.mjs';
import {billingConfiguration,createStripeClient,createBillingService,claimCustomer,claimCheckout,settleCustomer,settleCheckout,claimBillingEvent,finishBillingEvent,applyStripeSubscription,publicBillingState,publicBillingSummary,verifyStripeWebhook,STRIPE_API_VERSION,STRIPE_SDK_VERSION} from '../billing.mjs';

const NOW=Date.parse('2026-10-09T12:00:00Z'),DAY=86400000;
const owner={sub:'1001',email:'owner@gmail.com'},admin={sub:'1002',email:'admin@gmail.com'};
const key=['rk','test','fixture'].join('_'),secret=['whsec','fixture'].join('_');
const env={STRIPE_RESTRICTED_KEY:key,STRIPE_WEBHOOK_SECRET:secret,STRIPE_PRICE_STARTER:'price_starter',STRIPE_PRICE_GROWTH:'price_growth',STRIPE_PRICE_TEAM:'price_team',TRACKER_PUBLIC_ORIGIN:'https://hearwhispers.example'};
const config=billingConfiguration(env);
const check=code=>error=>error.code===code;
function storeFixture(){
  let state={version:1,products:[],items:[],searches:{},subscription:{planId:'growth',status:'trial',trialEndsAt:new Date(NOW+DAY).toISOString(),managedBy:'manual'}};
  bootstrapWorkspace(state,{id:'workspace1',name:'Fixture',owner,now:NOW});
  const invite=createInvite(state,owner,{email:admin.email,role:'admin',now:NOW},planFor(state));acceptInvite(state,admin,{token:invite.token,now:NOW},planFor(state));
  return {snapshot:async()=>structuredClone(state),mutate:async fn=>{const next=structuredClone(state),result=fn(next);state=next;return structuredClone(result);}};
}
function price(id){return {id:config.priceIds[id],object:'price',livemode:false,active:true,product:`prod_${id}`,type:'recurring',currency:'usd',unit_amount:planFor(id).price.amount*100,recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};}
function fakeStripe(){
  const state={calls:[],creates:new Map(),prices:Object.fromEntries(['starter','growth','team'].map(id=>[config.priceIds[id],price(id)])),sessions:{},subscriptions:{},invoices:{},lostCustomer:false,lostCheckout:false};
  const record=(kind,params,options)=>state.calls.push({kind,params:structuredClone(params),options:structuredClone(options)});
  const api={
    prices:{retrieve:async id=>{record('price.retrieve',{id});return structuredClone(state.prices[id]);}},
    customers:{create:async(params,options)=>{record('customer.create',params,options);let result=state.creates.get(options.idempotencyKey);if(!result){result={id:'cus_fixture',object:'customer',livemode:false,...structuredClone(params)};state.creates.set(options.idempotencyKey,result);}if(state.lostCustomer){state.lostCustomer=false;throw Error('Disconnected after commit');}return structuredClone(result);}},
    checkout:{sessions:{create:async(params,options)=>{record('checkout.create',params,options);let result=state.creates.get(options.idempotencyKey);if(!result){result={...structuredClone(params),id:'cs_test_'+(Object.keys(state.sessions).length+1),object:'checkout.session',livemode:false,url:'https://checkout.stripe.com/c/pay/fixture',status:'open',payment_status:'unpaid',subscription:null};state.creates.set(options.idempotencyKey,result);state.sessions[result.id]=result;}if(state.lostCheckout){state.lostCheckout=false;throw Error('Disconnected after commit');}return structuredClone(result);},retrieve:async id=>{record('checkout.retrieve',{id});return structuredClone(state.sessions[id]);}}},
    billingPortal:{sessions:{create:async params=>{record('portal.create',params);return {url:'https://billing.stripe.com/p/session/fixture'};}}},
    subscriptions:{retrieve:async(id,params)=>{record('subscription.retrieve',{id,...params});return structuredClone(state.subscriptions[id]);}},
    invoices:{retrieve:async id=>{record('invoice.retrieve',{id});return structuredClone(state.invoices[id]);},listLineItems:async id=>({data:state.invoices[id].allLines,has_more:false})},
    webhooks:{constructEvent:(raw,signature,signingSecret)=>{record('signature.verify',{rawBuffer:Buffer.isBuffer(raw)});const expected=createHmac('sha256',signingSecret).update(raw).digest('hex');if(signature!==expected)throw Error('Invalid signature');return JSON.parse(raw);}},
  };
  return {api,state};
}
async function fixture(){const store=storeFixture(),{api,state}=fakeStripe();let time=NOW;const service=createBillingService({store,stripe:api,config,now:()=>time});return {store,api,state,service,setNow:value=>time=value};}
function signed(event){const body=Buffer.from(JSON.stringify(event));return {body,signature:createHmac('sha256',secret).update(body).digest('hex')};}
function event(type,id,object,created=Math.floor(NOW/1000)){return {id:`evt_${id}`,object:'event',type,livemode:false,created,data:{object}};}
async function subscriptionFixture(f,{planId='growth',paid=true,status='active',cancelAtPeriodEnd=false,end=NOW+30*DAY}={}){
  const checkout=await f.service.checkout(owner,{planId});
  const data=await f.store.snapshot(),metadata={...data.billing.operations.checkout.params.subscription_data.metadata};
  const invoice={id:'in_fixture',object:'invoice',livemode:false,customer:data.billing.customerId,currency:'usd',status:paid?'paid':'open',amount_remaining:paid?0:planFor(planId).price.amount*100,parent:{type:'subscription_details',subscription_details:{subscription:'sub_fixture'}},lines:{data:[{id:'il_fixture',quantity:1,amount:planFor(planId).price.amount*100,pricing:{price_details:{price:config.priceIds[planId]}},parent:{subscription_item_details:{subscription_item:'si_fixture'}},period:{start:Math.floor(NOW/1000),end:Math.floor(end/1000)}}],has_more:false}};
  const sub={id:'sub_fixture',object:'subscription',livemode:false,customer:data.billing.customerId,metadata,status,cancel_at_period_end:cancelAtPeriodEnd,items:{data:[{id:'si_fixture',quantity:1,price:price(planId),current_period_start:Math.floor(NOW/1000),current_period_end:Math.floor(end/1000)}],has_more:false},latest_invoice:invoice};
  f.state.subscriptions[sub.id]=sub;f.state.invoices[invoice.id]=invoice;
  Object.assign(f.state.sessions[checkout.sessionId],{status:'complete',payment_status:paid?'paid':'unpaid',subscription:sub.id});
  return {sub,invoice,checkout};
}

test('configuration separates sandbox/live keys and permits only server-controlled prices and origin',()=>{
  assert.equal(config.configured,true);assert.equal(config.livemode,false);
  assert.equal(billingConfiguration({...env,STRIPE_LIVEMODE:'true'}).configured,false);
  assert.equal(billingConfiguration({...env,TRACKER_PUBLIC_ORIGIN:'https://attacker.example/path'}).configured,false);
  assert.equal(billingConfiguration({...env,STRIPE_PRICE_TEAM:env.STRIPE_PRICE_STARTER}).configured,false);
  assert.equal(billingConfiguration({...env,STRIPE_RESTRICTED_KEY:''}).configured,false);
  assert.equal(STRIPE_SDK_VERSION,'23.0.0');assert.equal(STRIPE_API_VERSION,'2026-09-30.endive');
});

test('production adapter instantiates an SDK client with current version and bounded retries',async()=>{
  let supplied;class Client{constructor(key,options){supplied={key,options};}}
  const instance=await createStripeClient(config,{StripeClient:Client});assert(instance instanceof Client);
  assert.equal(supplied.options.apiVersion,STRIPE_API_VERSION);assert.equal(supplied.options.maxNetworkRetries,2);
});

test('only owners can start Checkout or portal; plan selection never accepts arbitrary price IDs',async()=>{
  const f=await fixture();
  await assert.rejects(()=>f.service.checkout(admin,{planId:'starter'}),check('billing_owner_required'));
  await assert.rejects(()=>f.service.portal(admin),check('billing_owner_required'));
  await assert.rejects(()=>f.service.checkout(owner,{planId:'price_external'}),check('billing_plan_required'));
  await assert.rejects(()=>f.service.checkout(owner,{}),check('billing_plan_required'));
  assert.equal(f.state.calls.length,0);
});

test('Checkout persists intents before SDK writes, uses mapped quantity1 and omits unsupported tax/payment-method parameters',async()=>{
  const f=await fixture();const originalCustomer=f.api.customers.create,originalCheckout=f.api.checkout.sessions.create;
  f.api.customers.create=async(...args)=>{const data=await f.store.snapshot();assert.equal(data.billing.operations.customer.status,'running');assert(data.billing.operations.customer.idempotencyKey);return originalCustomer(...args);};
  f.api.checkout.sessions.create=async(...args)=>{const data=await f.store.snapshot();assert.equal(data.billing.operations.checkout.status,'running');return originalCheckout(...args);};
  const result=await f.service.checkout(owner,{planId:'starter',priceId:'price_external'});
  const request=f.state.calls.find(call=>call.kind==='checkout.create').params;
  assert.deepEqual(request.line_items,[{price:'price_starter',quantity:1}]);assert.equal(request.payment_method_types,undefined);assert.equal(request.automatic_tax,undefined);
  assert.match(request.integration_identifier,/^hearwhispers-hosted-[a-z]{8}$/);
  assert.equal(request.customer,'cus_fixture');assert.equal(request.client_reference_id,'workspace1');
  assert.equal((await f.store.snapshot()).subscription.status,'trial');
  assert.equal(result.url,'https://checkout.stripe.com/c/pay/fixture');
});

test('concurrent Checkout requests cannot create duplicate customers or subscriptions',async()=>{
  const f=await fixture();const results=await Promise.allSettled([f.service.checkout(owner,{planId:'growth'}),f.service.checkout(owner,{planId:'growth'})]);
  assert(results.some(result=>result.status==='fulfilled'));
  assert.equal(f.state.calls.filter(call=>call.kind==='customer.create').length,1);
  assert.equal(f.state.calls.filter(call=>call.kind==='checkout.create').length,1);
  const repeated=await f.service.checkout(owner,{planId:'growth'});assert.equal(repeated.sessionId,'cs_test_1');
  assert.equal(f.state.calls.filter(call=>call.kind==='checkout.create').length,1);
});

test('lost customer and checkout responses retry immutable params with the same idempotency keys',async()=>{
  const f=await fixture();f.state.lostCustomer=true;
  await assert.rejects(()=>f.service.checkout(owner,{planId:'starter'}),check('billing_provider_unavailable'));
  assert.equal((await f.store.snapshot()).billing.operations.customer.status,'uncertain');
  f.state.lostCheckout=true;
  await assert.rejects(()=>f.service.checkout(owner,{planId:'starter'}),check('billing_provider_unavailable'));
  const result=await f.service.checkout(owner,{planId:'starter'});assert.equal(result.sessionId,'cs_test_1');
  for(const kind of ['customer.create','checkout.create']){const calls=f.state.calls.filter(call=>call.kind===kind);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);}
});

test('unknown create outcomes are not repeated past Stripe idempotency retention',async()=>{
  const f=await fixture();f.state.lostCustomer=true;
  await assert.rejects(()=>f.service.checkout(owner,{planId:'starter'}));f.setNow(NOW+24*3600000);
  await assert.rejects(()=>f.service.checkout(owner,{planId:'starter'}),check('billing_reconciliation_required'));
  assert.equal(f.state.calls.filter(call=>call.kind==='customer.create').length,1);
});

test('Checkout is not reused for an existing subscription; portal is owner-bound and server-origin-bound',async()=>{
  const f=await fixture(),{sub}=await subscriptionFixture(f);
  await f.service.processEvent(event('customer.subscription.created','created',sub));
  await assert.rejects(()=>f.service.checkout(owner,{planId:'team'}),check('billing_portal_required'));
  const portal=await f.service.portal(owner);assert.equal(portal.url,'https://billing.stripe.com/p/session/fixture');
  assert.deepEqual(f.state.calls.find(call=>call.kind==='portal.create').params,{customer:'cus_fixture',return_url:'https://hearwhispers.example/#settings/billing'});
});

test('webhooks require the unmodified raw body, signature and correct Stripe environment',async()=>{
  const f=await fixture(),{sub}=await subscriptionFixture(f);const value=event('customer.subscription.created','sig',sub),payload=signed(value);
  assert.throws(()=>verifyStripeWebhook(f.api,config,JSON.parse(payload.body),'anything'),check('billing_signature_invalid'));
  assert.throws(()=>verifyStripeWebhook(f.api,config,Buffer.from(payload.body+' '),payload.signature),check('billing_signature_invalid'));
  const wrong=signed({...value,livemode:true});assert.throws(()=>verifyStripeWebhook(f.api,config,wrong.body,wrong.signature),check('billing_environment_mismatch'));
  await f.service.webhook(payload.body,payload.signature);assert.equal((await f.store.snapshot()).subscription.status,'active');
});

test('completed but unpaid asynchronous Checkout grants no paid access until invoice.paid',async()=>{
  const f=await fixture(),{sub,invoice,checkout}=await subscriptionFixture(f,{paid:false});
  await f.service.processEvent(event('checkout.session.completed','unpaid',f.state.sessions[checkout.sessionId]));
  let state=await f.store.snapshot();assert.equal(state.subscription.status,'past_due');assert.equal(subscriptionState(state,NOW).active,false);
  Object.assign(invoice,{status:'paid',amount_remaining:0});sub.latest_invoice=invoice;f.state.subscriptions[sub.id]=sub;
  await f.service.processEvent(event('invoice.paid','paid',invoice));
  state=await f.store.snapshot();assert.equal(state.subscription.status,'active');assert.equal(state.subscription.paidUntil,new Date(NOW+30*DAY).toISOString());
});

test('async payment succeeded uses a fresh Checkout and subscription, never the redirect',async()=>{
  const f=await fixture(),{sub,invoice,checkout}=await subscriptionFixture(f,{paid:false});
  const snapshot=await f.store.snapshot();assert.equal(snapshot.subscription.managedBy,'manual');
  Object.assign(invoice,{status:'paid',amount_remaining:0});Object.assign(f.state.sessions[checkout.sessionId],{payment_status:'paid'});sub.latest_invoice=invoice;
  await f.service.processEvent(event('checkout.session.async_payment_succeeded','asyncpaid',f.state.sessions[checkout.sessionId]));
  assert.equal((await f.store.snapshot()).subscription.status,'active');
});

test('duplicate and out-of-order events retrieve current subscription state and cannot restore stale paid access',async()=>{
  const f=await fixture(),{sub}=await subscriptionFixture(f);
  const first=event('customer.subscription.created','first',sub);await f.service.processEvent(first);
  const calls=f.state.calls.filter(call=>call.kind==='subscription.retrieve').length;
  assert.equal((await f.service.processEvent(first)).duplicate,true);assert.equal(f.state.calls.filter(call=>call.kind==='subscription.retrieve').length,calls);
  f.state.subscriptions[sub.id]={...sub,status:'canceled'};
  await f.service.processEvent(event('customer.subscription.deleted','deleted',{...sub,status:'canceled'},Math.floor(NOW/1000)+20));
  await f.service.processEvent(event('customer.subscription.updated','old_snapshot',{...sub,status:'active'},Math.floor(NOW/1000)-50));
  assert.equal((await f.store.snapshot()).subscription.status,'cancelled');
});

test('a current paid invoice defeats a stale payment_failed event while an unpaid renewal never extends access',async()=>{
  const f=await fixture(),{sub,invoice}=await subscriptionFixture(f);await f.service.processEvent(event('invoice.paid','firstpaid',invoice));
  await f.service.processEvent(event('invoice.payment_failed','stalefailed',{...invoice,status:'open'}));
  assert.equal((await f.store.snapshot()).subscription.status,'active');
  const oldEnd=NOW+30*DAY;f.setNow(oldEnd+1);Object.assign(sub.items.data[0],{current_period_start:Math.floor(oldEnd/1000),current_period_end:Math.floor((oldEnd+30*DAY)/1000)});
  Object.assign(invoice,{status:'open',amount_remaining:9900});sub.status='past_due';
  await f.service.processEvent(event('invoice.payment_failed','renewalfail',invoice));
  const state=await f.store.snapshot();assert.equal(state.subscription.status,'past_due');assert.equal(Date.parse(state.subscription.paidUntil),oldEnd);
});

test('paid cancellation at period end remains active until the exact paid boundary; immediate cancellation retains records',async()=>{
  const f=await fixture(),{sub}=await subscriptionFixture(f,{cancelAtPeriodEnd:true});
  await f.service.processEvent(event('customer.subscription.updated','cancelsoon',sub));
  const paid=await f.store.snapshot();assert.equal(subscriptionState(paid,NOW).active,true);assert.equal(subscriptionState(paid,NOW+30*DAY).active,false);
  await f.store.mutate(data=>{data.items.push({id:'saved',note:'Keep forever'});});
  sub.status='canceled';await f.service.processEvent(event('customer.subscription.deleted','cancelnow',sub));
  const cancelled=await f.store.snapshot();assert.equal(cancelled.subscription.status,'cancelled');assert.equal(cancelled.items[0].note,'Keep forever');
});

test('unknown prices, quantities, intervals, currency and customer/workspace mismatches fail closed',async()=>{
  const f=await fixture(),{sub,invoice}=await subscriptionFixture(f);const original=await f.store.snapshot();
  const variants=[
    value=>value.items.data[0].price.id='price_external',value=>value.items.data[0].quantity=2,value=>value.items.data[0].price.recurring.interval='year',value=>value.items.data[0].price.currency='eur',value=>value.items.data[0].price.unit_amount=1,
    value=>value.customer='cus_other',value=>value.metadata.hearwhispers_workspace_id='other',value=>value.livemode=true,
  ];
  for(const change of variants){const bad=structuredClone(sub);change(bad);assert.throws(()=>applyStripeSubscription(structuredClone(original),bad,invoice,config,{now:NOW}));}
  const badInvoice={...invoice,customer:'cus_other'};assert.throws(()=>applyStripeSubscription(structuredClone(original),sub,badInvoice,config,{now:NOW}),check('billing_binding_mismatch'));
  await assert.rejects(()=>f.service.processEvent(event('invoice.paid','othercustomer',{...invoice,customer:'cus_other'})),check('billing_binding_mismatch'));
  assert.equal((await f.store.snapshot()).subscription.managedBy,'manual');
});

test('upgrades require current-plan payment and paid downgrades apply despite over-capacity without deletion',async()=>{
  const f=await fixture(),{sub,invoice}=await subscriptionFixture(f,{planId:'team'});
  await f.service.processEvent(event('invoice.paid','teampaid',invoice));
  await f.store.mutate(data=>{data.products=[{id:'one',monitoring:true,keywords:['one'],createdAt:'2026-01-01'},{id:'two',monitoring:true,keywords:['two'],createdAt:'2026-01-02'}];data.items=[{id:'saved',productId:'two',note:'Keep note'}];});
  sub.items.data[0].price=price('starter');
  await f.service.processEvent(event('customer.subscription.updated','downgrade',sub));
  let state=await f.store.snapshot();assert.equal(state.subscription.planId,'starter');assert.equal(state.subscription.status,'active');assert.equal(state.products.length,2);assert.equal(state.items[0].note,'Keep note');assert.equal(state.products[1].planMonitoringBlocked,'plan_capacity');assert.equal(state.billing.overCapacity.products.used,2);
  sub.items.data[0].price=price('team');Object.assign(invoice,{status:'open',amount_remaining:24900});
  await f.service.processEvent(event('customer.subscription.updated','unpaidupgrade',sub));
  state=await f.store.snapshot();assert.equal(state.subscription.planId,'starter');
  Object.assign(invoice,{status:'paid',amount_remaining:0});invoice.lines.data[0].pricing.price_details.price='price_team';
  await f.service.processEvent(event('invoice.paid','paidupgrade',invoice));
  state=await f.store.snapshot();assert.equal(state.subscription.planId,'team');assert.equal(state.products[1].planMonitoringBlocked,undefined);
});

test('reconciliation leases reject overlapping handlers and late old settlements cannot win',async()=>{
  const f=await fixture(),{sub}=await subscriptionFixture(f);const data=await f.store.snapshot();
  const a=claimBillingEvent(data,event('customer.subscription.created','a',sub),config,NOW);
  assert.throws(()=>claimBillingEvent(data,event('customer.subscription.updated','b',sub),config,NOW+1),check('billing_busy'));
  const b=claimBillingEvent(data,event('customer.subscription.updated','b',sub),config,NOW+90001);assert.notEqual(a.token,b.token);
  assert.throws(()=>finishBillingEvent(data,a,{},NOW+90002),check('billing_lease_changed'));
  finishBillingEvent(data,b,{},NOW+90002);assert.equal(data.billing.events[b.eventId].status,'complete');
});

test('server-owned billing bindings, event receipts and payment periods cannot be reset by backup restore',async()=>{
  const f=await fixture(),{sub}=await subscriptionFixture(f);await f.service.processEvent(event('customer.subscription.created','restore',sub));
  const data=await f.store.snapshot(),restored=preserveServerOwnedState(data,{version:1,products:[],items:[],billing:{customerId:'cus_attack'},subscription:{planId:'team',status:'active'}},{validateCapacity:false});
  assert.deepEqual(restored.billing,data.billing);assert.deepEqual(restored.subscription,data.subscription);
  const visible=publicBillingState(data,NOW);assert.equal(JSON.stringify(visible).includes('idempotencyKey'),false);assert.equal(JSON.stringify(visible).includes('cus_fixture'),false);
  const summary=publicBillingSummary(data,config,NOW);assert.equal(summary.configured,true);assert.equal(summary.configuredCustomer,true);assert.equal(summary.hasSubscription,true);assert.equal(summary.environment,'sandbox');
  assert.equal(JSON.stringify(summary).includes(config.secretKey),false);assert.equal(JSON.stringify(summary).includes(config.webhookSecret),false);assert.equal(summary.priceIds,undefined);
});

test('a canceled subscription can start a new Checkout without reusing its completed session',async()=>{
  const f=await fixture(),{sub}=await subscriptionFixture(f);await f.service.processEvent(event('customer.subscription.created','first',sub));
  sub.status='canceled';await f.service.processEvent(event('customer.subscription.deleted','canceled',sub));
  const result=await f.service.checkout(owner,{planId:'starter'});assert.equal(result.sessionId,'cs_test_2');
  const data=await f.store.snapshot();assert.equal(Object.keys(data.billing.checkoutHistory).length,1);assert.equal(data.subscription.status,'cancelled');
});

test('actual Stripe SDK verifies signed raw payloads locally without API requests',async t=>{
  let Client;try{Client=(await import('stripe')).default;}catch{t.skip('Install the verified stripe@23.0.0 dependency to run SDK signature verification.');return;}
  const stripe=await createStripeClient(config,{StripeClient:Client});const value=event('invoice.paid','actual',{id:'in_fixture',customer:'cus_fixture'}),body=Buffer.from(JSON.stringify(value));
  const signature=stripe.webhooks.generateTestHeaderString({payload:body.toString(),secret:config.webhookSecret});
  assert.equal(verifyStripeWebhook(stripe,config,body,signature).id,value.id);
  assert.throws(()=>verifyStripeWebhook(stripe,config,Buffer.from(body+' '),signature),check('billing_signature_invalid'));
});
