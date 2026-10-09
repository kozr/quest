import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapWorkspace, filterWorkspaceState} from '../workspace.mjs';
import {planFor} from '../plans.mjs';
import {setNotificationPreference,removeNotificationPreference,saveIntegration,publicNotifications,enqueueNotification,enqueueDueNotifications,claimNotification,validateNotificationDelivery,markNotificationDispatched,finishNotification,expireNotificationLeases,validateIntegrationURL,publicAddress,EMAIL_IDEMPOTENCY_WINDOW_MS} from '../notifications.mjs';
import {createDeliveryAdapters,deliverNotification,resolvePublicDestination} from '../delivery.mjs';
import {buildReport,reportCSV,reportJSON,canonicalConversationKey,csvCell} from '../reports.mjs';

const NOW=Date.parse('2026-10-09T12:00:00Z'),DAY=86400000;
const owner={sub:'owner',email:'owner@example.com'},bob={sub:'bob',email:'bob@example.com'};
function fixture(planId='team') {
  const data={version:1,subscription:{planId,status:'manual'},products:[{id:'p1',name:'Product one',clientId:'c1'},{id:'p2',name:'Product two',clientId:'c2'}],items:[{id:'one',productId:'p1',source:'Reddit',author:'alice',url:'https://www.reddit.com/r/example/comments/abc/topic/def/',type:'comment',title:'Original discussion',snippet:'Original source words',publishedAt:'2026-10-08T20:00:00Z',foundAt:'2026-10-09T06:00:00Z',note:'PRIVATE NOTE',draft:'PRIVATE DRAFT'},{id:'two',productId:'p2',source:'X',author:'carol',url:'https://x.com/carol/status/123',title:'Other client',snippet:'Client two source',publishedAt:'2026-10-09T02:00:00Z',foundAt:'2026-10-09T07:00:00Z'}],searches:{}};
  bootstrapWorkspace(data,{id:'workspace',owner,now:NOW-DAY});
  data.workspace.clients={c1:{id:'c1',name:'Client one'},c2:{id:'c2',name:'Client two'}};
  data.workspace.members.bob={sub:bob.sub,email:bob.email,role:'member',status:'active',clientIds:['c1'],createdAt:new Date(NOW-DAY).toISOString()};
  if(planId==='starter')delete data.workspace.members.bob;
  return data;
}
const preference=(data,options={},principal=owner)=>setNotificationPreference(data,principal,{enabled:true,productIds:['p1'],now:NOW-DAY,...options});
function queued(data,{channel='email',mode='immediate',principal=owner}={}) {
  let integrationId=null;
  if(channel!=='email')integrationId=saveIntegration(data,owner,{channel,name:'Destination',url:channel==='slack'?'https://hooks.slack.com/services/TOKEN/CHANNEL/SECRET':'https://hooks.example.com/SECRET',enabled:true,productIds:['p1'],now:NOW}).id;
  const pref=preference(data,{channel,mode,integrationId},principal);
  const job=enqueueNotification(data,principal,{preferenceId:pref.id,itemIds:['one'],...(mode==='digest'?{windowStart:'2026-10-08T08:00:00Z',windowEnd:'2026-10-09T08:00:00Z'}:{}),now:NOW});return {pref,job};
}
function memory(data) { return {data,async snapshot(){return structuredClone(this.data);},async mutate(fn){const next=structuredClone(this.data),result=fn(next);this.data=next;return structuredClone(result);}}; }
const env={TRACKER_NOTIFICATIONS_ENABLED:'true',TRACKER_EMAIL_FROM:'HearWhispers <alerts@example.com>',RESEND_API_KEY:'fixture-server-secret'};
const resolver=async()=>[{address:'8.8.8.8',family:4}];

