import {fetchText, readText, CollectionError} from './http.mjs';
import {parseRedlib, redlibPath} from './redlib-html.mjs';
import {setTimeout as pause} from 'node:timers/promises';
import {ScrapeBadgerAdapter} from './scrapebadger.mjs';
export {ScrapeBadgerAdapter} from './scrapebadger.mjs';

/**
 * RedditAdapter contract:
 * search({query, signal, limit}) -> {rows, coverage}
 * Rows use the tracker schema plus sourceId, postId, parentId and collectedAt.
 * Redlib also implements list() and thread() for watchlist collectors.
 * Provider errors must remain errors; no silent provider fallback or synthetic rows.
 */
export class PublicRedditAdapter {
  id = 'public-json';
  constructor({fetchImpl = fetch} = {}) { this.fetchImpl = fetchImpl; }
  async listing(endpoint, signal, limit) {
    const response = await this.fetchImpl(endpoint, {signal, redirect: 'error', headers: {Accept: 'application/json', 'User-Agent': 'OpportunityTracker/1.0 (personal read-only research)'}});
    const body = JSON.parse(await readText(response, 1_048_576));
    if (!Array.isArray(body.data?.children)) throw new CollectionError('unexpected_response');
    const rows = body.data.children.slice(0, limit).flatMap(child => {
      const row = child?.data;
      if (!row || typeof row.permalink !== 'string' || !/^\/r\/[\w]{2,21}\/comments\/[\da-z]+\//i.test(row.permalink) || row.removed_by_category || row.locked || row.archived) return [];
      if (row.author === '[deleted]' || ['[removed]', '[deleted]'].includes(row.selftext)) return [];
      return [{source: 'Reddit', provider: this.id, url: `https://www.reddit.com${row.permalink}`, title: row.title,
        snippet: row.selftext, outboundURL: row.url, author: row.author, publishedAt: row.created_utc,
        ...(row.id ? {sourceId: `t3_${row.id}`} : {}), type: 'post', collectedAt: new Date().toISOString()}];
    });
    return {rows, coverage: {provider: this.id, comments: 'not_collected', partial: Boolean(body.data.after)}};
  }
  search({query, signal, limit = 30}) {
    const endpoint = new URL('https://www.reddit.com/search.json');
    endpoint.search = new URLSearchParams({q: query, sort: 'new', t: 'all', limit: String(limit), raw_json: '1', type: 'link'}).toString();
    return this.listing(endpoint, signal, limit);
  }
  list({subreddit, sort = 'new', signal, limit = 30}) {
    if (!/^[\w]{2,21}$/.test(subreddit || '') || !['new', 'hot'].includes(sort)) throw new CollectionError('invalid_listing', 400);
    return this.listing(new URL(`https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}&raw_json=1`), signal, limit);
  }
}

export class RedlibAdapter {
  id = 'redlib';
  constructor({baseURL, fetchImpl = fetch, cacheTTL = 60_000, now = () => Date.now(), maxPages = 2, maxThreads = 3, sleep} = {}) {
    if (!baseURL) throw new Error('Configure REDLIB_BASE_URL for the collector.');
    const base = new URL(baseURL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Use a Redlib origin without credentials or a path.');
    this.baseURL = base.origin; this.fetchImpl = fetchImpl; this.cacheTTL = cacheTTL; this.now = now;
    this.maxPages = maxPages; this.maxThreads = maxThreads; this.sleep = sleep;
    this.cache = new Map(); this.pending = new Map();
  }
  async page(path, signal) {
    const safePath = redlibPath(path);
    if (!safePath) throw new CollectionError('invalid_collection_path', 400);
    const cached = this.cache.get(safePath);
    if (cached && cached.expires > this.now()) return structuredClone({...cached.value, cacheHit: true});
    signal?.throwIfAborted();
    if (this.pending.has(safePath)) return structuredClone(await this.pending.get(safePath));
    const request = (async () => {
      const html = await fetchText(new URL(safePath, this.baseURL), {fetchImpl: this.fetchImpl, signal, sleep: this.sleep,
        headers: {Accept: 'text/html', 'User-Agent': 'OpportunityTracker-Redlib/1.0'}});
      const value = {...parseRedlib(html, {path: safePath, collectedAt: new Date(this.now()).toISOString()}), cacheHit: false};
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(safePath, {expires: this.now() + this.cacheTTL, value});
      return value;
    })();
    this.pending.set(safePath, request);
    try { return structuredClone(await request); } finally { this.pending.delete(safePath); }
  }
  async collect(path, {signal, limit = 200, maxPages = this.maxPages} = {}) {
    const queue = [path], visited = new Set(), rows = new Map(), errors = [];
    let advertisedCommentCount = null, cacheHits = 0, truncated = false;
    while (queue.length && visited.size < maxPages && rows.size < limit) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      try {
        const page = await this.page(current, signal);
        cacheHits += Number(page.cacheHit);
        advertisedCommentCount ??= page.advertisedCommentCount;
        for (const row of page.rows) {
          if (rows.size >= limit && !rows.has(row.sourceId)) { truncated = true; break; }
          rows.set(row.sourceId, row);
        }
        for (const next of page.continuations) if (!visited.has(next) && !queue.includes(next)) queue.push(next);
      } catch (error) {
        if (!rows.size) throw error;
        errors.push(error.code || 'collection_interrupted'); break;
      }
    }
    const comments = [...rows.values()].filter(row => row.type === 'comment').length;
    return {rows: [...rows.values()], coverage: {provider: this.id, pages: visited.size, cacheHits,
      partial: Boolean(queue.length || truncated || errors.length || (advertisedCommentCount !== null && comments < advertisedCommentCount && /\/comments\//.test(path))),
      comments: /\/comments\//.test(path) ? 'available_html_only' : 'not_collected',
      complete: false, advertisedCommentCount, collectedComments: comments, errors}};
  }
  list({subreddit, sort = 'new', signal, limit = 30}) {
    if (!/^[\w]{2,21}$/.test(subreddit || '') || !['new', 'hot'].includes(sort)) throw new CollectionError('invalid_listing', 400);
    return this.collect(`/r/${subreddit}/${sort}?limit=${limit}`, {signal, limit});
  }
  thread({path, signal, limit = 200}) {
    const safePath = redlibPath(path);
    if (!safePath || !/^\/r\/[\w]{2,21}\/comments\/[a-z0-9]+\//i.test(safePath)) throw new CollectionError('invalid_thread', 400);
    return this.collect(safePath, {signal, limit});
  }
  async search({query, signal, limit = 30}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new CollectionError('invalid_query', 400);
    const path = `/search?${new URLSearchParams({q: query, sort: 'new', t: 'all', type: 'link', limit: String(limit)})}`;
    const listing = await this.collect(path, {signal, limit});
    const rows = new Map(listing.rows.map(row => [row.sourceId, row]));
    const candidates = listing.rows.filter(row => row.type === 'post' && row.commentCount !== 0);
    let threads = 0, collectedComments = 0;
    const errors = [...listing.coverage.errors];
    let partial = listing.coverage.partial || candidates.length > this.maxThreads;
    for (const post of candidates.slice(0, this.maxThreads)) {
      try {
        const thread = await this.thread({path: post.collectionPath, signal});
        for (const row of thread.rows) rows.set(row.sourceId, row);
        threads++; collectedComments += thread.coverage.collectedComments;
        partial ||= thread.coverage.partial;
        errors.push(...thread.coverage.errors);
      } catch (error) { partial = true; errors.push(error.code || 'thread_unavailable'); }
    }
    return {rows: [...rows.values()], coverage: {...listing.coverage, partial, threads, collectedComments,
      comments: 'selected_threads_only', complete: false, errors: [...new Set(errors)]}};
  }
}

export class RedlibBridgeAdapter {
  id = 'redlib';
  constructor({baseURL, token, fetchImpl = fetch} = {}) {
    if (!baseURL || !token) throw new Error('Configure REDLIB_BRIDGE_URL and REDLIB_BRIDGE_TOKEN.');
    const url = new URL(baseURL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS for the remote Redlib bridge.');
    if (url.username || url.password || url.search || url.hash) throw new Error('Use a bridge URL without credentials or query parameters.');
    this.baseURL = url.href.replace(/\/$/, ''); this.token = token; this.fetchImpl = fetchImpl;
    this.active = 0; this.waiters = [];
  }
  async acquire(signal) {
    signal?.throwIfAborted();
    if (this.active < 2) { this.active++; return; }
    await new Promise((resolve, reject) => {
      const waiter = {resolve: () => { signal?.removeEventListener('abort', abort); this.active++; resolve(); }};
      const abort = () => { this.waiters = this.waiters.filter(entry => entry !== waiter); reject(signal.reason); };
      signal?.addEventListener('abort', abort, {once: true});
      this.waiters.push(waiter);
    });
  }
  release() { this.active--; this.waiters.shift()?.resolve(); }
  async request(method, parameters) {
    const {signal, ...payload} = parameters;
    await this.acquire(signal);
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await this.fetchImpl(`${this.baseURL}/v1/${method}`, {method: 'POST', signal, redirect: 'error',
          headers: {'Content-Type': 'application/json', Authorization: `Bearer ${this.token}`}, body: JSON.stringify(payload)});
        if (response.status === 429 && attempt < 2) {
          await response.body?.cancel(); await pause(2_000, undefined, {signal}); continue;
        }
        const body = JSON.parse(await readText(response));
        if (!Array.isArray(body.rows) || body.rows.length > 1_000 || body.coverage?.provider !== 'redlib') throw new CollectionError('unexpected_response');
        return body;
      }
    } finally { this.release(); }
  }
  search({query, signal, limit = 30}) { return this.request('search', {query, signal, limit}); }
  list({subreddit, sort = 'new', signal, limit = 30}) { return this.request('list', {subreddit, sort, signal, limit}); }
  thread({path, signal, limit = 200}) { return this.request('thread', {path, signal, limit}); }
}

export function createRedditAdapter({env = process.env, fetchImpl = fetch} = {}) {
  const provider = env.REDDIT_PROVIDER || (env.SCRAPEBADGER_API_KEY ? 'scrapebadger' : env.REDLIB_BRIDGE_URL ? 'redlib' : 'public-json');
  if (provider === 'scrapebadger') return new ScrapeBadgerAdapter({apiKey:env.SCRAPEBADGER_API_KEY,fetchImpl});
  if (provider === 'redlib') return new RedlibBridgeAdapter({baseURL: env.REDLIB_BRIDGE_URL, token: env.REDLIB_BRIDGE_TOKEN, fetchImpl});
  if (provider === 'public-json') return new PublicRedditAdapter({fetchImpl});
  throw new Error('Unknown REDDIT_PROVIDER. Choose scrapebadger, redlib or public-json.');
}
