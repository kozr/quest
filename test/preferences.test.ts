import assert from 'node:assert/strict';
import {test} from 'node:test';
import {defaultPreferences,resolvePreferences,patchPreferences,shouldNotify} from '../src/database.js';
import type {ActivityEvent,EventKind,Preferences} from '../src/types.js';
const kinds: [EventKind,keyof Preferences][] = [
  ['sale','sales'],['renewal','renewals'],['trial','trials'],['refund','refunds'],
  ['refund_reversed','refundReversals'],['auto_renew_disabled','autoRenewDisabled'],
  ['auto_renew_enabled','autoRenewEnabled'],['billing_issue','billingIssues'],
  ['expired','expirations'],['other','otherUpdates'],
];
const event=(kind:EventKind,environment:ActivityEvent['environment']='Production') => ({kind,environment} as ActivityEvent);
test('legacy records retain the notification choices for every event category',()=>{
  for (const enabled of [false,true]) {
    const p=resolvePreferences({sales:enabled,refunds:enabled,lifecycle:enabled});
    for (const [kind] of kinds) assert.equal(shouldNotify(event(kind),p),enabled,kind);
  }
  assert.equal(resolvePreferences().trials,false);
  assert.equal(resolvePreferences().renewals,true);
});
test('every notification option can be selected independently',()=>{
  const off=resolvePreferences({sales:false,refunds:false,lifecycle:false});
  for (const [selected,key] of kinds) {
    const p={...off,[key]:true};
    for (const [kind] of kinds) assert.equal(shouldNotify(event(kind),p),kind===selected,`${selected} / ${kind}`);
    assert.equal(shouldNotify(event(selected,'Sandbox'),p),false);
    assert.equal(shouldNotify(event(selected,'Sandbox'),{...p,sandbox:true}),true);
  }
});
test('legacy group changes work and explicit individual choices take precedence',()=>{
  const initial=resolvePreferences(defaultPreferences);
  const updated=patchPreferences(initial,{lifecycle:true,trials:false});
  assert.equal(updated.trials,false);
  assert.equal(updated.billingIssues,true);
  assert.equal(patchPreferences(updated,{hideAmounts:true}).trials,false);
  assert.equal(patchPreferences(updated,{sales:false}).renewals,false);
  assert.equal(patchPreferences(updated,{sales:false,renewals:true}).renewals,true);
});
test('Apple connection tests stay silent and explicit demo pushes remain available',()=>{
  const p=resolvePreferences({sales:false,refunds:false,lifecycle:true,sandbox:true});
  assert.equal(shouldNotify(event('test'),p),false);
  assert.equal(shouldNotify(event('sale','Demo'),p),true);
});
