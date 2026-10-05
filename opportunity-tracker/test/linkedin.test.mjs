import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeLinkedInSearch, LinkedInCollector} from '../linkedin/collector.mjs';
import {LinkedInBridgeAdapter} from '../linkedin/adapter.mjs';
import {createRedlibBridge} from '../reddit/bridge.mjs';
import {discover} from '../discovery.mjs';
import {createTrackerApp, validateProduct} from '../server.mjs';
import {dueProducts, MONITOR_INTERVAL_MS} from '../monitor.mjs';
import {CollectionError} from '../reddit/http.mjs';
import {createServer} from 'node:http';

const id = '7507254982996332545';
const permalink = `/posts/demo-person_product-tracking-share-${id}-AbCd`;
const block = (name = 'Demo Person', body = 'I need subscription reminders. My calendar is hard to manage.') => `Feed post\n\n${name}\n\n• 3rd+\nSoftware engineer\nSep 20 •\nFollow\n\n${body}\n… more\n6 reactions\nLike\nComment\nRepost\nSend\n`;
const fixture = () => ({sections: {search_results: block()}, references: {search_results: [
  {kind: 'feed_post', url: '/feed/update/urn:li:activity:9999999999999999999/'},
  {kind: 'feed_post', url: permalink},
  {kind: 'person', url: '/in/demo-person/', text: 'Demo Person'},
]}});
const product = {id: 'fixture', name: 'QuietBoard', description: 'Track subscriptions and renewal reminders.', url: 'https://quietboard.dev', keywords: ['subscription reminders'], aliases: ['QuietBoard'], communities: [], linkedin: true, monitoring: true};

test('unordered references retain only unique observed author/permalink matches; no URN ordering guesses', () => {
  const value = fixture();
  value.sections.search_results += block('Another Person', 'I need subscription reminders too.');
  value.references.search_results.unshift({kind: 'person', url: '/in/another-person/', text: 'Another Person'});
  const result = normalizeLinkedInSearch(value, {collectedAt: '2026-10-05T08:30:00Z'});
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].author, 'Demo Person');
  assert.equal(result.rows[0].url, `https://www.linkedin.com${permalink}`);
  assert.equal(result.rows[0].sourceId, `li_${id}`);
  assert.equal(result.rows[0].publishedAt, null);
  assert.equal(result.coverage.skippedPosts, 1);
  assert.equal(result.coverage.complete, false);
  assert(!result.rows[0].snippet.includes('Software engineer'));
  assert(!result.rows[0].snippet.includes('reactions'));
  value.sections.search_results += block();
  assert.equal(normalizeLinkedInSearch(value).rows.length, 0, 'Two posts from one author cannot be mapped by order');
});

test('ambiguous links, external links, missing shapes and section failures never become invented posts or empty success', () => {
  const value = fixture();
  value.references.search_results.push({kind: 'feed_post', url: `/posts/demo-person_another-share-7507254982996332546-AbCd`});
  assert.equal(normalizeLinkedInSearch(value).rows.length, 0);
  value.references.search_results = [{kind: 'person', url: '/in/demo-person/', text: 'Demo Person'}, {kind: 'feed_post', url: 'https://evil.test' + permalink}];
  assert.equal(normalizeLinkedInSearch(value).rows.length, 0);
  assert.throws(() => normalizeLinkedInSearch({sections: {}}), /schema_changed/);
  assert.throws(() => normalizeLinkedInSearch({sections: {search_results: ''}, section_errors: {search_results: {error_type: 'rate_limit', error_message: 'private secret'}}}), /provider_failed/);
  assert.throws(() => normalizeLinkedInSearch({sections: {}, section_errors: {search_results: {error_type: 'authentication'}}}), /session_required/);
  const empty = normalizeLinkedInSearch({sections: {search_results: 'No results found. Try different keywords.'}});
  assert.deepEqual(empty.rows, []); assert.equal(empty.coverage.observedPosts, 0);
});

