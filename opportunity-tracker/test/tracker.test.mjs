import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createTrackerApp } from '../server.mjs';
import { Store } from '../store.mjs';
import { htmlMetadata, importMetadata, isPrivateAddress, plainText, publicUrl } from '../metadata.mjs';
import { discover, publicSourceURL } from '../discovery.mjs';

const productInput = {
  name: 'QuietBoard',
  description: 'Keep track of recurring subscriptions and renewal reminders.',
  url: 'https://quietboard.dev/',
  keywords: ['subscription reminders'],
  aliases: ['QuietBoard'],
  exclusions: ['enterprise'],
};
const match = (url, kind = 'opportunity', title = 'I need subscription reminders') => ({
  url, kind, title, snippet: 'Looking for subscription reminders before renewal.',
  source: 'Hacker News', author: 'someone', publishedAt: '2026-10-01T12:00:00.000Z',
  matchedTerms: kind === 'mention' ? ['QuietBoard'] : ['subscription reminders'],
  reason: 'Review needed: confirm this discussion is relevant.',
});

async function tracker(t, options = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'opportunity-tracker-test-'));
  const created = createTrackerApp({
    dataDirectory,
    discoverFn: async () => ({ items: [], sources: [], searchedAt: '2026-10-03T12:00:00.000Z' }),
    metadataFn: async url => ({ name: 'Imported product', description: 'Public product details', url, type: 'website' }),
    ...options,
  });
  const server = created.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const host = `localhost:${port}`;
  const origin = `http://${host}`;
  let token;
  async function request(path, { method = 'GET', body, headers = {}, authorized = true } = {}) {
    // Node fetch rewrites Host to the destination address. Use the HTTP client
    // here so the server really receives localhost and hostile Host fixtures.
    const response = await new Promise((resolve, reject) => {
      const outgoing = httpRequest(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Host: host,
          ...(method !== 'GET' && authorized ? { 'X-Tracker-Token': token } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: incoming.statusCode, headers: incoming.headers })));
        incoming.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.end(body !== undefined ? typeof body === 'string' ? body : JSON.stringify(body) : undefined);
    });
    const value = await response.json();
    return { response, value };
  }
  token = (await request('/api/state')).value.token;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return { ...created, dataDirectory, request, host, origin, token };
}

async function addProduct(instance, value = productInput) {
  const result = await instance.request('/api/products', { method: 'POST', body: value });
  assert.equal(result.response.status, 201, JSON.stringify(result.value));
  return result.value.product;
}

test('saved, dismissed, notes, products and discovery history survive restart and repeated discovery', async t => {
  let run = 0;
  const instance = await tracker(t, {
    discoverFn: async product => {
      assert.equal(product.name, 'QuietBoard');
      run++;
      return {
        items: [
          match('https://news.ycombinator.com/item?id=1201', 'opportunity', `Need reminders — revision ${run}`),
          match('https://news.ycombinator.com/item?id=1202', 'mention', `QuietBoard mention — revision ${run}`),
        ],
        sources: [{ name: 'Hacker News', status: 'ok', count: 2, queries: [], message: 'Limited public sample.' }],
        searchedAt: `2026-10-0${run + 1}T12:00:00.000Z`,
      };
    },
  });
  const product = await addProduct(instance);
  const first = await instance.request(`/api/products/${product.id}/search`, { method: 'POST' });
  assert.equal(first.response.status, 200);
  assert.equal(first.value.items.length, 2);
  const opportunity = first.value.items.find(item => item.kind === 'opportunity');
  const mention = first.value.items.find(item => item.kind === 'mention');
  const saved = await instance.request(`/api/items/${opportunity.id}`, { method: 'PATCH', body: { status: 'saved', note: 'Ask whether calendar export would help.', draft: 'A saved response before rediscovery.' } });
  assert.equal(saved.response.status, 200);
  const dismissed = await instance.request(`/api/items/${mention.id}`, { method: 'PATCH', body: { status: 'dismissed', note: 'An unrelated product with the same name.' } });
  assert.equal(dismissed.response.status, 200);

  const second = await instance.request(`/api/products/${product.id}/search`, { method: 'POST' });
  assert.equal(second.response.status, 200);
  assert.equal(second.value.items.length, 2, 'rediscovery must update records rather than duplicate them');
  const updated = second.value.items.find(item => item.id === opportunity.id);
  assert.equal(updated.status, 'saved');
  assert.equal(updated.note, 'Ask whether calendar export would help.');
  assert.equal(updated.draft, 'A saved response before rediscovery.');
  assert.equal(updated.foundAt, opportunity.foundAt);
  assert.equal(updated.lastSeenAt, '2026-10-03T12:00:00.000Z');
  assert.match(updated.title, /revision 2/);
  assert.equal(second.value.items.find(item => item.id === mention.id).status, 'dismissed');

  const state = (await instance.request('/api/state')).value;
  const restarted = new Store(instance.dataDirectory).snapshot();
  assert.deepEqual(restarted.products, state.products);
  assert.deepEqual(restarted.items, state.items);
  assert.deepEqual(restarted.searches, state.searches);
  assert.equal(restarted.items.find(item => item.id === mention.id).note, 'An unrelated product with the same name.');

  const restored = await instance.request(`/api/items/${mention.id}`, { method: 'PATCH', body: { status: 'new' } });
  assert.equal(restored.value.item.status, 'new');
  assert.equal(restored.value.item.note, 'An unrelated product with the same name.');
});