test('Starter gets explicit daily digest opt-in; Growth gets configurable email alerts; integrations require Team',()=>{
  const starter=fixture('starter');assert.deepEqual(enqueueDueNotifications(starter,owner,{now:NOW}),[]);
  const disabled=setNotificationPreference(starter,owner,{productIds:['p1'],now:NOW-DAY});assert.equal(disabled.enabled,false);assert.deepEqual(enqueueDueNotifications(starter,owner,{now:NOW}),[]);
  assert.throws(()=>preference(starter,{mode:'immediate'}),e=>e.code==='feature_unavailable');
  preference(starter,{id:disabled.id});assert.equal(enqueueDueNotifications(starter,owner,{now:NOW}).length,1);
  const growth=fixture('growth');preference(growth,{mode:'immediate'});assert.equal(enqueueDueNotifications(growth,owner,{now:NOW}).length,1);
  assert.throws(()=>saveIntegration(growth,owner,{channel:'webhook',name:'No',url:'https://example.com/hook',productIds:['p1']}),e=>e.code==='feature_unavailable');
});
test('preferences and enqueues enforce current product/client access and verified self recipient',()=>{
  const data=fixture();assert.throws(()=>preference(data,{productIds:['p2']},bob),e=>e.status===404);
  const pref=preference(data,{memberSub:'owner',email:'outside@example.com'},bob);
  assert.equal(pref.memberSub,'bob');
  assert.throws(()=>enqueueNotification(data,bob,{preferenceId:pref.id,itemIds:['two'],now:NOW}),e=>e.status===404);
  assert.throws(()=>enqueueNotification(data,owner,{preferenceId:pref.id,itemIds:['one'],now:NOW}),e=>e.status===404);
  const job=enqueueNotification(data,bob,{preferenceId:pref.id,itemIds:['one'],windowStart:'2026-10-08T08:00:00Z',windowEnd:'2026-10-09T08:00:00Z',now:NOW});
  assert.equal(data.notificationOutbox.jobs[job.id].recipient,bob.email);
});
test('outbox idempotency survives JSON restart and canonical source aliases are deduplicated',()=>{
  const data=fixture();data.items.push({...data.items[0],id:'duplicate',url:data.items[0].url+'?utm_source=duplicate'});
  const {pref,job}=queued(data);assert.equal(enqueueNotification(data,owner,{preferenceId:pref.id,itemIds:['one','duplicate'],now:NOW}).id,job.id);
  const restored=JSON.parse(JSON.stringify(data));assert.equal(enqueueNotification(restored,owner,{preferenceId:pref.id,itemIds:['duplicate'],now:NOW}).id,job.id);
  assert.equal(Object.keys(restored.notificationOutbox.jobs).length,1);
  assert.equal(restored.notificationOutbox.jobs[job.id].itemIds.length,1);
});
test('daily digest windows close before enqueue and repeated scheduler passes do not duplicate jobs',()=>{
  const data=fixture('starter'),pref=preference(data);const first=enqueueDueNotifications(data,owner,{now:NOW}),second=enqueueDueNotifications(data,owner,{now:NOW});assert.equal(first.length,1);assert.equal(second.length,0);assert.equal(Object.keys(data.notificationOutbox.jobs).length,1);
  assert.throws(()=>enqueueNotification(data,owner,{preferenceId:pref.id,itemIds:['one'],windowStart:new Date(NOW).toISOString(),windowEnd:new Date(NOW+DAY).toISOString(),now:NOW}),/completed daily/);
  removeNotificationPreference(data,owner,{id:pref.id,now:NOW});assert.throws(()=>claimNotification(data,owner,{id:first[0].id,now:NOW}),/disabled/);
});
test('historical results do not trigger notifications without separate explicit inclusion',()=>{
  const data=fixture();data.items[0].historical=true;const pref=preference(data,{mode:'immediate'});
  assert.equal(enqueueNotification(data,owner,{preferenceId:pref.id,itemIds:['one'],now:NOW}),null);
  const enabled=preference(data,{id:pref.id,mode:'immediate',includeHistorical:true});assert(enqueueNotification(data,owner,{preferenceId:enabled.id,itemIds:['one'],now:NOW}));
});
test('membership, downgrade, integration owner and client access are revalidated before dispatch',()=>{
  for(const change of [data=>data.workspace.members.bob.status='revoked',data=>data.workspace.members.bob.clientIds=[],data=>data.subscription.planId='starter']) {
    const data=fixture(),{job}=queued(data,{principal:bob}),lease=claimNotification(data,bob,{id:job.id,now:NOW});change(data);
    assert.throws(()=>validateNotificationDelivery(data,bob,{...lease,now:NOW+1}),e=>[403,404].includes(e.status));
  }
  const data=fixture(),{job}=queued(data,{channel:'slack'});data.integrations.records[Object.keys(data.integrations.records)[0]].createdBy='bob';data.workspace.members.bob.status='revoked';assert.throws(()=>claimNotification(data,owner,{id:job.id,now:NOW}),e=>e.status===403);
});
test('exclusive leases reject stale acknowledgements and preserve receipts',()=>{
  const data=fixture(),{job}=queued(data),lease=claimNotification(data,owner,{id:job.id,now:NOW});assert.equal(claimNotification(data,owner,{id:job.id,now:NOW}),null);
  const request={endpoint:'https://api.resend.com/emails',body:JSON.stringify({to:[owner.email],text:'Original'})};markNotificationDispatched(data,owner,{...lease,request,now:NOW});
  assert.throws(()=>finishNotification(data,{...lease,token:'wrong',outcome:'sent',now:NOW}),/lease/);
  finishNotification(data,{...lease,outcome:'sent',providerId:'receipt-1',now:NOW});assert.equal(claimNotification(data,owner,{id:job.id,now:NOW}),null);
  assert.equal(data.notificationOutbox.receipts[data.notificationOutbox.jobs[job.id].idempotencyKey].providerId,'receipt-1');
});
test('expired sending leases hold Slack uncertain and email retries only within idempotency retention',()=>{
  for(const channel of ['slack','email']) {
    const data=fixture(),{job}=queued(data,{channel}),lease=claimNotification(data,owner,{id:job.id,now:NOW});
    const packet=validateNotificationDelivery(data,owner,{...lease,now:NOW});markNotificationDispatched(data,owner,{...lease,request:{endpoint:packet.endpoint,body:JSON.stringify(channel==='email'?{to:[owner.email]}:{text:'Message'})},now:NOW});
    expireNotificationLeases(data,{now:NOW+61000});assert.equal(data.notificationOutbox.jobs[job.id].status,channel==='slack'?'uncertain':'retry');
    if(channel==='email'){assert.equal(claimNotification(data,owner,{id:job.id,now:NOW+EMAIL_IDEMPOTENCY_WINDOW_MS+1}),null);assert.equal(data.notificationOutbox.jobs[job.id].status,'uncertain');}
    else assert.equal(claimNotification(data,owner,{id:job.id,now:NOW+61000}),null);
  }
});
test('public projections and workspace backups never expose integration URLs, request bodies or server secrets',()=>{
  const data=fixture(),integration=saveIntegration(data,owner,{channel:'webhook',name:'Public label',url:'https://hooks.example.com/SECRET_TOKEN',signingSecret:'PRIVATE_SIGNING_SECRET_1234567890123456',enabled:true,productIds:['p1'],now:NOW});
  preference(data,{channel:'webhook',mode:'immediate',integrationId:integration.id});enqueueDueNotifications(data,owner,{now:NOW});
  const publicData=JSON.stringify(publicNotifications(data,owner)),backup=JSON.stringify(filterWorkspaceState(data,owner,planFor(data)));
  for(const value of [publicData,backup])for(const secret of ['SECRET_TOKEN','PRIVATE_SIGNING_SECRET','secret','idempotencyKey','recipient'])assert(!value.includes(secret));
});