test('MCP transport initializes SSE session, calls only bounded read-only post search, caches success, and closes session', async () => {
  const calls = []; let now = 1_000_000;
  const collector = new LinkedInCollector({endpoint: 'http://mcp:8080/mcp', now: () => now, fetchImpl: async (_url, options) => {
    calls.push(options);
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    const body = JSON.parse(options.body);
    if (!body.id) return new Response(null, {status: 202});
    const result = body.method === 'initialize' ? {protocolVersion: '2025-03-26'} : {structuredContent: fixture()};
    return new Response(`event: message\r\ndata: ${JSON.stringify({jsonrpc: '2.0', id: body.id, result})}\r\n\r\n`, {headers: {'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'fixture-session'}});
  }});
  const first = await collector.search({query: 'subscription reminders', datePosted: 'past-month', signal: AbortSignal.timeout(1000)});
  assert.equal(first.rows.length, 1);
  assert.deepEqual(JSON.parse(calls[2].body).params, {name: 'search_posts', arguments: {keywords: 'subscription reminders', max_pages: 1, date_posted: 'past-month'}});
  assert.equal(calls[2].headers['Mcp-Session-Id'], 'fixture-session');
  assert.equal(calls[2].headers.Host, '127.0.0.1:8080');
  assert.equal((await collector.search({query: 'subscription reminders', datePosted: 'past-month'})).coverage.cacheHit, true);
  assert.equal(calls.length, 4);
  now += 300_001; await collector.search({query: 'subscription reminders', datePosted: 'past-month'});
  assert.equal(calls.length, 8);
  await assert.rejects(collector.search({query: 'x', datePosted: 'all'}), /invalid/);
  assert.throws(() => new LinkedInCollector({endpoint: 'https://evil.test/mcp'}), /private/);
});

test('MCP tool errors and malformed replies fail closed; failures are not cached', async () => {
  let starts = 0;
  const collector = new LinkedInCollector({endpoint: 'http://mcp:8080/mcp', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (!body.id) return new Response(null, {status: 202});
    if (body.method === 'initialize') {starts++; return Response.json({id: body.id, result: {protocolVersion: '2025-03-26'}});}
    return Response.json({id: body.id, result: {isError: true, content: [{type: 'text', text: 'private-token: login required'}]}});
  }});
  for (let i = 0; i < 2; i++) await assert.rejects(collector.search({query: 'fixture'}), /session_required/);
  assert.equal(starts, 2);
});

test('real HTTP transport preserves MCP loopback authority on a private connection', async t => {
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push({method: req.method, host: req.headers.host});
    if (req.method === 'DELETE') {res.writeHead(204); return res.end();}
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body.id) {res.writeHead(202); return res.end();}
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'test-session'});
    const result = body.method === 'initialize' ? {protocolVersion: '2025-03-26'} : {structuredContent: fixture()};
    res.end(`event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: body.id, result})}\n\n`);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const collector = new LinkedInCollector({endpoint: `http://localhost:${port}/mcp`});
  const result = await collector.search({query: 'fixture', signal: AbortSignal.timeout(2000)});
  assert.equal(result.rows.length, 1);
  assert(calls.every(call => call.host === `127.0.0.1:${port}`));
  assert.equal(calls.length, 4);
});

test('expired MCP collection sends cancellation and deletes the session even when cancellation transport fails', async () => {
  for (const cancelFails of [false, true]) {
    const methods = []; let entered;
    const started = new Promise(resolve => {entered = resolve;});
    const controller = new AbortController();
    const collector = new LinkedInCollector({endpoint: 'http://mcp:8080/mcp', fetchImpl: async (_url, options) => {
      if (options.method === 'DELETE') {methods.push('DELETE');return new Response(null, {status: 204});}
      const body = JSON.parse(options.body); methods.push(body.method);
      if (body.method === 'initialize') return Response.json({id: 1, result: {protocolVersion: '2025-03-26'}}, {headers: {'Mcp-Session-Id': 'fixture-session'}});
      if (body.method === 'tools/call') {entered();return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));}
      if (body.method === 'notifications/cancelled' && cancelFails) throw Error('test cancellation transport failure');
      return new Response(null, {status: 202});
    }});
    const request = collector.search({query: 'fixture', signal: controller.signal});
    await started; controller.abort();
    await assert.rejects(request, /linkedin_timeout/);
    assert.deepEqual(methods.slice(-2), ['notifications/cancelled', 'DELETE']);
  }
});

