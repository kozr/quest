import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {request} from 'node:http';
import {createAuth} from '../auth.mjs';
import {createTrackerApp} from '../server.mjs';
import {Store} from '../store.mjs';
import {googleOptions,googleClientId,googleAllowedEmails,sessionSecret,verifyGoogleIdToken,credential} from './google-fixture.mjs';

const options={clientId:googleClientId,allowedEmails:googleAllowedEmails,secret:sessionSecret,verifyIdToken:verifyGoogleIdToken};
const req=(cookie='',nonce,token)=>({headers:{cookie},get:()=>nonce,body:{credential:token}});
const res=()=>({cookies:[],append(_key,value){this.cookies.push(value);}});
const cookies=response=>response.cookies.map(x=>x.split(';')[0]).join('; ');
function challenge(auth){const response=res();const value=auth.challenge(req(),response);return {...value,cookie:cookies(response)};}

test('Google signature, audience, issuer, expiry, nonce and verified identity are required',async()=>{
  const auth=createAuth(options),c=challenge(auth);
  for(const claims of [{aud:'other-client'},{iss:'https://evil.example'},{exp:Math.floor(Date.now()/1000)-600},{nonce:'other'},{email_verified:false},{sub:''}]) {
    await assert.rejects(()=>auth.login(req(c.cookie,c.nonce,credential(c.nonce,claims)),res()),{status:401});
  }
  const valid=credential(c.nonce),parts=valid.split('.');
  parts[1]=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(parts[1],'base64url')),email:'intruder@gmail.com'})).toString('base64url');
  await assert.rejects(()=>auth.login(req(c.cookie,c.nonce,parts.join('.')),res()),{status:401});
  const response=res();await auth.login(req(c.cookie,c.nonce,valid),response);
  assert.equal(auth.authenticated(req(response.cookies[0].split(';')[0])),true);
  assert.match(response.cookies[0],/HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
  assert.match(response.cookies[1],/Max-Age=0/);
});

test('unknown Google accounts and non-authoritative email identities cannot enter the shared workspace',async()=>{
  const auth=createAuth(options),c=challenge(auth);
  await assert.rejects(()=>auth.login(req(c.cookie,c.nonce,credential(c.nonce,{email:'intruder@gmail.com'})),res()),{status:403});
  const external=createAuth({...options,allowedEmails:'owner@example.com'}),e=challenge(external);
  await assert.rejects(()=>external.login(req(e.cookie,e.nonce,credential(e.nonce,{email:'owner@example.com'})),res()),{status:403});
  const pinned=createAuth({...options,allowedEmails:'',allowedSubjects:'123456789012345678901'}),p=challenge(pinned),response=res();
  await pinned.login(req(p.cookie,p.nonce,credential(p.nonce,{email:'owner@example.com'})),response);
  assert.equal(pinned.authenticated(req(response.cookies[0].split(';')[0])),true);
});

test('login requires the same signed browser challenge, with a ten-minute lifetime',async()=>{
  let time=Date.now();const auth=createAuth({...options,now:()=>time}),c=challenge(auth),d=challenge(auth);
  for(const request of [req('',c.nonce,credential(c.nonce)),req(c.cookie,'wrong',credential(c.nonce)),req(d.cookie,c.nonce,credential(c.nonce)),req(c.cookie+'tampered',c.nonce,credential(c.nonce))]) {
    await assert.rejects(()=>auth.login(request,res()),{status:403});
  }
  time+=601000;
  await assert.rejects(()=>auth.login(req(c.cookie,c.nonce,credential(c.nonce)),res()),{status:403});
});

test('sessions survive other instances but reject tampering, expiry, revoked accounts and old password cookies',async()=>{
  let time=Date.now();const auth=createAuth({...options,now:()=>time}),c=challenge(auth),response=res();
  await auth.login(req(c.cookie,c.nonce,credential(c.nonce)),response);
  const cookie=response.cookies[0].split(';')[0],other=createAuth(options);
  assert.equal(other.authenticated(req(cookie)),true);assert.equal(other.csrf(req(cookie)),auth.csrf(req(cookie)));
  assert.equal(auth.authenticated(req(cookie+'tampered')),false);
  assert.equal(auth.authenticated(req(cookie+'; '+cookie)),false);
  assert.equal(auth.authenticated(req(cookie.replace('__Host-tracker_session','tracker_session'))),false);
  assert.equal(createAuth({...options,allowedEmails:'someone@gmail.com'}).authenticated(req(cookie)),false);
  time+=7*86400000+1;assert.equal(auth.authenticated(req(cookie)),false);
  const out=res();other.logout(out);assert.ok(out.cookies.every(x=>x.includes('Max-Age=0')));
});

