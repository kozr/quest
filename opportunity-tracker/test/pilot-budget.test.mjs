import test from 'node:test';
import assert from 'node:assert/strict';
import {activatePilotBudget,pilotBudgetState,pilotBudgetBlock,assertPilotBudget} from '../pilot-budget.mjs';
import {reserveAnalysis,settleAnalysis,stageQualifications,claimQualification,claimQualificationBatch,budgetDay} from '../qualification.mjs';
import {beginCollection,claimCollection,finishCollection,collectionSettings} from '../collection.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {accountRestore} from '../account.mjs';
import {analysisUsageState} from '../usage.mjs';
import {Store} from '../store.mjs';

const NOW=Date.parse('2026-10-09T06:59:00Z'),DAY=86400000;
const settings={active:true,enabled:true,mode:'ongoing',until:Infinity,budgetMicroUsd:2000000,dailyMaxCalls:2000,maxCalls:2000};
const scrape=collectionSettings({TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'});
const product={id:'p',name:'Example',description:'Track a collection',capabilities:['Track owned figures'],needs:['Remember owned figures'],keywords:['figure collection'],aliases:['Example'],exclusions:[],communities:['smiskis'],monitoring:true,x:false};
const workspace=modern=>({version:1,products:[structuredClone(product)],items:[],searches:{},...(modern?{subscription:{planId:'growth',status:'manual'}}:{})});
const activate=(data,limits={})=>activatePilotBudget(data,{id:'growth-pilot',now:NOW,...limits});
const lease=()=>({kind:'manual',itemId:'item'});

test('activation captures existing cumulative costs and cannot reset or raise the approved pilot',()=>{
  const data=workspace(true);data.aiBudget={spentMicroUsd:7000000,reservedMicroUsd:0};data.collection={daily:{'2026-10-07':{spentCredits:5000,reservedCredits:0},'2026-10-08':{spentCredits:1000,reservedCredits:0}}};
  const state=activate(data);assert.equal(state.aiMicroUsd.used,0);assert.equal(state.scrapeCredits.used,0);assert.equal(state.aiMicroUsd.limit,3000000);assert.equal(state.scrapeCredits.limit,13333);
  assert.deepEqual(activate(data),state);assert.throws(()=>activatePilotBudget(data,{id:'new-pilot'}),{code:'pilot_budget_exists'});
  assert.throws(()=>activate(workspace(true),{aiMicroUsd:3000001}),{code:'pilot_budget_invalid'});
  assert.throws(()=>activate(workspace(true),{scrapeCredits:13334}),{code:'pilot_budget_invalid'});
});

test('activation waits for preexisting reservations and ledger regression fails closed',()=>{
  for(const extra of [{aiBudget:{spentMicroUsd:0,reservedMicroUsd:10}},{collection:{daily:{old:{spentCredits:0,reservedCredits:10}}}},{collection:{daily:{},active:{token:'old'}}}])assert.throws(()=>activate({...workspace(true),...extra}),{code:'pilot_reservations_pending'});
  const data=workspace(true);data.aiBudget={spentMicroUsd:100,reservedMicroUsd:0};activate(data);data.aiBudget.spentMicroUsd=99;
  assert.throws(()=>assertPilotBudget(data,'aiMicroUsd',1),{code:'pilot_budget_invalid'});
});

test('AI reservations include outstanding and uncertain holds across Pacific midnight',()=>{
  const data=workspace(true);activate(data,{aiMicroUsd:40000});
  const a=lease();reserveAnalysis(data,a,settings,NOW);assert.equal(pilotBudgetState(data).aiMicroUsd.used,20000);
  assert.equal(budgetDay(NOW),'2026-10-08');assert.equal(budgetDay(NOW+120000),'2026-10-09');
  const b=lease();reserveAnalysis(data,b,settings,NOW+120000);assert.equal(pilotBudgetState(data).aiMicroUsd.remaining,0);
  settleAnalysis(data,a);settleAnalysis(data,b);assert.equal(pilotBudgetState(data).aiMicroUsd.used,40000);
  assert.throws(()=>reserveAnalysis(data,lease(),settings,NOW+DAY),{code:'pilot_ai_budget'});
  assert.equal(data.aiBudget.calls,2);
});

test('final known usage releases only its actual over-reservation while the daily cap still applies',()=>{
  const data=workspace(true);activate(data,{aiMicroUsd:20000});const a=lease();reserveAnalysis(data,a,settings,NOW);settleAnalysis(data,a,5000);
  assert.equal(pilotBudgetState(data).aiMicroUsd.used,5000);assert.equal(pilotBudgetBlock(data,'aiMicroUsd',15000),null);
  assert.equal(pilotBudgetBlock(data,'aiMicroUsd',15001).code,'pilot_ai_budget');
  const large=workspace(true);activate(large);assert.throws(()=>reserveAnalysis(large,lease(),{...settings,budgetMicroUsd:19999},NOW),error=>error.status===429);
  assert.equal(large.aiBudget.reservedMicroUsd,0);
});

test('ScrapeBadger uncertainty consumes its hold without a new allowance the next day',()=>{
  const data=workspace(true);activate(data,{scrapeCredits:204});beginCollection(data,'p','scheduled',NOW,scrape);
  const first=claimCollection(data,scrape,'p',NOW);assert.equal(first.reserve,102);assert.equal(claimCollection(data,scrape,'p',NOW+1),null);
  finishCollection(data,first.token,{credits:null,error:'uncertain_dispatch'},NOW+1);assert.equal(pilotBudgetState(data).scrapeCredits.used,102);
  beginCollection(data,'p','scheduled',NOW+DAY,scrape);const second=claimCollection(data,scrape,'p',NOW+DAY);assert.equal(second.reserve,102);
  finishCollection(data,second.token,{credits:null,error:'uncertain_dispatch'},NOW+DAY+1);
  beginCollection(data,'p','scheduled',NOW+2*DAY,scrape);const before=data.collection.cycles.p.queue.length;
  assert.equal(claimCollection(data,scrape,'p',NOW+2*DAY),null);assert.equal(data.collection.cycles.p.blocked,'pilot_scraper_budget');assert.equal(data.collection.cycles.p.queue.length,before);
  assert.equal(pilotBudgetState(data).scrapeCredits.used,204);
});

test('ScrapeBadger and Apify share the pilot collection ceiling while daily limits still apply',()=>{
  const data=workspace(true);activate(data);beginCollection(data,'p','scheduled',NOW,scrape);
  assert.equal(claimCollection(data,{...scrape,dailyCreditLimit:0},'p',NOW),null);assert.equal(data.collection.cycles.p.blocked,'daily_scraper_budget');
  const task=data.collection.cycles.p.queue[0];Object.assign(task,{kind:'reddit_comment_search',query:'figure collection',cutoff:NOW-DAY});
  const claim=claimCollection(data,{...scrape,commentSearchEnabled:true,commentDailyLimitMicroUsd:500000},'p',NOW);assert.equal(claim.provider,'reddit-apify');assert.equal(claim.reserve,100000);assert.equal(pilotBudgetState(data).scrapeCredits.apifyEquivalentCredits,667);assert.equal(pilotBudgetState(data).scrapeCredits.limit,13333);
});

for(const modern of [false,true])for(const batched of [false,true])test(`${modern?'provisioned':'legacy'} ${batched?'batch':'single'} qualification cannot reserve beyond the total pilot cap`,()=>{
  const data=workspace(modern);activate(data,{aiMicroUsd:1});
  stageQualifications(data,data.products[0],[{source:'Reddit',type:'post',url:'https://www.reddit.com/r/smiskis/comments/abc/figure/',title:'How can I track figures?',snippet:'I want to remember the figures I own.',publishedAt:new Date(NOW-1000).toISOString()}],new Date(NOW).toISOString(),'manual');
  const result=(batched?claimQualificationBatch:claimQualification)(data,settings,NOW,'p');
  if(modern){assert.equal(result.status,'blocked');assert.equal(result.blocked.code,'pilot_ai_budget');assert.equal(analysisUsageState(data,NOW).monthly.used,0);}else assert.equal(result,null);
  assert.equal(data.aiBudget.reservedMicroUsd,0);assert.equal(data.aiBudget.calls,0);assert(Object.values(data.qualifications).every(job=>job.status!=='running'));
});

test('two racing Store CAS reservations cannot both use the last pilot allowance',async()=>{
  let data=workspace(true),revision=0;activate(data,{aiMicroUsd:20000});
  const store=new FirestoreStore({async read(){return {revision,data:structuredClone(data)};},async compareAndSwap(expected,next){if(expected!==revision)return false;data=structuredClone(next);revision++;return true;}});
  const outcomes=await Promise.allSettled([1,2].map(()=>store.mutate(next=>{reserveAnalysis(next,lease(),settings,NOW);return true;})));
  assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);assert.equal(outcomes.find(value=>value.status==='rejected').reason.code,'pilot_ai_budget');
  assert.equal(pilotBudgetState(await store.snapshot()).aiMicroUsd.used,20000);
});

test('backup restore cannot reset an existing pilot or enable an imported pilot',()=>{
  const data=workspace(true);activate(data);const original=structuredClone(data.pilotBudget),incoming=structuredClone(data);incoming.pilotBudget.baseline.aiMicroUsd=999999;incoming.pilotBudget.active=false;
  assert.deepEqual(accountRestore(data,incoming).pilotBudget,original);
  const fresh=workspace(true);assert.equal(accountRestore(fresh,incoming).pilotBudget,undefined);
  assert.equal(pilotBudgetState(fresh),null);assert.equal(pilotBudgetBlock(fresh,'aiMicroUsd',999999999),null);
});

for(const adapter of ['local','record'])test(`${adapter} legacy import also preserves operator pilot authority`,async()=>{
  for(const active of [false,true]){
    let state=workspace(false),revision=0;if(active)activate(state);const prior=structuredClone(state.pilotBudget);let store;
    if(adapter==='local'){store=Object.create(Store.prototype);store.data=state;store.commit=value=>{store.data=value;};}
    else store=new FirestoreStore({async read(){return {revision,data:structuredClone(state)};},async compareAndSwap(expected,next){if(expected!==revision)return false;state=structuredClone(next);revision++;return true;}});
    const backup=workspace(false);backup.pilotBudget={active:false,baseline:{aiMicroUsd:99999}};await store.importData(backup);
    assert.deepEqual((await store.snapshot()).pilotBudget,prior);
  }
});
