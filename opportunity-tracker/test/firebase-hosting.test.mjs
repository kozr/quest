import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuth} from '../auth.mjs';
import {createTrackerApp} from '../server.mjs';
import {Store} from '../store.mjs';
import {firebaseRuntimeConfig,runFirebaseMonitorTick} from '../firebase-entry.mjs';
import {googleOptions,googleClientId,googleAllowedEmails,sessionSecret,verifyGoogleIdToken,credential} from './google-fixture.mjs';

const req=(cookie='',nonce,token)=>({headers:{cookie},get:()=>nonce,body:{credential:token}});
const res=()=>({cookies:[],append(_key,value){this.cookies.push(value);}});
const options={clientId:googleClientId,allowedEmails:googleAllowedEmails,secret:sessionSecret,verifyIdToken:verifyGoogleIdToken,cookieMode:'firebase-hosting'};
test('Hosting forwards one signed cookie for the challenge and then the session; login does not erase the session',async()=>{
  const auth=createAuth(options),challengeResponse=res(),challenge=auth.challenge(req(),challengeResponse);
  const challengeCookie=challengeResponse.cookies[0].split(';')[0];assert.match(challengeCookie,/^__session=/);
  assert.equal(auth.authenticated(req(challengeCookie)),false);
  const login=res();await auth.login(req(challengeCookie,challenge.nonce,credential(challenge.nonce)),login);
  const sessionCookie=login.cookies.find(x=>x.startsWith('__session='));
  assert(sessionCookie);assert.equal(login.cookies.filter(x=>x.startsWith('__session=')).length,1);
  assert.equal(createAuth(options).authenticated(req(sessionCookie.split(';')[0])),true);
  assert.equal(auth.authenticated(req(sessionCookie.split(';')[0]+'tampered')),false);
  assert.equal(auth.authenticated(req(sessionCookie.split(';')[0]+'; '+sessionCookie.split(';')[0])),false);
  const out=res();auth.logout(out);assert.equal(out.cookies.length,1);assert.match(out.cookies[0],/^__session=;.*Max-Age=0/);
  await assert.rejects(()=>auth.login(req(sessionCookie.split(';')[0],challenge.nonce,credential(challenge.nonce)),res()),{status:403});
});
test('Hosting rejects insecure cookie mode and uninvited Google accounts',async()=>{
  assert.throws(()=>createAuth({...options,secure:false}));assert.throws(()=>createAuth({...options,cookieMode:'unknown'}));
  const auth=createAuth(options),r=res(),c=auth.challenge(req(),r);
  await assert.rejects(()=>auth.login(req(r.cookies[0].split(';')[0],c.nonce,credential(c.nonce,{email:'intruder@gmail.com'})),res()),{status:403});
});
test('exact public Hosting origins survive an internal proxy Host; arbitrary origins and missing CSRF still fail',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'tracker-firebase-'));const store=new Store(directory);
  const app=createTrackerApp({hosted:true,store,...googleOptions,qualificationEnv:{TRACKER_AUTH_COOKIE_MODE:'firebase-hosting',TRACKER_PUBLIC_ORIGINS:'https://hearwhispers-dashboard.web.app'}}).app;
  const listener=app.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(async()=>{await new Promise(resolve=>listener.close(resolve));await rm(directory,{recursive:true,force:true});});
  const send=(path,options={})=>fetch(`http://127.0.0.1:${listener.address().port}${path}`,{...options,headers:{Host:'internal.run.app','X-Forwarded-Proto':'https',Origin:'https://hearwhispers-dashboard.web.app','Content-Type':'application/json',...options.headers}});
  const a=await send('/api/auth'),c=await a.json(),cookie=a.headers.getSetCookie()[0].split(';')[0];
  const attempt={method:'POST',headers:{Cookie:cookie,'X-Tracker-Login':c.google.nonce},body:JSON.stringify({credential:credential(c.google.nonce)})};
  assert.equal((await send('/api/login/google',{...attempt,headers:{...attempt.headers,Origin:'https://evil.example'}})).status,403);
  const login=await send('/api/login/google',attempt);assert.equal(login.status,200);
  const session=login.headers.getSetCookie()[0].split(';')[0];const state=await send('/api/state?light=1',{headers:{Cookie:session}});assert.equal(state.status,200);
  assert.equal((await send('/api/logout',{method:'POST',headers:{Cookie:session},body:'{}'})).status,403);
  const token=(await state.json()).token;assert.equal((await send('/api/logout',{method:'POST',headers:{Cookie:session,'X-Tracker-Token':token},body:'{}'})).status,200);
});
test('Firebase runtime refuses stale storage targets and Vercel credentials',()=>{
  const config={FIREBASE_PROJECT_ID:'the-app-quest',FIREBASE_DATABASE_ID:'opportunity-tracker',TRACKER_WORKSPACE:'personal',TRACKER_RECORD_STORAGE_ENABLED:'true',TRACKER_AUTH_COOKIE_MODE:'firebase-hosting',TRACKER_PUBLIC_ORIGINS:'https://hearwhispers-dashboard.web.app'};
  const read=c=>firebaseRuntimeConfig({HEARWHISPERS_RUNTIME_CONFIG:JSON.stringify(c)});
  assert.deepEqual(read(config),config);
  for(const change of [{FIREBASE_DATABASE_ID:'(default)'},{TRACKER_RECORD_STORAGE_ENABLED:'false'},{GCP_WIF_PROVIDER:'old-vercel'},{NODE_OPTIONS:'unsafe'}])assert.throws(()=>read({...config,...change}));
});
test('worker uses existing due jobs and scheduled claims, isolates failures and respects its time bound',async()=>{
  const calls=[],snapshot={products:[{id:'a',monitoring:true,communities:['c']},{id:'b',monitoring:true,communities:['c']}],searches:{}};
  let clock=Date.now();
  const current={store:{snapshot:async()=>snapshot},runSearch:async(id,scheduled)=>{calls.push([id,scheduled]);clock+=100;throw new Error('provider unavailable');},runQualification:async()=>{calls.push('qualification');}};
  const result=await runFirebaseMonitorTick(current,{now:()=>clock,maxDurationMs:50});
  assert.deepEqual(calls,[['a',true]]);assert.deepEqual(result,{checked:0,failed:1,qualification:'deferred'});
});
