import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTrackerApp} from '../server.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {LocalRecordBackend} from '../record-backend.mjs';
import {Store} from '../store.mjs';
import {activatePilotBudget} from '../pilot-budget.mjs';

const product={id:'p',name:'Example',url:'https://example.com/',description:'A collector app',capabilities:['Track owned figures'],needs:['Track a collection'],keywords:['figure tracker'],aliases:['Example'],communities:['smiskis'],monitoring:true,x:false};
function backend(){let data={version:1,products:[product],items:Array.from({length:130},(_,i)=>({id:`i${i}`,productId:'p',kind:'conversation',status:'new',note:'',draft:'',title:'Example source',snippet:`An original Example mention ${i}.`,url:`https://www.reddit.com/r/smiskis/comments/post${i}/`,source:'Reddit',foundAt:'2026-10-09T12:00:00Z'})),searches:{},subscription:{planId:'growth',status:'manual'}},revision=0;data.conversationEvidence={p:data.items.map(item=>({...item,text:item.snippet,collectedAt:item.foundAt,contentHash:item.id}))};activatePilotBudget(data,{id:'test'});return {async read(){return {revision,data:structuredClone(data)};},async compareAndSwap(expected,next){if(expected!==revision)return false;data=structuredClone(next);revision++;return true;}};}

test('private record-storage opt-in migrates existing data without creating ownership or account routes',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'private-record-pilot-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const legacy=new Store(directory);legacy.commit({version:1,products:[product],items:[],searches:{},sentinel:'existing-private-data'});
  const tracker=createTrackerApp({dataDirectory:directory,qualificationEnv:{TRACKER_RECORD_STORAGE_ENABLED:'true'}});
  assert(tracker.store instanceof FirestoreStore);assert(tracker.store.backend instanceof LocalRecordBackend);
  const before=await tracker.store.snapshot();assert.equal(before.sentinel,'existing-private-data');assert.equal(before.workspace,undefined);assert.equal(before.subscription,undefined);
  await tracker.store.mutate(data=>{data.recordMigrationTest=true;});
  const after=(await new LocalRecordBackend(directory).read()).data;assert.equal(after.recordMigrationTest,true);assert.equal(after.workspace,undefined);assert.equal(after.sentinel,'existing-private-data');
});

test('private Growth state, complete mention paging and existing note edits work without account migration',async t=>{
  const store=new FirestoreStore(backend()),tracker=createTrackerApp({store,qualificationEnv:{TRACKER_RECORD_STORAGE_ENABLED:'true',TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'},monitorToken:'fixture-monitor-token-at-least-32-characters'});
  const server=tracker.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const state=await (await fetch(origin+'/api/state')).json();assert.equal(state.entitlements.id,'growth');assert.equal(state.entitlements.intervals.keyword,15*60000);assert.equal(state.conversationPaging,true);assert.equal(state.items.length,100);assert.equal(state.itemPage.total,130);assert.equal(state.account,undefined);assert.equal(state.pilotBudget.aiMicroUsd.limit,3000000);assert(state.schedules.p);
  assert.equal(state.monitoring.intervalMinutes,15);assert.equal(state.pipeline.products.p.retained,130);assert.equal(state.pipeline.products.p.conversations.length,50);assert.equal(state.collection.collectedUsage.monthly.used,130);
  const page=await (await fetch(origin+'/api/conversations?relevance=mentions&offset=100&limit=30')).json();assert.equal(page.total,130);assert.equal(page.items.length,30);assert(page.items.every(item=>item.keywordMention));
  const saved=await fetch(origin+`/api/items/${page.items[0].id}`,{method:'PATCH',headers:{'Content-Type':'application/json','X-Tracker-Token':state.token},body:JSON.stringify({note:'Preserved private review'})});assert.equal(saved.status,200);assert.equal((await saved.json()).item.note,'Preserved private review');
  for(const route of ['/api/workspaces','/api/account','/api/billing/checkout','/healthz'])assert.equal((await fetch(origin+route)).status,404);
  assert.equal((await fetch(origin+'/api/monitor')).status,401);
  const monitor=await fetch(origin+'/api/monitor',{headers:{Authorization:'Bearer fixture-monitor-token-at-least-32-characters'}});assert.equal(monitor.status,200);const monitoring=await monitor.json();assert.equal(monitoring.schedules.reddit.intervalMinutes,15);assert.equal(monitoring.schedules.x.intervalMinutes,15);assert.equal(monitoring.schedules.keyword.intervalMinutes,15);assert.equal(monitoring.schedules.long_tail.intervalMinutes,360);assert.equal(monitoring.schedules.analysis.intervalMinutes,60);
  assert.equal((await store.snapshot()).workspace,undefined);
});
