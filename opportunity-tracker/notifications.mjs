import {createHash, randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {assertFeature, planFor} from './plans.mjs';
import {accessContext, authorizeProduct} from './workspace.mjs';
import {attributedConversation, canonicalConversationKey} from './reports.mjs';

const DAY = 86400000, HOUR = 3600000;
export const NOTIFICATION_LEASE_MS = 60000;
// https://resend.com/docs/dashboard/emails/idempotency-keys documents 24 hours.
export const EMAIL_IDEMPOTENCY_WINDOW_MS = 23 * HOUR; // Safely inside provider retention.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const iso = value => new Date(value).toISOString();
const fail = (message,code='notification_invalid',status=400) => { throw Object.assign(new Error(message),{status,code}); };
function at(value=Date.now()) { if(!Number.isFinite(value)||value<0)fail('Use a valid notification time.'); return value; }
function state(data) { data.notifications ||= {version:1,preferences:{}}; data.notificationOutbox ||= {version:1,jobs:{},receipts:{}}; data.integrations ||= {version:1,records:{}}; if([data.notifications,data.notificationOutbox,data.integrations].some(value=>value.version!==1))fail('Unsupported notification schema.','notification_schema',409); return data.notifications; }
function principalFor(data,sub) { const member = Object.hasOwn(data.workspace?.members || {},sub) ? data.workspace.members[sub] : null; if(!member)fail('Member not found.','membership_required',403); return {sub:member.sub,email:member.email}; }
function scope(data,principal,{productIds,clientId},plan) {
  accessContext(data,principal,clientId == null ? {} : {clientId},plan);
  if(!Array.isArray(productIds)||!productIds.length||productIds.length>100||productIds.some(id=>typeof id!=='string'))fail('Choose products for this notification.');
  const ids=[...new Set(productIds)], products=ids.map(id=>authorizeProduct(data,principal,id,{},plan));
  if(clientId != null && products.some(p=>p.clientId!==clientId))fail('Every selected product must belong to the selected client.');
  return ids;
}
export function publicAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g,'');
  if(isIP(ip)===4) {
    const [a,b,c]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
  }
  if(isIP(ip)===6) {
    const [a,b] = ip.toLowerCase().split(':').map(value=>parseInt(value||'0',16));
    return a>=0x2000&&a<=0x3ffe&&a!==0x2002&&!(a===0x2001&&(b<0x0200||b===0x0db8));
  }
  return false;
}
export function validateIntegrationURL(value,channel='webhook') {
  if(typeof value!=='string'||value.length>4096)fail('Enter a public HTTPS destination.');
  let url; try { url=new URL(value); } catch { fail('Enter a public HTTPS destination.'); }
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||(!isIP(host)&&(!host.includes('.')||/(^|\.)(localhost|local|internal|invalid|test|onion)$/.test(host)))||isIP(host)&&!publicAddress(host))fail('Use a public HTTPS destination without credentials or redirects.');
  if(channel==='slack'&&(!['hooks.slack.com','hooks.slack-gov.com'].includes(host)||!/^\/services\/[A-Za-z0-9/_-]+$/.test(url.pathname)||url.search))fail('Use a Slack incoming webhook URL.');
  return url.href;
}
function features(data,pref,now) {
  assertFeature(data,'digest',{now});
  if(pref.mode==='immediate')assertFeature(data,'configurableAlerts',{now});
  if(pref.clientId)assertFeature(data,'routing',{now});
  if(pref.channel!=='email')assertFeature(data,'integrations',{now});
}
function integrationFor(data,pref) {
  if(pref.channel==='email')return null;
  const integration=data.integrations?.records?.[pref.integrationId];
  if(!integration||!integration.enabled||integration.channel!==pref.channel)fail('The selected integration is unavailable.','integration_unavailable',409);
  if(pref.productIds.some(id=>!integration.productIds.includes(id))||integration.clientId&&pref.clientId!==integration.clientId)fail('The integration does not cover these products.','integration_scope',403);
  return integration;
}
function preference(data,principal,id,now) {
  const plan=planFor(data), context=accessContext(data,principal,{},plan), pref=data.notifications?.preferences?.[id];
  if(!pref||pref.memberSub!==context.member.sub)fail('Notification preference not found.','notification_not_found',404);
  features(data,pref,now); scope(data,principal,pref,plan);
  if(!pref.enabled)fail('This notification preference is disabled.','notification_disabled',409);
  const integration=integrationFor(data,pref);
  if(integration) {
    const creator=principalFor(data,integration.createdBy);
    accessContext(data,creator,{admin:true},plan);
    scope(data,creator,integration,plan);
  }
  return {pref,context,integration};
}
function configHash(pref,integration) { const {lastDigestWindowEnd,...configuration}=pref;return digest([configuration,integration?{id:integration.id,revision:integration.revision}:null]); }
function publicPreference(pref) { const {id,memberSub,channel,mode,enabled,productIds,clientId,integrationId,digestHourUTC,includeHistorical,createdAt,updatedAt}=pref; return {id,memberSub,channel,mode,enabled,productIds,clientId,integrationId,digestHourUTC,includeHistorical,createdAt,updatedAt}; }
function publicJob(job) { return {id:job.id,preferenceId:job.preferenceId,channel:job.channel,status:job.status,count:job.itemIds.length,attempts:job.attempts,createdAt:job.createdAt,nextAttemptAt:job.nextAttemptAt,sentAt:job.sentAt||null,errorCode:job.errorCode||null}; }