test('gateway enforces existing bearer auth, bounded inputs, one LinkedIn call at a time, safe failures, and Redlib compatibility', async t => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const bridge = createRedlibBridge({token: 'x'.repeat(32), adapter: {search: async () => ({rows: [], coverage: {provider: 'redlib'}})}, linkedinCollector: {search: async ({query}) => {
    if (query === 'pending') await pending;
    if (query === 'fail') throw Error('secret provider failure');
    return normalizeLinkedInSearch(fixture());
  }}}).listen(0, '127.0.0.1');
  await once(bridge, 'listening');t.after(() => new Promise(resolve => bridge.close(resolve)));
  const baseURL = `http://127.0.0.1:${bridge.address().port}`;
  const headers = {'Content-Type': 'application/json', Authorization: 'Bearer ' + 'x'.repeat(32)};
  const post = body => fetch(baseURL + '/v1/linkedin/search', {method: 'POST', headers, body: JSON.stringify(body)});
  assert.equal((await fetch(baseURL + '/v1/linkedin/search', {method: 'POST'})).status, 401);
  assert.equal((await post({query: 'x', tool: 'send_message'})).status, 400);
  assert.equal((await post({query: 'x', limit: 31})).status, 400);
  assert.equal((await post({query: 'x', datePosted: 'all'})).status, 400);
  const inFlight = post({query: 'pending'}); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await post({query: 'busy'})).status, 429); release(); await inFlight;
  assert.equal((await post({query: 'fail'})).status, 502);
  assert.equal(await (await post({query: 'fail'})).text(), '{"error":"linkedin_provider_failed"}');
  const client = new LinkedInBridgeAdapter({baseURL, token: 'x'.repeat(32)});
  assert.equal((await client.search({query: 'fixture'})).rows.length, 1);
  const reddit = await fetch(baseURL + '/v1/search', {method: 'POST', headers, body: JSON.stringify({query: 'fixture'})});
  assert.equal((await reddit.json()).coverage.provider, 'redlib');
});

test('scheduled LinkedIn searches use existing matching, empty/failure coverage, and a two-query cap', async () => {
  let calls = 0;
  const options = {watchOnly: true, linkedinAdapter: {search: async ({datePosted}) => {calls++; assert([null, 'past-month'].includes(datePosted)); return normalizeLinkedInSearch(fixture());}}};
  const result = await discover(product, options);
  assert.equal(calls, 2); assert.equal(result.sources.length, 1); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].provider, 'linkedin-mcp'); assert.equal(result.items[0].kind, 'opportunity');
  assert.match(result.sources[0].message, /coverage is partial/i);
  const empty = await discover(product, {watchOnly: true, linkedinAdapter: {search: async () => ({rows: [], coverage: {provider: 'linkedin-mcp'}})}});
  assert.equal(empty.sources[0].status, 'ok'); assert.equal(empty.items.length, 0);
  const failure = await discover(product, {watchOnly: true, linkedinAdapter: {search: async () => {throw new CollectionError('linkedin_session_required');}}});
  assert.equal(failure.sources[0].status, 'error'); assert.match(failure.sources[0].message, /renew/);
  assert(!JSON.stringify(failure).includes('private-token'));
  const mixed = await discover(product, {watchOnly: true, linkedinAdapter: {search: async ({datePosted}) => {if (!datePosted) throw Error('secret-token'); return normalizeLinkedInSearch(fixture());}}});
  assert.equal(mixed.items.length, 1); assert.match(mixed.sources[0].message, /Completed 1 of 2/); assert(!JSON.stringify(mixed).includes('secret-token'));
});

