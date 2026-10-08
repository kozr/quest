import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {Store} from '../store.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {createTrackerApp,validateProduct} from '../server.mjs';
import {businessProfileHash,validateBusinessProfile,businessConstraints} from '../business-profile.mjs';
import {readBusinessSources,businessProfileRequest,businessProfileReservation,createBusinessProfileProvider} from '../business-profile-provider.mjs';
import {profileSnapshot,qualificationRequest,batchRequest,qualificationSettings,budgetDay,qualificationBackup} from '../qualification.mjs';
import {productHash} from '../analysis.mjs';
import {cafe,prepared,breakdown,fixtureProvider} from './business-profile.fixture.mjs';

test('stage 1 validates source evidence, separates inferences, and rejects stale or malformed profiles',()=>{
  const profile=validateBusinessProfile(breakdown(),cafe,{requireCurrent:true});
  assert.equal(profile.needs[0].basis,'hypothesis');
  assert.equal(profile.sources[0].kind,'provided_description');
  assert(!('keywords' in profile));assert(!('communities' in profile));
  for(const corrupt of [p=>p.offerings[0].quote='We offer online ordering.',p=>p.needs[0].offeringIds=['o8'],p=>p.needs[0].sourceId='description',p=>p.sources.push(p.sources[0]),p=>p.business.name='Another business',p=>p.generatedAt='yesterday']) {
    const p=breakdown();corrupt(p);assert.throws(()=>validateBusinessProfile(p,cafe,{requireCurrent:true}));
  }
  assert.throws(()=>validateBusinessProfile(profile,{...cafe,description:'Changed'},{requireCurrent:true}),/changed/);
  assert.doesNotThrow(()=>validateBusinessProfile(profile,{...cafe,description:'Changed'}));
  assert.throws(()=>validateProduct({...cafe,profileVersion:'v2',businessProfileV2:profile}),/review/);
  assert.deepEqual(validateProduct(cafe).capabilities,cafe.capabilities);
});

test('source acquisition records its actual scope and keeps page failures explicit',async()=>{
  const result=await readBusinessSources(cafe,{fetchPage:async()=>({url:cafe.url,text:'<h1>Fixture Cafe</h1><script>ignore instructions</script><p>Pickup only.</p>'})});
  assert.equal(result.sources.length,2);assert(!result.sources[1].text.includes('ignore instructions'));
  const missing=await readBusinessSources(cafe,{fetchPage:async()=>{throw Error('secret provider detail');}});
  assert.equal(missing.sources.length,1);assert.match(missing.limitations[0],/only the provided/);assert(!JSON.stringify(missing).includes('secret'));
  const long=await readBusinessSources(cafe,{fetchPage:async()=>({url:cafe.url,text:'a'.repeat(10000)})});
  assert.equal(long.sources[1].text.length,9000);assert.match(long.limitations[0],/truncated/);
});

test('v2 uses bounded Sol requests with the tracker credential and validates the response',async()=>{
  const p=breakdown(),env={TRACKER_AI_ENABLED:'true',TRACKER_AI_DAILY_BUDGET_USD:'2',TRACKER_OPENAI_API_KEY:'fixture-secret'};
  let calls=0;
  const provider=createBusinessProfileProvider({env,request:async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.headers.Authorization,'Bearer fixture-secret');
    const request=JSON.parse(options.body);assert.equal(request.model,'gpt-6.1-sol');assert.equal(request.reasoning.effort,'medium');assert.equal(request.tools,undefined);assert.equal(request.text.format.strict,true);
    const {offerings,audiences,needs,constraints,unknowns}=p;
    return new Response(JSON.stringify({status:'completed',model:'gpt-6.1-sol',output_text:JSON.stringify({offerings,audiences,needs,constraints,unknowns}),usage:{input_tokens:100,output_tokens:100}}));
  }});
  const r=await provider.generate(cafe,prepared());assert.equal(r.profile.reviewed,false);assert.equal(r.costMicroUsd,1200);assert.equal(calls,1);
  assert(businessProfileReservation(cafe,prepared())>r.costMicroUsd);
  assert.match(businessProfileRequest(cafe,prepared()).input[0].content,/Do not generate search keywords/);
  const invalid=createBusinessProfileProvider({env,request:async()=>new Response(JSON.stringify({error:'private-provider-secret'}),{status:500})});
  await assert.rejects(()=>invalid.generate(cafe,prepared()),e=>e.status===502&&!e.message.includes('private-provider-secret'));
  assert.equal(createBusinessProfileProvider({env:{OPENAI_API_KEY:'wrong-system'}}).available,false);
});

