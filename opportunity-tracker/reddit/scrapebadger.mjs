import {CollectionError, readText} from './http.mjs';

const API = 'https://scrapebadger.com/v1/reddit/';
const native = /^[a-z0-9]{1,20}$/;
const communityName = /^[a-z0-9_]{2,21}$/i;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

function identity(row, prefix) {
  const values = [row.id, row.fullname].filter(value => value != null);
  const ids = values.map(value => typeof value === 'string' ? value.replace(new RegExp(`^${prefix}`), '') : '');
  return ids.length && ids.every(id => native.test(id)) && new Set(ids).size === 1 ? ids[0] : null;
}
function community(row) {
  const names = [row.subreddit, row.subreddit_name_prefixed].filter(value => value != null)
    .map(value => typeof value === 'string' ? value.replace(/^r\//i, '').toLowerCase() : '');
  return names.length && names.every(name => communityName.test(name)) && new Set(names).size === 1 ? names[0] : null;
}
function timestamp(row, now) {
  const raw = row.created_utc ?? row.created_at;
  const ms = typeof raw === 'number' ? raw * 1000 : typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms) || ms <= 0 || ms > now + 300_000) return null;
  if (row.created_at != null && (!Number.isFinite(Date.parse(row.created_at)) || Math.abs(Date.parse(row.created_at) - ms) > 1000)) return null;
  return new Date(ms).toISOString();
}
function matchingPermalink(value, name, postId, commentId = null) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.startsWith('/r/') ? `https://www.reddit.com${value}` : value);
    const parts = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:' && ['reddit.com', 'www.reddit.com'].includes(url.hostname) && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      parts[0] === 'r' && parts[1]?.toLowerCase() === name && parts[2] === 'comments' && parts[3] === postId &&
      (commentId ? parts.length === 6 && parts[5] === commentId : parts.length >= 4 && parts.length <= 5);
  } catch { return false; }
}
function author(row) {
  return typeof row.author === 'string' && /^[a-z0-9_-]{3,32}$/i.test(row.author) ? row.author : null;
}

export function normalizeScrapeBadgerPost(value, collectedAt, {includeClosed=false,preserveText=false} = {}) {
  const row = record(value); if (!row) return null;
  const id = identity(row, 't3_'), name = community(row), publishedAt = timestamp(row, Date.parse(collectedAt));
  if (!id || !name || !publishedAt || typeof row.title !== 'string' || typeof row.selftext !== 'string' ||
    typeof row.archived !== 'boolean' || typeof row.locked !== 'boolean' || (!includeClosed && (row.archived || row.locked)) || row.removed_by_category ||
    ['[removed]', '[deleted]'].includes(row.selftext.trim()) || !author(row) || !matchingPermalink(row.permalink, name, id)) return null;
  return {source: 'Reddit', provider: 'scrapebadger', sourceId: `t3_${id}`, postId: `t3_${id}`, parentId: null, type: 'post',
    url: `https://www.reddit.com/r/${name}/comments/${id}/`, collectionPath: `/r/${name}/comments/${id}/_/`,
    title: preserveText ? row.title : row.title.slice(0,1000), snippet: preserveText ? row.selftext : row.selftext.slice(0,10000), outboundURL: row.url,
    author: author(row), publishedAt, collectedAt, ...(row.crosspost_parent?{crosspost:true}:{}), ...(includeClosed?{discussionClosed:row.archived||row.locked}:{}), commentCount: Number.isSafeInteger(row.num_comments) && row.num_comments >= 0 ? row.num_comments : null};
}
export function normalizeScrapeBadgerComments(values, post, collectedAt, limit = 100, {includeClosed=false,preserveText=false} = {}) {
  const rows = new Map(), queue = [...values]; let inspected = 0;
  const name = post.url.split('/')[4], postId = post.postId.slice(3);
  while (queue.length && rows.size < limit && inspected++ < 1000) {
    const row = record(queue.shift()); if (!row) continue;
    if (Array.isArray(row.replies)) queue.push(...row.replies.slice(0,100));
    const id = identity(row, 't1_'), publishedAt = timestamp(row, Date.parse(collectedAt));
    const links = [row.post_id,row.link_id].filter(value => value != null);
    if (!id || community(row) !== name || !publishedAt || !author(row) || !links.length || links.some(value => value !== post.postId) ||
      typeof row.parent_id !== 'string' || !/^t[13]_[a-z0-9]{1,20}$/.test(row.parent_id) || row.parent_id === `t1_${id}` ||
      row.parent_id.startsWith('t3_') && row.parent_id !== post.postId ||
      ['archived','locked'].some(key => row[key] != null && (typeof row[key] !== 'boolean' || (!includeClosed && row[key]))) || row.removed_by_category ||
      typeof row.body !== 'string' || !row.body.trim() || ['[removed]','[deleted]'].includes(row.body.trim()) ||
      !matchingPermalink(row.permalink, name, postId, id)) continue;
    rows.set(id, {source: 'Reddit comment', provider: 'scrapebadger', sourceId: `t1_${id}`, postId: post.postId, parentId: row.parent_id,
      type: 'comment', url: `https://www.reddit.com/r/${name}/comments/${postId}/_/${id}/`,
      title: row.body.slice(0,180), snippet: preserveText ? row.body : row.body.slice(0,10000), author: author(row), publishedAt, collectedAt, ...(row.crosspost_parent?{crosspost:true}:{}), ...(includeClosed?{discussionClosed:Boolean(post.discussionClosed||row.archived||row.locked)}:{})});
  }
  return [...rows.values()];
}