test('product updates preserve identity and deleting a product removes only its records', async t => {
  const instance = await tracker(t, {
    discoverFn: async product => ({ items: [match(`https://news.ycombinator.com/item?id=${product.name === 'QuietBoard' ? 21 : 22}`)], sources: [], searchedAt: '2026-10-03T12:00:00.000Z' }),
  });
  const first = await addProduct(instance);
  const second = await addProduct(instance, { ...productInput, name: 'Other product', url: 'https://otherproduct.dev/' });
  await instance.request(`/api/products/${first.id}/search`, { method: 'POST' });
  await instance.request(`/api/products/${second.id}/search`, { method: 'POST' });
  const updated = await instance.request(`/api/products/${first.id}`, { method: 'PUT', body: { ...productInput, name: 'QuietBoard updated', keywords: ['renewal reminders'] } });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.value.product.id, first.id);
  assert.equal(updated.value.product.createdAt, first.createdAt);
  assert.deepEqual(updated.value.product.keywords, ['renewal reminders']);
  assert.equal((await instance.request(`/api/products/${first.id}`, { method: 'DELETE' })).response.status, 200);
  const state = (await instance.request('/api/state')).value;
  assert.deepEqual(state.products.map(product => product.id), [second.id]);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].productId, second.id);
  assert.equal(state.searches[first.id], undefined);
  assert.ok(state.searches[second.id]);
});

test('mutation authorization rejects missing tokens, cross-origin requests and untrusted hosts', async t => {
  const instance = await tracker(t);
  const missingToken = await instance.request('/api/products', { method: 'POST', body: productInput, authorized: false });
  assert.equal(missingToken.response.status, 403);
  const crossOrigin = await instance.request('/api/products', { method: 'POST', body: productInput, headers: { Origin: 'https://unrelated.dev' } });
  assert.equal(crossOrigin.response.status, 403);
  const badHost = await instance.request('/api/state', { headers: { Host: 'attacker.dev' } });
  assert.equal(badHost.response.status, 403);
  const sameOrigin = await instance.request('/api/products', { method: 'POST', body: productInput, headers: { Origin: instance.origin } });
  assert.equal(sameOrigin.response.status, 201);
  assert.equal((await instance.request('/api/state')).value.products.length, 1);
  assert.equal(badHost.response.headers.get('x-powered-by'), null);
  assert.equal(sameOrigin.response.headers.get('x-content-type-options'), 'nosniff');
});

test('invalid product and match inputs are rejected without changing persisted records', async t => {
  const instance = await tracker(t, {
    discoverFn: async () => ({ items: [match('https://news.ycombinator.com/item?id=31')], sources: [], searchedAt: '2026-10-03T12:00:00.000Z' }),
  });
  for (const invalid of [
    { ...productInput, name: '' },
    { ...productInput, keywords: [] },
    { ...productInput, url: 'http://127.0.0.1/' },
    { ...productInput, url: 'https://user:password@quietboard.dev/' },
    { ...productInput, keywords: ['x'.repeat(161)] },
  ]) {
    assert.equal((await instance.request('/api/products', { method: 'POST', body: invalid })).response.status, 400);
  }
  assert.equal(instance.store.snapshot().products.length, 0);
  const product = await addProduct(instance);
  const search = await instance.request(`/api/products/${product.id}/search`, { method: 'POST' });
  const item = search.value.items[0];
  for (const body of [{ status: 'contacted' }, { note: 'x'.repeat(3001) }, { note: {} }]) {
    assert.equal((await instance.request(`/api/items/${item.id}`, { method: 'PATCH', body })).response.status, 400);
  }
  assert.deepEqual(instance.store.snapshot().items[0], item);
  assert.equal((await instance.request('/api/items/missing', { method: 'PATCH', body: { status: 'saved' } })).response.status, 404);
});

