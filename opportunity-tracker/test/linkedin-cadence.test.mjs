import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dueSources, dueProducts, linkedinSlot} from '../monitor.mjs';
import {Store} from '../store.mjs';
import {discover} from '../discovery.mjs';
import {createTrackerApp} from '../server.mjs';

const morning = Date.parse('2026-10-05T15:00:00Z'); // 08:00 PDT
const evening = Date.parse('2026-10-06T03:00:00Z'); // 20:00 PDT
const product = {id:'cadence', name:'Figure Shelf', url:'https://figureshelf.dev', description:'Keep a record of your figure collection.',
  capabilities:['Keep track of the figures in your collection.'], needs:['Keep a record of the figures I own.'],
  keywords:['collection spreadsheet'], aliases:['Figure Shelf'], exclusions:['wholesale'], communities:['smiskis'], linkedin:true, monitoring:true};
const state = (p=product, searches={}) => ({products:[p], searches});
const row = (snippet, id=1) => ({source:'LinkedIn', provider:'linkedin-mcp', sourceId:`li_750725498299633254${id}`, type:'post',
  title:snippet, snippet, url:`https://www.linkedin.com/posts/demo-person_collection-share-750725498299633254${id}-AbCd`});
async function storeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'tracker-cadence-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const store = new Store(directory);
  const p = store.saveProduct(product, undefined);
  return {store,p,directory};
}

test('LinkedIn runs once per latest Pacific morning/evening slot while Reddit stays hourly', () => {
  const p = {...product, monitorAttempts:{reddit:new Date(morning).toISOString(), linkedin:new Date(morning).toISOString()}};
  assert.deepEqual(dueSources(p,state(p),morning+3599999),[]);
  assert.deepEqual(dueSources(p,state(p),morning+3600000),['reddit']);
  assert.deepEqual(dueSources(p,state(p),evening-1),['reddit']);
  assert.deepEqual(dueSources(p,state(p),evening),['reddit','linkedin']);
  assert.deepEqual(dueSources({...p,communities:[]},state(p),evening-1),[]);
  assert.deepEqual(dueProducts(state({...p,monitoring:false}),evening),[]);
  assert.equal(linkedinSlot(morning-1),'2026-10-04:20');
  assert.equal(linkedinSlot(morning),'2026-10-05:08');
  assert.equal(linkedinSlot(evening),'2026-10-05:20');
  assert.equal(linkedinSlot(evening+5*86400000),'2026-10-10:20');
});

test('Pacific slots retain 08:00 and 20:00 across spring/fall daylight-saving changes', () => {
  for (const [at,slot] of [
    ['2026-03-07T16:00:00Z','2026-03-07:08'], ['2026-03-08T15:00:00Z','2026-03-08:08'],
    ['2026-10-31T15:00:00Z','2026-10-31:08'], ['2026-11-01T16:00:00Z','2026-11-01:08'],
    ['2026-11-02T04:00:00Z','2026-11-01:20'],
  ]) assert.equal(linkedinSlot(Date.parse(at)),slot);
});

test('legacy receipts migrate by actual source and unrelated manual checks cannot reset LinkedIn', () => {
  const p = {...product,lastMonitorAttemptAt:new Date(morning).toISOString()};
  assert.deepEqual(dueSources(p,state(p,{cadence:{searchedAt:new Date(evening-60000).toISOString(),sources:[{name:'Reddit watchlist'}]}}),evening),['linkedin']);
  const searches={cadence:{searchedAt:new Date(morning).toISOString(),sources:[{name:'LinkedIn'}]}};
  assert.deepEqual(dueSources(product,state(product,searches),morning+60000),['reddit']);
  searches.cadence={searchedAt:new Date(evening).toISOString(),sources:[{name:'LinkedIn',checkedAt:new Date(morning).toISOString()},{name:'Reddit watchlist',checkedAt:new Date(evening).toISOString()}]};
  assert.deepEqual(dueSources(product,state(product,searches),evening),['linkedin']);
});

test('atomic per-source attempts back off failures and survive reload without disturbing saved decisions', async t => {
  const {store,p,directory}=await storeFixture(t);
  assert.deepEqual(store.markMonitorAttempt(p.id,morning).sources,['reddit','linkedin']);
  assert.equal(store.markMonitorAttempt(p.id,morning+60000),null);
  assert.deepEqual(store.markMonitorAttempt(p.id,morning+3600000).sources,['reddit']);
  const liAt=new Date(morning).toISOString(), redditAt=new Date(morning+3600000).toISOString();
  store.recordSearch(p.id,{searchedAt:liAt,sources:[{name:'LinkedIn',status:'ok',count:1}],items:[{...row('I keep forgetting which figures I own.'),kind:'opportunity'}]});
  const id=store.snapshot().items[0].id;
  store.updateItem(id,{status:'saved',note:'Keep this note.'});
  store.recordSearch(p.id,{searchedAt:redditAt,sources:[{name:'Reddit watchlist',status:'ok',count:0}],items:[]});
  let snapshot=new Store(directory).snapshot();
  assert.equal(snapshot.searches[p.id].sources.find(s=>s.name==='LinkedIn').checkedAt,liAt);
  assert.equal(snapshot.searches[p.id].lastChecks.linkedin,liAt);
  assert.equal(snapshot.products[0].monitorAttempts.linkedin,liAt);
  assert.deepEqual(store.markMonitorAttempt(p.id,evening).sources,['reddit','linkedin']);
  store.recordSearch(p.id,{searchedAt:new Date(evening).toISOString(),sources:[{name:'LinkedIn',status:'error',message:'Provider failed.'}],items:[]});
  snapshot=store.snapshot();
  assert.equal(snapshot.items[0].status,'saved'); assert.equal(snapshot.items[0].note,'Keep this note.');
  assert.equal(snapshot.searches[p.id].sources.find(s=>s.name==='Reddit watchlist').checkedAt,redditAt);
  assert(!dueSources(snapshot.products[0],snapshot,evening+60000).includes('linkedin'));
});

