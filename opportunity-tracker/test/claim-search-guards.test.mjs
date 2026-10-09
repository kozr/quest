import test from 'node:test';
import assert from 'node:assert/strict';
import {FirestoreStore} from '../firestore-store.mjs';
import {createAccountRuntime} from '../account-runtime.mjs';

const owner={sub:'101',email:'owner@gmail.com',authoritativeEmail:true};
function memoryBackend(){
  let data={version:1,products:[],items:[],searches:{}},revision=0,conflict;
  return {
    async read(){return {revision,data:structuredClone(data)};},
    async compareAndSwap(expected,next){
      if(conflict){const change=conflict;conflict=null;change(data);revision++;return false;}
      if(expected!==revision)return false;data=structuredClone(next);revision++;return true;
    },
    conflictOnce(change){conflict=change;},
  };
}
async function fixture(){
  const backend=memoryBackend(),store=new FirestoreStore(backend);
  await store.initializeAccount({id:'workspace',name:'Workspace',owner,planId:'growth'});
  await store.mutate(data=>{data.products=[{id:'p',name:'Example',monitoring:true,keywords:[]}];data.subscription={planId:'growth',status:'active',managedBy:'stripe',paidUntil:new Date(Date.now()+3600000).toISOString()};});
  const runtime=createAccountRuntime({defaultStore:store,defaultWorkspace:'workspace',principalFor:()=>owner});
  const request=operation=>runtime.middleware({path:'/api/products/p/search',method:'POST',body:{},get:name=>name==='X-Workspace-ID'?'workspace':undefined},{},cause=>{if(cause)throw cause;return operation(runtime.store);});
  return {backend,store,runtime,request};
}
const expiry=data=>{data.subscription.paidUntil=new Date(Date.now()-1).toISOString();};
const blocked=data=>{data.products[0].planMonitoringBlocked='plan_capacity';};

test('member search claims recheck payment, product blocking and revocation after request authorization',async()=>{
  for(const [change,code]of [[expiry,'subscription_inactive'],[blocked,'plan_capacity'],[data=>{data.products[0].archived=true;},'product_archived'],[data=>{data.workspace.members[owner.sub].status='revoked';},'membership_required']]){
    const f=await fixture();
    await assert.rejects(()=>f.request(async scoped=>{await f.store.mutate(change);return scoped.claimSearch('p');}),error=>error.code===code);
    assert.equal((await f.store.snapshot()).leases?.p,undefined);
  }
});

test('service search claims reject expired, cancelled, blocked, archived and deleted products',async()=>{
  for(const [change,code]of [[expiry,'subscription_inactive'],[data=>{data.subscription.status='cancelled';},'subscription_inactive'],[blocked,'plan_capacity'],[data=>{data.products[0].archived=true;},'product_archived'],[data=>{data.products=[];},'product_not_found']]){
    const f=await fixture();await f.store.mutate(change);
    await assert.rejects(()=>f.store.claimSearch('p'),error=>error.code===code);
    assert.equal((await f.store.snapshot()).leases?.p,undefined);
  }
});

test('both search CAS paths recheck a downgrade when the first publication loses a race',async()=>{
  for(const member of [false,true]){
    const f=await fixture();f.backend.conflictOnce(blocked);
    await assert.rejects(()=>member?f.request(scoped=>scoped.claimSearch('p')):f.store.claimSearch('p'),{code:'plan_capacity'});
    assert.equal((await f.store.snapshot()).leases?.p,undefined);
  }
});

test('active paid work leases still serialize and legacy service search remains compatible',async()=>{
  const f=await fixture(),token=await f.request(scoped=>scoped.claimSearch('p'));
  assert.equal(typeof token,'string');assert.equal(await f.store.claimSearch('p'),null);
  await f.store.releaseSearch('p',token);assert.equal(typeof await f.store.claimSearch('p'),'string');
  const legacy=new FirestoreStore(memoryBackend());assert.equal(typeof await legacy.claimSearch('legacy'),'string');
});