test('metadata API returns imported fields and rejects local URLs before any network request', async t => {
  const imported = await tracker(t);
  const result = await imported.request('/api/metadata', { method: 'POST', body: { url: 'https://quietboard.dev/' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.name, 'Imported product');
  assert.equal(result.value.description, 'Public product details');
  assert.equal(result.value.type, 'website');
  assert.equal((await imported.request('/api/metadata', { method: 'POST', body: { url: {} } })).response.status, 400);

  const validating = await tracker(t, { metadataFn: importMetadata });
  for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://192.168.1.10/', 'https://[::1]/', 'https://quietboard.dev:8443/']) {
    const rejected = await validating.request('/api/metadata', { method: 'POST', body: { url } });
    assert.equal(rejected.response.status, 400, url);
    assert.match(rejected.value.error, /public website URL/);
  }
});

test('a running search cannot overlap or race a backup restore, and failure allows a retry', async t => {
  let release;
  let calls = 0;
  const started = new Promise(resolve => { release = resolve; });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const instance = await tracker(t, {
    discoverFn: async () => {
      calls++;
      if (calls === 1) { release(); await pending; throw new Error('Test source failure'); }
      return { items: [], sources: [], searchedAt: '2026-10-03T12:00:00.000Z' };
    },
  });
  const product = await addProduct(instance);
  const running = instance.request(`/api/products/${product.id}/search`, { method: 'POST' });
  await started;
  assert.deepEqual((await instance.request('/api/state')).value.busy, [product.id]);
  assert.equal((await instance.request(`/api/products/${product.id}/search`, { method: 'POST' })).response.status, 409);
  const backup = (await instance.request('/api/export')).value;
  assert.equal((await instance.request('/api/import', { method: 'POST', body: backup })).response.status, 400);
  finish();
  assert.equal((await running).response.status, 400);
  assert.deepEqual((await instance.request('/api/state')).value.busy, []);
  assert.equal((await instance.request(`/api/products/${product.id}/search`, { method: 'POST' })).response.status, 200);
  assert.equal(calls, 2);
});

test('JSON export and restore preserve durable products, decisions and notes', async t => {
  const original = await tracker(t, {
    discoverFn: async () => ({ items: [{...match('https://www.reddit.com/r/Python/comments/abc123/_/def456/'),
      source: 'Reddit', provider: 'redlib', sourceId: 't1_def456', postId: 'abc123', parentId: 't3_abc123', type: 'comment', collectedAt: '2026-10-03T11:59:00.000Z'}], sources: [], searchedAt: '2026-10-03T12:00:00.000Z' }),
  });
  const product = await addProduct(original, { ...productInput, url: 'https://apps.apple.com/us/app/quietboard/id123456789' });
  const search = await original.request(`/api/products/${product.id}/search`, { method: 'POST' });
  await original.request(`/api/items/${search.value.items[0].id}`, { method: 'PATCH', body: { status: 'saved', note: 'Review next week.', draft: 'Draft survives backup restore.' } });
  const exported = await original.request('/api/export');
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get('content-disposition'), /product-tracker\.json/);
  assert.equal(exported.value.token, undefined);
  const restored = await tracker(t);
  assert.equal((await restored.request('/api/import', { method: 'POST', body: exported.value })).response.status, 200);
  const snapshot = new Store(restored.dataDirectory).snapshot();
  assert.deepEqual(snapshot.products, exported.value.products);
  assert.deepEqual(snapshot.items, exported.value.items);
  assert.deepEqual(snapshot.searches, {}, 'volatile source status is refreshed by a new search');
  assert.equal(snapshot.products[0].type, 'app_store');
});

