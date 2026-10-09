import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveAnalysisUnits,settleAnalysisUnits,expireAnalysisReservations,analysisUsageState,monthlyPeriod} from '../usage.mjs';

const now=Date.parse('2026-10-09T12:00:00Z');
const request=(executionKey,sourceIdentities=['reddit:t3_one'],extra={})=>({productId:'p',executionKey,sourceIdentities,now,...extra});
test('month boundaries are UTC including December rollover',()=>{
  assert.deepEqual(monthlyPeriod(Date.parse('2026-12-31T23:59:59Z')),{key:'2026-12',startsAt:'2026-12-01T00:00:00.000Z',resetAt:'2027-01-01T00:00:00.000Z'});
  assert.equal(monthlyPeriod(Date.parse('2026-11-01T00:00:00Z')).key,'2026-11');
});
test('reservations count canonical conversations once across products, batches and duplicate inputs',()=>{
  const data={};const a=reserveAnalysisUnits(data,request('a',['reddit:t3_one','reddit:t3_one']));
  const b=reserveAnalysisUnits(data,request('b',undefined,{productId:'other'}));
  assert.equal(a.newUnits,1);assert.equal(b.newUnits,0);assert.equal(analysisUsageState(data,now).monthly.used,1);
  settleAnalysisUnits(data,a.id,{outcome:'failed',now:now+1});assert.equal(analysisUsageState(data,now).monthly.reserved,1);
  settleAnalysisUnits(data,b.id,{outcome:'success',now:now+2});assert.equal(analysisUsageState(data,now).monthly.completed,1);
});
test('retries of an execution never dispatch twice and successful reruns remain cached across months',()=>{
  const data={},first=reserveAnalysisUnits(data,request('same'));
  const retry=reserveAnalysisUnits(data,request('same'));assert.equal(retry.id,first.id);assert.equal(retry.dispatch,false);
  settleAnalysisUnits(data,first.id,{outcome:'success',now:now+1});
  const cached=reserveAnalysisUnits(data,request('same',undefined,{now:Date.parse('2026-11-01T12:00:00Z')}));
  assert.equal(cached.cached,true);assert.equal(cached.dispatch,false);assert.equal(analysisUsageState(data,Date.parse('2026-11-01T12:00:00Z')).monthly.used,0);
  assert.throws(()=>reserveAnalysisUnits(data,request('same',['reddit:t3_different'])),error=>error.code==='analysis_execution_conflict');
});
test('a definite failure releases units and a retry receives a fresh reservation',()=>{
  const data={},first=reserveAnalysisUnits(data,request('retry'));settleAnalysisUnits(data,first.id,{outcome:'failed',now:now+1});
  assert.equal(analysisUsageState(data,now).monthly.used,0);
  const next=reserveAnalysisUnits(data,request('retry',undefined,{now:now+2}));assert.notEqual(next.id,first.id);assert.equal(next.dispatch,true);assert.equal(next.newUnits,1);
  settleAnalysisUnits(data,first.id,{outcome:'success',now:now+3});assert.equal(analysisUsageState(data,now).monthly.reserved,1);
});
test('partial batches charge success, release known failures and hold missing outcomes',()=>{
  const data={},r=reserveAnalysisUnits(data,request('batch',['a','b','c']));
  settleAnalysisUnits(data,r.id,{outcome:'partial',successfulSourceIdentities:['a'],failedSourceIdentities:['b'],now:now+1});
  const state=analysisUsageState(data,now).monthly;assert.equal(state.used,2);assert.equal(state.completed,1);assert.equal(state.uncertain,1);assert.equal(state.reserved,0);
  assert.equal(reserveAnalysisUnits(data,request('batch',['a','b','c'])).dispatch,false);
});
test('invalid partial outcomes do not settle a reservation',()=>{
  const data={},r=reserveAnalysisUnits(data,request('batch',['a','b']));
  assert.throws(()=>settleAnalysisUnits(data,r.id,{outcome:'partial',successfulSourceIdentities:['a'],failedSourceIdentities:['a'],now}),error=>error.code==='invalid_usage_request');
  assert.equal(data.usage.reservations[r.id].status,'reserved');assert.equal(analysisUsageState(data,now).monthly.reserved,2);
});
test('failed concurrent review cannot release a unit already completed by another product',()=>{
  const data={},a=reserveAnalysisUnits(data,request('a')),b=reserveAnalysisUnits(data,request('b',undefined,{productId:'b'}));
  settleAnalysisUnits(data,a.id,{outcome:'success',now});settleAnalysisUnits(data,b.id,{outcome:'failed',now});
  assert.equal(analysisUsageState(data,now).monthly.completed,1);
});
test('atomic serial reservations enforce the workspace cap including work in flight',()=>{
  let data={};const fill=Array.from({length:999},(_,i)=>`source:${i}`);
  reserveAnalysisUnits(data,request('fill',fill));
  function transaction(options){const next=structuredClone(data),result=reserveAnalysisUnits(next,options);data=next;return result;}
  transaction(request('last',['source:last']));
  assert.throws(()=>transaction(request('over',['source:over'])),error=>error.status===429&&error.limit===1000&&error.used===1000&&error.resetAt==='2026-11-01T00:00:00.000Z'&&error.requiredPlan==='growth');
  assert.equal(analysisUsageState(data,now).monthly.used,1000);assert.equal(Object.keys(data.usage.reservations).length,2);
});
test('expired holds survive rollover and the same execution cannot obtain another grant',()=>{
  const before=Date.parse('2026-10-31T23:59:59Z'),after=Date.parse('2026-11-01T00:00:02Z'),data={};
  const r=reserveAnalysisUnits(data,request('cross-month',['a'],{now:before,leaseMs:1000}));
  assert.deepEqual(expireAnalysisReservations(data,after),[r.id]);
  assert.equal(analysisUsageState(data,before).monthly.uncertain,1);assert.equal(analysisUsageState(data,after).monthly.used,0);
  const retry=reserveAnalysisUnits(data,request('cross-month',['a'],{now:after}));assert.equal(retry.dispatch,false);assert.equal(retry.status,'uncertain');assert.equal(retry.bucketId,'2026-10');
  settleAnalysisUnits(data,r.id,{outcome:'failed',now:after+1});assert.equal(analysisUsageState(data,before).monthly.uncertain,1);
  const newContent=reserveAnalysisUnits(data,request('new-content',['a'],{now:after+1}));assert.equal(newContent.newUnits,1);assert.equal(analysisUsageState(data,after).monthly.used,1);
});
test('a successful callback after midnight settles its origin period',()=>{
  const before=Date.parse('2026-10-31T23:59:59Z'),after=before+2000,data={};
  const r=reserveAnalysisUnits(data,request('cross',['a'],{now:before,leaseMs:10000}));settleAnalysisUnits(data,r.id,{outcome:'success',now:after});
  assert.equal(analysisUsageState(data,before).monthly.completed,1);assert.equal(analysisUsageState(data,after).monthly.used,0);
});
test('late settlement cannot skip expiry accounting just because no worker retired the lease',()=>{
  const data={},r=reserveAnalysisUnits(data,request('expired',['a'],{leaseMs:1000}));
  const late=settleAnalysisUnits(data,r.id,{outcome:'failed',now:now+1000});
  assert.equal(late.status,'uncertain');assert.equal(analysisUsageState(data,now).monthly.uncertain,1);
});
test('historical grants never spend the recurring allowance and remain stable on retry',()=>{
  const data={},identities=Array.from({length:1000},(_,i)=>`history:${i}`);
  const h=reserveAnalysisUnits(data,request('history',identities,{historical:true,backfillId:'backfill-one'}));settleAnalysisUnits(data,h.id,{outcome:'success',now});
  assert.equal(analysisUsageState(data,now).monthly.used,0);assert.equal(Object.values(analysisUsageState(data,now).historical)[0].used,1000);
  assert.throws(()=>reserveAnalysisUnits(data,request('history-over',['other'],{historical:true,backfillId:'backfill-one'})),error=>error.code==='historical_analysis_limit'&&error.resetAt===null);
  const fresh=reserveAnalysisUnits(data,request('fresh',['new']));assert.equal(fresh.newUnits,1);
  data.subscription={planId:'growth',status:'manual'};
  assert.equal(Object.values(analysisUsageState(data,now).historical)[0].limit,1000);
  const second=reserveAnalysisUnits(data,request('second',['history:0'],{productId:'second',historical:true,backfillId:'backfill-one'}));assert.equal(second.newUnits,1);
  assert.deepEqual(Object.values(analysisUsageState(data,now).historical).map(pool=>pool.limit),[1000,5000]);
});
test('completed historical results encountered in live monitoring reuse the execution without a recurring charge',()=>{
  const data={},historical=reserveAnalysisUnits(data,request('same-analysis',['a'],{historical:true,backfillId:'backfill-one'}));
  settleAnalysisUnits(data,historical.id,{outcome:'success',now});
  const live=reserveAnalysisUnits(data,request('same-analysis',['a']));assert.equal(live.cached,true);assert.equal(live.scope,'historical');assert.equal(live.dispatch,false);
  assert.equal(analysisUsageState(data,now).monthly.used,0);
});
test('downgrade preserves usage and allows already-counted conversations while denying new units',()=>{
  const data={subscription:{planId:'growth',status:'manual'}},sources=Array.from({length:1001},(_,i)=>`source:${i}`);
  const r=reserveAnalysisUnits(data,request('growth',sources));settleAnalysisUnits(data,r.id,{outcome:'success',now});
  data.subscription.planId='starter';assert.equal(analysisUsageState(data,now).monthly.remaining,0);
  assert.equal(reserveAnalysisUnits(data,request('updated-content',['source:0'])).newUnits,0);
  assert.throws(()=>reserveAnalysisUnits(data,request('new',['another'])),error=>error.code==='monthly_analysis_limit');
});
test('expired subscriptions cannot dispatch analysis and invalid requests fail explicitly',()=>{
  const data={subscription:{planId:'starter',status:'trial',trialEndsAt:new Date(now).toISOString()}};
  assert.throws(()=>reserveAnalysisUnits(data,request('a')),error=>error.status===402);
  assert.throws(()=>reserveAnalysisUnits({},request('a',[])),error=>error.code==='invalid_usage_request');
  assert.throws(()=>reserveAnalysisUnits({},request('a',['x'],{historical:true})),error=>error.code==='invalid_usage_request');
});
