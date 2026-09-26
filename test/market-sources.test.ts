import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  MARKET_APIFY_MAX_CALL_USD,MarketRedditSource,collectRelevantComments,normalizeMarketRedditRow,
  collectRelevantMarketSources,normalizeMarketRedditRows,normalizeMarketRedditSource,selectRelevantMarketThreads,
} from '../src/market-sources.js';

const fetchedAt='2026-09-24T12:00:00.000Z';
const post={dataType:'post',id:'t3_p123',parsedId:'p123',subredditName:'BlindBox',title:'  Tracking missing figures  ',body:'I use Notes and a spreadsheet.\nIt is hard to remember.',
  createdAt:'2026-09-23T08:00:00Z',authorId:'t2_postAuthor',authorFullname:'t2_postAuthor',authorName:'CollectorOne',
  postUrl:'https://www.reddit.com/r/blindbox/comments/p123/tracking-missing-figures/'};
const comment={dataType:'comment',id:'c456',parsedId:null,parsedPostId:'p123',postId:'t3_p123',parentId:'t3_p123',subredditName:'blindbox',
  body:'  I have the same problem.\n',commentCreatedAt:'2026-09-23T09:00:00Z',createdAt:'2026-09-23T08:00:00Z',
  authorId:'c456',authorFullname:'t2_commentAuthor',authorName:'CollectorTwo',
  url:'https://www.reddit.com/r/blindbox/comments/p123/tracking-missing-figures/c456/',
  postUrl:'https://www.reddit.com/r/blindbox/comments/p123/tracking-missing-figures/'};

test('normalizes posts and comments with exact text, stable IDs, thread parents, and verified Reddit URLs',()=>{
  const normalizedPost=normalizeMarketRedditSource(post,fetchedAt)!;
  const normalizedComment=normalizeMarketRedditSource(comment,fetchedAt)!;
  assert.equal(normalizedPost.id,'reddit:post:p123');
  assert.equal(normalizedPost.threadId,'p123');
  assert.equal(normalizedPost.parentId,null);
  assert.equal(normalizedPost.authorKey,'reddit:t2_postauthor');
  assert.equal(normalizedPost.title,'  Tracking missing figures  ');
  assert.equal(normalizedPost.text,'I use Notes and a spreadsheet.\nIt is hard to remember.');
  assert.equal(normalizedPost.url,'https://www.reddit.com/r/blindbox/comments/p123/');
  assert.equal(normalizedPost.expiresAt,'2026-10-23T08:00:00.000Z');
  assert.equal(normalizedPost.contentHash,createHash('sha256').update(JSON.stringify({id:normalizedPost.id,provider:normalizedPost.provider,kind:normalizedPost.kind,
    threadId:normalizedPost.threadId,parentId:normalizedPost.parentId,authorKey:normalizedPost.authorKey,authorDisplayName:normalizedPost.authorDisplayName,
    title:normalizedPost.title,text:normalizedPost.text,community:normalizedPost.community,url:normalizedPost.url,createdAt:normalizedPost.createdAt})).digest('hex'));
  const sameTextDifferentAuthor=normalizeMarketRedditSource({...post,authorFullname:'t2_someoneElse',authorId:'t2_someoneElse'},fetchedAt)!;
  assert.equal(sameTextDifferentAuthor.text,normalizedPost.text);
  assert.notEqual(sameTextDifferentAuthor.contentHash,normalizedPost.contentHash,'body-identical author changes invalidate old snapshot evidence');
  assert.equal(normalizedComment.id,'reddit:comment:c456');
  assert.equal(normalizedComment.threadId,'p123');
  assert.equal(normalizedComment.parentId,'t3_p123');
  assert.equal(normalizedComment.createdAt,'2026-09-23T09:00:00.000Z');
  assert.equal(normalizedComment.authorKey,'reddit:t2_commentauthor');
  assert.equal(normalizedComment.authorDisplayName,'CollectorTwo');
  assert.equal(normalizedComment.text,'  I have the same problem.\n');
  assert.equal(normalizedComment.url,'https://www.reddit.com/r/blindbox/comments/p123/_/c456/');
});

test('comment legacy authorId never replaces t2 author identity; deleted authors remain unknown',()=>{
  const legacy=normalizeMarketRedditSource({...comment,authorFullname:undefined,authorId:'c456',authorName:'Some_User'},fetchedAt)!;
  assert.equal(legacy.authorKey,'reddit:name:some_user');
  const deleted=normalizeMarketRedditSource({...comment,authorFullname:undefined,authorName:'[deleted]'},fetchedAt)!;
  assert.equal(deleted.authorKey,null);
  assert.equal(deleted.authorDisplayName,null);
  const staleIdentity=normalizeMarketRedditSource({...comment,authorName:'[deleted]'},fetchedAt)!;
  assert.equal(staleIdentity.authorKey,null);
});

test('rejects mismatched or unsafe permalinks and sources outside the 30-day source window',()=>{
  assert.equal(normalizeMarketRedditSource({...comment,url:'https://evil.example/r/blindbox/comments/p123/c456/'},fetchedAt),null);
  assert.equal(normalizeMarketRedditSource({...comment,url:'https://www.reddit.com/r/blindbox/comments/other-thread/c456/'},fetchedAt),null);
  assert.equal(normalizeMarketRedditSource({...comment,url:'https://www.reddit.com/r/blindbox/comments/p123/c456/'},fetchedAt),null);
  assert.equal(normalizeMarketRedditSource({...post,postUrl:'https://www.reddit.com/r/other/comments/p123/title/'},fetchedAt),null);
  assert.equal(normalizeMarketRedditSource({...post,createdAt:'2026-08-01T00:00:00Z'},fetchedAt),null);
  assert.equal(normalizeMarketRedditSource({...comment,parsedPostId:'another-thread'},fetchedAt),null);
  assert.equal(normalizeMarketRedditSource({...post,subreddit:'somewhere-else'},fetchedAt),null);
});

