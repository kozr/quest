import test from 'node:test';
import assert from 'node:assert/strict';
import { Firestore } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { once } from 'node:events';
import { configuredFirestore, createVercelAuthClient, FirestoreBackend, FirestoreStore } from '../firestore-store.mjs';
import { createTrackerApp } from '../server.mjs';

import {googleOptions,credential} from './google-fixture.mjs';
const secret='test-only-session-secret-that-is-at-least-32-chars';
const product={name:'Tracker test',url:'https://tracker.dev',description:'A tool for specific tasks',keywords:['task management'],aliases:['Tracker test'],exclusions:[]};
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
if (emulator && !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(emulator)) throw new Error('Tracker tests require a local Firestore emulator.');
const firestoreTest = {skip: emulator ? false : 'Start the Firestore emulator and set FIRESTORE_EMULATOR_HOST to run these integration tests.'};
async function backend(t) {
  const databases=[];
  const workspace=`fixture-${randomUUID()}`;
  const create=()=>{
    const db=new Firestore({projectId:'demo-opportunity-tracker'});
    databases.push(db);
    return new FirestoreBackend(db,workspace);
  };
  t.after(async()=>{
    if (databases.length) await databases[0].recursiveDelete(databases[0].collection('opportunityTrackers').doc(workspace));
    await Promise.all(databases.map(db=>db.terminate()));
  });
  return {create};
}
async function server(t,store) {
  const app=createTrackerApp({hosted:true,store,...googleOptions,discoverFn:async()=>({items:[],sources:[],searchedAt:new Date().toISOString()})}).app;
  const listener=app.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(()=>new Promise(resolve=>listener.close(resolve)));
  return async(path,{method='GET',body,cookie,token,loginNonce,origin='https://tracker.vercel.app'}={})=>{
    const result=await new Promise((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port:listener.address().port,path,method,headers:{Host:'tracker.vercel.app','X-Forwarded-Proto':'https',Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(token?{'X-Tracker-Token':token}:{}),...(loginNonce?{'X-Tracker-Login':loginNonce}:{})}},res=>{
        const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,value:JSON.parse(Buffer.concat(chunks).toString())}));
      });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
    });return result;
  };
}

test('cloud instances preserve LinkedIn settings, source coverage, identity and decisions', firestoreTest, async t => {
  const {create} = await backend(t);
  const a = new FirestoreStore(create()), b = new FirestoreStore(create());
  const p = await a.saveProduct({...product, communities: [], linkedin: true, monitoring: true});
  assert.deepEqual(await b.activeSearches(), []);
  const item = {url: 'https://www.linkedin.com/posts/demo-person_fixture-share-7507254982996332545-AbCd', title: 'I need task management help', kind: 'opportunity', source: 'LinkedIn', provider: 'linkedin-mcp', sourceId: 'li_7507254982996332545', postId: '7507254982996332545', type: 'post'};
  await a.recordSearch(p.id, {searchedAt: new Date().toISOString(), trigger: 'scheduled', sources: [{name: 'LinkedIn', status: 'ok', count: 1, coverage: [{provider: 'linkedin-mcp', partial: true}]}], items: [item]});
  const id = (await b.snapshot()).items[0].id;
  await b.updateItem(id, {status: 'saved', note: 'Check the linked post.'});
  await a.recordSearch(p.id, {searchedAt: new Date().toISOString(), trigger: 'manual', sources: [{name: 'LinkedIn', status: 'error', message: 'Session renewal required.'}], items: []});
  const snapshot = await new FirestoreStore(create()).snapshot();
  assert.equal(snapshot.products[0].linkedin, true);
  assert.equal(snapshot.items[0].sourceId, item.sourceId);
  assert.equal(snapshot.items[0].status, 'saved');
  assert.equal(snapshot.items[0].note, 'Check the linked post.');
  assert.equal(snapshot.searches[p.id].sources[0].status, 'error');
  const morning = Date.parse('2026-10-05T15:00:00Z');
  const evening = Date.parse('2026-10-06T03:00:00Z');
  const scheduled = await a.saveProduct({...product, communities: ['productivity'], linkedin: true, monitoring: true});
  assert.deepEqual((await a.markMonitorAttempt(scheduled.id, morning)).sources, ['reddit', 'linkedin']);
  assert.equal(await b.markMonitorAttempt(scheduled.id, morning + 60000), null);
  assert.deepEqual((await b.markMonitorAttempt(scheduled.id, morning + 2 * 3600000)).sources, ['reddit']);
  assert.deepEqual((await new FirestoreStore(create()).markMonitorAttempt(scheduled.id, evening)).sources, ['reddit', 'linkedin']);
  assert.equal((await a.snapshot()).products.find(row => row.id === scheduled.id).monitorAttempts.linkedin, new Date(evening).toISOString());
});

