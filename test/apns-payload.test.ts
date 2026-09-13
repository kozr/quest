import test from 'node:test';
import assert from 'node:assert/strict';
import {pushPayload} from '../src/apns.js';
import type {ActivityEvent, Preferences} from '../src/types.js';
const preferences:Preferences={sales:true,refunds:true,lifecycle:true,sandbox:true,hideAmounts:false};
const event:ActivityEvent={id:'event',appId:'app',appName:'My App',kind:'sale',title:'New sale',detail:'',amountMilliunits:2990,currency:'USD',productId:'monthly',transactionId:'transaction',environment:'Production',occurredAt:'',receivedAt:'',notificationType:'SUBSCRIBED',subtype:null,isMonetary:true};
test('app artwork enables enrichment and preserves routing with compact copy',()=>{
 const payload=pushPayload(event,preferences,'https://is1-ssl.mzstatic.com/image/icon.png');
 assert.deepEqual(payload.aps,{alert:{title:'My App',body:'New sale · USD 2.99'},sound:'default','thread-id':'app','mutable-content':1});
 assert.equal(payload.appIconUrl,'https://is1-ssl.mzstatic.com/image/icon.png');
 assert.equal(payload.appId,'app');assert.equal(payload.eventId,'event');
});
test('missing or untrusted artwork keeps a plain alert',()=>{
 for(const icon of [null,'http://is1.mzstatic.com/icon.png','https://mzstatic.com.evil.test/icon.png','https://user:pass@is1.mzstatic.com/icon.png']) {
  const payload=pushPayload(event,preferences,icon);
  assert.equal(payload.appIconUrl,undefined);
  assert.equal((payload.aps as any)['mutable-content'],undefined);
 }
});
test('privacy and nonproduction labels remain visible with artwork',()=>{
 for(const environment of ['Demo','Sandbox'] as const){
  const payload=pushPayload({...event,environment,kind:'refund',title:'Refund'},{...preferences,hideAmounts:true},'https://is1.mzstatic.com/icon.png');
  assert.deepEqual((payload.aps as any).alert,{title:`[${environment}] My App`,body:'Refund'});
 }
 assert.equal(pushPayload(null,preferences,'https://is1.mzstatic.com/icon.png').appIconUrl,undefined);
});
