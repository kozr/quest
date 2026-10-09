import test from 'node:test';
import assert from 'node:assert/strict';
import {cafe,breakdown} from './business-profile.fixture.mjs';
import {validateSearchPlan} from '../search-plan.mjs';
import {beginCollection,claimCollection,finishCollection,collectionPlanState,collectionDueIds,collectionSettings,beginBackfill,createCollectionProvider} from '../collection.mjs';
import {createBackfill} from '../backfill.mjs';
import {dueSources,startLocalMonitoring} from '../monitor.mjs';
import {monitorCycle} from '../reddit/monitor-worker.mjs';
import {budgetDay} from '../qualification.mjs';
const now=Date.parse('2026-10-09T12:00:00Z'),minute=60000,day=86400000;
const settings=collectionSettings({TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'});
const empty={credits:1,result:{rows:[],cursor:null,oldest:null}};
function workspace({planId='team',loops=['keyword','long_tail'],platforms=['reddit'],modern=true}={}){
  let p={...cafe,id:'p',monitoring:true,x:platforms.includes('x'),instagram:platforms.includes('instagram'),tiktok:platforms.includes('tiktok')};
  p={...p,profileVersion:'v2',businessProfileV2:{...breakdown(p),reviewed:true}};
  const queries=loops.flatMap(loop=>platforms.map(platform=>({id:`${loop}_${platform}`,loop,platform,query:`${loop} sandwich ${platform}`,community:platform==='reddit'?'vancouver':null})));
  p.searchPlanV2={...validateSearchPlan({themes:[{id:'lunch',title:'Lunch',need:'Find lunch nearby',purposes:['potential_customer'],offeringIds:['o1'],keywords:['sandwich'],longTail:[],queries}],limitations:[]},p),reviewed:true};p.listeningVersion='v2';
  return {products:[p],items:[],searches:{},...(modern?{subscription:{planId,status:'manual'}}:{})};
}
function complete(data,at){const claim=claimCollection(data,settings,'p',at);assert(claim?.token);finishCollection(data,claim.token,structuredClone(empty),at+1);return claim;}
for(const [planId,minutes,tailMinutes] of [['starter',60,1440],['growth',15,360],['team',5,60]])test(`${planId}: manual and scheduled collection respect independent exact boundaries`,()=>{
  const data=workspace({planId});beginCollection(data,'p','scheduled',now,settings);complete(data,now);complete(data,now+15000);
  assert.equal(beginCollection(data,'p','manual',now+minutes*minute-1,settings),null);
  assert.deepEqual(dueSources(data.products[0],data,now+minutes*minute),['reddit']);
  const cycle=beginCollection(data,'p','manual',now+minutes*minute,settings);assert.deepEqual(cycle.queue.map(t=>t.queryFamily),['keyword']);
  assert.equal(Date.parse(data.loopSchedules.p.long_tail.nextRunAt),now+tailMinutes*minute);
});
test('a due keyword family joins unfinished long-tail work without replaying its prior run',()=>{
  const data=workspace();const first=beginCollection(data,'p','scheduled',now,settings),tail=first.familyRuns.long_tail.id;complete(data,now);
  const next=beginCollection(data,'p','scheduled',now+5*minute,settings);assert.equal(next.id,first.id);assert.equal(next.familyRuns.long_tail.id,tail);
  assert.notEqual(next.familyRuns.keyword.id,first.familyRuns.keyword.id);assert.deepEqual(next.queue.map(t=>t.queryFamily),['keyword','long_tail']);
  const again=beginCollection(data,'p','scheduled',now+5*minute,settings);assert.equal(again.queue.length,2);
});
test('long-tail-only plans never claim a keyword loop',()=>{
  const data=workspace({loops:['long_tail']});const cycle=beginCollection(data,'p','scheduled',now,settings);assert.equal(cycle.queue.length,1);assert.equal(cycle.queue[0].queryFamily,'long_tail');assert.equal(data.loopSchedules.p.keyword,undefined);
});
test('paid Reddit freshness does not bypass daily TikTok/Instagram source floors',()=>{
  const data=workspace({loops:['keyword'],platforms:['reddit','tiktok','instagram']});const apify={...settings,instagramSearchEnabled:true,apifyDailyLimitMicroUsd:500000};
  beginCollection(data,'p','scheduled',now,apify);
  for(let i=0;i<3;i++){const claim=claimCollection(data,apify,'p',now+i*15000);assert(claim);finishCollection(data,claim.token,structuredClone(empty),now+i*15000+1);}
  assert.deepEqual(collectionPlanState(data,'p',now+5*minute)[0].sources,['reddit']);
  const next=beginCollection(data,'p','manual',now+5*minute,apify);assert.deepEqual(next.queue.map(t=>t.kind),['search']);
  assert(!collectionPlanState(data,'p',now+day+29999)[0].sources.includes('instagram'));assert(collectionPlanState(data,'p',now+day+30000)[0].sources.includes('instagram'));
});
test('pause, downgrade blocks, and cancellation preserve queues and prevent dispatch',()=>{
  const data=workspace();beginCollection(data,'p','scheduled',now,settings);const queue=structuredClone(data.collection.cycles.p.queue);
  data.products[0].planMonitoringBlocked='plan_capacity';assert.equal(claimCollection(data,settings,'p',now),null);assert.deepEqual(collectionDueIds(data,now),[]);assert.deepEqual(data.collection.cycles.p.queue,queue);assert.deepEqual(dueSources(data.products[0],data,now),[]);
  delete data.products[0].planMonitoringBlocked;data.products[0].monitoring=false;assert.equal(claimCollection(data,settings,'p',now),null);assert.deepEqual(data.collection.cycles.p.queue,queue);
  data.products[0].monitoring=true;data.subscription.status='cancelled';assert.equal(claimCollection(data,settings,'p',now),null);assert.deepEqual(data.collection.cycles.p.queue,queue);
  data.subscription.status='manual';assert(claimCollection(data,settings,'p',now));
});
test('expired provider request is charged conservatively and never replayed',()=>{
  const data=workspace();beginCollection(data,'p','scheduled',now,settings);const first=claimCollection(data,settings,'p',now),second=claimCollection(data,settings,'p',now+45001);
  assert.equal(first.task.queryFamily,'keyword');assert.equal(second.task.queryFamily,'long_tail');assert.equal(data.collection.daily[budgetDay(now)].uncertainCredits,102);
  assert.equal(finishCollection(data,first.token,structuredClone(empty),now+46000),null);
});
test('monthly cadence work survives provider daily budgets without spending or losing tasks',()=>{
  const data=workspace();beginCollection(data,'p','scheduled',now,settings);assert.equal(claimCollection(data,{...settings,dailyCreditLimit:0},'p',now),null);assert.equal(data.collection.cycles.p.queue.length,2);assert.equal(data.collection.cycles.p.blocked,'daily_scraper_budget');
  assert(claimCollection(data,settings,'p',now+day));
  const instagram=workspace({loops:['keyword'],platforms:['instagram']}),blocked={...settings,instagramSearchEnabled:true,apifyDailyLimitMicroUsd:0};beginCollection(instagram,'p','scheduled',now,blocked);
  assert.equal(claimCollection(instagram,blocked,'p',now),null);assert.equal(instagram.collection.cycles.p.queue.length,1);
  const resumed=claimCollection(instagram,{...blocked,apifyDailyLimitMicroUsd:500000},'p',now+day);assert(resumed?.token);finishCollection(instagram,resumed.token,structuredClone(empty),now+day+1);assert.equal(beginCollection(instagram,'p','manual',now+day+2,blocked),null,'A delayed daily dispatch starts the actual source freshness floor');
});
test('old account-mode cache entries cannot masquerade as a fresh five-minute keyword run',()=>{
  const data=workspace({loops:['keyword']});beginCollection(data,'p','scheduled',now,settings);const first=complete(data,now);
  beginCollection(data,'p','scheduled',now+5*minute,settings);const next=claimCollection(data,settings,'p',now+5*minute);assert(next.token);assert.notEqual(next.token,first.token);assert.equal(next.cached,undefined);
});
test('past-year jobs retain trusted backfill identities across profile replacement',()=>{
  const data=workspace();const first=beginBackfill(data,'p',now);assert.equal(data.collection.backfillRuns[first.id].productId,'p');assert.equal(Date.parse(first.from),now-365*day);assert(first.branches.some(b=>b.queryFamily==='long_tail'));
  data.collection.backfills.p.status='complete';const second=createBackfill(data,data.products[0],[],'newprofile',now+1);assert.notEqual(second.id,first.id);assert(data.collection.backfillRuns[first.id]);assert(data.collection.backfillRuns[second.id]);
});
test('local account monitor delegates to the workspace runner',async()=>{
  let calls=0;const stop=startLocalMonitoring({store:{snapshot(){throw Error('Wrong global store');}},runWorkspaceTick:async()=>{calls++;},interval:60000});await new Promise(resolve=>setImmediate(resolve));stop();assert.equal(calls,1);
});
test('monitor worker isolates workspaces and delivers notifications only when opted in',async()=>{
  const calls=[];const fetchImpl=async(url,options)=>{calls.push({path:url.pathname,...options});if(url.pathname==='/api/monitor/workspaces')return Response.json({ids:['w1','w2'],accountMode:true});const workspace=options.headers['X-Workspace-ID'];assert(['w1','w2'].includes(workspace));if(url.pathname==='/api/monitor')return Response.json({ids:['sameProduct'],qualifications:{available:true},notifications:{available:workspace==='w1'}});if(url.pathname==='/api/monitor/qualifications')return Response.json({status:'complete'});return Response.json({status:'ok'});};
  const results=await monitorCycle({baseURL:'https://example.com/',token:'a'.repeat(32),fetchImpl});assert.equal(results.filter(row=>row.id==='sameProduct').length,2);assert.equal(results.filter(row=>row.id==='notifications').length,1);assert.equal(results.find(row=>row.id==='notifications').workspaceId,'w1');assert.equal(calls.filter(row=>row.method==='POST').length,5);
});
test('monitor worker rejects an invalid workspace directory before sending any mutation',async()=>{
  let calls=0;await assert.rejects(monitorCycle({baseURL:'https://example.com/',token:'a'.repeat(32),fetchImpl:async()=>{calls++;return Response.json({ids:['../other'],accountMode:true});}}),/Invalid workspace/);assert.equal(calls,1);
});
test('monitor worker remains compatible with a legacy server without a workspace route',async()=>{
  const results=await monitorCycle({baseURL:'https://example.com/',token:'a'.repeat(32),fetchImpl:async url=>url.pathname==='/api/monitor/workspaces'?new Response('',{status:404}):url.pathname==='/api/monitor'?Response.json({ids:['p']}):new Response('',{status:200})});assert.deepEqual(results,[{id:'p',status:200}]);
});
test('regular source rows are immediately editable and retain full text before analysis',()=>{
  const data=workspace({loops:['keyword']}),snippet='Source text '.repeat(1600);beginCollection(data,'p','scheduled',now,settings);const request=claimCollection(data,settings,'p',now);
  finishCollection(data,request.token,{credits:1,result:{rows:[{source:'Reddit',sourceId:'t3_a',postId:'t3_a',type:'post',url:'https://www.reddit.com/r/vancouver/comments/a/',title:'Lunch nearby',snippet,author:'author',publishedAt:new Date(now-1000).toISOString(),commentCount:0}],cursor:null}},now+1);
  assert.equal(data.items.length,1);assert.equal(data.items[0].snippet,snippet);assert.equal(data.items[0].analysisStatus,'awaiting_analysis');assert.equal(data.items[0].qualification,undefined);assert.equal(data.items[0].queryFamilies[0],'keyword');
});
test('collection provider forwards preserveText into Reddit normalization without changing legacy clips',async()=>{
  const selftext='Full source '.repeat(1500),body={posts:[{id:'a',subreddit:'vancouver',created_utc:Math.floor(Date.now()/1000)-1,title:'Lunch nearby',selftext,archived:false,locked:false,author:'author'}]};
  const provider=createCollectionProvider({env:{SCRAPEBADGER_API_KEY:'fixture'},fetchImpl:async()=>Response.json(body)});
  const request={url:'https://scrapebadger.com/v1/reddit/search/posts',task:{kind:'search',name:'vancouver'}};
  const modern=await provider.fetchPage({...request,preserveText:true}),legacy=await provider.fetchPage(request);assert.equal(modern.result.rows[0].snippet,selftext);assert.equal(legacy.result.rows[0].snippet.length,10000);
});

test('interleaved products independently advance live keywords and historical search',()=>{
  const data=workspace(),second=structuredClone(data.products[0]);second.id='second';data.products.push(second);
  for(const id of ['p','second']){beginCollection(data,id,'scheduled',now,settings);beginBackfill(data,id,now);}
  data.collection.lastMode='regular'; // A legacy global cursor must not change either product’s first live turn.
  const modes={p:[],second:[]};
  for(let turn=0;turn<8;turn++){
    const id=turn%2?'second':'p',at=now+turn*15000;
    const claim=claimCollection(data,settings,id,at);assert(claim?.token);
    modes[id].push(claim.mode);
    if(modes[id].length===1)assert.equal(claim.task.queryFamily,'keyword');
    finishCollection(data,claim.token,structuredClone(empty),at+1);
  }
  assert.deepEqual(modes,{p:['regular','backfill','regular','backfill'],second:['regular','backfill','regular','backfill']});
  assert.deepEqual(data.collection.lastModes,{p:'backfill',second:'backfill'});
  for(const id of ['p','second'])assert.equal(data.collection.backfills[id].requests,2);
});


test('new keyword runs cannot starve an existing long-tail queue; both families retain FIFO',()=>{
  const data=workspace({planId:'growth'});const initial=beginCollection(data,'p','scheduled',now,settings),cycle=data.collection.cycles.p;
  const keyword=cycle.queue.find(task=>task.queryFamily==='keyword'),tail=cycle.queue.find(task=>task.queryFamily==='long_tail');
  cycle.queue=[...Array.from({length:3},(_,i)=>({...keyword,query:`keyword ${i}`,queryId:`k${i}`})),...Array.from({length:3},(_,i)=>({...tail,query:`long tail ${i}`,queryId:`t${i}`}))];
  const claims=[];
  for(let i=0;i<6;i++){
    // Simulate a slow worker: a fresh keyword run is due before the old tail drains.
    const at=now+i*16*minute;beginCollection(data,'p','scheduled',at,settings);
    claims.push(complete(data,at).task);
  }
  assert.deepEqual(claims.map(task=>task.queryFamily),['keyword','long_tail','keyword','long_tail','keyword','long_tail']);
  assert.deepEqual(claims.filter(task=>task.queryFamily==='long_tail').map(task=>task.queryId),['t0','t1','t2']);
  assert.deepEqual(claims.filter(task=>task.queryFamily==='keyword').map(task=>task.queryId),['k0','k1','k2']);
  assert(claims.filter(task=>task.queryFamily==='long_tail').every(task=>task.loopRunId===initial.familyRuns.long_tail.id));
  assert.equal(data.loopSchedules.p.long_tail.lastOutcome,'success');
  // More keyword work remains after the old long-tail family completed.
  assert(cycle.queue.some(task=>task.queryFamily==='keyword'));
});