test('LinkedIn matches supported related wording and rejects promotion, unrelated needs, incidental context and exclusions', async () => {
  const rows=[row('I keep forgetting which figures I already own. Does anyone recommend a way to organize them?',1),
    row('Does anyone recommend an app to list the figures I own?',2),
    row('I finished my collection spreadsheet. I need to hire an engineer.',3),
    row('I need a buyer for the figures I own.',4), row('We launched a brilliant collection spreadsheet today!',5),
    row('I need to track my wholesale figure collection.',6), row('I need to improve the odds in blind boxes.',7),
    row('My collection spreadsheet is ready, but I need a better meal plan.',8), row('Figure Shelf helped with my collection.',9)];
  const result=await discover(product,{watchOnly:true,scheduledSources:['linkedin'],now:new Date(morning),linkedinAdapter:{search:async()=>({rows,coverage:{provider:'linkedin-mcp'}})}});
  assert.deepEqual(result.items.map(item=>item.sourceId).sort(),[rows[0].sourceId,rows[1].sourceId,rows[8].sourceId].sort());
  assert.equal(result.items.find(item=>item.sourceId===rows[0].sourceId).kind,'opportunity');
  assert.match(result.items.find(item=>item.sourceId===rows[0].sourceId).reason,/confirmed tracking profile/);
  assert.equal(result.items.find(item=>item.sourceId===rows[8].sourceId).kind,'mention');
  const unsupported=await discover({...product,capabilities:[],needs:[]},{watchOnly:true,scheduledSources:['linkedin'],now:new Date(morning),linkedinAdapter:{search:async()=>({rows:[rows[0]],coverage:{}})}});
  assert.equal(unsupported.items.length,0,'A name/description alone does not invent related capabilities');
  const unrelatedFeatures=await discover({...product,capabilities:['Browse a collection of furniture.','Track shipping progress.'],needs:[]},{watchOnly:true,scheduledSources:['linkedin'],now:new Date(morning),linkedinAdapter:{search:async()=>({rows:[rows[0]],coverage:{}})}});
  assert.equal(unrelatedFeatures.items.length,0,'Separate features cannot be joined into an invented collection-tracking capability');
});

test('retrieval rotates bounded context/name queries and scheduled Reddit checks never call LinkedIn', async () => {
  const calls=[];let redditCalls=0;
  const options={watchOnly:true,redditAdapter:{id:'redlib',list:async()=>{redditCalls++;return {rows:[],coverage:{}};}},linkedinAdapter:{search:async entry=>{calls.push(entry);return {rows:[],coverage:{}};}}};
  const reddit=await discover(product,{...options,scheduledSources:['reddit'],now:new Date(morning)});
  assert.equal(calls.length,0);assert.equal(redditCalls,1);assert.deepEqual(reddit.sources.map(s=>s.name),['Reddit watchlist']);
  const li=await discover(product,{...options,scheduledSources:['linkedin'],now:new Date(morning)});
  assert.equal(redditCalls,1);assert.equal(calls.length,2);assert.equal(li.items.length,0);assert.equal(li.sources[0].status,'ok');
  await discover(product,{...options,scheduledSources:['linkedin'],now:new Date(evening)});
  assert.equal(calls.length,4);assert.notEqual(calls[0].query,calls[2].query);
  assert([calls[0].query,calls[2].query].includes('collection checklist'));
  assert(calls.every(call=>call.limit===30&&[null,'past-month'].includes(call.datePosted)));
});

test('fatal provider failures wait for the next LinkedIn slot and manual discovery remains available', async t => {
  const {store,p,directory}=await storeFixture(t);
  const attempts=[];
  const tracker=createTrackerApp({store,dataDirectory:directory,discoverFn:async(_p,options)=>{attempts.push(options);throw Error('Provider unavailable');}});
  await assert.rejects(()=>tracker.runSearch(p.id,true),/Provider/);
  assert.equal(await tracker.runSearch(p.id,true),null);
  assert.equal(attempts.length,1);assert.deepEqual(attempts[0].scheduledSources,['reddit','linkedin']);
  await assert.rejects(()=>tracker.runSearch(p.id,false),/Provider/);
  assert.equal(attempts.length,2);assert.equal(attempts[1].scheduledSources,undefined);
  assert.equal(dueProducts(store.snapshot()).length,0);
});