test('destination checks reject private, loopback, ambiguous IP and credentialed endpoints',async()=>{
  for(const value of ['http://example.com/hook','https://localhost/hook','https://127.0.0.1/hook','https://2130706433/hook','https://[::1]/hook','https://[::ffff:127.0.0.1]/hook','https://10.0.0.1/hook','https://169.254.169.254/latest','https://user:pass@example.com/hook','https://example.com:8443/hook','https://host.internal/hook'])assert.throws(()=>validateIntegrationURL(value));
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);assert.equal(publicAddress('2001:db8::1'),false);
  await assert.rejects(resolvePublicDestination('https://example.com/hook',{resolver:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]}),e=>e.code==='destination_not_public');
  assert.throws(()=>validateIntegrationURL('https://evil.example.com/services/a/b','slack'));
});
test('Resend uses fixed HTTPS endpoint and identical idempotent body after retry despite source edits',async()=>{
  const data=fixture(),{job}=queued(data),store=memory(data),calls=[];let time=NOW;
  const adapters=createDeliveryAdapters({env,resolver,request:async input=>{calls.push(input);return calls.length===1?{status:503,body:''}:{status:200,body:JSON.stringify({id:'resend-receipt'})};}});
  assert.equal((await deliverNotification(store,{principal:owner,id:job.id,adapters,now:()=>time})).status,'retry');
  store.data.items[0].snippet='Changed source after dispatch';time+=61000;
  assert.equal((await deliverNotification(store,{principal:owner,id:job.id,adapters,now:()=>time})).status,'sent');
  assert.equal(calls[0].endpoint,'https://api.resend.com/emails');assert.equal(calls[0].address,'8.8.8.8');assert.equal(calls[0].body,calls[1].body);assert.equal(calls[0].headers['Idempotency-Key'],calls[1].headers['Idempotency-Key']);assert.equal(calls[0].headers.Authorization,'Bearer fixture-server-secret');
  assert(!JSON.stringify(store.data).includes('fixture-server-secret'));assert(!calls[0].body.includes('PRIVATE NOTE'));assert(!calls[0].body.includes('PRIVATE DRAFT'));
});
test('disabled adapters do not claim or send and recipient revocation during DNS preparation prevents dispatch',async()=>{
  const data=fixture(),{job}=queued(data,{principal:bob}),store=memory(data);let calls=0;
  const off=createDeliveryAdapters({env:{},resolver,request:async()=>{calls++;}});assert.equal((await deliverNotification(store,{principal:bob,id:job.id,adapters:off,now:NOW})).status,'unconfigured');assert.equal(store.data.notificationOutbox.jobs[job.id].attempts,0);
  const adapters=createDeliveryAdapters({env,resolver:async()=>{store.data.workspace.members.bob.status='revoked';return resolver();},request:async()=>{calls++;return {status:200,body:'{}'};}});
  const result=await deliverNotification(store,{principal:bob,id:job.id,adapters,now:NOW});assert.equal(result.status,'failed');assert.equal(calls,0);
});
test('webhooks never follow redirects and uncertain non-idempotent dispatches are not retried',async()=>{
  for(const response of [{status:302,headers:{location:'http://127.0.0.1'},body:''},{status:503,body:''},null]) {
    const data=fixture(),{job}=queued(data,{channel:'webhook'}),store=memory(data);let calls=0;
    const adapters=createDeliveryAdapters({env,resolver,request:async()=>{calls++;if(!response)throw new Error('timeout');return response;}});
    const result=await deliverNotification(store,{principal:owner,id:job.id,adapters,now:NOW});assert.equal(result.status,response?.status===302?'failed':'uncertain');
    assert.equal((await deliverNotification(store,{principal:owner,id:job.id,adapters,now:NOW+100000})).status,'not_due');assert.equal(calls,1);
  }
});
test('known rate-limit rejection backs off safely without changing delivery identity',async()=>{
  const data=fixture(),{job}=queued(data,{channel:'slack'}),store=memory(data),adapters=createDeliveryAdapters({env,resolver,request:async()=>({status:429,headers:{'retry-after':'120'},body:''})});
  const result=await deliverNotification(store,{principal:owner,id:job.id,adapters,now:NOW});assert.equal(result.status,'retry');assert.equal(Date.parse(result.nextAttemptAt),NOW+120000);assert.equal((await deliverNotification(store,{principal:owner,id:job.id,adapters,now:NOW+100000})).status,'not_due');
});