export function saveIntegration(data,principal,{id,channel,name,url,signingSecret,enabled=false,productIds,clientId=null,now=Date.now()}={}) {
  now=at(now); assertFeature(data,'integrations',{now}); const plan=planFor(data),context=accessContext(data,principal,{admin:true,write:true},plan);
  if(!['slack','webhook'].includes(channel)||typeof name!=='string'||!name.trim()||name.length>120||typeof enabled!=='boolean')fail('Choose an integration channel and name.');
  const ids=scope(data,principal,{productIds,clientId},plan); if(clientId)assertFeature(data,'routing',{now});
  const endpoint=validateIntegrationURL(url,channel);
  if(signingSecret!==undefined&&(channel!=='webhook'||typeof signingSecret!=='string'||signingSecret.length<32||signingSecret.length>256))fail('Webhook signing secrets must contain 32–256 characters.');
  state(data); const prior=id?data.integrations.records[id]:null; if(id&&!prior)fail('Integration not found.','integration_not_found',404);
  const record={id:prior?.id||randomUUID(),channel,name:name.trim(),enabled,productIds:ids,clientId,revision:(prior?.revision||0)+1,createdBy:context.member.sub,createdAt:prior?.createdAt||iso(now),updatedAt:iso(now),secret:{url:endpoint,...(signingSecret?{signingSecret}:prior?.secret?.signingSecret&&channel==='webhook'?{signingSecret:prior.secret.signingSecret}:{})}};
  data.integrations.records[record.id]=record;
  return {id:record.id,channel,name:record.name,enabled,productIds:ids,clientId,configured:true};
}
export function removeIntegration(data,principal,{id,now=Date.now()}={}) {
  accessContext(data,principal,{admin:true,write:true},planFor(data)); const record=data.integrations?.records?.[id];
  if(!record)fail('Integration not found.','integration_not_found',404);
  for(const productId of record.productIds)authorizeProduct(data,principal,productId,{},planFor(data));
  record.enabled=false; record.secret={}; record.revision++; record.updatedAt=iso(at(now)); return {id,enabled:false};
}
export function setNotificationPreference(data,principal,{id,channel='email',mode='digest',enabled=false,productIds,clientId=null,integrationId=null,digestHourUTC=8,includeHistorical=false,now=Date.now()}={}) {
  now=at(now); const plan=planFor(data),context=accessContext(data,principal,{},plan);
  if(!['email','slack','webhook'].includes(channel)||!['digest','immediate'].includes(mode)||typeof enabled!=='boolean'||typeof includeHistorical!=='boolean'||!Number.isInteger(digestHourUTC)||digestHourUTC<0||digestHourUTC>23)fail('Choose valid notification settings.');
  const ids=scope(data,principal,{productIds,clientId},plan), candidate={channel,mode,enabled,productIds:ids,clientId,integrationId,digestHourUTC,includeHistorical};
  features(data,candidate,now); integrationFor(data,candidate); state(data);
  const prior=id?data.notifications.preferences[id]:null;
  if(id&&(!prior||prior.memberSub!==context.member.sub))fail('Notification preference not found.','notification_not_found',404);
  const pref={...candidate,id:prior?.id||randomUUID(),memberSub:context.member.sub,createdAt:prior?.createdAt||iso(now),updatedAt:iso(now),revision:(prior?.revision||0)+1,...(prior?.lastDigestWindowEnd?{lastDigestWindowEnd:prior.lastDigestWindowEnd}:{})};
  data.notifications.preferences[pref.id]=pref; return publicPreference(pref);
}
export function removeNotificationPreference(data,principal,{id,now=Date.now()}={}) {
  const context=accessContext(data,principal,{},planFor(data)),pref=data.notifications?.preferences?.[id];
  if(!pref||pref.memberSub!==context.member.sub)fail('Notification preference not found.','notification_not_found',404);
  for(const productId of pref.productIds)authorizeProduct(data,principal,productId,{},planFor(data));
  pref.enabled=false; pref.updatedAt=iso(at(now)); pref.revision++; return publicPreference(pref);
}
export function publicNotifications(data,principal,now=Date.now()) {
  const context=accessContext(data,principal,{},planFor(data)), allowed=new Set(context.productIds), prefs=Object.values(data.notifications?.preferences||{}).filter(p=>p.memberSub===context.member.sub&&p.productIds.every(id=>allowed.has(id)));
  const ids=new Set(prefs.map(p=>p.id));
  return {preferences:prefs.map(publicPreference),integrations:Object.values(data.integrations?.records||{}).filter(i=>i.productIds.every(id=>allowed.has(id))).map(i=>({id:i.id,name:i.name,channel:i.channel,enabled:i.enabled,productIds:i.productIds,clientId:i.clientId,configured:Boolean(i.secret?.url)})),deliveries:Object.values(data.notificationOutbox?.jobs||{}).filter(job=>job.memberSub===context.member.sub&&ids.has(job.preferenceId)).map(publicJob)};
}

