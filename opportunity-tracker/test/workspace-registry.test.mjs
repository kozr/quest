import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceRegistry} from '../workspace-registry.mjs';
import {createInvite, acceptInvite, removeMember} from '../workspace.mjs';
import {planFor, setSubscriptionPlan} from '../plans.mjs';

const now = Date.parse('2026-10-09T12:00:00Z');
const alice = {sub:'101',email:'alice@gmail.com',authoritativeEmail:true};
const bob = {sub:'202',email:'bob@gmail.com',authoritativeEmail:true};
function backend(initial = {}) {
  let revision = 0, data = structuredClone(initial);
  return {
    async read() { return {revision, data:structuredClone(data)}; },
    async compareAndSwap(expected, next) {
      if (expected !== revision) return false;
      data = structuredClone(next); revision++; return true;
    },
  };
}
function fixture() {
  const directory = backend(), stores = new Map();
  const storeFor = async id => {
    if (!stores.has(id)) {
      const db = backend({version:1,products:[],items:[],searches:{}});
      stores.set(id, {
        async snapshot() { return (await db.read()).data; },
        async mutate(change) {
          for (let n = 0; n < 12; n++) {
            const {revision,data} = await db.read();
            const result = change(data);
            if (await db.compareAndSwap(revision,data)) return result;
          }
          throw new Error('Fixture transaction exhausted');
        },
      });
    }
    return stores.get(id);
  };
  return {registry:new WorkspaceRegistry({backend:directory,storeFor,now:()=>now}),directory,stores,storeFor};
}

test('workspace creation is idempotent and each owner sees only their own account',async()=>{
  const {registry} = fixture();
  const a = await registry.create(alice,{name:'Alice product',requestId:'request-alice-01'});
  const again = await registry.create(alice,{name:'Alice product',requestId:'request-alice-01'});
  assert.equal(again.id,a.id);
  const b = await registry.create(bob,{name:'Bob product',requestId:'request-bob-01'});
  assert.notEqual(a.id,b.id);
  assert.deepEqual((await registry.list(alice)).map(w=>w.id),[a.id]);
  assert.deepEqual((await registry.list(bob)).map(w=>w.id),[b.id]);
  await assert.rejects(registry.resolve(alice,b.id),{status:403});
  await assert.rejects(registry.resolve(bob,a.id),{status:403});
  const state = await a.store.snapshot();
  assert.equal(state.subscription.planId,'starter');
  assert.equal(state.subscription.status,'trial');
  assert.equal(Date.parse(state.subscription.trialEndsAt),now+7*86400000);
});

test('stale or forged directory entries do not grant access; revocation applies on resolve',async()=>{
  const {registry} = fixture();
  const a = await registry.create(alice,{requestId:'request-owner-01'});
  await a.store.mutate(data=>setSubscriptionPlan(data,'growth',{now,status:'active'}));
  const invitation = await a.store.mutate(data=>createInvite(data,alice,{email:bob.email,now},planFor(data)));
  await a.store.mutate(data=>acceptInvite(data,bob,{token:invitation.token,now},planFor(data)));
  await registry.register(a.id,bob);
  assert.equal((await registry.list(bob)).length,1);
  await a.store.mutate(data=>removeMember(data,alice,{sub:bob.sub,now},planFor(data)));
  assert.equal((await registry.list(bob)).length,0);
  await assert.rejects(registry.resolve(bob,a.id),{status:403});
  await assert.rejects(registry.register(a.id,bob),{status:403});
});

test('concurrent creation cannot reset a free trial by making extra workspaces',async()=>{
  const {registry} = fixture();
  const result = await Promise.allSettled([
    registry.create(alice,{requestId:'first-request-01'}),
    registry.create(alice,{requestId:'second-request-02'}),
  ]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(result.find(r=>r.status==='rejected').reason.code,'workspace_exists');
  assert.equal((await registry.list(alice)).length,1);
});

test('a provisioning failure can resume the same account without resetting its trial',async()=>{
  const {registry} = fixture();
  const original = registry.register.bind(registry);
  let rejectOnce = true;
  registry.register = async (...args)=>{if(rejectOnce){rejectOnce=false;throw new Error('temporary directory outage');}return original(...args);};
  await assert.rejects(registry.create(alice,{requestId:'recover-request-01'}),/temporary directory outage/);
  const result = await registry.create(alice,{requestId:'recover-request-01'});
  assert.equal((await registry.list(alice)).length,1);
  assert.equal((await result.store.snapshot()).subscription.createdAt,new Date(now).toISOString());
});

test('workspace selection validates identity and forbids path traversal',async()=>{
  const {registry} = fixture();
  await assert.rejects(registry.resolve(null,'personal'),{status:401});
  await assert.rejects(registry.resolve(alice,'../someone-else'),{status:404});
  await assert.rejects(registry.resolve(alice,'missing'),{status:404});
});


test('registering an invited teammate preserves the original owner trial marker',async()=>{
 const {registry}=fixture();
 const first=await registry.create(alice,{requestId:'one-trial-only'});
 await first.store.mutate(data=>setSubscriptionPlan(data,'growth',{now,status:'active'}));
 const invitation=await first.store.mutate(data=>createInvite(data,alice,{email:bob.email,now},planFor(data)));
 await first.store.mutate(data=>acceptInvite(data,bob,{token:invitation.token,now},planFor(data)));
 await registry.register(first.id,bob);
 await registry.register(first.id,alice);
 await assert.rejects(registry.create(alice,{requestId:'second-trial-request'}),{code:'workspace_exists'});
 assert.deepEqual((await registry.list(bob)).map(row=>row.id),[first.id]);
});