test('actual Firestore transactions persist across cloud instances without losing concurrent updates',firestoreTest,async t=>{
  const {create}=await backend(t);
  const a=new FirestoreStore(create()),b=new FirestoreStore(create());
  await a.snapshot();await b.snapshot();
  const products=await Promise.all(Array.from({length:8},(_,i)=>(i%2?a:b).saveProduct({...product,name:`Product ${i}`})));
  assert.equal((await new FirestoreStore(create()).snapshot()).products.length,8);
  const id=products[0].id;
  await a.recordSearch(id,{searchedAt:new Date().toISOString(),sources:[],items:[{url:'https://news.ycombinator.com/item?id=1',title:'Need help',kind:'opportunity'}]});
  const item=(await b.snapshot()).items[0];
  await Promise.all([a.updateItem(item.id,{status:'saved'}),b.updateItem(item.id,{note:'Keep this note'})]);
  const saved=(await new FirestoreStore(create()).snapshot()).items[0];
  assert.equal(saved.status,'saved');assert.equal(saved.note,'Keep this note');
});

test('search leases are shared across instances, imports cannot race searches, and stale releases do not unlock new work',firestoreTest,async t=>{
  const {create}=await backend(t);const a=new FirestoreStore(create()),b=new FirestoreStore(create());
  const p=await a.saveProduct(product);
  const first=await a.claimSearch(p.id);
  assert.ok(first);assert.equal(await b.claimSearch(p.id),null);
  assert.deepEqual(await b.activeSearches(),[p.id]);
  await assert.rejects(()=>b.importData({version:1,products:[],items:[],searches:{}}),/running searches/);
  await b.releaseSearch(p.id,'wrong-token');assert.equal(await a.claimSearch(p.id),null);
  await b.releaseSearch(p.id,first);const second=await a.claimSearch(p.id);assert.ok(second);
  await a.releaseSearch(p.id,first);assert.deepEqual(await b.activeSearches(),[p.id]);
  await a.releaseSearch(p.id,second);assert.deepEqual(await b.activeSearches(),[]);
});

test('hosted data requires an invited Google identity and stable signed sessions/CSRF work across independent functions',firestoreTest,async t=>{
  const {create}=await backend(t);const a=await server(t,new FirestoreStore(create())),b=await server(t,new FirestoreStore(create()));
  assert.equal((await a('/api/state')).status,401);
  assert.equal((await a('/api/export')).status,401);
  const challenge=await a('/api/auth'),loginNonce=challenge.value.google.nonce;
  const loginOptions={method:'POST',cookie:challenge.headers['set-cookie'][0].split(';')[0],loginNonce,body:{credential:credential(loginNonce)}};
  assert.equal((await a('/api/login',{method:'POST',body:{password:'retired'}})).status,401);
  assert.equal((await a('/api/login/google',{...loginOptions,origin:'https://evil.dev'})).status,403);
  const login=await a('/api/login/google',loginOptions);assert.equal(login.status,200);
  const setCookie=login.headers['set-cookie'][0];assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Strict/);
  const cookie=setCookie.split(';')[0];
  const state=await b('/api/state',{cookie});assert.equal(state.status,200);assert.equal(state.value.storage,'cloud');
  const token=state.value.token;
  assert.equal((await a('/api/products',{method:'POST',body:product,cookie})).status,403);
  assert.equal((await a('/api/products',{method:'POST',body:product,cookie,token,origin:'https://evil.dev'})).status,403);
  assert.equal((await a('/api/products',{method:'POST',body:product,cookie,token})).status,201);
  assert.equal((await b('/api/state',{cookie})).value.products.length,1);
  assert.equal((await b('/api/state',{cookie:cookie+'tampered'})).status,401);
  const loggedOut=await b('/api/logout',{method:'POST',body:{},cookie,token});assert.match(loggedOut.headers['set-cookie'][0],/Max-Age=0/);
});