/** Same search/list/thread contract as Redlib. No implicit provider fallback. */
export class ScrapeBadgerAdapter {
  id = 'scrapebadger';
  constructor({apiKey, fetchImpl = fetch, now = Date.now, cacheTTL = 60_000, maxPages = 2, maxThreads = 3} = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Configure the server-only SCRAPEBADGER_API_KEY.');
    this.apiKey = apiKey; this.fetchImpl = fetchImpl; this.now = now; this.cacheTTL = cacheTTL;
    this.maxPages = Math.max(1,Math.min(2,maxPages)); this.maxThreads = Math.max(0,Math.min(3,maxThreads));
    this.cache = new Map(); this.pending = new Map(); this.active = 0; this.waiters = [];
  }
  async acquire(signal) {
    signal?.throwIfAborted();
    if (this.active < 2) {this.active++; return;}
    await new Promise((resolve,reject) => {
      const abort = () => {this.waiters = this.waiters.filter(entry => entry !== waiter); reject(signal.reason);};
      const waiter = {resolve: () => {signal?.removeEventListener('abort',abort); this.active++; resolve();}};
      signal?.addEventListener('abort',abort,{once:true}); this.waiters.push(waiter);
    });
  }
  release() {this.active--; this.waiters.shift()?.resolve();}
  async json(path, params, signal) {
    const url = new URL(path, API); url.search = new URLSearchParams(params).toString();
    const cached = this.cache.get(url.href);
    if (cached && cached.expires > this.now()) return structuredClone({...cached.value,creditsUsed:0,cacheHit:true});
    signal?.throwIfAborted();
    if (this.pending.has(url.href)) return structuredClone(await this.pending.get(url.href));
    const operation = (async () => {
      await this.acquire(signal);
      try {
        signal?.throwIfAborted();
        const deadline = AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(12_000)]);
        // No retries: a network timeout can still have incurred provider credits.
        const response = await this.fetchImpl(url.href,{method:'GET',signal:deadline,redirect:'error',
          headers:{'X-API-Key':this.apiKey,Accept:'application/json'}});
        const text = await readText(response,2_097_152);
        let body; try {body = JSON.parse(text);} catch {throw new CollectionError('unexpected_response');}
        if (!record(body)) throw new CollectionError('unexpected_response');
        const rawCredits = response.headers.get('X-Credits-Used');
        const credits = rawCredits != null && rawCredits.trim() ? Number(rawCredits) : NaN;
        return {body,collectedAt:new Date(this.now()).toISOString(),creditsUsed:Number.isFinite(credits) && credits >= 0 ? credits : null,cacheHit:false};
      } catch (error) {
        if (error instanceof CollectionError || signal?.aborted || ['AbortError','TimeoutError'].includes(error?.name)) throw error;
        throw new CollectionError('upstream_unreachable');
      } finally {this.release();}
    })();
    this.pending.set(url.href,operation);
    try {return structuredClone(await operation);} finally {this.pending.delete(url.href);}
  }
  cacheResponse(path,params,result) {
    const url = new URL(path,API);url.search = new URLSearchParams(params).toString();
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(url.href,{expires:this.now()+this.cacheTTL,value:structuredClone(result)});
  }
  limit(value,max=100) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new CollectionError('invalid_limit',400);
    return value;
  }
  async listing(path,params,{signal,limit,preserveText=false}) {
    this.limit(limit); const rows = new Map(), cursors = new Set(), errors = []; let after = null, pages = 0, creditsUsed = 0, cacheHits = 0;
    const expectedCommunity = path.match(/^subreddits\/([^/]+)\/posts$/)?.[1];
    do {
      const query = {...params,limit:String(Math.min(100,limit-rows.size)),...(after ? {after} : {})};
      try {
        const result = await this.json(path,query,signal), body = result.body;
        if (!Array.isArray(body.posts) || body.posts.length > Number(query.limit)) throw new CollectionError('unexpected_response');
        const cursor = body.pagination?.after ?? null;
        if (cursor !== null && (typeof cursor !== 'string' || !/^t3_[a-z0-9]{1,20}$/.test(cursor))) throw new CollectionError('unexpected_response');
        this.cacheResponse(path,query,result);pages++;cacheHits += Number(result.cacheHit);
        creditsUsed = creditsUsed === null || result.creditsUsed === null ? null : creditsUsed + result.creditsUsed;
        for (const value of body.posts) {
          const row = normalizeScrapeBadgerPost(value,result.collectedAt,{preserveText});
          if (row && (!expectedCommunity || row.url.split('/')[4] === expectedCommunity)) rows.set(row.sourceId,row);
        }
        after = body.posts.length ? cursor : null;
        if (after && cursors.has(after)) {errors.push('repeated_cursor');break;}
        if (after) cursors.add(after);
      } catch (error) {if (!rows.size) throw error;errors.push(error.code || 'collection_interrupted');break;}
    } while (after && pages < this.maxPages && rows.size < limit);
    return {rows:[...rows.values()].slice(0,limit),coverage:{provider:this.id,pages,cacheHits,creditsUsed,
      partial:Boolean(after || errors.length),complete:false,comments:'not_collected',errors}};
  }
  list({subreddit,sort='new',signal,limit=30,preserveText=false}) {
    if (!communityName.test(subreddit || '') || !['new','hot'].includes(sort)) throw new CollectionError('invalid_listing',400);
    return this.listing(`subreddits/${subreddit.toLowerCase()}/posts`,{sort},{signal,limit,preserveText});
  }
  async thread({path,signal,limit=200,preserveText=false}) {
    this.limit(limit,200);
    const match = typeof path === 'string' && path.match(/^\/r\/([a-z0-9_]{2,21})\/comments\/([a-z0-9]{1,20})\/(?:[^/?#]+\/)?$/i);
    if (!match) throw new CollectionError('invalid_thread',400);
    const [name,id] = [match[1].toLowerCase(),match[2]], postResult = await this.json(`posts/${id}`,{},signal);
    const post = normalizeScrapeBadgerPost(postResult.body.post ?? postResult.body,postResult.collectedAt,{preserveText});
    if (!post || post.sourceId !== `t3_${id}` || post.url.split('/')[4] !== name) throw new CollectionError('unexpected_response');
    this.cacheResponse(`posts/${id}`,{},postResult);
    const rows = [post], errors = []; let creditsUsed = postResult.creditsUsed, partial = false, cacheHits = Number(postResult.cacheHit);
    if (limit > 1) {
      const params = {sort:'new',limit:String(Math.min(100,limit-1)),depth:'10'};
      try {
        const result = await this.json(`posts/${id}/comments`,params,signal), values = result.body.tree ?? result.body.comments;
        if (!Array.isArray(values)) throw new CollectionError('unexpected_response');
        this.cacheResponse(`posts/${id}/comments`,params,result);cacheHits += Number(result.cacheHit);
        rows.push(...normalizeScrapeBadgerComments(values,post,result.collectedAt,Math.min(100,limit-1),{preserveText}));
        creditsUsed = creditsUsed === null || result.creditsUsed === null ? null : creditsUsed + result.creditsUsed;
      } catch (error) {partial = true;creditsUsed = null;errors.push(error.code || 'thread_unavailable');}
    }
    const comments = rows.length-1;
    return {rows,coverage:{provider:this.id,pages:1,cacheHits,creditsUsed,partial:partial || post.commentCount === null || comments < post.commentCount,
      complete:false,comments:'bounded_threads_only',advertisedCommentCount:post.commentCount,collectedComments:comments,errors}};
  }
  async search({query,signal,limit=30,preserveText=false}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new CollectionError('invalid_query',400);
    const listing = await this.listing('search/posts',{q:query,sort:'new',t:'all'},{signal,limit,preserveText});
    const rows = new Map(listing.rows.map(row => [row.sourceId,row])), errors = [...listing.coverage.errors];
    const candidates = listing.rows.filter(row => row.commentCount !== 0); let threads = 0, comments = 0, partial = listing.coverage.partial || candidates.length > this.maxThreads;
    let creditsUsed = listing.coverage.creditsUsed;
    for (const post of candidates.slice(0,this.maxThreads)) {
      try {
        const thread = await this.thread({path:post.collectionPath,signal,preserveText});
        for (const row of thread.rows) rows.set(row.sourceId,row);
        threads++;comments += thread.coverage.collectedComments;partial ||= thread.coverage.partial;errors.push(...thread.coverage.errors);
        creditsUsed = creditsUsed === null || thread.coverage.creditsUsed === null ? null : creditsUsed + thread.coverage.creditsUsed;
      } catch (error) {partial = true;creditsUsed = null;errors.push(error.code || 'thread_unavailable');}
    }
    return {rows:[...rows.values()],coverage:{...listing.coverage,partial,threads,collectedComments:comments,creditsUsed,
      comments:'selected_threads_only',complete:false,errors:[...new Set(errors)]}};
  }
}
