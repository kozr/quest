import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Timestamp} from 'firebase-admin/firestore';
import {summarizeLeadProgress,readLeadProgress} from '../src/leads-progress.js';
import {leadContentHash} from '../src/leads-candidates.js';
import type {LeadJob,LeadProfile} from '../src/leads-types.js';
import type {Store} from '../src/database.js';
import type {StoredRedditPost} from '../src/reddit.js';

const now=Date.parse('2026-09-23T12:00:00Z');
const profile={user_id:'owner',app_id:'app',revision:2,enabled:true,communities:['journaling']} as LeadProfile;
function job(id:string,state:LeadJob['state'],changes:Partial<LeadJob>={}):LeadJob {
  return {id,user_id:'owner',app_id:'app',kind:'qualify',inputHash:'hash',profileRevision:2,postId:id,postContentHash:'hash',state,
    nextAttemptAt:now,createdAt:'2026-09-23T11:50:00Z',updatedAt:'2026-09-23T11:59:00Z',leaseUntil:now+1000,
    expireAt:Timestamp.fromMillis(now+86400000),...changes};
}
const summarize=(jobs:LeadJob[],extra:Partial<Parameters<typeof summarizeLeadProgress>[0]>={})=>summarizeLeadProgress({profile,jobs,now,...extra});

test('progress counts a fixed enqueue batch, scopes ownership/revision and previews the running job',()=>{
  const result=summarize([job('done','succeeded'),job('current','running'),job('next','pending'),
    job('old','succeeded',{createdAt:'2026-09-22T11:50:00Z'}),job('foreign','running',{user_id:'other'}),job('revision','running',{profileRevision:1}),
    job('draft','running',{kind:'draft'}),job('expired','running',{expireAt:Timestamp.fromMillis(now-1)})]);
  assert.equal(result.progress.phase,'assessing');assert.equal(result.progress.fraction,1/3);assert.equal(result.previewJob?.id,'current');
  assert.equal(result.progress.batchId,'2:2026-09-23T11:50:00Z');
});
test('a new later batch does not move an unfinished batch denominator',()=>{
  const result=summarize([job('done','succeeded'),job('next','pending'),job('new','pending',{createdAt:'2026-09-23T11:58:00Z'})]);
  assert.equal(result.progress.fraction,.5);assert.equal(result.progress.phase,'queued');assert.equal(result.previewJob?.id,'done');
});
test('collecting is indeterminate, scoped to selected communities and expires if stuck',()=>{
  const active={runId:'run',startedAt:now-1000,communities:['journaling']};
  assert.equal(summarize([],{collector:{active}}).progress.phase,'collecting');
  assert.equal(summarize([],{collector:{active}}).progress.fraction,null);
  assert.equal(summarize([],{collector:{active:{...active,communities:['other']}}}).progress.phase,'waiting');
  assert.equal(summarize([],{collector:{active:{...active,startedAt:now-16*60000}}}).progress.phase,'interrupted');
});
test('paused, expired leases, uncertain calls and partial reads never masquerade as completion',()=>{
  assert.equal(summarize([job('a','pending',{reasonCode:'BUDGET_PAUSED'})]).progress.phase,'paused');
  assert.equal(summarize([job('a','running',{leaseUntil:now-1})]).progress.phase,'interrupted');
  assert.equal(summarize([job('a','uncertain')]).progress.phase,'interrupted');
  assert.equal(summarize([job('a','succeeded')],{truncated:true}).progress.phase,'unavailable');
  assert.equal(summarize([job('a','running')],{limited:true}).progress.phase,'paused');
});
test('finished and zero-candidate scans stop loading; no recorded scan stays waiting',()=>{
  assert.equal(summarize([job('a','succeeded')]).progress.phase,'complete');
  assert.equal(summarize([],{scanComplete:true}).progress.phase,'complete');
  assert.equal(summarize([]).progress.phase,'waiting');
});
test('preview includes only the same unexpired post content from a followed community',async()=>{
  const post:StoredRedditPost={id:'abc',subreddit:'journaling',title:'An app for daily entries?',body:'I want a daily journal.',url:'https://www.reddit.com/r/journaling/comments/abc/',createdAt:new Date(now-1000).toISOString(),score:0,comments:0,expireAt:Timestamp.fromMillis(now+10000)};
  const active=job(post.id,'running',{postContentHash:leadContentHash(post)});
  const query={where:()=>query,limit:()=>query};
  const store={collection:()=>query,query:async()=>[active],get:async(name:string)=>name==='reddit_posts'?post:undefined} as unknown as Store;
  const result=await readLeadProgress(store,profile,undefined,false,now);
  assert.equal(result.post?.state,'reviewing');assert.equal(result.post?.title,post.title);
  post.body='Edited since qualification started';
  assert.equal((await readLeadProgress(store,profile,undefined,false,now)).post,null);
});

test('daily-capped monitoring does not mask active setup, while provider and setup budget pauses remain visible',async()=>{
  const scan={state:'queued',requestedAt:now,searchRound:1,fetchedPostIds:['setup'],allFetchedPostIds:[]};
  const rows=[job('monitoring','pending',{reasonCode:'DAILY_LIMIT'}),job('setup','pending')];
  const query={where:()=>query,limit:()=>query};
  const store={collection:()=>query,query:async()=>rows,get:async(name:string)=>name==='lead_scans'?scan:undefined} as unknown as Store;
  assert.equal((await readLeadProgress(store,profile,undefined,false,now)).phase,'queued');
  assert.equal((await readLeadProgress(store,profile,undefined,true,now)).phase,'paused');
  rows[1].reasonCode='BUDGET_PAUSED';
  assert.equal((await readLeadProgress(store,profile,undefined,false,now)).phase,'paused');
  rows.pop();scan.fetchedPostIds=[];
  assert.equal((await readLeadProgress(store,profile,undefined,false,now)).phase,'queued');
});
