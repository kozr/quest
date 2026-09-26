import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RedditApify,normalizeRedditPost,matchesRedditKeywords} from '../src/reddit-apify.js';
const sample={dataType:'post',id:'t3_abc123',subredditName:'iOSProgramming',title:'Help with renewals',body:'Subscription revenue',createdAt:'2026-09-22T10:00:00Z',postUrl:'javascript:alert(1)'};
test('normalizes untrusted results and constructs Reddit-only links',()=>{
  const post=normalizeRedditPost(sample)!;
  assert.equal(post.url,'https://www.reddit.com/r/iosprogramming/comments/abc123/');
  assert.equal(matchesRedditKeywords(post,['REVENUE']),true);
  assert.equal(matchesRedditKeywords(post,['blind box']),false);
  assert.equal(normalizeRedditPost({...sample,dataType:'comment'}),null);
  assert.equal(normalizeRedditPost({...sample,createdAt:'invalid'}),null);
  assert.equal(normalizeRedditPost({...sample,removedByCategory:'moderator'}),null);
});

test('historical retrieval fetches bounded direct threads without a date cutoff',async()=>{
  let calls=0;const urls=['https://www.reddit.com/r/journaling/comments/abc123/'];
  const request=(async(url:any,init:any)=>{
    calls++;assert.ok(String(url).includes('maxTotalChargeUsd=0.5'));
    const input=JSON.parse(init.body);assert.deepEqual(input.startUrls,urls.map(url=>({url})));
    assert.equal(input.postedAfter,undefined);assert.equal(input.postedBefore,undefined);
    assert.equal(input.maxPostsCount,20);assert.equal(input.crawlCommentsPerPost,false);
    return new Response(JSON.stringify({data:{id:'run',status:'RUNNING',defaultDatasetId:'dataset'}}));
  }) as typeof fetch;
  const client=new RedditApify('private-token',request);await client.startThreads(urls,.5);
  await assert.rejects(client.startThreads(['https://evil.example/thread'],.5),/Invalid/);
  await assert.rejects(client.startThreads(Array(21).fill(urls[0]),.5),/Invalid/);assert.equal(calls,1);
});
test('batches communities, restricts time and charges, and keeps the token out of URLs',async()=>{
  const request=(async(url:any,init:any)=>{
    assert.ok(String(url).includes('maxTotalChargeUsd=0.5'));
    assert.ok(!String(url).includes('private-token'));
    assert.equal(init.headers.Authorization,'Bearer private-token');
    const input=JSON.parse(init.body);
    assert.equal(input.startUrls.length,2);
    assert.equal(input.postedAfter,'2026-09-22T08:00:00Z');
    assert.equal(input.crawlCommentsPerPost,false);
    return new Response(JSON.stringify({data:{id:'run',status:'RUNNING',defaultDatasetId:'dataset'}}));
  }) as typeof fetch;
  const client=new RedditApify('private-token',request);
  assert.equal((await client.start(['iosprogramming','swift'],'2026-09-22T08:00:00Z','2026-09-22T10:00:00Z',0.5)).id,'run');
});
