import test from 'node:test';
import assert from 'node:assert/strict';
import {loopIntervalMs,scheduleState,dueLoops,claimScheduledLoop,finishScheduledLoop} from '../schedules.mjs';

const now=Date.parse('2026-10-09T12:00:00Z'),minute=60000;
const workspace=(planId='starter')=>({subscription:{planId,status:'manual'},products:[{id:'p',monitoring:true}]});
function run(data,loop,at=now,options={}) { const result=claimScheduledLoop(data,'p',loop,{now:at,...options});assert.equal(result.claimed,true);return result; }
function done(data,loop,claim,at=now,outcome='success',options={}) { return finishScheduledLoop(data,'p',loop,claim.lease.id,{now:at,outcome,...options}); }
test('all three loops run independently and honor exact plan boundaries',()=>{
  const data=workspace('growth'),keyword=run(data,'keyword'),discovery=run(data,'long_tail'),analysis=run(data,'analysis',now,{candidatesReady:true});
  done(data,'keyword',keyword);done(data,'long_tail',discovery);done(data,'analysis',analysis);
  for(const [loop,interval] of [['keyword',15*minute],['long_tail',360*minute],['analysis',60*minute]]) {
    assert.equal(scheduleState(data,'p',loop,{now:now+interval-1,candidatesReady:true}).due,false);
    assert.equal(scheduleState(data,'p',loop,{now:now+interval,candidatesReady:true}).due,true);
  }
});
test('concurrent claims have one lease and stale workers cannot finish a newer job',()=>{
  const data=workspace('team'),first=run(data,'keyword');
  const conflict=claimScheduledLoop(data,'p','keyword',{now});assert.equal(conflict.claimed,false);assert.equal(conflict.status,'running');
  done(data,'keyword',first);const second=run(data,'keyword',now+5*minute);
  assert.equal(done(data,'keyword',first,now+5*minute).finished,false);assert.equal(data.loopSchedules.p.keyword.lease.id,second.lease.id);
});
test('manual calls obey cadence and do not force repeat searches',()=>{
  const data=workspace(),first=run(data,'keyword',now,{manual:true});done(data,'keyword',first);
  const early=claimScheduledLoop(data,'p','keyword',{now:now+minute,manual:true});assert.equal(early.claimed,false);assert.equal(early.status,'not_due');
  assert.equal(claimScheduledLoop(data,'p','keyword',{now:now+60*minute,manual:true}).claimed,true);
});
test('analysis runs only when candidates are ready and does not replay a completed batch',()=>{
  const data=workspace('team');assert.equal(scheduleState(data,'p','analysis',{now}).status,'no_candidates');
  const first=run(data,'analysis',now,{candidatesReady:true,candidateKey:'batch-1'});done(data,'analysis',first);
  assert.equal(scheduleState(data,'p','analysis',{now:now+60*minute,candidatesReady:true,candidateKey:'batch-1'}).status,'already_processed');
  assert.equal(scheduleState(data,'p','analysis',{now:now+15*minute,candidatesReady:true,candidateKey:'batch-2'}).due,true);
});
test('source capability floor bounds a fast plan without changing other loops',()=>{
  const data=workspace('team');assert.equal(loopIntervalMs(data,'keyword',{sourceFloorMs:1440*minute}),1440*minute);
  const first=run(data,'keyword',now,{sourceFloorMs:1440*minute});done(data,'keyword',first,now,'success',{sourceFloorMs:1440*minute});
  assert.equal(scheduleState(data,'p','keyword',{now:now+5*minute,sourceFloorMs:1440*minute}).due,false);
  assert.equal(scheduleState(data,'p','keyword',{now:now+1440*minute,sourceFloorMs:1440*minute}).due,true);
  assert.equal(loopIntervalMs(data,'long_tail'),60*minute);
});
test('upgrades and downgrades derive cadence from current entitlements and recorded starts',()=>{
  const data=workspace(),first=run(data,'keyword');done(data,'keyword',first);
  data.subscription.planId='team';assert.equal(scheduleState(data,'p','keyword',{now:now+5*minute}).due,true);
  data.subscription.planId='starter';assert.equal(scheduleState(data,'p','keyword',{now:now+5*minute}).due,false);
});
test('known failures apply backoff and still obey the plan interval',()=>{
  const data=workspace('team'),first=run(data,'keyword');done(data,'keyword',first,now+4*minute,'failed',{retryAfterMs:2*minute});
  assert.equal(scheduleState(data,'p','keyword',{now:now+5*minute}).due,false);
  assert.equal(scheduleState(data,'p','keyword',{now:now+6*minute}).due,true);
  const retry=run(data,'keyword',now+6*minute);done(data,'keyword',retry,now+6*minute,'success');assert.equal(data.loopSchedules.p.keyword.failures,0);
});
test('expired lease is retired conservatively before another claim can dispatch',()=>{
  const data=workspace('team'),first=run(data,'keyword',now,{leaseMs:1000});
  const expired=claimScheduledLoop(data,'p','keyword',{now:now+5*minute});assert.equal(expired.claimed,false);assert.equal(expired.status,'not_due');
  assert.equal(data.loopSchedules.p.keyword.lastOutcome,'uncertain');assert.equal(data.loopSchedules.p.keyword.lastLeaseId,first.lease.id);
  assert.equal(done(data,'keyword',first,now+5*minute).finished,false);
  assert.equal(claimScheduledLoop(data,'p','keyword',{now:now+6*minute}).claimed,true);
});
test('paused, archived and unpaid products never acquire scheduled jobs',()=>{
  const data=workspace();data.products[0].monitoring=false;assert.equal(scheduleState(data,'p','keyword',{now}).status,'monitoring_paused');
  assert.equal(claimScheduledLoop(data,'p','keyword',{now,manual:true}).claimed,true);
  data.products[0].archived=true;assert.equal(scheduleState(data,'p','keyword',{now,manual:true}).status,'archived');
  data.products[0].archived=false;data.subscription.status='cancelled';assert.equal(scheduleState(data,'p','keyword',{now,manual:true}).status,'subscription_inactive');
});
test('due loop enumeration is candidate-aware and product isolation is preserved',()=>{
  const data=workspace();data.products.push({id:'other',monitoring:true});
  assert.deepEqual(dueLoops(data,'p',{now}).map(row=>row.loop),['keyword','long_tail']);
  run(data,'keyword');assert.equal(scheduleState(data,'other','keyword',{now}).due,true);
  assert.throws(()=>claimScheduledLoop(data,'missing','keyword',{now}),error=>error.status===404);
});
