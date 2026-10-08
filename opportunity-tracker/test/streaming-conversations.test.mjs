import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createTrackerApp} from '../server.mjs';
import {captureEvidence,pendingEvidenceCount,qualificationDue,qualificationInputHash} from '../conversation-evidence.mjs';
import {conversationCurrentState} from '../conversation-feed.mjs';
import {collectionSettings} from '../collection.mjs';
import {discoveryProgress} from '../discovery-progress.mjs';
import {budgetDay,qualificationSettings} from '../qualification.mjs';
import {feedProgress} from '../ui/src/progress.mjs';
import {matchesConversation} from '../ui/src/feed.mjs';
import {v2Business,conversations,stageValue,pipelineProvider} from './pipeline.fixture.mjs';

const env={TRACKER_AI_ENABLED:'true',TRACKER_AI_MODE:'ongoing',TRACKER_AI_DAILY_BUDGET_USD:'2',TRACKER_OPENAI_API_KEY:'fixture',TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'streaming-conversations-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const app=createTrackerApp({dataDirectory:dir,qualificationEnv:env,stageProvider:pipelineProvider()});
 const saved=app.store.saveProduct(v2Business());await app.runStage(saved.id,'search_plan');
 app.store.saveSearchPlan(saved.id,{...app.store.snapshot().pipelineStages[saved.id].search_plan.data,reviewed:true},'v2');
 return {...app,p:app.store.snapshot().products[0]};
}
const rows=(n,start=0)=>Array.from({length:n},(_,i)=>({...conversations()[(i+start)%4],url:`https://www.reddit.com/r/vancouver/comments/stream${i+start}/`,postId:`t3_stream${i+start}`,sourceId:`t3_stream${i+start}`,author:`person_${i+start}`}));
const search=(f,rs,at=Date.now())=>f.store.recordSearch(f.p.id,{semantic:true,items:[],candidates:rs,sources:[],searchedAt:new Date(at).toISOString()});
const review=(f,now)=>{const claim=f.store.claimStage(f.p.id,'qualify',null,false,now);return f.store.finishStage(claim.lease,{value:stageValue('qualify',claim.input),model:'fixture-sol'},now+1);};

test('a completed batch reaches the customer while the backfill is still running',async t=>{
 const f=await fixture(t),now=Date.now();f.store.beginBackfill(f.p.id,now);const initial=rows(35);initial[3].title=f.p.name+' lunch delivery is frustrating';search(f,initial,now);review(f,now+1);
 assert.equal(f.store.snapshot().collection.backfills[f.p.id].status,'running');
 const server=f.app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const state=await (await fetch(`http://127.0.0.1:${server.address().port}/api/state`)).json();
 assert.equal(state.pipeline.products[f.p.id].pending,23);assert.equal(state.discovery[f.p.id].phase,'finding');
 assert.equal(state.items.filter(i=>matchesConversation(i)).length,12);
 assert(state.items.some(i=>i.kind==='conversation'&&i.currentConversationRelevant&&!i.currentOpportunityFit));
 const status=feedProgress(state,[f.p],now+1);assert.match(status.message,/12 conversations ready to review · Finding more conversations/);
});

test('queue preserves in-flight rows past the 120-record sample and receipts avoid duplicate review',async t=>{
 const f=await fixture(t),now=Date.now(),initial=rows(100);search(f,initial,now);
 const claim=f.store.claimStage(f.p.id,'qualify',null,false,now);search(f,rows(50,100),now+1);
 assert.equal(f.store.snapshot().conversationEvidence[f.p.id].length,120);
 assert.equal(pendingEvidenceCount(f.store.snapshot(),f.p),150);
 f.store.finishStage(claim.lease,{value:stageValue('qualify',claim.input),model:'fixture'},now+2);
 for(let i=0;i<12;i++)review(f,now+3+i);
 assert.equal(pendingEvidenceCount(f.store.snapshot(),f.p),0);assert.equal(f.store.snapshot().items.length,150);
 const earliest=claim.input.evidence[0],item=f.store.snapshot().items.find(i=>i.url===earliest.url);f.store.updateItem(item.id,{status:'saved',note:'Keep my note',draft:'Unsent text'});
 search(f,rows(120,150),now+20);for(let i=0;i<10;i++)review(f,now+21+i);
 assert.equal(f.store.snapshot().conversationEvidence[f.p.id].some(r=>r.id===earliest.id),false);
 assert.equal(conversationCurrentState(f.store.snapshot(),f.store.snapshot().items.find(i=>i.id===item.id)).currentConversationRelevant,true);
 search(f,[initial.find(r=>r.url===earliest.url)],now+30);assert.equal(pendingEvidenceCount(f.store.snapshot(),f.p),0);
 search(f,[{...initial.find(r=>r.url===earliest.url),snippet:'I now want delivery instead.'}],now+31);
 assert.equal(pendingEvidenceCount(f.store.snapshot(),f.p),1);
 assert.equal(conversationCurrentState(f.store.snapshot(),f.store.snapshot().items.find(i=>i.id===item.id)).currentConversationRelevant,false);
 const pending=f.store.claimStage(f.p.id,'qualify',null,false,now+32),value=stageValue('qualify',pending.input);
 value.results[0]={...value.results[0],relevant:false,directFit:false,offeringIds:[],purposes:[],need:'',quote:'',reason:'This changed source is no longer relevant.'};
 f.store.finishStage(pending.lease,{value,model:'fixture'},now+33);
 const saved=f.store.snapshot().items.find(i=>i.id===item.id);
 assert.equal(saved.note,'Keep my note');assert.equal(saved.draft,'Unsent text');assert.equal(saved.status,'saved');
 assert.equal(matchesConversation({...saved,...conversationCurrentState(f.store.snapshot(),saved)}),false);
 assert.equal(matchesConversation(saved,{view:'saved'}),true);
});

