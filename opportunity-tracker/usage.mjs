import {createHash,randomUUID} from 'node:crypto';
import {assertSubscriptionActive,planFor,planError,requiredPlanFor} from './plans.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const iso=value=>new Date(value).toISOString();
const owns=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
function validNow(now) { if(!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime()))throw planError('Invalid usage timestamp.',{status:400,code:'invalid_usage_request'}); }
function text(value,name) { if(typeof value!=='string'||!value.trim()||value.length>4096)throw planError(`Provide a valid ${name}.`,{status:400,code:'invalid_usage_request'});return value; }
export function monthlyPeriod(now=Date.now()) {
  validNow(now);const at=new Date(now),year=at.getUTCFullYear(),month=at.getUTCMonth();
  return {key:`${year}-${String(month+1).padStart(2,'0')}`,startsAt:iso(Date.UTC(year,month,1)),resetAt:iso(Date.UTC(year,month+1,1))};
}
function usageLedger(data) {
  data.usage??={version:1,periods:{},historical:{},reservations:{},executions:{}};
  if(data.usage.version!==1)throw planError('Unsupported analysis usage ledger.',{status:409,code:'invalid_usage_ledger'});
  for(const name of ['periods','historical','reservations','executions'])data.usage[name]??={};
  return data.usage;
}
function bucketFor(ledger,reservation) { return reservation.scope==='historical'?ledger.historical[reservation.bucketId]:ledger.periods[reservation.bucketId]; }
function bucketCounts(bucket) {
  const units=Object.values(bucket?.units||{});
  return {used:units.length,completed:units.filter(unit=>unit.completed===true).length,uncertain:units.filter(unit=>!unit.completed&&unit.uncertain===true).length,reserved:units.filter(unit=>!unit.completed&&!unit.uncertain).length};
}
function publicReservation(reservation,dispatch=false) { return {...structuredClone(reservation),dispatch,cached:reservation.status==='succeeded'}; }
function updateUnits(ledger,reservation,outcomes) {
  const bucket=bucketFor(ledger,reservation);
  for(const key of reservation.sourceKeys) {
    const unit=bucket?.units[key];
    if(!unit)throw planError('An analysis reservation has lost its allowance record.',{status:409,code:'invalid_usage_ledger'});
    const outcome=outcomes[key];
    unit.claims=unit.claims.filter(id=>id!==reservation.id);
    if(outcome==='success')unit.completed=true;
    else if(outcome==='uncertain')unit.uncertain=true;
    if(!unit.completed&&!unit.uncertain&&!unit.claims.length)delete bucket.units[key];
  }
}
// Expiration is ambiguous: keep the original month's units charged. Do not
// silently release a dispatched request when a worker disappears or a month ends.
export function expireAnalysisReservations(data,now=Date.now()) {
  validNow(now);if(!data.usage)return [];
  const ledger=usageLedger(data),expired=[];
  for(const reservation of Object.values(ledger.reservations)) {
    if(reservation.status!=='reserved'||Date.parse(reservation.expiresAt)>now)continue;
    const outcomes=Object.fromEntries(reservation.sourceKeys.map(key=>[key,'uncertain']));
    updateUnits(ledger,reservation,outcomes);
    Object.assign(reservation,{status:'uncertain',outcomes,settledAt:iso(now),reason:'lease_expired'});
    expired.push(reservation.id);
  }
  return expired;
}
// The caller supplies canonical workspace-wide source identities. executionKey
// describes product + profile + source content + analysis version independently.
// Repeat executions and cross-product reviews never add a second monthly unit.
export function reserveAnalysisUnits(data,{productId,backfillId,historical=false,executionKey,sourceIdentities,now=Date.now(),leaseMs=120000}={}) {
  validNow(now);const p=assertSubscriptionActive(data,now);
  text(productId,'product ID');text(executionKey,'execution key');
  if(historical)text(backfillId,'server-created backfill ID');
  if(!Array.isArray(sourceIdentities)||!sourceIdentities.length||sourceIdentities.length>30000)throw planError('Provide the conversations being analyzed.',{status:400,code:'invalid_usage_request'});
  const sourceKeys=[...new Set(sourceIdentities.map(value=>hash(text(value,'source identity'))))].sort();
  if(!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>86400000)throw planError('Invalid analysis reservation duration.',{status:400,code:'invalid_usage_request'});
  const ledger=usageLedger(data);expireAnalysisReservations(data,now);
  // Pool attribution does not change an analysis. A historical result encountered
  // later in the live stream remains the same cached execution in its origin pool.
  const executionId=hash(executionKey),fingerprint=hash(JSON.stringify({productId,sourceKeys}));
  const priorId=ledger.executions[executionId],prior=priorId?ledger.reservations[priorId]:null;
  if(prior&&prior.fingerprint!==fingerprint)throw planError('An execution key cannot describe different conversations.',{status:409,code:'analysis_execution_conflict'});
  if(prior&&prior.status!=='failed')return publicReservation(prior,false);
  const period=monthlyPeriod(now),bucketId=historical?hash(JSON.stringify([productId,backfillId])):period.key;
  let bucket=historical?ledger.historical[bucketId]:ledger.periods[bucketId];
  if(!bucket) {
    bucket={units:{},createdAt:iso(now),...(historical?{productId,backfillId,allowance:p.history.allowancePerProduct}:{startsAt:period.startsAt,resetAt:period.resetAt})};
    (historical?ledger.historical:ledger.periods)[bucketId]=bucket;
  }
  // Historical grant is fixed when the product's backfill starts. It is distinct
  // from the live monthly allowance and does not renew or silently grow on retry.
  const limit=historical?bucket.allowance:p.limits.monthlyAiAnalyses;
  const newKeys=sourceKeys.filter(key=>!owns(bucket.units,key)),used=Object.keys(bucket.units).length;
  if(newKeys.length&&used+newKeys.length>limit)throw planError(historical?'This historical analysis allowance has been reached.':'This month’s unique-conversation analysis allowance has been reached.',{status:429,code:historical?'historical_analysis_limit':'monthly_analysis_limit',resource:historical?'historicalAnalyses':'monthlyAiAnalyses',limit,used,requested:newKeys.length,resetAt:historical?null:bucket.resetAt,requiredPlan:historical?null:requiredPlanFor('monthlyAiAnalyses',used+newKeys.length)});
  const id=randomUUID();
  const reservation={id,executionId,fingerprint,productId,scope:historical?'historical':'monthly',bucketId,...(historical?{backfillId}:{}),sourceKeys,status:'reserved',newUnits:newKeys.length,startedAt:iso(now),expiresAt:iso(now+leaseMs)};
  for(const key of sourceKeys) { bucket.units[key]??={completed:false,uncertain:false,claims:[]};bucket.units[key].claims.push(id); }
  ledger.reservations[id]=reservation;ledger.executions[executionId]=id;
  return publicReservation(reservation,true);
}
// outcome=failed is for a known failure before a useful analysis completed;
// outcome=uncertain preserves allowance for an ambiguous provider outcome.
// Partial batches explicitly identify successes/failures; omitted rows remain held.
export function settleAnalysisUnits(data,reservationId,{outcome,successfulSourceIdentities=[],failedSourceIdentities=[],now=Date.now()}={}) {
  validNow(now);
  if(!['success','failed','uncertain','partial'].includes(outcome))throw planError('Choose a valid analysis outcome.',{status:400,code:'invalid_usage_request'});
  const ledger=usageLedger(data);expireAnalysisReservations(data,now);
  const reservation=ledger.reservations[reservationId];
  if(!reservation)throw planError('Analysis reservation not found.',{status:404,code:'analysis_reservation_missing'});
  // Terminal receipts are immutable. A late callback or failed retry cannot
  // erase a previously successful or ambiguous provider charge.
  if(reservation.status!=='reserved')return publicReservation(reservation,false);
  const outcomes=Object.fromEntries(reservation.sourceKeys.map(key=>[key,outcome==='partial'?'uncertain':outcome]));
  if(outcome==='partial') {
    const success=new Set(successfulSourceIdentities.map(value=>hash(text(value,'source identity'))));
    const failed=new Set(failedSourceIdentities.map(value=>hash(text(value,'source identity'))));
    for(const key of [...success,...failed])if(!owns(outcomes,key)||success.has(key)&&failed.has(key))throw planError('Partial outcomes must identify distinct reserved conversations.',{status:400,code:'invalid_usage_request'});
    for(const key of success)outcomes[key]='success';for(const key of failed)outcomes[key]='failed';
  }
  updateUnits(ledger,reservation,outcomes);
  const statuses=Object.values(outcomes);
  const status=statuses.every(value=>value==='success')?'succeeded':statuses.every(value=>value==='failed')?'failed':statuses.some(value=>value==='uncertain')?'uncertain':'partial';
  Object.assign(reservation,{status,outcomes,settledAt:iso(now)});
  return publicReservation(reservation,false);
}
export function analysisUsageState(data,now=Date.now()) {
  const p=planFor(data),period=monthlyPeriod(now),ledger=data.usage;
  const monthly={period:period.key,startsAt:period.startsAt,resetAt:period.resetAt,limit:p.limits.monthlyAiAnalyses,...bucketCounts(ledger?.periods?.[period.key])};
  monthly.remaining=Math.max(0,monthly.limit-monthly.used);
  const historical=Object.fromEntries(Object.entries(ledger?.historical||{}).map(([key,bucket])=>{const counts=bucketCounts(bucket);return [key,{productId:bucket.productId,backfillId:bucket.backfillId,limit:bucket.allowance,...counts,remaining:Math.max(0,bucket.allowance-counts.used)}];}));
  return {monthly,historical};
}
