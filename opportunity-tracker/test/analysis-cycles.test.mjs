import test from 'node:test';
import assert from 'node:assert/strict';
import {cafe,breakdown} from './business-profile.fixture.mjs';
import {validateSearchPlan} from '../search-plan.mjs';
import {captureEvidence,pendingEvidenceCount} from '../conversation-evidence.mjs';
import {claimStage,finishStage,failStage} from '../pipeline-runtime.mjs';
import {analysisCycleState,analysisCycleDue} from '../analysis-cycles.mjs';
import {analysisUsageState,reserveAnalysisUnits,settleAnalysisUnits} from '../usage.mjs';
import {stageQualifications,claimQualificationBatch,finishQualificationBatch,claimQualification,finishQualification,qualificationSettings,budgetDay,profileHash} from '../qualification.mjs';
import {hash,PIPELINE_VERSION} from '../pipeline-contract.mjs';
import {STAGE_DEFINITIONS} from '../pipeline-stages.mjs';

const now=Date.parse('2026-10-09T12:00:00Z'),minute=60000;
const settings={active:true,enabled:true,mode:'ongoing',until:Infinity,budgetMicroUsd:2000000,dailyMaxCalls:2000,maxCalls:2000};
function workspace({version='v2',planId='starter'}={}) {
  let p={...cafe,id:'p',monitoring:true};
  if(version==='v2'){
    p={...p,profileVersion:'v2',businessProfileV2:{...breakdown(),reviewed:true}};
    p.searchPlanV2={...validateSearchPlan({themes:[{id:'lunch',title:'Lunch',need:'Lunch nearby',purposes:['feedback'],offeringIds:['o1'],keywords:['lunch'],longTail:[],queries:[{id:'q',loop:'keyword',query:'croissant sandwich',platform:'reddit',community:'vancouver'}]}],limitations:[]},p),reviewed:true};p.listeningVersion='v2';
  }
  return {version:1,subscription:{planId,status:'manual'},products:[p],items:[],searches:{}};
}
const rows=(count,start=0,extra={})=>Array.from({length:count},(_,i)=>({id:`unused${i+start}`,source:'Reddit',sourceId:`t3_post${i+start}`,postId:`t3_post${i+start}`,type:'post',url:`https://www.reddit.com/r/vancouver/comments/post${i+start}/`,title:`Lunch conversation ${i+start}`,snippet:`I need a sandwich near Vancouver ${i+start}.`,author:`author${i+start}`,publishedAt:new Date(now-1000).toISOString(),...extra}));
function collect(data,count,start=0,extra={}){captureEvidence(data,data.products[0],rows(count,start,extra),new Date(now).toISOString());}
const response=input=>({value:{results:input.evidence.map(row=>({evidenceId:row.id,relevant:false,directFit:false,category:'other',need:'',quote:'',offeringIds:[],reason:'No relevant product need.',resolved:'unknown',purposes:[]}))},model:'fixture',costMicroUsd:1000});