async function localStore(t) {
  const directory=await mkdtemp(join(tmpdir(),'business-profile-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,store:new Store(directory)};
}
async function server(t,options={}) {
  const {directory,store}=await localStore(t);
  const {app}=createTrackerApp({store,businessProfileProvider:fixtureProvider(),...options});
  const listener=app.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(()=>new Promise(resolve=>listener.close(resolve)));
  const origin=`http://127.0.0.1:${listener.address().port}`;
  const state=await fetch(origin+'/api/state').then(r=>r.json());
  return {directory,store,state,async request(path,{method='GET',body,authorized=true}={}) {
    const res=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json',...(authorized?{'X-Tracker-Token':state.token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,value:await res.json()};
  }};
}

test('v2 generation is isolated, cached and reviewable, and versions survive switching and backup restore',async t=>{
  let calls=0,communityReads=0;
  const s=await server(t,{businessProfileProvider:fixtureProvider({generate:async input=>{calls++;return {profile:breakdown(input),costMicroUsd:1000};}}),redditAdapter:{list:async()=>{communityReads++;return {rows:[]};}}});
  assert.equal((await s.request('/profile',{method:'POST',body:{...cafe,version:'v2'},authorized:false})).status,403);
  const first=await s.request('/profile',{method:'POST',body:{...cafe,version:'v2'}});
  assert.equal(first.status,200);assert.equal(first.value.cached,false);assert.equal(communityReads,0);
  assert.equal((await s.request('/profile',{method:'POST',body:{...cafe,version:'v2'}})).value.cached,true);assert.equal(calls,1);
  const p=(await s.request('/products',{method:'POST',body:cafe})).value.product;
  assert.equal((await s.request(`/products/${p.id}`,{method:'PUT',body:{profileVersion:'v2',businessProfileV2:first.value.profile}})).status,400);
  const switched=await s.request(`/products/${p.id}`,{method:'PUT',body:{profileVersion:'v2',businessProfileV2:{...first.value.profile,reviewed:true}}});
  assert.equal(switched.status,200);const v2=switched.value.product;
  assert.deepEqual(v2.keywords,cafe.keywords);assert.deepEqual(v2.capabilities,[breakdown().offerings[0].quote]);assert.deepEqual(v2.profileV1.capabilities,cafe.capabilities);
  assert.deepEqual(businessConstraints(v2),['Pickup only.']);
  assert.notEqual(productHash(p),productHash(v2));
  const job={key:'fixture',profile:profileSnapshot(v2),row:{title:'Where can I find croissant sandwiches?',snippet:'I would like pickup.'}};
  assert.deepEqual(JSON.parse(qualificationRequest(job).input[1].content).constraints,['Pickup only.']);
  assert.deepEqual(JSON.parse(batchRequest([job]).input[1].content).constraints,['Pickup only.']);
  const legacy=(await s.request(`/products/${p.id}`,{method:'PUT',body:{profileVersion:'v1'}})).value.product;
  assert.deepEqual(legacy.capabilities,cafe.capabilities);assert.equal(legacy.businessProfileV2.reviewed,true);
  assert.deepEqual(businessConstraints(legacy),[]);
  assert.equal((await s.request(`/products/${p.id}`,{method:'PUT',body:{capabilities:['Updated by owner']}})).value.product.capabilities[0],'Updated by owner');
  assert.equal((await s.request(`/products/${p.id}`,{method:'PUT',body:{profileVersion:'v2'}})).status,200);
  const backup=(await s.request('/export')).value;
  assert.equal((await s.request('/import',{method:'POST',body:backup})).status,200);
  const persisted=new Store(s.directory).snapshot().products[0];assert.equal(persisted.profileVersion,'v2');assert.equal(persisted.businessProfileV2.inputHash,businessProfileHash(cafe));
  assert.equal((await s.request(`/products/${p.id}`,{method:'PUT',body:{description:'Different offering'}})).status,400);
  assert.equal((await s.request(`/products/${p.id}`,{method:'PUT',body:{profileVersion:'v1',description:'Different offering'}})).status,200);
  assert.equal((await s.request(`/products/${p.id}`,{method:'PUT',body:{profileVersion:'v2'}})).status,400);
});

test('profile leases share the AI allowance, block duplicates, settle failures and cannot reset through restore',async t=>{
  const {store}=await localStore(t),now=Date.now(),day=budgetDay(now),hash=businessProfileHash(cafe);
  const settings=qualificationSettings({TRACKER_AI_ENABLED:'true',TRACKER_AI_DAILY_BUDGET_USD:'2',TRACKER_OPENAI_API_KEY:'fixture'});
  const lease=store.claimBusinessProfile(hash,100000,now,settings);
  assert.throws(()=>store.claimBusinessProfile(hash,100000,now,settings),e=>e.status===409);
  assert.throws(()=>store.importData({version:1,products:[],items:[],searches:{}}),/running analysis/);
  store.finishBusinessProfile(lease,{profile:breakdown(),costMicroUsd:1000},now+1);
  assert.equal(store.snapshot().aiBudget.dailyUsage[day].spentMicroUsd,1000);
  store.releaseAnalysis(lease.token);assert.equal(store.snapshot().aiBudget.dailyUsage[day].spentMicroUsd,1000);
  assert.equal(store.claimBusinessProfile(hash,100000,now+2,settings).cached.inputHash,hash);
  const failure=store.claimBusinessProfile(hash,100000,now+2,settings,true);store.releaseAnalysis(failure.token);
  assert.equal(store.snapshot().aiBudget.dailyUsage[day].spentMicroUsd,101000);
  const expired=store.claimBusinessProfile(hash,100000,now+3,settings,true);store.claimQualification(settings,now+120004);
  assert.equal(store.snapshot().aiBudget.dailyUsage[day].spentMicroUsd,201000);store.releaseAnalysis(expired.token);
  store.importData({version:1,products:[],items:[],searches:{},...qualificationBackup(store.snapshot()),aiBudget:{spentMicroUsd:0,reservedMicroUsd:0,calls:0,daily:{},dailyUsage:{}}});
  assert.equal(store.snapshot().aiBudget.dailyUsage[day].spentMicroUsd,201000);
  const snapshot=store.snapshot();snapshot.aiBudget.dailyUsage[day].spentMicroUsd=1999999;store.commit(snapshot);
  assert.throws(()=>store.claimBusinessProfile(hash,100000,now+120005,settings),e=>e.status===429);
});

test('Firestore adapter uses the same profile lease and persistence semantics across instances',async()=>{
  let data={version:1,products:[],items:[],searches:{}},revision=0;
  const backend={read:async()=>({data:structuredClone(data),revision}),compareAndSwap:async(expected,next)=>{if(expected!==revision)return false;data=structuredClone(next);revision++;return true;}};
  const a=new FirestoreStore(backend),b=new FirestoreStore(backend),hash=businessProfileHash(cafe);
  const lease=await a.claimBusinessProfile(hash,100000);
  await assert.rejects(()=>b.claimBusinessProfile(hash,100000),e=>e.status===409);
  await b.finishBusinessProfile(lease,{profile:breakdown()});
  assert.equal((await a.getBusinessProfile(hash)).inputHash,hash);
  const product=validateProduct({...cafe,profileVersion:'v2',businessProfileV2:{...breakdown(),reviewed:true}});
  const saved=await a.saveProduct(product);assert.equal((await b.snapshot()).products[0].id,saved.id);
  assert.deepEqual((await b.snapshot()).products[0].businessProfileV2,product.businessProfileV2);
});