async function server(t){
  const directory=await mkdtemp(join(tmpdir(),'tracker-google-'));
  const store=new Store(directory),app=createTrackerApp({hosted:true,store,...googleOptions,qualificationEnv:{}}).app;
  const listener=app.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(async()=>{await new Promise(resolve=>listener.close(resolve));await rm(directory,{recursive:true,force:true});});
  return async(path,{method='GET',body,cookie,nonce,token,origin='https://tracker.example'}={})=>new Promise((resolve,reject)=>{
    const outgoing=request({host:'127.0.0.1',port:listener.address().port,path,method,headers:{Host:'tracker.example','X-Forwarded-Proto':'https',Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(nonce?{'X-Tracker-Login':nonce}:{}),...(token?{'X-Tracker-Token':token}:{})}},incoming=>{
      const data=[];incoming.on('data',x=>data.push(x));incoming.on('end',()=>resolve({status:incoming.statusCode,headers:incoming.headers,value:JSON.parse(Buffer.concat(data))}));
    });outgoing.on('error',reject);outgoing.end(body?JSON.stringify(body):undefined);
  });
}

test('HTTP login protects data and mutations, removes password access, and signs out',async t=>{
  const send=await server(t);
  assert.equal((await send('/api/state')).status,401);
  const c=await send('/api/auth'),nonce=c.value.google.nonce,cookie=c.headers['set-cookie'][0].split(';')[0];
  const attempt={method:'POST',cookie,nonce,body:{credential:credential(nonce)}};
  assert.equal((await send('/api/login',{method:'POST',body:{password:'old-password'}})).status,401);
  assert.equal((await send('/api/login/google',{...attempt,origin:'https://evil.example'})).status,403);
  assert.equal((await send('/api/login/google',{...attempt,nonce:undefined})).status,403);
  const login=await send('/api/login/google',attempt);assert.equal(login.status,200);
  const session=login.headers['set-cookie'][0].split(';')[0],state=await send('/api/state',{cookie:session});
  assert.equal(state.status,200);assert.equal((await send('/api/auth',{cookie:session})).value.google,undefined);
  assert.equal((await send('/api/logout',{method:'POST',body:{},cookie:session})).status,403);
  const logout=await send('/api/logout',{method:'POST',body:{},cookie:session,token:state.value.token});
  assert.equal(logout.status,200);assert.ok(logout.headers['set-cookie'].every(x=>x.includes('Max-Age=0')));
});

test('failed sign-in attempts are rate limited and errors do not leak verifier details',async t=>{
  const send=await server(t),c=await send('/api/auth'),nonce=c.value.google.nonce,cookie=c.headers['set-cookie'][0].split(';')[0];
  for(let i=0;i<15;i++) assert.equal((await send('/api/login/google',{method:'POST',cookie,nonce,body:{credential:'invalid'}})).status,401);
  assert.equal((await send('/api/login/google',{method:'POST',cookie,nonce,body:{credential:'invalid'}})).status,429);
  const auth=createAuth({...options,verifyIdToken:async()=>{throw new Error('SECRET_INTERNAL_ERROR');}}),a=challenge(auth);
  await assert.rejects(()=>auth.login(req(a.cookie,a.nonce,'invalid'),res()),error=>!error.message.includes('SECRET_INTERNAL_ERROR'));
});

test('hosted config fails closed, frontend has no password, and Vercel permits Google identity',async()=>{
  for(const changed of [{clientId:''},{allowedEmails:'',allowedSubjects:''},{secret:'short'}]) assert.throws(()=>createAuth({...options,...changed}),/Hosted login requires/);
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/type="password"|tracker-password|login-form/);assert.match(html,/id="google-sign-in"/);
  const headers=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8')).headers[0].headers;
  assert.match(headers.find(x=>x.key==='Content-Security-Policy').value,/frame-src https:\/\/accounts.google.com\/gsi\//);
});
