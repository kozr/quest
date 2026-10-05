import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {parseRedlib, redlibPath} from '../reddit/redlib-html.mjs';
import {RedlibAdapter, RedlibBridgeAdapter, createRedditAdapter} from '../reddit/adapters.mjs';
import {fetchText} from '../reddit/http.mjs';
import {createRedlibBridge} from '../reddit/bridge.mjs';
import {discover} from '../discovery.mjs';

// Synthetic fixtures using the observed Redlib 0.36 layout; never production leads.
const path = '/r/Python/comments/abc123/example/';
const post = (id = 'abc123') => `<div class="post" id="${id}"><p class="post_header"><a class="post_author">u/poster</a><span class="created" title="Oct 04 2026, 12:00:00 UTC"></span></p><h2 class="post_title"><a class="post_flair">Showcase</a><a>QuietBoard discussion</a></h2><div class="post_body"><p>I need subscription reminders.</p></div><div class="post_score" title="15"></div><a class="post_comments" title="3 comments" href="/r/Python/comments/${id}/example/">3 comments</a></div>`;
const comment = (id, body, replies = '') => `<div class="comment" id="${id}"><div class="comment_left"><p class="comment_score" title="5"></p></div><details class="comment_right"><summary class="comment_data"><a class="comment_author">u/${id}</a><a class="created" title="Oct 04 2026, 12:30:00 UTC" href="${path}${id}/?context=3#${id}"></a></summary><div class="comment_body"><p>${body}</p></div><blockquote class="replies">${replies}</blockquote></details></div>`;
const page = body => `<html><head><title>Redlib</title></head><body><main>${body}</main></body></html>`;
const response = html => new Response(html, {headers: {'Content-Type': 'text/html'}});

test('post and nested comments retain their own text, author, identity, time and parent', () => {
  const parsed = parseRedlib(page(post() + '<p id="comment_count">3 comments</p>' + comment('aaa', 'Parent text', comment('bbb', 'Child only'))), {path, collectedAt: '2026-10-04T14:00:00Z'});
  assert.equal(parsed.rows.length, 3);
  const [p, parent, child] = parsed.rows;
  assert.equal(p.title, 'QuietBoard discussion');
  assert.equal(p.sourceId, 't3_abc123');
  assert.equal(parent.snippet, 'Parent text');
  assert.equal(parent.author, 'aaa');
  assert.equal(parent.parentId, 't3_abc123');
  assert.equal(child.parentId, 't1_aaa');
  assert.equal(child.sourceId, 't1_bbb');
  assert.equal(child.url, 'https://www.reddit.com/r/Python/comments/abc123/_/bbb/');
  assert.equal(child.publishedAt, '2026-10-04T12:30:00.000Z');
  assert.equal(child.collectedAt, '2026-10-04T14:00:00Z');
  assert.equal(parsed.advertisedCommentCount, 3);
});

test('pagination follows actual links without losing phrase spaces or fetching external hosts', () => {
  const parsed = parseRedlib(page(post() + '<footer><a accesskey="N" href="?q=blind box&amp;sort=new\n\t&amp;after=t3_abc123">NEXT</a></footer><a href="https://evil.test/search">NEXT</a>'), {path: '/search?q=blind+box'});
  assert.deepEqual(parsed.continuations, ['/search?q=blind+box&sort=new&after=t3_abc123']);
  for (const href of ['http://169.254.169.254/', '//evil.test/search', '/settings', '/r/Python/../../login', 'javascript:alert(1)']) assert.equal(redlibPath(href), null);
  assert.throws(() => parseRedlib(page('<h1>Upstream error</h1>'), {path}), /unrecognized/);
  assert.throws(() => parseRedlib(page('<div class="error">No posts available due to an upstream error</div>'), {path}), /unrecognized/);
  assert.equal(parseRedlib(page('<p>No results found</p>'), {path: '/search?q=unknown'}).rows.length, 0);
});

test('collection deduplicates IDs, caches success, expires caches and reports bounded pagination', async () => {
  let calls = 0, now = Date.parse('2026-10-04T14:00:00Z');
  const adapter = new RedlibAdapter({baseURL: 'http://127.0.0.1:18080', now: () => now, maxThreads: 0,
    fetchImpl: async url => {
      calls++;
      assert.equal(url.origin, 'http://127.0.0.1:18080');
      return response(page(post() + (url.searchParams.has('after') ? post('def456') : '') + '<a accesskey="N" href="?q=term&after=t3_abc123">NEXT</a>'));
    }});
  const first = await adapter.search({query: 'term', limit: 30});
  assert.equal(first.rows.length, 2);
  assert.equal(calls, 2);
  const second = await adapter.search({query: 'term'});
  assert.equal(calls, 2);
  assert.equal(second.coverage.cacheHits, 2);
  assert.equal(second.rows[0].collectedAt, first.rows[0].collectedAt);
  now += 60_001;
  await adapter.search({query: 'term'});
  assert.equal(calls, 4);
  assert.equal(first.coverage.partial, true, 'thread hydration was intentionally bounded');
});