test('hosted configuration never falls back to ephemeral files and Firebase errors never expose credentials',async()=>{
  assert.throws(()=>createTrackerApp({hosted:true,...googleOptions,firebaseProjectId:''}),/FIREBASE_PROJECT_ID/);
  assert.throws(()=>createTrackerApp({hosted:true,...googleOptions,googleClientId:''}),/Hosted login/);
  assert.throws(()=>configuredFirestore({projectId:'demo-opportunity-tracker',serviceAccountJson:'DO_NOT_EXPOSE'}),error=>!error.message.includes('DO_NOT_EXPOSE')&&/FIREBASE_SERVICE_ACCOUNT_JSON/.test(error.message));
  const value=new FirestoreBackend({collection:()=>({doc:()=>({})}),runTransaction:async()=>{throw new Error('private_key=DO_NOT_EXPOSE');}});
  await assert.rejects(()=>value.read(),error=>error.status===503&&!error.message.includes('DO_NOT_EXPOSE'));
  await assert.rejects(()=>value.compareAndSwap(0,{}),error=>error.status===503&&!error.message.includes('DO_NOT_EXPOSE'));
});

test('Firestore stores snapshots larger than one document and atomically removes old chunks on restore',firestoreTest,async t=>{
  const {create}=await backend(t);const a=new FirestoreStore(create()),b=new FirestoreStore(create());
  const data={version:1,products:[{...product,id:'large'}],items:Array.from({length:160},(_,i)=>({id:String(i),productId:'large',snippet:'界'.repeat(3000),matchedTerms:[['nested arrays are serialized safely']]})),searches:{}};
  await a.importData(data);
  const restored=await b.snapshot();
  for(const key of ['version','products','items','searches'])assert.deepEqual(restored[key],data[key]);
  assert.deepEqual(restored.analysisUsage,{});
  assert.deepEqual(restored.conversationReviewReceipts,{});
  const database=b.backend;
  assert.ok((await database.document.get()).data().chunks>1);
  await b.importData({version:1,products:[],items:[],searches:{}});
  assert.equal((await database.document.collection('stateChunks').get()).size,1);
  assert.deepEqual((await a.snapshot()).items,[]);
});

test('Vercel federation obtains fresh identity tokens and rejects mismatched project credentials',async()=>{
  const configuration={projectId:'demo-opportunity-tracker',provider:'projects/123456789/locations/global/workloadIdentityPools/tracker/providers/vercel',serviceAccountEmail:'vercel-tracker@demo-opportunity-tracker.iam.gserviceaccount.com'};
  let count=0;
  const auth=createVercelAuthClient({...configuration,tokenSupplier:async()=>`fixture-token-${++count}`});
  assert.equal(await auth.retrieveSubjectToken(),'fixture-token-1');
  assert.equal(await auth.retrieveSubjectToken(),'fixture-token-2');
  assert.throws(()=>createVercelAuthClient({...configuration,provider:'https://untrusted.example/token'}),/GCP_WIF_PROVIDER/);
  assert.throws(()=>createVercelAuthClient({...configuration,serviceAccountEmail:'other@another-project.iam.gserviceaccount.com'}),/GCP_SERVICE_ACCOUNT_EMAIL/);
  assert.throws(()=>configuredFirestore({...configuration,databaseId:'../default'}),/FIREBASE_DATABASE_ID/);
  const db=configuredFirestore({...configuration,databaseId:'opportunity-tracker'});
  assert.equal(db.projectId,configuration.projectId);
  assert.equal(db.databaseId,'opportunity-tracker');
  await db.terminate();
});