test('ScrapeBadger backup restore preserves source identity, saved decisions, and notes', async t => {
  const original = await tracker(t, {discoverFn:async() => ({items:[{...match('https://www.reddit.com/r/swift/comments/abc123/_/c123/'),
    source:'Reddit comment',provider:'scrapebadger',sourceId:'t1_c123',postId:'t3_abc123',parentId:'t3_abc123',type:'comment',
    collectedAt:'2026-10-06T12:00:00.000Z'}],sources:[],searchedAt:'2026-10-06T12:00:00.000Z'})});
  const product = await original.store.saveProduct(productInput);
  const search = await original.request(`/api/products/${product.id}/search`, {method:'POST'});
  await original.request(`/api/items/${search.value.items[0].id}`, {method:'PATCH',body:{status:'saved',note:'Keep this comment.'}});
  const exported = (await original.request('/api/export')).value;
  const restored = await tracker(t);
  assert.equal((await restored.request('/api/import',{method:'POST',body:exported})).response.status,200);
  const [item] = restored.store.snapshot().items;
  assert.equal(item.provider,'scrapebadger');assert.equal(item.sourceId,'t1_c123');assert.equal(item.postId,'t3_abc123');
  assert.equal(item.parentId,'t3_abc123');assert.equal(item.status,'saved');assert.equal(item.note,'Keep this comment.');
});

test('Apify LinkedIn backup restore preserves post identity, saved decisions, and notes', async t => {
  const id = '7507254982996332545';
  const original = await tracker(t,{discoverFn:async() => ({items:[{...match(`https://www.linkedin.com/posts/demo-person_product-tracking-activity-${id}-AbCd`),
    source:'LinkedIn',provider:'linkedin-apify',sourceId:`li_${id}`,postId:id,parentId:null,type:'post',
    collectedAt:'2026-10-06T12:00:00.000Z'}],sources:[],searchedAt:'2026-10-06T12:00:00.000Z'})});
  const product = await original.store.saveProduct(productInput);
  const search = await original.request(`/api/products/${product.id}/search`,{method:'POST'});
  await original.request(`/api/items/${search.value.items[0].id}`,{method:'PATCH',body:{status:'saved',note:'Check this LinkedIn need.'}});
  const exported = (await original.request('/api/export')).value;
  const restored = await tracker(t);
  assert.equal((await restored.request('/api/import',{method:'POST',body:exported})).response.status,200);
  const [item] = restored.store.snapshot().items;
  assert.equal(item.provider,'linkedin-apify');assert.equal(item.sourceId,`li_${id}`);assert.equal(item.postId,id);
  assert.equal(item.parentId,null);assert.equal(item.status,'saved');assert.equal(item.note,'Check this LinkedIn need.');
});

test('restore rejects malformed and unsafe backups atomically and cannot pollute prototypes', async t => {
  const instance = await tracker(t, {
    discoverFn: async () => ({ items: [match('https://news.ycombinator.com/item?id=51')], sources: [], searchedAt: '2026-10-03T12:00:00.000Z' }),
  });
  const product = await addProduct(instance);
  await instance.request(`/api/products/${product.id}/search`, { method: 'POST' });
  const before = instance.store.snapshot();
  const missingId = structuredClone(before);
  delete missingId.products[0].id;
  const invalidBackups = [
    { ...before, version: 99 },
    missingId,
    { ...before, products: [{ ...before.products[0], id: '__proto__' }] },
    { ...before, products: [{ ...before.products[0], id: 'constructor' }] },
    { ...before, products: [before.products[0], before.products[0]] },
    { ...before, items: [before.items[0], before.items[0]] },
    { ...before, items: [{ ...before.items[0], productId: 'missing' }] },
    { ...before, items: [{ ...before.items[0], status: 'contacted' }] },
    { ...before, items: [{ ...before.items[0], url: 'http://10.0.0.1/' }] },
  ];
  for (const backup of invalidBackups) {
    const result = await instance.request('/api/import', { method: 'POST', body: backup });
    assert.equal(result.response.status, 400, JSON.stringify(backup));
    assert.deepEqual(instance.store.snapshot(), before, 'an invalid backup must not partially replace saved data');
  }
  const polluted = JSON.parse(JSON.stringify(before));
  Object.defineProperty(polluted, '__proto__', { value: { trackerPolluted: true }, enumerable: true });
  Object.defineProperty(polluted.items[0], '__proto__', { value: { trackerPolluted: true }, enumerable: true });
  polluted.items[0].constructor = { prototype: { trackerPolluted: true } };
  const result = await instance.request('/api/import', { method: 'POST', body: polluted });
  assert.ok([200, 400].includes(result.response.status));
  assert.equal(Object.prototype.trackerPolluted, undefined);
  assert.equal(({}).trackerPolluted, undefined);
  assert.equal(instance.store.snapshot().items[0].status, 'new');
  assert.equal(Object.hasOwn(instance.store.snapshot().items[0], '__proto__'), false);
  assert.equal(Object.hasOwn(instance.store.snapshot().items[0], 'constructor'), false);
});