test('thread follows continuations and reports missing comments and unavailable parent context', async () => {
  const adapter = new RedlibAdapter({baseURL: 'http://localhost:18080', fetchImpl: async url => response(page(
    url.pathname.endsWith('/bbb/') ? comment('bbb', 'Reply from continuation') : post() + comment('aaa', 'First') + `<a href="${path}bbb/">Continue this thread</a>`
  ))});
  const thread = await adapter.thread({path});
  assert.equal(thread.rows.length, 3);
  assert.equal(thread.coverage.pages, 2);
  assert.equal(thread.coverage.partial, true, 'advertised comment count exceeds returned comments');
  assert.equal(thread.coverage.complete, false);
  assert.equal(thread.rows.find(row => row.sourceId === 't1_bbb').parentId, null);
});

test('retry backoff is bounded and respects an overall abort and long Retry-After', async () => {
  let calls = 0; const delays = [];
  const html = await fetchText('http://localhost:18080/search', {fetchImpl: async () => ++calls === 1 ? new Response('', {status: 429}) : response(page(post())), sleep: async ms => delays.push(ms)});
  assert.match(html, /QuietBoard/); assert.deepEqual(delays, [300]);
  await assert.rejects(fetchText('http://localhost', {fetchImpl: async () => new Response('', {status: 429, headers: {'Retry-After': '60'}})}), /upstream_rate_limited/);
  const signal = AbortSignal.abort();
  await assert.rejects(fetchText('http://localhost', {signal, fetchImpl: () => { throw new Error('must not fetch'); }}), {name: 'AbortError'});
  await assert.rejects(fetchText('http://localhost', {fetchImpl: async () => new Response('{}', {headers: {'Content-Type': 'application/json'}})}), /unexpected_content_type/);
});

test('error pages are not cached and continuation failure retains partial rows', async () => {
  let calls = 0;
  const adapter = new RedlibAdapter({baseURL: 'http://localhost:18080', fetchImpl: async () => { calls++; return response(page('<p>Unknown layout</p>')); }});
  await assert.rejects(adapter.search({query: 'term'}));
  await assert.rejects(adapter.search({query: 'term'}));
  assert.equal(calls, 2);
  const partial = new RedlibAdapter({baseURL: 'http://localhost:18080', fetchImpl: async url => response(page(url.searchParams.has('after') ? '<p>Unknown layout</p>' : post() + '<a accesskey="N" href="?after=t3_abc123">NEXT</a>'))});
  const result = await partial.list({subreddit: 'Python'});
  assert.equal(result.rows.length, 1); assert.equal(result.coverage.partial, true);
  assert.deepEqual(result.coverage.errors, ['unrecognized_redlib_page']);
});

test('authenticated bridge and client enforce safe input, redact errors and bound concurrent work', async t => {
  const token = 'fixture-token-'.repeat(4);
  const adapter = new RedlibAdapter({baseURL: 'http://localhost:18080', maxThreads: 0, fetchImpl: async () => response(page(post()))});
  const server = createRedlibBridge({token, adapter}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${baseURL}/v1/search`, {method: 'POST'})).status, 401);
  const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
  assert.equal((await fetch(`${baseURL}/v1/thread`, {method: 'POST', headers, body: JSON.stringify({path: 'http://169.254.169.254/'})})).status, 400);
  const client = new RedlibBridgeAdapter({baseURL, token});
  const results = await Promise.all(Array.from({length: 6}, () => client.search({query: 'QuietBoard', signal: AbortSignal.timeout(5_000)})));
  assert.equal(results.length, 6); assert.equal(results[0].rows[0].sourceId, 't3_abc123');
  assert.throws(() => createRedditAdapter({env: {REDDIT_PROVIDER: 'redlib'}}), /Configure/);
  assert.throws(() => createRedditAdapter({env: {REDDIT_PROVIDER: 'unknown'}}), /Unknown/);
});

test('discovery accepts an injected adapter and preserves comment provenance through classification', async () => {
  const rows = parseRedlib(page(post() + comment('aaa', 'I need subscription reminders.')), {path}).rows;
  const redditAdapter = {id: 'redlib', search: async () => ({rows, coverage: {provider: 'redlib', partial: true}})};
  const result = await discover({id: 'example', name: 'QuietBoard', url: 'https://quietboard.dev', keywords: ['subscription reminders'], aliases: ['QuietBoard']},
    {redditAdapter, now: new Date('2026-10-04T14:00:00Z'), fetchImpl: async () => new Response('{"hits":[]}')});
  assert.equal(result.items.length, 2);
  const matchedComment = result.items.find(item => item.type === 'comment');
  assert.equal(matchedComment.author, 'aaa'); assert.equal(matchedComment.sourceId, 't1_aaa');
  assert.equal(matchedComment.kind, 'opportunity'); assert.ok(matchedComment.collectedAt);
  assert.equal(result.sources.find(source => source.name === 'Reddit').provider, 'redlib');
  assert.match(result.sources.find(source => source.name === 'Reddit').message, /partial coverage/);
});
