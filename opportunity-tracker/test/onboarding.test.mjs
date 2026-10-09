import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {starterProfile, suggestProfile, checkCommunities, communities} from '../profile.mjs';
import {createTrackerApp, validateProduct} from '../server.mjs';
import {Store} from '../store.mjs';
import {dueProducts, MONITOR_INTERVAL_MS} from '../monitor.mjs';
import {monitorCycle} from '../reddit/monitor-worker.mjs';
import {discover} from '../discovery.mjs';

const product={name:'Blind Box Tracker',url:'https://blindboxtracker.com',description:'Keep track of the figures in your blind box collection.',keywords:['collection','duplicates'],aliases:['Blind Box Tracker'],capabilities:['Keep track of the figures in your blind box collection.'],needs:['Keep a record of the figures I own.'],communities:['smiskis'],monitoring:true};

test('starter profiles remain editable and model suggestions require source-backed capabilities',async()=>{
  const starter=starterProfile(product);
  assert(starter.communities.includes('smiskis'));
  assert(starter.needs.every(need=>! /avoid|odds|seller|buyer/i.test(need)));
  let called=false;
  assert.equal((await suggestProfile(product,{env:{},fetchImpl:()=>{called=true;}})).method,'starter');
  assert.equal(called,false);
  const env={OPENAI_API_KEY:'test-secret',OPPORTUNITY_SETUP_MODEL:'test-model'};
  const fetchImpl=async()=>new Response(JSON.stringify({output_text:JSON.stringify({capabilities:['Guarantees no duplicate pulls'],needs:['Never pull duplicates'],keywords:['duplicates'],communities:['smiskis']})}));
  assert.equal((await suggestProfile(product,{env,fetchImpl})).method,'starter');
  const supported=await suggestProfile(product,{env,fetchImpl:async()=>new Response(JSON.stringify({output_text:JSON.stringify({capabilities:product.capabilities,needs:product.needs,keywords:product.keywords,communities:['r/Smiskis']})}))});
  assert.equal(supported.method,'model');
  assert.deepEqual(supported.communities,['smiskis']);
});

test('community suggestions distinguish accessible feeds from failed or empty checks',async()=>{
  assert.deepEqual(communities(['r/Smiskis','SMISKIS']),['smiskis']);
  assert.throws(()=>communities(['https://example.com']),/subreddit/);
  const checks=await checkCommunities(['Smiskis','SonnyAngel','unknownsub'],{adapter:{list:async({subreddit})=>{
    if(subreddit==='sonnyangel')throw Error('private-provider-body-and-token');
    return {rows:subreddit==='smiskis'?[{}]:[]};
  }}});
  assert.deepEqual(checks.map(row=>row.status),['accessible','unverified','unverified']);
  assert(!JSON.stringify(checks).includes('private-provider'));
  assert.throws(()=>validateProduct({...product,monitoring:true,communities:[]}),/at least one/);
  assert.throws(()=>validateProduct({...product,monitoring:'true'}),/whether/);
});

test('watchlist discovery retrieves relevant thread comments and applies confirmed needs',async()=>{
  const rows=[{source:'Reddit',provider:'redlib',sourceId:'t3_abc',type:'post',url:'https://www.reddit.com/r/smiskis/comments/abc/thread/',title:'How do you track your collection?',snippet:'I need a collection checklist.',publishedAt:new Date().toISOString()},
    {source:'Reddit',provider:'redlib',sourceId:'t3_def',type:'post',url:'https://www.reddit.com/r/smiskis/comments/def/thread/',title:'I need to find a buyer for duplicates',snippet:'Does anyone want duplicates?',publishedAt:new Date().toISOString()}];
  let threadCalls=0;
  const adapter={id:'redlib',list:async()=>({rows,coverage:{provider:'redlib',partial:true}}),thread:async()=>{threadCalls++;return {rows:[{...rows[0],sourceId:'t1_xyz',type:'comment',url:'https://www.reddit.com/r/smiskis/comments/abc/_/xyz/',author:'comment-author',title:'I need a collection tracker',snippet:'I need a collection tracker because I keep forgetting what I own.'}],coverage:{provider:'redlib',partial:true}};}};
  const result=await discover(product,{redditAdapter:adapter,watchOnly:true});
  assert.equal(result.sources.length,1);
  assert.equal(result.sources[0].name,'Reddit watchlist');
  assert.equal(result.sources[0].status,'ok');
  assert(result.items.some(row=>row.type==='comment'&&row.author==='comment-author'));
  assert(!result.items.some(row=>row.url.includes('/def/')),'Finding a buyer is not an inventory-tracking need');
  assert(threadCalls>0);
});