test('HTML product metadata prefers site names, decodes text and removes executable markup', () => {
  const metadata = htmlMetadata(`<!doctype html><title>Fallback</title>
    <META property='og:title' content='Product page'>
    <meta content="Quiet &amp; Board" PROPERTY="og:site_name">
    <meta name=description content='Reminders &quot;on time&quot; &amp; a calendar.'>
    <meta property='og:description' content='Less useful fallback'>`, 'https://quietboard.dev/');
  assert.deepEqual(metadata, { name: 'Quiet & Board', description: 'Reminders "on time" & a calendar.', url: 'https://quietboard.dev/', type: 'website' });
  assert.equal(htmlMetadata('<title> Board <b>tracker</b> </title>', 'https://quietboard.dev/').name, 'Board tracker');
  assert.equal(htmlMetadata('<html></html>', 'https://quietboard.dev/').name, 'quietboard.dev');
  assert.equal(plainText('<style>hide me</style><script>alert(1)</script>Useful <b>text</b> &#65; &nbsp; next'), 'Useful text A next');
  assert.equal(publicUrl('quietboard.dev/#details').href, 'https://quietboard.dev/');
});

test('metadata address validation accepts public IPv4 and IPv6 while blocking private and mapped addresses', () => {
  for (const address of ['199.16.172.28', '23.45.72.32', '2600:140a:1000:482::2a1']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:199.16.172.28', 'not-an-address']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('199.16.172.28', 4), false);
  assert.equal(isPrivateAddress('2600:140a:1000:482::2a1', 6), false);
});

async function withoutWebKey(fn) {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try { return await fn(); }
  finally { if (previous !== undefined) process.env.OPENAI_API_KEY = previous; }
}
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('discovery finds relevant needs and exact mentions, ignores unrelated context, and deduplicates sources', async () => {
  await withoutWebKey(async () => {
    const requests = [];
    const result = await discover({ ...productInput, id: 'test-product' }, {
      now: new Date('2026-10-03T12:00:00.000Z'),
      fetchImpl: async (input, options) => {
        const url = new URL(input);
        requests.push(url);
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        if (url.hostname === 'hn.algolia.com') return jsonResponse({ hits: [
          { objectID: '100', title: 'How can I get subscription reminders before renewal?', story_text: '<p>I need an app for this.</p>', author: 'reader', created_at_i: 1790938800 },
          { objectID: '101', title: 'QuietBoard has a useful reminder screen', story_text: 'My notes about the product', author: 'writer', created_at_i: 1735689600 },
          { objectID: '102', title: 'History of subscription reminders', story_text: 'A survey of existing products.' },
          { objectID: '103', title: 'QuietBoardly is an unrelated project', story_text: 'No product mention here.' },
          { objectID: '104', title: 'I need subscription reminders for enterprise billing', story_text: 'Can you recommend a tool?' },
          { objectID: '105', story_title: 'QuietBoard and subscription reminders', comment_text: 'Thanks for sharing.', _tags: ['comment'], author: 'commenter' },
          { objectID: '106', title: 'I need subscription reminders', story_text: 'Any recommendation?', created_at_i: 1767225600 },
        ] });
        if (url.hostname === 'www.reddit.com') return jsonResponse({ data: { children: [
          { data: { title: 'I need subscription reminders', selftext: 'Any recommendation for a small app?', permalink: '/r/productivity/comments/abc123/first_title/', author: 'person' } },
          { data: { title: 'I need subscription reminders', selftext: 'Same public discussion in another search.', permalink: '/r/productivity/comments/abc123/second_title/?utm_source=test', author: 'person' } },
          { data: { title: 'QuietBoard', selftext: '[removed]', permalink: '/r/productivity/comments/abc124/removed/', author: '[deleted]' } },
          { data: { title: 'QuietBoard', selftext: 'An archived post', permalink: '/r/productivity/comments/abc125/archived/', author: 'person', archived: true } },
        ] } });
        throw new Error(`Unexpected provider request: ${url.hostname}`);
      },
    });
    assert.equal(result.searchedAt, '2026-10-03T12:00:00.000Z');
    assert.equal(result.items.length, 3);
    assert.equal(new Set(result.items.map(item => item.url)).size, 3);
    assert.equal(result.items.find(item => item.url.endsWith('id=100')).kind, 'opportunity');
    assert.equal(result.items.find(item => item.url.endsWith('id=101')).kind, 'mention');
    assert.equal(result.items.find(item => item.url.endsWith('id=101')).publishedAt, '2025-01-01T00:00:00.000Z', 'historical mentions remain useful');
    assert.equal(result.items.find(item => item.url.endsWith('id=106')), undefined, 'old dated opportunities are not current needs');
    assert.equal(result.items.find(item => item.source === 'Reddit').url, 'https://www.reddit.com/r/productivity/comments/abc123/');
    assert.match(result.items.find(item => item.source === 'Reddit').reason, /date is unavailable/);
    assert.ok(result.items.every(item => item.reason.startsWith('Review needed:') && item.matchedTerms.length));
    assert.ok(result.items.every(item => !item.snippet.includes('<p>')));
    assert.deepEqual(result.sources.map(source => [source.name, source.status]), [['Hacker News', 'ok'], ['Reddit', 'ok'], ['Web search', 'unconfigured']]);
    assert.ok(requests.length > 2, 'opportunity and mention queries should both be searched');
    assert.ok(requests.every(url => ['hn.algolia.com', 'www.reddit.com'].includes(url.hostname)));
    assert.ok(requests.some(url => url.pathname === '/api/v1/search_by_date' && url.searchParams.get('numericFilters')?.startsWith('created_at_i>')));
    assert.ok(requests.some(url => url.pathname === '/api/v1/search' && url.searchParams.get('query') === '"QuietBoard"'));
    assert.equal(result.sources.find(source => source.name === 'Hacker News').count, 2);
    assert.equal(result.sources.find(source => source.name === 'Reddit').count, 1);
  });
});

test('discovery retains healthy-source matches and reports provider failures without leaking secrets', async () => {
  await withoutWebKey(async () => {
    const result = await discover({ ...productInput, id: 'test-product' }, {
      fetchImpl: async input => {
        if (new URL(input).hostname === 'hn.algolia.com') throw new Error('provider failed with secret=private-api-key');
        return jsonResponse({ data: { children: [{ data: { title: 'QuietBoard feedback', selftext: 'Useful reminder app', permalink: '/r/productivity/comments/xyz123/feedback/', author: 'reader' } }] } });
      },
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, 'mention');
    const failed = result.sources.find(source => source.name === 'Hacker News');
    assert.equal(failed.status, 'error');
    assert.match(failed.message, /could not be reached/);
    assert.doesNotMatch(JSON.stringify(result), /private-api-key/);
    assert.equal(result.sources.find(source => source.name === 'Reddit').status, 'ok');
  });
});

test('explicit product aliases disambiguate common names in discussion text', async () => {
  await withoutWebKey(async () => {
    const result = await discover({
      ...productInput, id: 'day-one-product', name: 'Day One',
      url: 'https://dayoneapp.com/', keywords: ['journaling app'], aliases: ['Day One journal'], exclusions: [],
    }, {
      now: new Date('2026-10-03T12:00:00.000Z'),
      fetchImpl: async input => {
        if (new URL(input).hostname === 'hn.algolia.com') return jsonResponse({ hits: [
          { objectID: '201', title: 'We have tracked this since day one', story_text: 'A general discussion about project management.' },
          { objectID: '202', title: 'Day One journal exports', story_text: 'My notes on exporting journal entries.' },
          { objectID: '203', title: 'I need a journaling app', story_text: 'Any recommendation for keeping a daily journal?' },
        ] });
        return jsonResponse({ data: { children: [] } });
      },
    });
    assert.equal(result.items.length, 2);
    assert.equal(result.items.find(item => item.url.endsWith('id=201')), undefined);
    assert.equal(result.items.find(item => item.url.endsWith('id=202')).kind, 'mention');
    assert.deepEqual(result.items.find(item => item.url.endsWith('id=202')).matchedTerms, ['Day One journal']);
    assert.equal(result.items.find(item => item.url.endsWith('id=203')).kind, 'opportunity');
  });
});

test('opportunity evidence ties the requested help to the topic rather than a nearby accomplishment', async () => {
  await withoutWebKey(async () => {
    const result = await discover({
      ...productInput, id: 'calendar-product', name: 'PlanKeeper',
      url: 'https://plankeeper.dev/', keywords: ['calendar'], aliases: ['PlanKeeper'], exclusions: [],
    }, {
      now: new Date('2026-10-03T12:00:00.000Z'),
      fetchImpl: async input => {
        if (new URL(input).hostname === 'hn.algolia.com') return jsonResponse({ hits: [
          { objectID: '301', _tags: ['comment'], comment_text: 'Also built a calendar library published on Maven Central. Looking for backend/full-stack roles.' },
          { objectID: '302', _tags: ['comment'], comment_text: 'I need a calendar app that makes planning easier.' },
          { objectID: '303', title: 'Calendar library accomplishments', story_text: 'Looking for backend/full-stack roles.' },
          { objectID: '304', _tags: ['comment'], comment_text: 'Built a calendar library; I need help finding backend roles.' },
          { objectID: '305', _tags: ['comment'], comment_text: 'Built a calendar library, but I am looking for backend roles.' },
        ] });
        return jsonResponse({ data: { children: [] } });
      },
    });
    assert.deepEqual(result.items.map(item => item.url), ['https://news.ycombinator.com/item?id=302']);
    assert.equal(result.items[0].kind, 'opportunity');
    assert.deepEqual(result.items[0].matchedTerms, ['calendar']);
    assert.equal(result.items[0].snippet.match(/I need a calendar app/g)?.length, 1, 'a comment excerpt should not repeat its generated title');
  });
});

test('source links reject unsafe schemes and private addresses and canonicalize repeated Reddit results', () => {
  for (const url of ['javascript:alert(1)', 'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.0.1/', 'https://[::ffff:7f00:1]/', 'https://user:password@quietboard.dev/', 'https://quietboard.dev:8443/']) {
    assert.equal(publicSourceURL(url), null, url);
  }
  assert.equal(publicSourceURL('https://old.reddit.com/r/Productivity/comments/Abc123/a_title/?utm_source=test#fragment'), 'https://www.reddit.com/r/productivity/comments/abc123/');
  assert.equal(publicSourceURL('https://www.reddit.com/r/productivity/comments/abc123/title/def456/?utm_campaign=test'), 'https://www.reddit.com/r/productivity/comments/abc123/_/def456/');
  assert.equal(publicSourceURL('https://quietboard.dev/post?z=2&utm_source=test&a=1#fragment'), 'https://quietboard.dev/post?a=1&z=2');
});


test('draft edits require authorization, reject invalid values, and persist independently of review status', async t => {
  const instance = await tracker(t, {discoverFn: async () => ({items:[match('https://news.ycombinator.com/item?id=551')],sources:[],searchedAt:'2026-10-08T12:00:00Z'})});
  const product = await addProduct(instance);
  const result = await instance.request(`/api/products/${product.id}/search`, {method:'POST'});
  const id = result.value.items[0].id;
  assert.equal((await instance.request(`/api/items/${id}`,{method:'PATCH',authorized:false,body:{draft:'Unauthorized'}})).response.status,403);
  for (const draft of [42, 'x'.repeat(5001)]) assert.equal((await instance.request(`/api/items/${id}`,{method:'PATCH',body:{draft}})).response.status,400);
  assert.equal(instance.store.snapshot().items[0].draft,'');
  const saved = await instance.request(`/api/items/${id}`,{method:'PATCH',body:{draft:'Helpful reply'}});
  assert.equal(saved.response.status,200);
  assert.equal(saved.value.item.status,'new');
  assert.equal(new Store(instance.dataDirectory).snapshot().items[0].draft,'Helpful reply');
  const backup = (await instance.request('/api/export')).value;
  backup.items[0].draft = 'x'.repeat(5001);
  assert.equal((await instance.request('/api/import',{method:'POST',body:backup})).response.status,400);
  assert.equal(instance.store.snapshot().items[0].draft,'Helpful reply');
  assert.equal((await instance.request(`/api/items/${id}`,{method:'PATCH',body:{draft:''}})).value.item.draft,'');
});
