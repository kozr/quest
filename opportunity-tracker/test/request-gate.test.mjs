import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestGate} from '../ui/src/request-gate.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>Promise.resolve();

test('repeated state polls keep one slow page alive until its result arrives',async()=>{
 const gate=createRequestGate(),response=deferred(),accepted=[];let calls=0,signal;
 const load=received=>{calls++;signal=received;return response.promise;};
 const first=gate.run('same product and filters',load,value=>accepted.push(value));await tick();
 for(let poll=0;poll<20;poll++)assert.strictEqual(gate.run('same product and filters',load,value=>accepted.push(value)),first);
 assert.equal(calls,1);assert.equal(signal.aborted,false);response.resolve({items:['result'],total:1});await first;assert.deepEqual(accepted,[{items:['result'],total:1}]);
 const fresh=gate.run('same product and filters',async()=>({items:['new result']}),value=>accepted.push(value));await fresh;assert.equal(accepted.length,2);
});
test('filter change aborts old request and late old response cannot replace current page',async()=>{
 const gate=createRequestGate(),old=deferred(),next=deferred(),accepted=[];let oldSignal;
 const before=gate.run('old query',signal=>{oldSignal=signal;return old.promise;},value=>accepted.push(value));await tick();
 const after=gate.run('new query',()=>next.promise,value=>accepted.push(value));await tick();assert.equal(oldSignal.aborted,true);
 next.resolve('new page');await after;old.resolve('old page from transport ignoring abort');await before;assert.deepEqual(accepted,['new page']);
});
test('state reload callers share in-flight request instead of perpetually superseding slow responses',async()=>{
 const gate=createRequestGate(),response=deferred(),states=[];let active=0,maxActive=0,calls=0;
 const load=async()=>{calls++;active++;maxActive=Math.max(maxActive,active);try{return await response.promise;}finally{active--;}};
 const callers=Array.from({length:12},()=>gate.run('state',load,value=>states.push(value)));await tick();assert.equal(calls,1);assert.equal(maxActive,1);
 response.resolve({products:[{id:'loaded'}]});await Promise.all(callers);assert.equal(states.length,1);assert.equal(states[0].products[0].id,'loaded');
});
test('logout cancellation isolates the next session and failed refresh can retry',async()=>{
 const gate=createRequestGate(),old=deferred(),states=[];const first=gate.run('state',()=>old.promise,value=>states.push(value));await tick();gate.cancel();
 const second=gate.run('state',async()=>'new session',value=>states.push(value));await second;old.resolve('old session');await first;assert.deepEqual(states,['new session']);
 let rejected=0;await assert.rejects(gate.run('state',async()=>{throw Error('unavailable');},()=>assert.fail(),()=>rejected++),/unavailable/);assert.equal(rejected,1);
 await gate.run('state',async()=>'retry success',value=>states.push(value));assert.deepEqual(states,['new session','retry success']);
});


test('a manual refresh after saving supersedes a background snapshot taken before the save',async()=>{
 const gate=createRequestGate(),beforeSave=deferred(),afterSave=deferred(),states=[];let firstSignal;
 const background=gate.run('state',signal=>{firstSignal=signal;return beforeSave.promise;},value=>states.push(value));await tick();
 // App's default reload cancels; only the background timer opts into coalescing.
 gate.cancel();const manual=gate.run('state',()=>afterSave.promise,value=>states.push(value));await tick();assert.equal(firstSignal.aborted,true);assert.notStrictEqual(manual,background);
 beforeSave.resolve({note:'before save'});await background;assert.deepEqual(states,[]);
 afterSave.resolve({note:'saved note'});assert.deepEqual(await manual,{note:'saved note'});assert.deepEqual(states,[{note:'saved note'}]);
});


test('manual-refresh epoch replaces a pending pre-save page while background state updates keep its key',async()=>{
 const gate=createRequestGate(),beforeSave=deferred(),afterSave=deferred(),pages=[];let beforeSignal;
 const key=epoch=>JSON.stringify([epoch,'product','query','all','active','mentions',0,5]);
 const before=gate.run(key(1),signal=>{beforeSignal=signal;return beforeSave.promise;},value=>pages.push(value));await tick();
 for(let poll=0;poll<3;poll++)assert.strictEqual(gate.run(key(1),()=>assert.fail(),()=>assert.fail()),before);
 const after=gate.run(key(2),()=>afterSave.promise,value=>pages.push(value));await tick();assert.equal(beforeSignal.aborted,true);
 afterSave.resolve({note:'saved note',status:'saved'});await after;beforeSave.resolve({note:'old note',status:'new'});await before;assert.deepEqual(pages,[{note:'saved note',status:'saved'}]);
});
