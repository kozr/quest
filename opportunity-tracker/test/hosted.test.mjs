import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { request } from 'node:http';
import { once } from 'node:events';
import { PostgresBackend, PostgresStore } from '../postgres-store.mjs';
import { createTrackerApp } from '../server.mjs';

const password='test-only-password-very-long';
const secret='test-only-session-secret-that-is-at-least-32-chars';
const product={name:'Tracker test',url:'https://tracker.dev',description:'A tool for specific tasks',keywords:['task management'],aliases:['Tracker test'],exclusions:[]};
async function backend(t) {
  const db=new PGlite();
  t.after(()=>db.close());
  const create=()=>{
    const value=new PostgresBackend('postgresql://test:test@example.neon.tech/test','fixture');
    value.sql=async(strings,...values)=>{
      const query=strings.reduce((text,part,index)=>text+(index?`$${index}`:'')+part,'');
      return (await db.query(query,values)).rows;
    };
    return value;
  };
  return {db,create};
}
async function server(t,store) {
  const app=createTrackerApp({hosted:true,store,password,sessionSecret:secret,discoverFn:async()=>({items:[],sources:[],searchedAt:new Date().toISOString()})}).app;
  const listener=app.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(()=>new Promise(resolve=>listener.close(resolve)));
  return async(path,{method='GET',body,cookie,token,origin='https://tracker.vercel.app'}={})=>{
    const result=await new Promise((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port:listener.address().port,path,method,headers:{Host:'tracker.vercel.app','X-Forwarded-Proto':'https',Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(token?{'X-Tracker-Token':token}:{})}},res=>{
        const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,value:JSON.parse(Buffer.concat(chunks).toString())}));
      });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
    });return result;
  };
}

test('actual Postgres queries persist across cloud instances and retry concurrent revisions without losing updates',async t=>{
  const {create}=await backend(t);
  const a=new PostgresStore(create()),b=new PostgresStore(create());
  await a.snapshot();await b.snapshot();
  const products=await Promise.all(Array.from({length:8},(_,i)=>(i%2?a:b).saveProduct({...product,name:`Product ${i}`})));
  assert.equal((await new PostgresStore(create()).snapshot()).products.length,8);
  const id=products[0].id;
  await a.recordSearch(id,{searchedAt:new Date().toISOString(),sources:[],items:[{url:'https://news.ycombinator.com/item?id=1',title:'Need help',kind:'opportunity'}]});
  const item=(await b.snapshot()).items[0];
  await Promise.all([a.updateItem(item.id,{status:'saved'}),b.updateItem(item.id,{note:'Keep this note'})]);
  const saved=(await new PostgresStore(create()).snapshot()).items[0];
  assert.equal(saved.status,'saved');assert.equal(saved.note,'Keep this note');
});

test('search leases are shared across instances, imports cannot race searches, and stale releases do not unlock new work',async t=>{
  const {create}=await backend(t);const a=new PostgresStore(create()),b=new PostgresStore(create());
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

test('hosted data requires a password and stable signed sessions/CSRF work across independent functions',async t=>{
  const {create}=await backend(t);const a=await server(t,new PostgresStore(create())),b=await server(t,new PostgresStore(create()));
  assert.equal((await a('/api/state')).status,401);
  assert.equal((await a('/api/export')).status,401);
  assert.equal((await a('/api/login',{method:'POST',body:{password:'wrong'}})).status,401);
  assert.equal((await a('/api/login',{method:'POST',body:{password},origin:'https://evil.dev'})).status,403);
  const login=await a('/api/login',{method:'POST',body:{password}});assert.equal(login.status,200);
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

test('hosted configuration never falls back to ephemeral files and provider errors never expose credentials',async t=>{
  assert.throws(()=>createTrackerApp({hosted:true,password,sessionSecret:secret,databaseUrl:''}),/DATABASE_URL/);
  assert.throws(()=>createTrackerApp({hosted:true,password:'short',sessionSecret:secret,databaseUrl:'postgresql://test:test@example.neon.tech/test'}),/Hosted login/);
  const value=new PostgresBackend('postgresql://test:test@example.neon.tech/test');
  value.sql=async()=>{throw new Error('database password=DO_NOT_EXPOSE');};
  await assert.rejects(()=>value.read(),error=>error.status===503&&!error.message.includes('DO_NOT_EXPOSE'));
});
