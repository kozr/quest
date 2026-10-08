import test from 'node:test';
import assert from 'node:assert/strict';
import {ScrapeBadgerAdapter,createRedditAdapter} from '../reddit/adapters.mjs';
import {normalizeScrapeBadgerPost,normalizeScrapeBadgerComments} from '../reddit/scrapebadger.mjs';
import {createLinkedInAdapter} from '../linkedin/adapter.mjs';
import {discover} from '../discovery.mjs';

const now = Date.parse('2026-10-06T12:00:00Z'), path = '/r/journaling/comments/abc123/_/';
const post = {id:'abc123',fullname:'t3_abc123',title:'How can I keep my journal together?',selftext:'I need an app to organize my journal entries.',
  subreddit:'journaling',subreddit_name_prefixed:'r/journaling',author:'Journaler',created_utc:now/1000-3600,
  archived:false,locked:false,num_comments:3,permalink:'/r/journaling/comments/abc123/journal/'};
const comment = {id:'c123',fullname:'t1_c123',subreddit:'journaling',author:'Commenter',created_utc:now/1000-1800,
  post_id:'t3_abc123',parent_id:'t3_abc123',body:'I need a way to organize my journal entries too.',
  permalink:'/r/journaling/comments/abc123/journal/c123/',replies:[]};
const json = (value,credits='2') => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','X-Credits-Used':credits}});

test('normalization preserves Reddit identities, exact own text, timestamps, and parent attribution',() => {
  const row = normalizeScrapeBadgerPost(post,new Date(now).toISOString());
  assert.equal(row.sourceId,'t3_abc123'); assert.equal(row.postId,'t3_abc123'); assert.equal(row.url,'https://www.reddit.com/r/journaling/comments/abc123/');
  assert.equal(row.snippet,post.selftext); assert.equal(row.publishedAt,'2026-10-06T11:00:00.000Z');
  const comments = normalizeScrapeBadgerComments([{...comment,replies:[{...comment,id:'c124',fullname:'t1_c124',parent_id:'t1_c123',body:'My own reply.',permalink:'/r/journaling/comments/abc123/journal/c124/'}]}],row,new Date(now).toISOString());
  assert.equal(comments.length,2); assert.equal(comments[1].parentId,'t1_c123');assert.equal(comments[1].snippet,'My own reply.');
  assert.equal(comments[1].url,'https://www.reddit.com/r/journaling/comments/abc123/_/c124/');
  for (const invalid of [{locked:true},{archived:true},{locked:'false'},{fullname:'t3_wrong'},{subreddit_name_prefixed:'r/other'},
    {selftext:'[removed]'},{author:'[deleted]'},{permalink:'https://evil.test/r/journaling/comments/abc123/'},{created_at:'2026-10-05T00:00:00Z'}])
    assert.equal(normalizeScrapeBadgerPost({...post,...invalid},new Date(now).toISOString()),null);
  for (const invalid of [{post_id:'t3_wrong'},{link_id:'t3_other'},{subreddit:'other'},{parent_id:'t3_other'},{parent_id:'t1_c123'},
    {permalink:'/r/journaling/comments/abc123/journal/other/'},{body:'[deleted]'}])
    assert.equal(normalizeScrapeBadgerComments([{...comment,...invalid}],row,new Date(now).toISOString()).length,0);
});

test('ScrapeBadger API requests keep credentials in headers and paginate with validated cursors',async () => {
  const calls = [],adapter = new ScrapeBadgerAdapter({apiKey:'private-key',maxThreads:0,now:() => now,fetchImpl:async(raw,init) => {
    const target = new URL(raw); calls.push(target);
    assert.equal(target.origin,'https://scrapebadger.com');assert.equal(init.headers['X-API-Key'],'private-key');assert.equal(init.redirect,'error');
    assert.ok(!target.href.includes('private-key'));assert.equal(target.searchParams.get('q'),'journal entries');
    return target.searchParams.has('after') ? json({posts:[post,{...post,id:'def456',fullname:'t3_def456',permalink:'/r/journaling/comments/def456/journal/'}],pagination:{after:null}})
      : json({posts:[post],pagination:{after:'t3_abc123'}});
  }});
  const result = await adapter.search({query:'journal entries'});
  assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('after'),'t3_abc123');assert.equal(result.rows.length,2);
  assert.equal(result.coverage.creditsUsed,4);assert.equal(result.coverage.partial,true,'selected comment threads were intentionally omitted');
  assert.equal((await adapter.search({query:'journal entries'})).coverage.creditsUsed,0);assert.equal(calls.length,2);
});

test('subreddit listings reject mismatched communities and thread retrieval keeps bounded comments',async () => {
  const adapter = new ScrapeBadgerAdapter({apiKey:'key',now:() => now,fetchImpl:async raw => {
    const target = new URL(raw);
    if (target.pathname.endsWith('/comments')) {assert.equal(target.searchParams.get('limit'),'4');return json({tree:[comment]},'3');}
    if (target.pathname === '/v1/reddit/posts/abc123') return json({post});
    assert.equal(target.pathname,'/v1/reddit/subreddits/journaling/posts');assert.equal(target.searchParams.get('sort'),'new');
    return json({posts:[post,{...post,subreddit:'other',subreddit_name_prefixed:'r/other',permalink:'/r/other/comments/abc123/'}],pagination:{after:null}});
  }});
  assert.equal((await adapter.list({subreddit:'Journaling'})).rows.length,1);
  const thread = await adapter.thread({path,limit:5});assert.equal(thread.rows.length,2);
  assert.equal(thread.rows[1].sourceId,'t1_c123');assert.equal(thread.coverage.collectedComments,1);assert.equal(thread.coverage.partial,true);
  assert.equal(thread.coverage.creditsUsed,5);
  await assert.rejects(adapter.thread({path:'https://evil.test/thread'}),/invalid_thread/);
  assert.throws(() => adapter.list({subreddit:'../../credentials'}),/invalid_listing/);
});