test('returns removed and deleted identities for invalidating prior snapshots without keeping their text',()=>{
  const rows=normalizeMarketRedditRows([
    post,
    {...comment,body:'[removed]'},
    {...comment,id:'t1_c789',parsedPostId:'p123',postId:'t3_p123',parentId:'t1_c456',body:'[deleted]',url:'https://www.reddit.com/r/blindbox/comments/p123/title/c789/'},
    {...comment,id:'t1_c999',parsedPostId:'p123',postId:'t3_p123',parentId:'t3_p123',body:undefined,removedByCategory:'moderator',url:'https://www.reddit.com/r/blindbox/comments/p123/title/c999/'},
  ],fetchedAt,10);
  assert.deepEqual(rows.sources.map(source=>source.id),['reddit:post:p123']);
  assert.deepEqual(rows.invalidations.map(item=>[item.sourceId,item.reason]),[
    ['reddit:comment:c456','removed'],['reddit:comment:c789','deleted'],['reddit:comment:c999','removed'],
  ]);
  assert.equal(normalizeMarketRedditRow({...comment,parentId:'t3_another'},fetchedAt),null);
});

test('selects newest unique matching threads and caps comment normalization per selected thread',()=>{
  const anotherPost={...post,id:'p456',parsedId:'p456',title:'Another tracking problem',createdAt:'2026-09-24T08:00:00Z',
    postUrl:'https://reddit.com/r/blindbox/comments/p456/title/'};
  const normalizedPosts=[normalizeMarketRedditSource(post,fetchedAt)!,normalizeMarketRedditSource(anotherPost,fetchedAt)!,normalizeMarketRedditSource(post,fetchedAt)!];
  const selected=selectRelevantMarketThreads(normalizedPosts,['tracking'],2);
  assert.deepEqual(selected.map(item=>item.threadId),['p456','p123']);
  const comment2={...comment,id:'c457',parsedPostId:'p123',postId:'t3_p123',parentId:'t1_c456',commentCreatedAt:'2026-09-23T10:00:00Z',
    url:'https://reddit.com/r/blindbox/comments/p123/title/c457/'};
  const sources=collectRelevantComments([post,comment,comment2],normalizedPosts,{keywords:['tracking'],maxThreads:2,maxCommentsPerThread:1,fetchedAt});
  assert.deepEqual(sources.map(item=>item.id),['reddit:post:p456','reddit:post:p123','reddit:comment:c456']);
  const invalidated=collectRelevantMarketSources([{...post,body:'[removed]'}],[normalizedPosts[0]!],
    {keywords:['tracking'],maxThreads:1,maxCommentsPerThread:1,fetchedAt});
  assert.deepEqual(invalidated.sources,[]);
  assert.equal(invalidated.invalidations[0]?.sourceId,'reddit:post:p123');
});

test('Apify adapter sends bounded community searches and selected-thread comment crawls',async()=>{
  const calls:Array<{url:string;input:Record<string,unknown>|null}> = [];
  const request=(async(url:RequestInfo|URL,init?:RequestInit)=>{
    const serialized=String(url),body=typeof init?.body==='string'?JSON.parse(init.body) as Record<string,unknown>:null;
    calls.push({url:serialized,input:body});
    return new Response(JSON.stringify({data:{id:`run${calls.length}`,status:'RUNNING',defaultDatasetId:`dataset${calls.length}`}}));
  }) as typeof fetch;
  const client=new MarketRedditSource('private-token',request);
  const search=await client.startSearch({communities:['blindbox','sonnyangel'],keywords:['tracker'],after:'2026-09-01T00:00:00Z',before:fetchedAt,maxPosts:80},MARKET_APIFY_MAX_CALL_USD);
  assert.equal(search.id,'run1');
  const searchInput=calls[0]!.input!;
  assert.equal(searchInput.maxPostsCount,80);
  assert.equal(searchInput.postedAfter,'2026-09-01');
  assert.equal(searchInput.postedBefore,'2026-09-24');
  assert.equal(searchInput.crawlCommentsPerPost,false);
  assert.equal(searchInput.maxCommentsPerPost,0);
  const normalized=normalizeMarketRedditSource(post,fetchedAt)!;
  await client.startThreadComments([normalized],{maxCommentsPerThread:12},MARKET_APIFY_MAX_CALL_USD);
  const commentInput=calls[1]!.input!;
  assert.equal(commentInput.crawlCommentsPerPost,true);
  assert.equal(commentInput.maxCommentsPerPost,12);
  assert.deepEqual(commentInput.startUrls,[{url:normalized.url}]);
  assert.ok(calls.every(call=>!call.url.includes('private-token')));
  await assert.rejects(client.startSearch({communities:['blindbox'],keywords:[],after:'2026-09-01T00:00:00Z',before:fetchedAt},.51),/charge ceiling/);
  await assert.rejects(client.startThreadComments([normalized],{maxCommentsPerThread:26},.5),/bounded/);
  assert.equal(calls.length,2);
});

test('status and dataset requests validate IDs and reject excess rows',async()=>{
  let response:unknown={data:{id:'run',status:'SUCCEEDED',defaultDatasetId:'dataset'}};
  const request=(async()=>new Response(JSON.stringify(response))) as typeof fetch;
  const client=new MarketRedditSource('private-token',request);
  assert.equal((await client.status('run_123')).status,'SUCCEEDED');
  response=[post,post,post];
  await assert.rejects(client.datasetRows('dataset',2),/result limit/);
  await assert.rejects(client.status('bad/id'),/run ID/);
});