test('collection pauses before another paid page when reviews fall behind, then resumes after a batch',async t=>{
 const f=await fixture(t),now=Date.now();f.store.beginCollection(f.p.id,'manual',now);search(f,rows(60),now);
 const before=f.store.snapshot().collection.cycles[f.p.id].queue.length;
 assert.equal(f.store.claimCollection(collectionSettings(env),f.p.id,now+1),null);
 const paused=f.store.snapshot();assert.equal(paused.collection.cycles[f.p.id].blocked,'awaiting_ai_review');
 assert.equal(paused.collection.cycles[f.p.id].queue.length,before);assert.deepEqual(paused.collection.daily,{});
 review(f,now+2);const claim=f.store.claimCollection(collectionSettings(env),f.p.id,now+3);assert(claim?.token);
 assert.equal(claim.reserve,102);assert.equal(f.store.snapshot().collection.cycles[f.p.id].blocked,undefined);
});

test('automatic review waits for a batch or a short timeout, and flushes the tail of a one-off job',async t=>{
 const f=await fixture(t),now=Date.now();f.store.beginCollection(f.p.id,'manual',now);search(f,rows(5),now);
 assert.equal(qualificationDue(f.store.snapshot(),f.p,now+59000),false);
 assert.equal(qualificationDue(f.store.snapshot(),f.p,now+60000),true);
 await f.runQualification();assert.equal(f.store.snapshot().items.length,0);
 const next=f.store.snapshot();next.products[0].monitoring=false;next.collection.cycles[f.p.id].status='complete';f.store.commit(next);
 assert.equal(qualificationDue(f.store.snapshot(),f.p,now+1),true);
 await f.runQualification();assert.equal(f.store.snapshot().items.length,5);
 assert.equal(pendingEvidenceCount(f.store.snapshot(),f.p),0);
});

test('status stays active for unfinished review, shows real allowance pauses, and finishes without backend jargon',async t=>{
 const f=await fixture(t),now=Date.now();search(f,rows(5),now);
 const settings=qualificationSettings(env),s=f.store.snapshot();s.collection={cycles:{[f.p.id]:{status:'complete',finishedAt:new Date(now).toISOString()}},backfills:{}};
 assert.equal(discoveryProgress(s,f.p,{settings,now}).phase,'finding');
 s.aiBudget={dailyUsage:{[budgetDay(now)]:{calls:1,spentMicroUsd:1999999,reservedMicroUsd:0}}};
 const pause=discoveryProgress(s,f.p,{settings,now});assert.equal(pause.phase,'paused');assert.equal(pause.reason,'allowance');
 let ui=feedProgress({items:[],discovery:{[f.p.id]:pause}},[f.p],now);assert.equal(ui.message,'Updates paused until tomorrow.');
 s.aiBudget.dailyUsage[budgetDay(now)].spentMicroUsd=0;s.analysisUsage={[budgetDay(now)]:40};
 assert.equal(discoveryProgress(s,f.p,{settings,now}).phase,'finding');
 s.aiBudget.dailyUsage[budgetDay(now)].calls=settings.dailyMaxCalls;assert.equal(discoveryProgress(s,f.p,{settings,now}).reason,'allowance');
 review(f,now+1);const complete=f.store.snapshot();complete.collection=s.collection;
 const done=discoveryProgress(complete,f.p,{settings,now:now+10});assert.equal(done.phase,'idle');
 ui=feedProgress({items:complete.items.map(i=>({...i,...conversationCurrentState(complete,i)})),discovery:{[f.p.id]:done}},[f.p],now+10);
 assert.equal(ui.message,'Updated just now.');assert(!/scrap|qualif|model|backend/i.test(ui.message));
 assert.match(feedProgress({items:[],discovery:{[f.p.id]:done}},[f.p],now+600000).message,/Updated /);
});

test('shared sample eviction preserves the other business’s queue and product deletion clears it',async t=>{
 const f=await fixture(t),at=new Date().toISOString(),data=f.store.snapshot();
 for(let n=0;n<6;n++){
  const p={...structuredClone(f.p),id:`business${n}`};data.products.push(p);
  data.conversationEvidence ||= {};data.conversationEvidence[p.id]=[];
  if(n<5)captureEvidence(data,p,rows(100,n*100),at);
 }
 const p=data.products.find(p=>p.id==='business5');captureEvidence(data,p,rows(100,500),at);
 assert.equal(Object.values(data.conversationEvidence).flat().length,600);
 assert.equal(Object.values(data.conversationReviewQueue).flat().length,600);
 assert.throws(()=>captureEvidence(data,p,rows(1,999),at),/catching up/);
 f.store.commit(data);f.store.deleteProduct(p.id);
 assert.equal(f.store.snapshot().conversationReviewQueue[p.id],undefined);
});
