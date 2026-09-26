import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {Timestamp} from 'firebase-admin/firestore';
import {testStore} from './firebase-fixture.js';
import {collectReddit} from '../src/reddit-collector.js';
import {RedditApify} from '../src/reddit-apify.js';
import {redditRouter} from '../src/reddit.js';
import {documentKey} from '../src/database.js';
const now=Date.parse('2026-09-22T12:00:00Z');
const env={REDDIT_MONITORING_ENABLED:'true',REDDIT_BETA_USER_IDS:'alice,bob',REDDIT_MONTHLY_BUDGET_USD:'15'};
async function fixture() {
  const store=testStore();
  for(const user of ['alice','bob']) await store.set('reddit_settings',user,{user_id:user,enabled:true,communities:['swift'],keywords:[],updatedAt:new Date(now).toISOString()});
  return store;
}
function provider(calls:{count:number},cost=.1) {
  return {start:async(communities:string[])=>{calls.count++;assert.deepEqual(communities,['swift']);return {id:'run',status:'RUNNING',defaultDatasetId:'data'};},
    status:async()=>({id:'run',status:'SUCCEEDED',defaultDatasetId:'data',finishedAt:new Date(now+60000).toISOString(),usageTotalUsd:cost}),
    posts:async()=>[{id:'abc123',subreddit:'swift',title:'Hello',body:'Revenue discussion',url:'https://www.reddit.com/r/swift/comments/abc123/',createdAt:new Date(now-60000).toISOString(),score:1,comments:0}],
  } as unknown as RedditApify;
}
test('overlapping customers share one paid run; concurrent ticks do not double-start; budget settles once',async()=>{
  const store=await fixture();const calls={count:0};const api=provider(calls);
  await Promise.all([collectReddit(store,api,env,now),collectReddit(store,api,env,now)]);
  assert.equal(calls.count,1);
  await Promise.all([collectReddit(store,api,env,now+300000),collectReddit(store,api,env,now+300000)]);
  assert.equal((await store.list('reddit_posts')).length,1);
  assert.deepEqual(await store.get('reddit_budgets','2026-09'),{spent:.1,reserved:0});
  await collectReddit(store,api,env,now+600000);assert.equal(calls.count,1);
});
test('budget exhaustion and disabled feature prevent paid requests',async()=>{
  const store=await fixture();const calls={count:0};const api=provider(calls);
  await store.set('reddit_budgets','2026-09',{spent:14.8,reserved:0});
  await collectReddit(store,api,env,now);assert.equal(calls.count,0);
  assert.match((await store.get<any>('reddit_control','collector')).message,/budget/);
  await collectReddit(store,api,{...env,REDDIT_MONITORING_ENABLED:'false'},now+9000000);assert.equal(calls.count,0);
});
test('ambiguous paid starts remain reserved and are never automatically repeated',async()=>{
  const store=await fixture();let starts=0;
  const api={start:async()=>{starts++;throw new Error('connection lost');}} as unknown as RedditApify;
  await collectReddit(store,api,env,now);
  await collectReddit(store,api,env,now+9000000);
  assert.equal(starts,1);assert.deepEqual(await store.get('reddit_budgets','2026-09'),{spent:0,reserved:.5});
});
test('account settings and saved status remain isolated; deleted accounts cannot write',async t=>{
  const store=testStore();const users=[`alice-${randomUUID()}`,`bob-${randomUUID()}`];
  const oldEnabled=process.env.REDDIT_MONITORING_ENABLED;const oldIds=process.env.REDDIT_BETA_USER_IDS;
  process.env.REDDIT_MONITORING_ENABLED='true';process.env.REDDIT_BETA_USER_IDS=users.join(',');
  t.after(()=>{if(oldEnabled===undefined) delete process.env.REDDIT_MONITORING_ENABLED;else process.env.REDDIT_MONITORING_ENABLED=oldEnabled;if(oldIds===undefined) delete process.env.REDDIT_BETA_USER_IDS;else process.env.REDDIT_BETA_USER_IDS=oldIds;});
  const app=express();app.use(express.json());
  // Authentication itself is covered by existing session tests; inject two authenticated identities here.
  app.use((req,_res,next)=>{(req as any).user={id:req.headers['x-test-user']};next();});
  app.use('/api/reddit',redditRouter(store));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status ?? 400).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const address=server.address() as any;
  const request=(uid:string,path:string,method='GET',body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api/reddit${path}`,{method,headers:{'x-test-user':uid,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  for(const user of users) assert.equal((await request(user,'/settings','PUT',{enabled:true,communities:['swift'],keywords:[]})).status,200);
  await store.set('reddit_posts','abc123',{id:'abc123',subreddit:'swift',title:'Example',body:'',url:'https://www.reddit.com/r/swift/comments/abc123/',createdAt:new Date().toISOString(),score:1,comments:0,expireAt:Timestamp.fromMillis(Date.now()+86400000)});
  assert.equal((await request(users[0],'/posts/abc123','PUT',{status:'saved'})).status,200);
  assert.equal((await (await request(users[0],'/posts?view=saved')).json()).posts.length,1);
  assert.equal((await (await request(users[1],'/posts?view=saved')).json()).posts.length,0);
  assert.equal((await (await request(users[1],'/posts')).json()).posts.length,1);
  assert.equal((await request('outsider','/settings')).status,403);
  await store.set('account_deletions',users[0],{state:'pending'});
  assert.notEqual((await request(users[0],'/settings','PUT',{enabled:false,communities:[],keywords:[]})).status,200);
  assert.equal((await store.get<any>('reddit_post_states',documentKey(users[0],'abc123'))).user_id,users[0]);
});