test('concurrent equivalent paid calls are shared, validated results cache, and expiry makes a new call',async () => {
  let calls = 0,time = now,release;
  const wait = new Promise(resolve => {release = resolve;});
  const adapter = new ScrapeBadgerAdapter({apiKey:'key',now:() => time,fetchImpl:async () => {calls++;await wait;return json({posts:[post],pagination:{after:null}});}});
  const a = adapter.list({subreddit:'journaling'}),b = adapter.list({subreddit:'journaling'});release();
  const results = await Promise.all([a,b]);assert.equal(calls,1);assert.deepEqual(results[0].rows,results[1].rows);
  const cached = await adapter.list({subreddit:'journaling'});assert.equal(cached.coverage.cacheHits,1);assert.equal(cached.rows[0].collectedAt,results[0].rows[0].collectedAt);
  time += 60_001;await adapter.list({subreddit:'journaling'});assert.equal(calls,2);
});

test('errors remain private, failed schemas are not cached, and ambiguous paid requests never retry',async () => {
  let calls = 0;
  const adapter = new ScrapeBadgerAdapter({apiKey:'private-key',fetchImpl:async () => {calls++;throw Error('private-key sensitive data');}});
  await assert.rejects(adapter.search({query:'test'}),error => error.code === 'upstream_unreachable' && !error.message.includes('private-key'));
  assert.equal(calls,1);
  const invalid = new ScrapeBadgerAdapter({apiKey:'key',fetchImpl:async () => {calls++;return json({error:'private-key'});}});
  await assert.rejects(invalid.list({subreddit:'journaling'}),/unexpected_response/);await assert.rejects(invalid.list({subreddit:'journaling'}),/unexpected_response/);
  assert.equal(calls,3);
  const rateLimited = new ScrapeBadgerAdapter({apiKey:'key',fetchImpl:async () => new Response('private-key',{status:429})});
  await assert.rejects(rateLimited.search({query:'test'}),/upstream_http_429/);
});

test('partial comment failure retains the fetched original and exposes incomplete cost accounting',async () => {
  let calls = 0;
  const adapter = new ScrapeBadgerAdapter({apiKey:'key',now:() => now,fetchImpl:async() => {
    if (calls++) throw Error('timeout after charge');return json({post});
  }});
  const result = await adapter.thread({path});assert.equal(result.rows.length,1);assert.equal(result.coverage.partial,true);
  assert.equal(result.coverage.creditsUsed,null);assert.deepEqual(result.coverage.errors,['upstream_unreachable']);assert.equal(calls,2);
});

test('provider selection enables ScrapeBadger separately from existing LinkedIn gateway settings',() => {
  const env = {SCRAPEBADGER_API_KEY:'private-key',REDLIB_BRIDGE_URL:'https://gateway.test',REDLIB_BRIDGE_TOKEN:'x'.repeat(40)};
  assert.equal(createRedditAdapter({env}).id,'scrapebadger');assert.equal(createLinkedInAdapter({env}).id,'linkedin-mcp');
  assert.equal(createRedditAdapter({env:{...env,REDDIT_PROVIDER:'redlib'}}).id,'redlib');
  assert.throws(() => createRedditAdapter({env:{REDDIT_PROVIDER:'scrapebadger'}}),/SCRAPEBADGER_API_KEY/);
  assert.equal(createRedditAdapter({env:{}}).id,'public-json');
});

test('end-to-end discovery keeps Reddit post and comment matches with ScrapeBadger provenance',async () => {
  const adapter = new ScrapeBadgerAdapter({apiKey:'key',now:() => now,fetchImpl:async raw => {
    const target = new URL(raw);
    return target.pathname.endsWith('/comments') ? json({tree:[comment]},'3') : target.pathname.endsWith('/abc123') ? json({post}) : json({posts:[post],pagination:{after:null}});
  }});
  const result = await discover({id:'product',name:'JournalKit',url:'https://journalkit.app',description:'Organize journal entries',keywords:['journal entries'],needs:['Organize journal entries'],aliases:['JournalKit'],exclusions:[],communities:['journaling']},
    {now:new Date(now),redditAdapter:adapter,fetchImpl:async() => json({hits:[]})});
  assert.ok(result.items.some(row => row.sourceId === 't3_abc123'));
  assert.ok(result.items.some(row => row.sourceId === 't1_c123' && row.provider === 'scrapebadger'));
  assert.equal(result.sources.find(row => row.name === 'Reddit').provider,'scrapebadger');
  assert.equal(result.sources.find(row => row.name === 'Reddit watchlist').provider,'scrapebadger');
});