test('one daily analysis cycle drains its whole fixed snapshot in bounded batches',()=>{
  const data=workspace();collect(data,25);
  const first=claimStage(data,'p','qualify',settings,false,now);assert.equal(first.input.evidence.length,12);
  assert.equal(first.lease.inputHash,hash([PIPELINE_VERSION,'qualify',STAGE_DEFINITIONS.qualify.promptVersion,first.input]));
  const cycleId=analysisCycleState(data,'p',now).id;collect(data,3,100);
  finishStage(data,first.lease,response(first.input),now+1000);
  const second=claimStage(data,'p','qualify',settings,false,now+2000);assert.equal(second.input.evidence.length,12);assert.equal(analysisCycleState(data,'p').id,cycleId);
  finishStage(data,second.lease,response(second.input),now+3000);
  const third=claimStage(data,'p','qualify',settings,false,now+4000);assert.equal(third.input.evidence.length,1);finishStage(data,third.lease,response(third.input),now+5000);
  assert.equal(analysisCycleState(data,'p').status,'complete');assert.equal(analysisUsageState(data,now).monthly.completed,25);assert.equal(pendingEvidenceCount(data,data.products[0]),3);
  assert.equal(claimStage(data,'p','qualify',settings,true,now+6000).status,'not_due');assert.equal(analysisCycleDue(data,'p',now+86400000),true);
  assert.equal(claimStage(data,'p','qualify',settings,false,now+86400000).input.evidence.length,3);
});
test('provider allowance pauses a cycle without spending plan units or losing candidates',()=>{
  const data=workspace();collect(data,13);
  const blocked=claimStage(data,'p','qualify',{...settings,budgetMicroUsd:0},false,now);
  assert.equal(blocked.status,'blocked');assert.equal(analysisUsageState(data,now).monthly.used,0);assert.equal(analysisCycleState(data,'p').remaining,13);assert.equal(Object.keys(data.analysisLeases).length,0);
  const next=claimStage(data,'p','qualify',settings,false,now+minute);assert.equal(next.input.evidence.length,12);assert.equal(analysisCycleState(data,'p').total,13);
});
test('plan quota shrinks a batch and resumes the same candidate snapshot after UTC rollover',()=>{
  const data=workspace(),fill=reserveAnalysisUnits(data,{productId:'p',executionKey:'fill',sourceIdentities:Array.from({length:999},(_,i)=>`seen:${i}`),now});settleAnalysisUnits(data,fill.id,{outcome:'success',now});collect(data,3);
  const first=claimStage(data,'p','qualify',settings,false,now);assert.equal(first.input.evidence.length,1);finishStage(data,first.lease,response(first.input),now+1);
  assert.equal(analysisCycleState(data,'p').blocked.code,'monthly_analysis_limit');assert.equal(analysisCycleState(data,'p').remaining,2);
  const next=claimStage(data,'p','qualify',settings,false,Date.parse('2026-11-01T00:00:00Z'));assert.equal(next.input.evidence.length,2);assert.equal(analysisUsageState(data,Date.parse('2026-11-01T00:00:00Z')).monthly.reserved,2);
});
test('historical and live candidates reserve distinct pools within one provider batch',()=>{
  const data=workspace();data.collection={backfills:{p:{id:'history'}}};collect(data,2,0,{historical:true,backfillId:'history'});collect(data,2,10);
  const first=claimStage(data,'p','qualify',settings,false,now);assert.equal(first.input.evidence.length,4);
  let usage=analysisUsageState(data,now);assert.equal(usage.monthly.reserved,2);assert.equal(Object.values(usage.historical)[0].reserved,2);
  finishStage(data,first.lease,response(first.input),now+1);usage=analysisUsageState(data,now);assert.equal(usage.monthly.completed,2);assert.equal(Object.values(usage.historical)[0].completed,2);
});
test('a full recurring allowance does not stop remaining historical batches in the same cycle',()=>{
  const data=workspace(),fill=reserveAnalysisUnits(data,{productId:'p',executionKey:'fill',sourceIdentities:Array.from({length:1000},(_,i)=>`seen:${i}`),now});settleAnalysisUnits(data,fill.id,{outcome:'success',now});
  data.collection={backfills:{p:{id:'history'}}};collect(data,1);collect(data,15,100,{historical:true,backfillId:'history'});
  const first=claimStage(data,'p','qualify',settings,false,now);assert.equal(first.input.evidence.length,12);finishStage(data,first.lease,response(first.input),now+1);
  const second=claimStage(data,'p','qualify',settings,false,now+2);assert.equal(second.input.evidence.length,3);finishStage(data,second.lease,response(second.input),now+3);
  assert.equal(Object.values(analysisUsageState(data,now).historical)[0].completed,15);assert.equal(analysisCycleState(data,'p').remaining,1);
});
test('past backfill provenance remains valid when a subsequent backfill becomes current',()=>{
  const data=workspace();data.collection={backfills:{p:{id:'new'}},backfillRuns:{old:{id:'old',productId:'p'}}};collect(data,1,0,{historical:true,backfillId:'old'});
  const claim=claimStage(data,'p','qualify',settings,false,now);assert.equal(claim.input.evidence.length,1);assert.equal(Object.values(analysisUsageState(data,now).historical)[0].backfillId,'old');
});
test('invalid per-row provider output releases only that row’s unit',()=>{
  const data=workspace();collect(data,2);const first=claimStage(data,'p','qualify',settings,false,now),result=response(first.input);
  result.value.results[0].directFit=true;finishStage(data,first.lease,result,now+1);
  const usage=analysisUsageState(data,now).monthly;assert.equal(usage.completed,1);assert.equal(usage.used,1);assert.equal(analysisCycleState(data,'p').failed,1);
});
test('unknown dispatch and expired leases hold units and do not replay candidates',()=>{
  const data=workspace();collect(data,13);const first=claimStage(data,'p','qualify',settings,false,now);
  const second=claimStage(data,'p','qualify',settings,false,now+120000);assert.equal(second.input.evidence.length,1);
  assert.equal(analysisUsageState(data,now).monthly.uncertain,12);assert.equal(pendingEvidenceCount(data,data.products[0]),1);
  failStage(data,second.lease,'Provider connection was lost.',undefined,now+120001);assert.equal(analysisUsageState(data,now).monthly.uncertain,13);assert.equal(analysisCycleState(data,'p').status,'complete');
});
test('identical completed execution is restored from its cache without a provider dispatch or fresh units',()=>{
  const data=workspace();collect(data,1);const first=claimStage(data,'p','qualify',settings,false,now);finishStage(data,first.lease,response(first.input),now+1);
  delete data.conversationEvidence.p[0].qualification;data.conversationReviewReceipts={};
  const cached=claimStage(data,'p','qualify',settings,false,now+86400000);assert.equal(cached.status,'complete');assert.equal(cached.lease,undefined);assert.equal(analysisUsageState(data,now).monthly.used,1);assert.equal(pendingEvidenceCount(data,data.products[0]),0);
});
test('legacy batches use the same cadence and unique allowance while preserving their provider cost ledger',()=>{
  const data=workspace({version:'v1'});stageQualifications(data,data.products[0],rows(23).map(row=>({...row,pipeline:'experiment-v1'})),new Date(now).toISOString(),'manual');
  const reject={decision:'rejected',intentQuote:'',evidenceQuotes:[],capabilityIds:[],whyItFits:''};
  for(const [index,count] of [10,10,3].entries()) {
    const batch=claimQualificationBatch(data,settings,now+index*2000,'p');assert.equal(batch.jobs.length,count);
    finishQualificationBatch(data,batch,{assessments:Object.fromEntries(batch.jobs.map(job=>[job.key,reject])),costMicroUsd:1000},now+index*2000+1);
  }
  assert.equal(analysisCycleState(data,'p').status,'complete');assert.equal(analysisUsageState(data,now).monthly.completed,23);assert.equal(data.aiBudget.dailyUsage[budgetDay(now)].calls,3);
  stageQualifications(data,data.products[0],rows(1,100),new Date(now+10000).toISOString(),'manual');assert.equal(claimQualification(data,settings,now+10000,'p').status,'not_due');
});
test('legacy single-item qualification cannot bypass allowances or cadence',()=>{
  const data=workspace({version:'v1'});stageQualifications(data,data.products[0],rows(2),new Date(now).toISOString(),'manual');
  const job=claimQualification(data,settings,now,'p');assert(job.key);finishQualification(data,job.key,job.token,{assessment:{decision:'rejected',intentQuote:'',evidenceQuotes:[],capabilityIds:[],whyItFits:''},costMicroUsd:1000},now+1);
  assert.equal(analysisUsageState(data,now).monthly.completed,1);assert(claimQualification(data,settings,now+2,'p').key);
});
test('legacy automatic selection skips a product waiting for its next cadence',()=>{
  const data=workspace({version:'v1',planId:'growth'});data.products.push({...data.products[0],id:'second'});
  stageQualifications(data,data.products[0],rows(1),new Date(now).toISOString(),'manual');
  const first=claimQualification(data,settings,now,'p');finishQualification(data,first.key,first.token,{assessment:{decision:'rejected',intentQuote:'',evidenceQuotes:[],capabilityIds:[],whyItFits:''},costMicroUsd:1000},now+1);
  stageQualifications(data,data.products[0],rows(1,2),new Date(now+2).toISOString(),'manual');stageQualifications(data,data.products[1],rows(1,3),new Date(now+3).toISOString(),'manual');
  const next=claimQualification(data,settings,now+4);assert.equal(next.productId,'second');
});