test('analysis reservations and results are shared across cloud instances without resetting allowance on restore',firestoreTest,async t=>{
  const {create}=await backend(t);const a=new FirestoreStore(create()),b=new FirestoreStore(create());
  const p=await a.saveProduct({...product,capabilities:['Manage tasks'],needs:['Remember tasks']});
  const claims=await Promise.allSettled([a.claimAnalysis(p.id),b.claimAnalysis(p.id)]);
  assert.equal(claims.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(claims.find(row=>row.status==='rejected').reason.status,409);
  const lease=claims.find(row=>row.status==='fulfilled').value;
  await assert.rejects(()=>b.importData({version:1,products:[],items:[],searches:{}}),/running analysis/);
  await b.finishAnalysis(lease,{findings:[],landscape:[],people:[],coverage:'No supported findings.'});
  assert.equal((await new FirestoreStore(create()).snapshot()).research[p.id].coverage,'No supported findings.');
  const before=(await a.backend.read()).data.analysisUsage;
  await b.importData({version:1,products:[p],items:[],searches:{}});
  assert.deepEqual((await a.backend.read()).data.analysisUsage,before);
  const changed=await a.claimAnalysis(p.id);await b.saveProduct({...p,description:'Changed during analysis'},p.id);
  await assert.rejects(()=>b.finishAnalysis(changed,{findings:[],landscape:[],people:[],coverage:'Should not save.'}),error=>error.status===409);
  await b.releaseAnalysis(changed.token);assert.equal((await a.snapshot()).research,undefined);
});

test('qualification and research atomically share the Pacific daily budget across Firestore instances',firestoreTest,async t=>{
 const {qualificationSettings,budgetDay,qualificationBackup}=await import('../qualification.mjs');
 const settings=qualificationSettings({TRACKER_OPENAI_API_KEY:'fixture',TRACKER_AI_ENABLED:'true',TRACKER_AI_DAILY_BUDGET_USD:'2'});
 const {create}=await backend(t),a=new FirestoreStore(create()),b=new FirestoreStore(create());
 const p=await a.saveProduct({...product,capabilities:['Manage tasks'],needs:['Remember tasks']}),q=await a.saveProduct({...product,name:'Another product',capabilities:['Manage tasks']});
 const now=Date.now(),day=budgetDay(now);
 const claims=await Promise.allSettled([a.claimAnalysis(p.id,null,now,settings),b.claimAnalysis(q.id,null,now,settings)]);
 assert.equal(claims.filter(c=>c.status==='fulfilled').length,1);assert.equal(claims.find(c=>c.status==='rejected').reason.status,429);
 let snapshot=await a.snapshot();assert.equal(snapshot.aiBudget.dailyUsage[day].reservedMicroUsd,1100000);assert.equal(snapshot.aiBudget.dailyUsage[day].calls,1);
 await a.finishAnalysis(claims.find(c=>c.status==='fulfilled').value,{findings:[],landscape:[],people:[],coverage:'Fixture',costMicroUsd:10000},now+1000);
 const remaining=await b.claimAnalysis(q.id,null,now+2000,settings);await b.releaseAnalysis(remaining.token);
 snapshot=await b.snapshot();assert.equal(snapshot.aiBudget.dailyUsage[day].spentMicroUsd,1110000);assert.equal(snapshot.aiBudget.dailyUsage[day].reservedMicroUsd,0);
 const old={version:1,products:snapshot.products,items:[],searches:{},...qualificationBackup({qualifications:{},qualificationMigrations:{},aiBudget:{spentMicroUsd:0,reservedMicroUsd:0,calls:0,daily:{},dailyUsage:{}}})};
 await a.importData(old);assert.equal((await b.snapshot()).aiBudget.dailyUsage[day].spentMicroUsd,1110000);
});
