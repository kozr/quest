import {createHash,randomUUID} from 'node:crypto';
import {activeProduct,assertSubscriptionActive,planError,subscriptionState} from './plans.mjs';
import {claimScheduledLoop,finishScheduledLoop,scheduleState} from './schedules.mjs';
import {reserveAnalysisUnits,settleAnalysisUnits,expireAnalysisReservations} from './usage.mjs';
import {sourceIdentity} from './incremental.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso=now=>new Date(now).toISOString();
const CYCLE_HEARTBEAT_MS=300000,BATCH_LEASE_MS=120000;
const active=cycle=>cycle&&['running','blocked'].includes(cycle.status);
export function analysisCandidate(row,{id=row.id,profileHash,version}={}) {
  const identity=sourceIdentity(row);
  if(!identity||typeof id!=='string'||!id)throw planError('Conversation identity is missing.',{status:409,code:'analysis_source_missing'});
  return {id,sourceIdentity:identity,contentHash:row.contentHash||hash([row.title,row.text??row.snippet,row.context]),profileHash,version,historical:row.historical===true,backfillId:row.backfillId||null,backfillIds:Array.isArray(row.backfillIds)?row.backfillIds:[]};
}
function cycleTable(data) { data.analysisCycles??={};return data.analysisCycles; }
function heartbeat(data,cycle,now) {
  cycle.lastHeartbeatAt=iso(now);
  const record=data.loopSchedules?.[cycle.productId]?.analysis;
  if(record?.lease?.id===cycle.scheduleLeaseId)record.lease.expiresAt=iso(now+CYCLE_HEARTBEAT_MS);
}
function blockValue(error,now) {
  return {code:error.code||'analysis_unavailable',message:error.message||'Analysis is temporarily unavailable.',status:error.status||503,limit:error.limit??null,used:error.used??null,resetAt:error.resetAt??null,requiredPlan:error.requiredPlan??null,at:iso(now)};
}
export function blockAnalysisCycle(data,productId,error,{now=Date.now(),retryAfterMs=60000}={}) {
  const cycle=data.analysisCycles?.[productId];if(!active(cycle))return null;
  cycle.status='blocked';cycle.blocked=blockValue(error,now);cycle.retryAt=error.resetAt||iso(now+retryAfterMs);heartbeat(data,cycle,now);
  return analysisCycleState(data,productId,now);
}
function finishCycle(data,cycle,now) {
  if(cycle.queue.length||cycle.batch)return;
  cycle.status='complete';cycle.finishedAt=iso(now);delete cycle.blocked;delete cycle.retryAt;
  finishScheduledLoop(data,cycle.productId,'analysis',cycle.scheduleLeaseId,{now,outcome:'success'});
}
export function analysisCycleState(data,productId,now=Date.now()) {
  const cycle=data.analysisCycles?.[productId];
  if(!cycle)return null;
  return {id:cycle.id,productId,status:cycle.status,total:cycle.total,remaining:cycle.queue.length,completed:cycle.completed,failed:cycle.failed,uncertain:cycle.uncertain,cached:cycle.cached,skipped:cycle.skipped,startedAt:cycle.startedAt,finishedAt:cycle.finishedAt||null,lastHeartbeatAt:cycle.lastHeartbeatAt,batch:cycle.batch?{id:cycle.batch.id,count:cycle.batch.candidates.length,expiresAt:cycle.batch.expiresAt}:null,blocked:cycle.blocked||null,nextRunAt:cycle.retryAt||data.loopSchedules?.[productId]?.analysis?.nextRunAt||null};
}
export function analysisCycleDue(data,productId,now=Date.now()) {
  const product=data.products?.find(p=>p.id===productId);
  if(!product||!activeProduct(product)||product.planMonitoringBlocked||!subscriptionState(data,now).active)return false;
  const cycle=data.analysisCycles?.[productId];
  if(active(cycle))return (!cycle.batch||Date.parse(cycle.batch.expiresAt)<=now)&&(!cycle.retryAt||Date.parse(cycle.retryAt)<=now);
  return scheduleState(data,productId,'analysis',{now,manual:true,candidatesReady:true}).due;
}
export function prepareAnalysisCycle(data,productId,{profileHash,version,candidates,now=Date.now(),manual=true}={}) {
  assertSubscriptionActive(data,now);
  const product=data.products?.find(p=>p.id===productId);
  if(!product||!activeProduct(product)||product.planMonitoringBlocked)return {status:product?.planMonitoringBlocked||'archived'};
  const table=cycleTable(data),prior=table[productId];
  expireAnalysisReservations(data,now);
  if(active(prior)) {
    if(prior.version!==version)return {status:'blocked',blocked:{code:'analysis_cycle_active',message:'Another analysis cycle is finishing for this product.',status:409},cycle:analysisCycleState(data,productId,now)};
    if(prior.profileHash!==profileHash||prior.version!==version) {
      if(prior.batch)return {status:'blocked',blocked:{code:'analysis_cycle_active',message:'Another analysis cycle is finishing for this product.',status:409},cycle:analysisCycleState(data,productId,now)};
      prior.status='profile_changed';prior.finishedAt=iso(now);finishScheduledLoop(data,productId,'analysis',prior.scheduleLeaseId,{now,outcome:'failed'});
    } else {
      if(prior.batch&&Date.parse(prior.batch.expiresAt)<=now)finishAnalysisCycleBatch(data,productId,prior.batch.id,{}, {now});
      if(active(prior)) { heartbeat(data,prior,now);return {status:'ready',cycle:prior}; }
    }
  }
  if(!candidates.length)return {status:'complete'};
  const claim=claimScheduledLoop(data,productId,'analysis',{now,manual,candidatesReady:true,leaseMs:CYCLE_HEARTBEAT_MS});
  if(!claim.claimed)return {status:claim.status,nextRunAt:claim.nextRunAt};
  const unique=[...new Map(candidates.map(candidate=>[candidate.id,candidate])).values()];
  const cycle={id:randomUUID(),productId,profileHash,version,scheduleLeaseId:claim.lease.id,status:'running',startedAt:iso(now),lastHeartbeatAt:iso(now),total:unique.length,queue:unique.map(candidate=>candidate.id),candidates:Object.fromEntries(unique.map(candidate=>[candidate.id,structuredClone(candidate)])),completed:0,failed:0,uncertain:0,cached:0,skipped:0};
  table[productId]=cycle;return {status:'ready',cycle};
}
// The candidate snapshot is fixed for a cycle; later arrivals wait for the next
// cadence. Each resume claims another bounded batch, not another daily run.
export function claimAnalysisCycleBatch(data,productId,{candidates,profileHash,version,now=Date.now(),maxBatch=12,manual=true}={}) {
  if(!Number.isInteger(maxBatch)||maxBatch<1||maxBatch>12)throw planError('Analysis batches contain at most twelve conversations.',{status:400,code:'invalid_analysis_batch'});
  const prepared=prepareAnalysisCycle(data,productId,{candidates,profileHash,version,now,manual});
  if(prepared.status!=='ready')return prepared;
  const cycle=prepared.cycle;
  if(cycle.batch)return {status:'running',cycle:analysisCycleState(data,productId,now)};
  if(cycle.retryAt&&Date.parse(cycle.retryAt)>now)return {status:'blocked',blocked:cycle.blocked,nextRunAt:cycle.retryAt,cycle:analysisCycleState(data,productId,now)};
  delete cycle.blocked;delete cycle.retryAt;cycle.status='running';
  const current=new Map(candidates.map(candidate=>[candidate.id,candidate])),selected=[],cached=[],reservations={};let blocker=null;
  for(const id of [...cycle.queue]) {
    if(selected.length>=maxBatch)break;
    const candidate=cycle.candidates[id],latest=current.get(id);
    if(!latest||latest.contentHash!==candidate.contentHash||latest.profileHash!==candidate.profileHash) {cycle.queue=cycle.queue.filter(key=>key!==id);cycle.skipped++;continue;}
    if(candidate.historical){
      const ids=[...new Set([candidate.backfillId,...(candidate.backfillIds||[])].filter(Boolean))];
      const trustedId=ids.find(id=>data.collection?.backfills?.[productId]?.id===id||data.collection?.backfillRuns?.[id]?.productId===productId||Object.values(data.usage?.historical||{}).some(pool=>pool.productId===productId&&pool.backfillId===id));
      if(!trustedId){blocker=planError('Historical conversations need their original backfill attribution before analysis.',{status:409,code:'historical_attribution_required'});continue;}
      candidate.backfillId=trustedId;
    }
    const executionKey=hash([productId,candidate.profileHash,candidate.version,candidate.sourceIdentity,candidate.contentHash]);
    let reservation;
    try { reservation=reserveAnalysisUnits(data,{productId,backfillId:candidate.backfillId,historical:candidate.historical,executionKey,sourceIdentities:[candidate.sourceIdentity],now,leaseMs:BATCH_LEASE_MS}); }
    catch(error) { if(error.status!==429)throw error;blocker=error;continue; }
    if(!reservation.dispatch) {
      if(reservation.cached&&reservation.result!==undefined) {cached.push({candidate,result:structuredClone(reservation.result)});cycle.cached++;cycle.completed++;cycle.queue=cycle.queue.filter(key=>key!==id);}
      else if(reservation.status==='uncertain') {cycle.uncertain++;cycle.queue=cycle.queue.filter(key=>key!==id);}
      else blocker=planError(reservation.cached?'A cached analysis has no retained result.':'This conversation already has an analysis in progress.',{status:409,code:reservation.cached?'analysis_cache_missing':'analysis_in_progress'});
      continue;
    }
    selected.push(candidate);reservations[id]=reservation.id;
  }
  if(blocker){blockAnalysisCycle(data,productId,blocker,{now});if(selected.length)delete cycle.retryAt;}
  if(!selected.length) {finishCycle(data,cycle,now);return {status:cycle.status==='complete'?'complete':'blocked',cached,blocked:cycle.blocked||null,cycle:analysisCycleState(data,productId,now)};}
  const batch={id:randomUUID(),cycleId:cycle.id,productId,candidates:structuredClone(selected),reservations,startedAt:iso(now),expiresAt:iso(now+BATCH_LEASE_MS)};
  cycle.batch=batch;heartbeat(data,cycle,now);
  return {status:'ready',batch:structuredClone(batch),cached,cycle:analysisCycleState(data,productId,now)};
}
export function finishAnalysisCycleBatch(data,productId,batchId,outcomes={}, {now=Date.now()}={}) {
  const cycle=data.analysisCycles?.[productId],batch=cycle?.batch;if(!batch||batch.id!==batchId)return {status:'stale_batch'};
  for(const candidate of batch.candidates) {
    const outcome=outcomes[candidate.id]||{status:'uncertain'};
    const receipt=settleAnalysisUnits(data,batch.reservations[candidate.id],{outcome:outcome.status,now});
    if(outcome.status==='success'&&receipt.status==='succeeded') { if(outcome.result!==undefined)data.usage.reservations[receipt.id].result=structuredClone(outcome.result);cycle.completed++; }
    else if(receipt.status==='failed')cycle.failed++;else cycle.uncertain++;
    cycle.queue=cycle.queue.filter(id=>id!==candidate.id);
  }
  delete cycle.batch;heartbeat(data,cycle,now);finishCycle(data,cycle,now);
  return analysisCycleState(data,productId,now);
}
// The caller knows no provider request was dispatched (for example, a cost cap
// rejected it). Release plan reservations while leaving candidates in this cycle.
export function releaseAnalysisCycleBatch(data,productId,batchId,error,{now=Date.now()}={}) {
  const cycle=data.analysisCycles?.[productId],batch=cycle?.batch;if(!batch||batch.id!==batchId)return null;
  for(const reservationId of Object.values(batch.reservations))settleAnalysisUnits(data,reservationId,{outcome:'failed',now});
  delete cycle.batch;return blockAnalysisCycle(data,productId,error,{now});
}