test('bridge client serializes work and removes an aborted queued request without releasing another request', async () => {
  let release, started;
  const pending = new Promise(resolve => {release = resolve;});
  const entered = new Promise(resolve => {started = resolve;});
  const calls = [];
  const client = new LinkedInBridgeAdapter({baseURL: 'http://localhost:8081', token: 'x'.repeat(32), fetchImpl: async (_url, options) => {
    const {query} = JSON.parse(options.body); calls.push(query);
    if (query === 'first') {started(); await pending;}
    return Response.json({rows: [], coverage: {provider: 'linkedin-mcp'}});
  }});
  const first = client.search({query: 'first'}); await entered;
  const controller = new AbortController();
  const queued = client.search({query: 'aborted', signal: controller.signal});
  const third = client.search({query: 'third'});
  controller.abort(); await assert.rejects(queued);
  assert.deepEqual(calls, ['first']);
  release(); await Promise.all([first, third]);
  assert.deepEqual(calls, ['first', 'third']);
});

test('the gateway limits LinkedIn requests to twelve per minute independently of Redlib', async t => {
  const app = createRedlibBridge({token: 'x'.repeat(32), adapter: {search: async () => ({rows: [], coverage: {provider: 'redlib'}})}, linkedinCollector: {search: async () => ({rows: [], coverage: {provider: 'linkedin-mcp'}})}});
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + 'x'.repeat(32)}, body: JSON.stringify({query: 'fixture'})};
  for (let i = 0; i < 12; i++) assert.equal((await fetch(origin + '/v1/linkedin/search', options)).status, 200);
  assert.equal((await fetch(origin + '/v1/linkedin/search', options)).status, 429);
  assert.equal((await fetch(origin + '/v1/search', options)).status, 200);
});

test('LinkedIn-only hourly products persist source identity, notes and statuses through searches and backups; old profiles stay off', async t => {
  assert.equal(validateProduct({...product, linkedin: undefined, monitoring: false}).linkedin, false);
  assert.throws(() => validateProduct({...product, linkedin: 'true'}), /LinkedIn/);
  assert.equal(dueProducts({products: [product], searches: {}}, MONITOR_INTERVAL_MS).length, 1);
  const directory = await mkdtemp(join(tmpdir(), 'tracker-linkedin-'));
  const tracker = createTrackerApp({dataDirectory: directory, linkedinAvailable: true, discoverFn: p => discover(p, {watchOnly: true, linkedinAdapter: {search: async () => normalizeLinkedInSearch(fixture())}})});
  const server = tracker.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive: true, force: true});});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = await fetch(origin + '/api/state').then(r => r.json());
  assert.equal(state.sources.linkedin.available, true);
  const headers = {'Content-Type': 'application/json', 'X-Tracker-Token': state.token};
  const p = await fetch(origin + '/api/products', {method: 'POST', headers, body: JSON.stringify(product)}).then(r => r.json());
  await tracker.runSearch(p.product.id, true);
  const item = tracker.store.snapshot().items[0];
  tracker.store.updateItem(item.id, {status: 'saved', note: 'Check the original post.'});
  await tracker.runSearch(p.product.id);
  assert.equal(tracker.store.snapshot().items[0].status, 'saved');
  assert.equal(tracker.store.snapshot().items[0].note, 'Check the original post.');
  assert.equal(tracker.store.snapshot().searches[p.product.id].trigger, 'manual');
  const backup = await fetch(origin + '/api/export').then(r => r.json());
  assert.equal((await fetch(origin + '/api/import', {method: 'POST', headers, body: JSON.stringify(backup)})).status, 200);
  const restored = tracker.store.snapshot();
  assert.equal(restored.products[0].linkedin, true); assert.equal(restored.items[0].sourceId, `li_${id}`);
  assert.equal(restored.items[0].provider, 'linkedin-mcp'); assert.equal(restored.items[0].note, 'Check the original post.');
});