test('Team reports are product/client/date scoped, source attributed and separate from backups',()=>{
  const data=fixture();data.items.push({...data.items[0],id:'alias',url:data.items[0].url+'?ref=copy'},{...data.items[0],id:'undated',publishedAt:null,url:'https://example.com/undated'});
  const report=buildReport(data,bob,{clientId:'c1',from:'2026-10-08',to:'2026-10-10',now:NOW});assert.equal(report.rows.length,1);assert.equal(report.counts.duplicates,1);assert.equal(report.counts.excludedUndated,1);assert.equal(report.rows[0].text,'Original source words');assert.equal(report.rows[0].conversationId,'one');assert.equal(report.rows[0].author,'alice');assert.equal(report.scope.endExclusive,true);
  const output=reportJSON(report);assert(!output.includes('PRIVATE'));assert(!output.includes('Client two'));assert(!output.includes('ROI'));
  assert.throws(()=>buildReport(data,bob,{productIds:['p2'],from:'2026-10-08',to:'2026-10-10'}),e=>e.status===404);
  assert.throws(()=>buildReport(fixture('growth'),owner,{productIds:['p1'],from:'2026-10-08',to:'2026-10-10'}),e=>e.code==='feature_unavailable');
});
test('CSV preserves quotes/newlines while neutralizing spreadsheet formulas and controls',()=>{
  for(const value of ['=SUM(1,1)','+cmd','-1+2','@SUM(A1)','  =1','\t=1','\r+1','\ufeff=1'])assert(csvCell(value).startsWith('"\''));
  assert.equal(csvCell('Original "quote"\nsecond line'),'"Original ""quote""\nsecond line"');
  const data=fixture();data.items[0].snippet='=HYPERLINK("https://evil.example")';const report=buildReport(data,owner,{productIds:['p1'],from:'2026-10-08',to:'2026-10-10'});assert(reportCSV(report).includes('"\'=HYPERLINK(""https://evil.example"")"'));assert.equal(JSON.parse(reportJSON(report)).rows[0].text,data.items[0].snippet);
});
test('canonical identities distinguish selected comments while deduplicating provider links',()=>{
  assert.equal(canonicalConversationKey({url:'https://twitter.com/user/status/123?utm_source=x'}),'x:123');
  assert.equal(canonicalConversationKey({url:'https://www.reddit.com/r/test/comments/abc/title/def/'}),'reddit:t1_def');
  assert.notEqual(canonicalConversationKey({url:'https://www.reddit.com/r/test/comments/abc/title/def/'}),canonicalConversationKey({url:'https://www.reddit.com/r/test/comments/abc/title/ghi/'}));
  assert.equal(canonicalConversationKey({url:'javascript:alert(1)'}),null);
});
test('daily digest catchup persists progress without invalidating already queued jobs',()=>{
  const data=fixture('starter');const pref=preference(data,{now:NOW-4*DAY});
  data.items.push({...data.items[0],id:'older',url:'https://www.reddit.com/r/example/comments/older/',foundAt:new Date(NOW-2*DAY-6*3600000).toISOString()});
  const jobs=enqueueDueNotifications(data,owner,{now:NOW});assert.equal(jobs.length,2);
  const restored=JSON.parse(JSON.stringify(data));assert.equal(enqueueDueNotifications(restored,owner,{now:NOW}).length,0);
  for(const job of jobs)assert(claimNotification(restored,owner,{id:job.id,now:NOW}));
  assert.equal(restored.notifications.preferences[pref.id].lastDigestWindowEnd,'2026-10-09T08:00:00.000Z');
});
test('client routing cannot use another client integration and endpoint changes invalidate queued jobs',()=>{
  const data=fixture(),integration=saveIntegration(data,owner,{channel:'webhook',name:'Client one',url:'https://example.com/one',enabled:true,clientId:'c1',productIds:['p1'],now:NOW});
  assert.throws(()=>preference(data,{channel:'webhook',mode:'immediate',clientId:'c2',productIds:['p2'],integrationId:integration.id}),e=>e.code==='integration_scope');
  const pref=preference(data,{channel:'webhook',mode:'immediate',clientId:'c1',integrationId:integration.id});const job=enqueueNotification(data,owner,{preferenceId:pref.id,itemIds:['one'],now:NOW});
  saveIntegration(data,owner,{id:integration.id,channel:'webhook',name:'New destination',url:'https://example.com/two',enabled:true,clientId:'c1',productIds:['p1'],now:NOW});assert.throws(()=>claimNotification(data,owner,{id:job.id,now:NOW}),e=>e.code==='notification_changed');
});
test('Slack escapes source mention syntax and a generic webhook can sign its exact body',async()=>{
  const data=fixture(),{job}=queued(data,{channel:'slack'});data.items[0].snippet='Original <!here> <@U123> & source';const calls=[],store=memory(data);
  await deliverNotification(store,{principal:owner,id:job.id,now:NOW,adapters:createDeliveryAdapters({env,resolver,request:async input=>{calls.push(input);return {status:200,body:'ok'};}})});
  const slack=JSON.parse(calls[0].body);assert(slack.text.includes('&lt;!here&gt;'));assert(!slack.text.includes('<@'));assert.equal(slack.unfurl_links,false);
  const other=fixture(),integration=saveIntegration(other,owner,{channel:'webhook',name:'Signed',url:'https://example.com/hook',signingSecret:'test-signing-secret-at-least-32-characters',enabled:true,productIds:['p1'],now:NOW}),pref=preference(other,{channel:'webhook',mode:'immediate',integrationId:integration.id});const queuedJob=enqueueNotification(other,owner,{preferenceId:pref.id,itemIds:['one'],now:NOW});
  await deliverNotification(memory(other),{principal:owner,id:queuedJob.id,now:NOW,adapters:createDeliveryAdapters({env,resolver,request:async input=>{assert.match(input.headers['X-HearWhispers-Signature'],/^sha256=[0-9a-f]{64}$/);assert.equal(input.headers.Authorization,undefined);return {status:204,body:''};}})});
});
test('report counts distinguish unique source conversations from multiple product matches',()=>{
  const data=fixture();data.items=[data.items[0],{...data.items[0],id:'same-source-other-product',productId:'p2'}];
  const report=buildReport(data,owner,{productIds:['p1','p2'],from:'2026-10-08',to:'2026-10-10'});assert.equal(report.rows.length,2);assert.equal(report.counts.conversations,1);assert.equal(report.counts.productMatches,2);assert.equal(report.counts.sources.Reddit,1);
});
test('notification summaries bound message size without changing retained evidence or report text',async()=>{
  const data=fixture();data.items[0].snippet='Original long source '.repeat(3000);const {job}=queued(data,{channel:'webhook'}),store=memory(data);let payload;
  await deliverNotification(store,{principal:owner,id:job.id,now:NOW,adapters:createDeliveryAdapters({env,resolver,request:async input=>{payload=JSON.parse(input.body);return {status:204,body:''};}})});
  assert.equal(payload.totalConversations,1);assert.equal(payload.rows[0].text.length,2000);assert.equal(payload.rows[0].textIsExcerpt,true);assert.equal(store.data.items[0].snippet,data.items[0].snippet);
  assert.equal(buildReport(store.data,owner,{productIds:['p1'],from:'2026-10-08',to:'2026-10-10'}).rows[0].text,data.items[0].snippet);
});