function enqueue(data,principal,{preferenceId,eventId='conversation-found',itemIds,windowStart,windowEnd,now=Date.now()}={},itemIndex) {
  now=at(now); const {pref,context,integration}=preference(data,principal,preferenceId,now);
  if(typeof eventId!=='string'||!eventId||eventId.length>200||!Array.isArray(itemIds)||!itemIds.length)fail('Choose an event and conversations to notify about.');
  const items=[...new Set(itemIds)].map(id=>itemIndex.get(id));
  if(items.some(item=>!item))fail('Conversation not found.','item_not_found',404);
  const unique=new Map();
  for(const item of items) {
    authorizeProduct(data,principal,item.productId,{},planFor(data));
    if(!pref.productIds.includes(item.productId))fail('A conversation is outside the notification scope.','notification_scope',403);
    if(item.historical&&!pref.includeHistorical)continue;
    const key=canonicalConversationKey(item); if(key)unique.set(`${item.productId}:${key}`,item);
  }
  if(!unique.size)return null;
  let window=null;
  if(pref.mode==='digest') {
    const from=Date.parse(windowStart),to=Date.parse(windowEnd);
    if(!Number.isFinite(from)||!Number.isFinite(to)||to-from!==DAY||to>now||new Date(to).getUTCHours()!==pref.digestHourUTC||to%HOUR!==0)fail('Use a completed daily digest window.');
    window={from:iso(from),to:iso(to)};
    for(const [key,item] of unique)if(!(Date.parse(item.foundAt)>=from&&Date.parse(item.foundAt)<to))unique.delete(key);
    if(!unique.size)return null;
  }
  const recipient=pref.channel==='email'?context.member.email:integration.secret.url;
  const id=digest([context.workspaceId,context.member.sub,pref.channel,recipient,pref.mode,window?[pref.clientId,[...pref.productIds].sort(),window]:[eventId,[...unique.keys()].sort()]]);
  state(data); const prior=data.notificationOutbox.jobs[id];
  if(prior) {
    if(prior.status==='queued'&&!prior.request&&prior.configHash===configHash(pref,integration)) {
      const existing=new Set(prior.itemIds.map(id=>itemIndex.get(id)).filter(Boolean).map(item=>`${item.productId}:${canonicalConversationKey(item)}`));
      for(const [key,item] of unique)if(!existing.has(key)){prior.itemIds.push(item.id);existing.add(key);}
    }
    return publicJob(prior);
  }
  const job={id,workspaceId:context.workspaceId,memberSub:context.member.sub,preferenceId:pref.id,configHash:configHash(pref,integration),channel:pref.channel,recipient:pref.channel==='email'?recipient:integration.id,itemIds:[...unique.values()].map(item=>item.id),eventId,window,status:'queued',attempts:0,createdAt:iso(now),nextAttemptAt:iso(now),idempotencyKey:`hw-${id}`};
  data.notificationOutbox.jobs[id]=job; return publicJob(job);
}
export function enqueueNotification(data,principal,input={}) { return enqueue(data,principal,input,new Map((data.items||[]).map(item=>[item.id,item]))); }
export function enqueueDueNotifications(data,principal,{now=Date.now()}={}) {
  now=at(now); const context=accessContext(data,principal,{},planFor(data)), results=[],itemIndex=new Map((data.items||[]).map(item=>[item.id,item]));
  for(const pref of Object.values(data.notifications?.preferences||{}).filter(p=>p.memberSub===context.member.sub&&p.enabled)) {
    preference(data,principal,pref.id,now);
    const end=Math.floor((now-pref.digestHourUTC*HOUR)/DAY)*DAY+pref.digestHourUTC*HOUR;
    const items=(data.items||[]).filter(item=>pref.productIds.includes(item.productId)&&(!item.historical||pref.includeHistorical)&&Date.parse(item.foundAt)>=Date.parse(pref.createdAt));
    if(pref.mode==='digest') {
      const first=pref.lastDigestWindowEnd?Date.parse(pref.lastDigestWindowEnd)+DAY:Math.floor((Date.parse(pref.createdAt)-pref.digestHourUTC*HOUR)/DAY)*DAY+pref.digestHourUTC*HOUR+DAY;
      for(let to=first;to<=end;to+=DAY) {
        const batch=items.filter(item=>Date.parse(item.foundAt)>=to-DAY&&Date.parse(item.foundAt)<to);
        if(batch.length)results.push(enqueue(data,principal,{preferenceId:pref.id,itemIds:batch.map(i=>i.id),windowStart:iso(to-DAY),windowEnd:iso(to),now},itemIndex));
        pref.lastDigestWindowEnd=iso(to);
      }
    } else for(const item of items)results.push(enqueue(data,principal,{preferenceId:pref.id,itemIds:[item.id],now},itemIndex));
  }
  return results.filter(Boolean);
}
export function validateNotificationDelivery(data,principal,{id,token,now=Date.now()}={}) {
  now=at(now); const context=accessContext(data,principal,{},planFor(data)), job=data.notificationOutbox?.jobs?.[id];
  if(!job||job.memberSub!==context.member.sub||job.workspaceId!==context.workspaceId)fail('Delivery not found.','delivery_not_found',404);
  if(token!==undefined&&(!job.lease||job.lease.token!==token||Date.parse(job.lease.expiresAt)<=now))fail('Delivery lease expired.','delivery_lease',409);
  const {pref,integration}=preference(data,principal,job.preferenceId,now);
  if(job.configHash!==configHash(pref,integration)||job.channel==='email'&&job.recipient!==context.member.email)fail('Notification settings changed.','notification_changed',409);
  const itemIndex=new Map((data.items||[]).map(item=>[item.id,item]));
  const rows=job.itemIds.map(itemId=>{
    const item=itemIndex.get(itemId); if(!item)fail('Conversation no longer exists.','item_not_found',404);
    const product=authorizeProduct(data,principal,item.productId,{},planFor(data)); if(!pref.productIds.includes(product.id))fail('Delivery is outside the current product scope.','notification_scope',403);
    return attributedConversation(item,product,data.workspace.clients[product.clientId]);
  });
  return {id:job.id,channel:job.channel,idempotencyKey:job.idempotencyKey,recipient:job.channel==='email'?job.recipient:null,endpoint:job.channel==='email'?'https://api.resend.com/emails':integration.secret.url,signingSecret:integration?.secret?.signingSecret,request:job.request?clone(job.request):null,payload:{workspace: data.workspace.name,mode:pref.mode,window:job.window,rows}};
}
function expire(job,now) {
  if(!job.lease||Date.parse(job.lease.expiresAt)>now)return;
  if(job.status==='sending'&&(job.channel!=='email'||now-Date.parse(job.firstDispatchAt)>=EMAIL_IDEMPOTENCY_WINDOW_MS)) { job.status='uncertain'; job.errorCode='dispatch_outcome_unknown'; }
  else { job.status='retry'; job.nextAttemptAt=iso(now); }
  delete job.lease;
}
export function expireNotificationLeases(data,{now=Date.now()}={}) { now=at(now); for(const job of Object.values(data.notificationOutbox?.jobs||{}))expire(job,now); }
export function claimNotification(data,principal,{id,workerId='notification-worker',now=Date.now(),leaseMs=NOTIFICATION_LEASE_MS}={}) {
  now=at(now); if(typeof workerId!=='string'||workerId.length>100||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>300000)fail('Invalid delivery worker lease.');
  validateNotificationDelivery(data,principal,{id,now}); const job=data.notificationOutbox.jobs[id]; expire(job,now);
  if(!['queued','retry'].includes(job.status)||Date.parse(job.nextAttemptAt)>now)return null;
  if(job.firstDispatchAt&&now-Date.parse(job.firstDispatchAt)>=EMAIL_IDEMPOTENCY_WINDOW_MS&&job.channel==='email') { job.status='uncertain'; job.errorCode='email_idempotency_window_expired'; return null; }
  job.status='leased';job.attempts++;job.lease={token:randomUUID(),workerId,expiresAt:iso(now+leaseMs)};
  return {id,token:job.lease.token,channel:job.channel};
}
export function markNotificationDispatched(data,principal,{id,token,request,now=Date.now()}={}) {
  now=at(now); const packet=validateNotificationDelivery(data,principal,{id,token,now}),job=data.notificationOutbox.jobs[id];
  if(job.status!=='leased')fail('Delivery is not ready to dispatch.','delivery_state',409);
  if(!job.request) {
    if(!request||request.endpoint!==packet.endpoint||typeof request.body!=='string'||Buffer.byteLength(request.body)>2*1024*1024)fail('Invalid prepared delivery.');
    let body;try{body=JSON.parse(request.body);}catch{fail('Invalid prepared delivery.');}
    if(job.channel==='email'&&(!Array.isArray(body.to)||body.to.length!==1||body.to[0]!==packet.recipient))fail('Prepared email recipient does not match the opted-in member.');
    job.request={endpoint:request.endpoint,body:request.body};
  } else if(request&&(request.endpoint!==job.request.endpoint||request.body!==job.request.body))fail('Retry payload must match the original dispatch.','delivery_payload_changed',409);
  job.status='sending';job.firstDispatchAt ||= iso(now);job.lastDispatchAt=iso(now);
  return {...packet,request:clone(job.request)};
}
export function finishNotification(data,{id,token,outcome,providerId=null,errorCode=null,notSent=false,retryAfterMs=0,now=Date.now()}={}) {
  now=at(now); const job=data.notificationOutbox?.jobs?.[id];
  if(!job||job.lease?.token!==token)fail('Delivery lease no longer belongs to this worker.','delivery_lease',409);
  if(!['sent','retry','failed','uncertain'].includes(outcome))fail('Invalid delivery outcome.');
  if(outcome==='sent'&&job.status!=='sending')fail('Delivery was not dispatched.','delivery_state',409);
  if(providerId!==null&&(typeof providerId!=='string'||providerId.length>200))fail('Invalid delivery receipt.');
  if(errorCode!==null&&(typeof errorCode!=='string'||!/^[a-z0-9_-]{1,100}$/i.test(errorCode)))fail('Use a safe delivery error code.');
  if(outcome==='retry'&&!notSent&&(job.channel!=='email'||job.firstDispatchAt&&now-Date.parse(job.firstDispatchAt)>=EMAIL_IDEMPOTENCY_WINDOW_MS))outcome='uncertain';
  if(outcome==='retry'&&job.attempts>=6)outcome=notSent?'failed':'uncertain';
  job.status=outcome;job.errorCode=errorCode;delete job.lease;
  if(outcome==='retry')job.nextAttemptAt=iso(now+Math.max(Math.min(Math.max(0,Number(retryAfterMs)||0),HOUR),Math.min(HOUR,30000*2**Math.min(job.attempts-1,7))));
  if(outcome==='sent') { job.sentAt=iso(now);data.notificationOutbox.receipts[job.idempotencyKey]={jobId:id,sentAt:job.sentAt,providerId}; }
  return publicJob(job);
}
