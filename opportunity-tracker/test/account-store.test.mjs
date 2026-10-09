import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {LocalRecordBackend} from '../record-backend.mjs';

const owner = {sub:'101',email:'owner@gmail.com',authoritativeEmail:true};
const product = {name:'Useful app',url:'https://example.com',description:'A real product',keywords:['task tracking'],aliases:['Useful app'],exclusions:[]};
const account = {id:'test-account',name:'Test account',owner};
const empty = () => ({version:1,products:[],items:[],searches:{}});
function memoryBackend() {
  let revision=0,data=empty();
  return {
    async read(){return {revision,data:structuredClone(data)};},
    async compareAndSwap(expected,next){if(expected!==revision)return false;data=structuredClone(next);revision++;return true;},
  };
}
function local(t) {
  const dir=mkdtempSync(join(tmpdir(),'account-store-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return new Store(dir);
}

test('local provisioned account enforces product capacity inside the store mutation',t=>{
  const store=local(t);
  store.initializeAccount(account);
  const first=store.saveProduct(product);
  assert.throws(()=>store.saveProduct({...product,name:'Extra product'}),{code:'plan_capacity_exceeded',limit:1,used:2});
  assert.equal(store.snapshot().products.length,1);
  assert.equal(store.snapshot().products[0].id,first.id);
  assert.equal(store.accountSnapshot(owner).entitlements.id,'starter');
});

test('concurrent cloud store mutations cannot exceed product, seat or unique-analysis limits',async()=>{
  const backend=memoryBackend(),a=new FirestoreStore(backend),b=new FirestoreStore(backend);
  await a.initializeAccount({...account,planId:'growth'});
  const products=await Promise.allSettled(Array.from({length:8},(_,i)=>(i%2?a:b).saveProduct({...product,name:`Product ${i}`})));
  assert.equal(products.filter(r=>r.status==='fulfilled').length,3);
  assert.equal((await b.snapshot()).products.length,3);
  assert.ok(products.filter(r=>r.status==='rejected').every(r=>r.reason.code==='plan_capacity_exceeded'));
  const invites=await Promise.allSettled(Array.from({length:7},(_,i)=>(i%2?a:b).accountAction(owner,'invite.create',{email:`member${i}@gmail.com`})));
  assert.equal(invites.filter(r=>r.status==='fulfilled').length,2);
  assert.equal((await b.accountSnapshot(owner)).usage.capacity.seats,3);
  const first=await a.reserveAnalysisUnits({productId:'p',executionKey:'first',sourceIdentities:Array.from({length:4999},(_,i)=>`source:${i}`)});
  await a.settleAnalysisUnits(first.id,{outcome:'success'});
  const final=await Promise.allSettled([
    a.reserveAnalysisUnits({productId:'p',executionKey:'last-a',sourceIdentities:['source:a']}),
    b.reserveAnalysisUnits({productId:'p',executionKey:'last-b',sourceIdentities:['source:b']}),
  ]);
  assert.equal(final.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(final.find(r=>r.status==='rejected').reason.code,'monthly_analysis_limit');
  assert.equal((await b.accountSnapshot(owner)).usage.analysis.monthly.used,5000);
});

test('restore cannot change plan, membership, client scope or measured usage',async()=>{
  const store=new FirestoreStore(memoryBackend());
  await store.initializeAccount({...account,planId:'team'});
  const p=await store.saveProduct(product);
  const client=await store.accountAction(owner,'client.create',{name:'Client A'});
  await store.accountAction(owner,'product.client',{productId:p.id,clientId:client.id});
  const held=await store.reserveAnalysisUnits({productId:p.id,executionKey:'review',sourceIdentities:['source:one']});
  await store.settleAnalysisUnits(held.id,{outcome:'success'});
  const backup=await store.snapshot();
  backup.subscription={planId:'starter',status:'manual'};
  backup.workspace.members={attacker:{sub:'attacker',email:'attacker@gmail.com',role:'owner',status:'active'}};
  backup.usage={version:1,periods:{},historical:{},reservations:{},executions:{}};
  backup.products[0].clientId='untrusted-client';
  await store.importData(backup);
  const after=await store.snapshot();
  assert.equal(after.subscription.planId,'team');
  assert.equal(after.workspace.members[owner.sub].role,'owner');
  assert.equal(after.workspace.members.attacker,undefined);
  assert.equal(after.products[0].clientId,client.id);
  assert.equal((await store.accountSnapshot(owner)).usage.analysis.monthly.used,1);
});

test('record backend preserves account and usage through process-style recreation',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'account-record-store-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const make=()=>new FirestoreStore(new LocalRecordBackend(dir,{empty}));
  const a=make();
  await a.initializeAccount({...account,planId:'growth'});
  await a.saveProduct(product);
  const reservation=await a.reserveAnalysisUnits({productId:'p',executionKey:'one',sourceIdentities:['https://www.reddit.com/comments/example/']});
  await a.settleAnalysisUnits(reservation.id,{outcome:'success'});
  const restarted=make(),state=await restarted.accountSnapshot(owner);
  assert.equal(state.entitlements.id,'growth');
  assert.equal(state.usage.capacity.products,1);
  assert.equal(state.usage.analysis.monthly.used,1);
  const duplicate=await restarted.reserveAnalysisUnits({productId:'p',executionKey:'one',sourceIdentities:['https://www.reddit.com/comments/example/']});
  assert.equal(duplicate.dispatch,false);
  assert.equal(duplicate.cached,true);
});