test('a capacity downgrade or archive blocks analysis-cycle resumes without discarding pending candidates',()=>{
  const data=workspace();collect(data,13);const first=claimStage(data,'p','qualify',settings,false,now);finishStage(data,first.lease,response(first.input),now+1000);
  data.products[0].planMonitoringBlocked='plan_capacity';assert.equal(claimStage(data,'p','qualify',settings,false,now+2000).status,'plan_capacity');assert.equal(analysisCycleState(data,'p').remaining,1);assert.equal(analysisCycleDue(data,'p',now+2000),false);
  delete data.products[0].planMonitoringBlocked;data.products[0].archived=true;assert.equal(claimStage(data,'p','qualify',settings,false,now+2000).status,'archived');assert.equal(analysisCycleState(data,'p').remaining,1);
  data.products[0].archived=false;data.subscription.status='cancelled';assert.equal(analysisCycleDue(data,'p',now+2000),false);data.subscription.status='manual';assert.equal(claimStage(data,'p','qualify',settings,false,now+2000).input.evidence.length,1);
});
test('non-qualification paid AI stages require active subscription and capacity',()=>{
  const data=workspace();data.subscription.status='cancelled';assert.throws(()=>claimStage(data,'p','search_plan',settings,false,now),error=>error.code==='subscription_inactive');
  data.subscription.status='manual';data.products[0].planMonitoringBlocked='plan_capacity';assert.throws(()=>claimStage(data,'p','search_plan',settings,false,now),error=>error.code==='plan_capacity');
});