test('automatic checks require a separate secret, honor pauses and backoff, and retain the profile through backups',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'tracker-onboarding-'));
  const token='monitor-test-token-32-characters-long';let runs=0;
  const {app,store}=createTrackerApp({dataDirectory:directory,monitorToken:token,profileFn:async()=>starterProfile(product),redditAdapter:{list:async()=>({rows:[{}]})},discoverFn:async(_product,options)=>{runs++;assert.equal(options.watchOnly,true);return {items:[],sources:[],searchedAt:new Date().toISOString()};}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const state=await fetch(origin+'/api/state').then(r=>r.json());
  const headers={'Content-Type':'application/json','X-Tracker-Token':state.token};
  const created=await fetch(origin+'/api/products',{method:'POST',headers,body:JSON.stringify(product)}).then(r=>r.json());
  assert.deepEqual(created.product.communities,['smiskis']);
  assert.equal((await fetch(origin+'/api/monitor',{headers})).status,401);
  const workerHeaders={Authorization:`Bearer ${token}`};
  const monitor=await fetch(origin+'/api/monitor',{headers:workerHeaders}).then(r=>r.json());
  assert.deepEqual(monitor.ids,[created.product.id]);
  assert.deepEqual(monitor.schedules,{reddit:{intervalMinutes:120},x:{intervalMinutes:120},linkedin:{timeZone:'America/Los_Angeles',hours:[8,20]}});
  assert.equal((await fetch(origin+`/api/monitor/${created.product.id}`,{method:'POST',headers:workerHeaders})).status,200);
  assert.equal((await fetch(origin+`/api/monitor/${created.product.id}`,{method:'POST',headers:workerHeaders})).status,204);
  assert.equal(runs,1);
  const paused={...created.product,monitoring:false};
  await fetch(origin+`/api/products/${created.product.id}`,{method:'PUT',headers,body:JSON.stringify(paused)});
  assert.deepEqual((await fetch(origin+'/api/monitor',{headers:workerHeaders}).then(r=>r.json())).ids,[]);
  const backup=await fetch(origin+'/api/export').then(r=>r.json());
  const imported=await fetch(origin+'/api/import',{method:'POST',headers,body:JSON.stringify(backup)});
  assert.equal(imported.status,200);
  const persisted=new Store(directory).snapshot().products[0];
  assert.deepEqual(persisted.needs,product.needs);assert.deepEqual(persisted.capabilities,product.capabilities);assert.equal(persisted.monitoring,false);
  assert.deepEqual(dueProducts({products:[{...product,id:'x',lastMonitorAttemptAt:new Date().toISOString()}],searches:{}}),[]);
  assert.equal(MONITOR_INTERVAL_MS, 2 * 60 * 60 * 1000);
  const checkedAt = Date.parse('2026-10-05T00:00:00Z');
  const monitored = {products:[{...product,id:'x',lastMonitorAttemptAt:new Date(checkedAt).toISOString()}],searches:{}};
  assert.deepEqual(dueProducts(monitored, checkedAt + 30 * 60 * 1000), []);
  assert.deepEqual(dueProducts(monitored, checkedAt + MONITOR_INTERVAL_MS - 1), []);
  assert.equal(dueProducts(monitored, checkedAt + MONITOR_INTERVAL_MS).length, 1);
  assert.equal((await fetch(origin+'/api/state').then(r=>r.json())).monitoring.intervalMinutes, 120);
  assert.equal(dueProducts({products:[{...product,id:'x'}],searches:{}},MONITOR_INTERVAL_MS).length,1);
  const profile=await fetch(origin+'/api/profile',{method:'POST',headers,body:JSON.stringify(product)}).then(r=>r.json());
  assert(profile.checks.some(check=>check.status==='accessible'));
  assert.equal((await fetch(origin+'/api/profile',{method:'POST',body:JSON.stringify(product),headers:{'Content-Type':'application/json'}})).status,403);
});

test('VPS worker uses restricted origin and endpoints and continues after a product failure',async()=>{
  const urls=[];
  const results=await monitorCycle({baseURL:'https://tracker.vercel.app',token:'test-token-at-least-32-characters-long',fetchImpl:async(url,options)=>{
    urls.push(String(url));assert(options.headers.Authorization.startsWith('Bearer '));
    if(url.pathname==='/api/monitor/workspaces')return Response.json({ids:['personal'],accountMode:false});
    if(url.pathname==='/api/monitor')return new Response(JSON.stringify({ids:['a','b']}));
    return new Response('{}',{status:url.pathname.endsWith('/a')?502:200});
  }});
  assert.deepEqual(results.map(row=>row.status),[502,200]);
  assert.equal(urls.length,4);
  await assert.rejects(()=>monitorCycle({baseURL:'http://private.example.com',token:'x'.repeat(32)}),/HTTPS/);
  await assert.rejects(()=>monitorCycle({baseURL:'https://tracker.vercel.app',token:'x'.repeat(32),fetchImpl:async()=>new Response(JSON.stringify({ids:['../../secrets']}))}),/Invalid/);
});
