import {randomUUID} from 'node:crypto';
import {activeProduct,planFor,planError,subscriptionState} from './plans.mjs';

export const SCHEDULE_LOOPS=Object.freeze(['keyword','long_tail','analysis']);
const iso=value=>new Date(value).toISOString();
const stamp=value=>Number.isFinite(Date.parse(value))?Date.parse(value):0;
function validLoop(loop) { if(!SCHEDULE_LOOPS.includes(loop))throw planError('Unknown monitoring loop.',{status:400,code:'invalid_loop'}); }
function validTime(now) { if(!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime()))throw planError('Invalid scheduler timestamp.',{status:400,code:'invalid_schedule'}); }
function records(data,productId) { data.loopSchedules??={};data.loopSchedules[productId]??={};return data.loopSchedules[productId]; }
function productFor(data,productId) { const product=data.products?.find(p=>p.id===productId);if(!product)throw planError('Product not found.',{status:404,code:'product_not_found'});return product; }
export function loopIntervalMs(data,loop,{sourceFloorMs=0}={}) {
  validLoop(loop);
  if(!Number.isFinite(sourceFloorMs)||sourceFloorMs<0)throw planError('Invalid source schedule floor.',{status:400,code:'invalid_schedule'});
  return Math.max(planFor(data).intervals[loop],sourceFloorMs);
}
function nextTime(data,loop,record,sourceFloorMs) {
  if(!record?.lastStartedAt)return stamp(record?.retryAt);
  return Math.max(stamp(record.lastStartedAt)+loopIntervalMs(data,loop,{sourceFloorMs}),stamp(record.retryAt));
}
export function scheduleState(data,productId,loop,{now=Date.now(),sourceFloorMs=0,candidatesReady=false,candidateKey,manual=false}={}) {
  validTime(now);validLoop(loop);
  const product=productFor(data,productId),record=data.loopSchedules?.[productId]?.[loop],intervalMs=loopIntervalMs(data,loop,{sourceFloorMs});
  const base={productId,loop,intervalMs,due:false,nextRunAt:null,lastStartedAt:record?.lastStartedAt??null,lastFinishedAt:record?.lastFinishedAt??null,lastOutcome:record?.lastOutcome??null};
  if(!activeProduct(product))return {...base,status:'archived'};
  if(product.planMonitoringBlocked)return {...base,status:product.planMonitoringBlocked};
  if(!subscriptionState(data,now).active)return {...base,status:'subscription_inactive'};
  if(!manual&&product.monitoring!==true)return {...base,status:'monitoring_paused'};
  if(record?.lease) {
    if(stamp(record.lease.expiresAt)>now)return {...base,status:'running',lease:structuredClone(record.lease),nextRunAt:record.lease.expiresAt};
    // The worker can claim once to retire an expired lease. Retirement preserves
    // cadence/backoff and cannot instantly dispatch the same job again.
    return {...base,status:'lease_expired',due:true,lease:structuredClone(record.lease),nextRunAt:iso(now)};
  }
  if(loop==='analysis'&&!candidatesReady)return {...base,status:'no_candidates'};
  if(loop==='analysis'&&candidateKey&&record?.lastCompletedCandidateKey===candidateKey)return {...base,status:'already_processed'};
  const next=nextTime(data,loop,record,sourceFloorMs);
  return {...base,status:next>now?'not_due':'ready',due:next<=now,nextRunAt:iso(next||now)};
}
export function dueLoops(data,productId,options={}) { return SCHEDULE_LOOPS.map(loop=>scheduleState(data,productId,loop,options)).filter(state=>state.due); }
function backoffMs(failures,override) {
  if(override!==undefined) {
    if(!Number.isFinite(override)||override<1000||override>86400000)throw planError('Invalid retry delay.',{status:400,code:'invalid_schedule'});
    return override;
  }
  return Math.min(3600000,60000*2**Math.min(Math.max(0,failures-1),6));
}
function finishRecord(data,productId,loop,record,{now,outcome,sourceFloorMs=0,retryAfterMs}) {
  const lease=record.lease;
  record.lastFinishedAt=iso(now);record.lastOutcome=outcome;record.lastLeaseId=lease.id;
  if(outcome==='success') {
    record.lastSucceededAt=iso(now);record.failures=0;delete record.retryAt;
    if(loop==='analysis'&&lease.candidateKey)record.lastCompletedCandidateKey=lease.candidateKey;
  } else {
    record.failures=(record.failures||0)+1;record.retryAt=iso(now+backoffMs(record.failures,retryAfterMs));
  }
  delete record.lease;
  record.nextRunAt=iso(nextTime(data,loop,record,sourceFloorMs));
  return {productId,loop,...structuredClone(record)};
}
export function claimScheduledLoop(data,productId,loop,{now=Date.now(),leaseMs=120000,sourceFloorMs=0,candidatesReady=false,candidateKey,manual=false}={}) {
  validTime(now);validLoop(loop);
  if(!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>86400000)throw planError('Invalid scheduler lease duration.',{status:400,code:'invalid_schedule'});
  if(candidateKey!==undefined&&(typeof candidateKey!=='string'||!candidateKey||candidateKey.length>4096))throw planError('Invalid candidate revision.',{status:400,code:'invalid_schedule'});
  let current=scheduleState(data,productId,loop,{now,sourceFloorMs,candidatesReady,candidateKey,manual});
  if(current.status==='lease_expired') {
    const record=records(data,productId)[loop];
    finishRecord(data,productId,loop,record,{now,outcome:'uncertain',sourceFloorMs});
    current=scheduleState(data,productId,loop,{now,sourceFloorMs,candidatesReady,candidateKey,manual});
  }
  if(!current.due)return {claimed:false,...current};
  const record=records(data,productId)[loop]??={};
  const lease={id:randomUUID(),productId,loop,startedAt:iso(now),expiresAt:iso(now+leaseMs),...(candidateKey?{candidateKey}:{}),manual:manual===true};
  Object.assign(record,{lastStartedAt:iso(now),nextRunAt:iso(now+current.intervalMs),lease});
  return {claimed:true,productId,loop,status:'running',intervalMs:current.intervalMs,nextRunAt:record.nextRunAt,lease:structuredClone(lease)};
}
export function finishScheduledLoop(data,productId,loop,leaseId,{now=Date.now(),outcome,sourceFloorMs=0,retryAfterMs}={}) {
  validTime(now);validLoop(loop);
  if(!['success','failed','uncertain'].includes(outcome))throw planError('Invalid scheduler outcome.',{status:400,code:'invalid_schedule'});
  // Validate any caller-supplied retry before changing a durable record.
  if(retryAfterMs!==undefined)backoffMs(1,retryAfterMs);
  const record=data.loopSchedules?.[productId]?.[loop];
  if(!record?.lease||record.lease.id!==leaseId)return {finished:false,status:'stale_lease'};
  return {finished:true,...finishRecord(data,productId,loop,record,{now,outcome,sourceFloorMs,retryAfterMs})};
}
