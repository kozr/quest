import {setTimeout as pause} from 'node:timers/promises';
import {CollectionError, readText} from '../reddit/http.mjs';

const API = 'https://api.apify.com/v2/';
export const LINKEDIN_ACTOR = 'harvestapi~linkedin-post-search';
const terminal = new Set(['SUCCEEDED','FAILED','TIMED-OUT','ABORTED']);
const runID = /^[a-zA-Z0-9]{1,64}$/;
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim() : '';

function linkedinURL(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['linkedin.com','www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    url.hostname = 'www.linkedin.com'; url.search = ''; url.hash = '';
    url.pathname = url.pathname.replace(/\/$/,'');
    return url;
  } catch {return null;}
}

/** Only the top-level post's own content/author is evidence. Reposts, comments
 * and profile details are never concatenated or attributed to that author. */
export function normalizeApifyLinkedInPost(value, collectedAt) {
  if (!value || value.type !== 'post' || typeof value.id !== 'string' || !/^\d{10,20}$/.test(value.id)) return null;
  const url = linkedinURL(value.linkedinUrl), authorURL = linkedinURL(value.author?.linkedinUrl);
  const post = url?.pathname.match(/^\/posts\/([a-z0-9%._-]+)_[a-z0-9%._-]+-(\d{10,20})-[a-z0-9_-]+$/i);
  const profile = authorURL?.pathname.match(/^\/(?:in|company)\/([a-z0-9%._-]+)$/i);
  const content = clean(value.content), author = clean(value.author?.name);
  if (!post || post[2] !== value.id || !profile || !url.pathname.toLowerCase().startsWith(`/posts/${profile[1].toLowerCase()}_`) || !author || !content || content.length > 50_000) return null;
  let publishedAt = null;
  if (value.postedAt?.date != null || value.postedAt?.timestamp != null) {
    if (value.postedAt.date != null && typeof value.postedAt.date !== 'string') return null;
    const iso = value.postedAt.date != null ? Date.parse(value.postedAt.date) : null;
    const ms = value.postedAt.timestamp ?? iso;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || ms > Date.parse(collectedAt) + 300_000 ||
      iso != null && (!Number.isFinite(iso) || Math.abs(iso-ms) > 1000)) return null;
    publishedAt = new Date(ms).toISOString();
  }
  return {source:'LinkedIn',provider:'linkedin-apify',sourceId:`li_${value.id}`,postId:value.id,parentId:null,type:'post',
    url:url.href,author,title:content.split('\n')[0].slice(0,500),snippet:content.slice(0,8000),publishedAt,collectedAt};
}

export class ApifyLinkedInAdapter {
  id = 'linkedin-apify';
  constructor({token, fetchImpl = fetch, now = Date.now} = {}) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Configure the server-only APIFY_TOKEN.');
    this.token = token; this.fetchImpl = fetchImpl; this.now = now;
    this.cache = new Map(); this.pending = new Map(); this.active = 0; this.waiters = [];
  }
  async acquire(signal) {
    signal.throwIfAborted();
    if (this.active < 2) {this.active++; return;}
    await new Promise((resolve,reject) => {
      const abort = () => {this.waiters = this.waiters.filter(entry => entry !== waiter); reject(signal.reason);};
      const waiter = {resolve:() => {signal.removeEventListener('abort',abort); this.active++; resolve();}};
      signal.addEventListener('abort',abort,{once:true}); this.waiters.push(waiter);
    });
  }
  release() {this.active--; this.waiters.shift()?.resolve();}
  async json(path, {method = 'GET', signal, body, timeout = 12_000} = {}) {
    const response = await this.fetchImpl(new URL(path,API).href,{method,redirect:'error',
      signal:AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(timeout)]),
      headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json',...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {})});
    if (!response.ok) {
      await response.body?.cancel();
      throw new CollectionError([401,403].includes(response.status) ? 'linkedin_credentials_required' : `upstream_http_${response.status}`);
    }
    try {return JSON.parse(await readText(response,2_097_152));}
    catch (error) {throw error instanceof CollectionError ? error : new CollectionError('linkedin_schema_changed');}
  }
  run(value, expectedID) {
    const run = value?.data;
    if (!run || typeof run.id !== 'string' || !runID.test(run.id) || expectedID && run.id !== expectedID ||
      !['READY','RUNNING','SUCCEEDED','FAILED','TIMING-OUT','TIMED-OUT','ABORTING','ABORTED'].includes(run.status) ||
      run.defaultDatasetId != null && (typeof run.defaultDatasetId !== 'string' || !runID.test(run.defaultDatasetId))) throw new CollectionError('linkedin_schema_changed');
    return run;
  }
  async collect({query,limit,datePosted,signal}) {
    let run, acquired = false;
    try {
      await this.acquire(signal); acquired = true; signal.throwIfAborted();
      // Start exactly once. Transport errors cannot tell us whether a paid run
      // started. Never retry that POST or ask Apify to restart failed runs.
      run = this.run(await this.json(`actors/${LINKEDIN_ACTOR}/runs?timeout=45&maxTotalChargeUsd=0.10&restartOnError=false`,{
        method:'POST',signal,timeout:8_000,body:{searchQueries:[query],maxPosts:limit,sortBy:'date',
          postedLimit:datePosted === 'past-month' ? 'month' : 'any',profileScraperMode:'short',
          scrapeComments:false,scrapeReactions:false,postNestedComments:false,postNestedReactions:false}}));
      for (let poll = 0; !terminal.has(run.status) && poll < 6; poll++) {
        run = this.run(await this.json(`actor-runs/${run.id}?waitForFinish=10`,{signal}),run.id);
        if (!terminal.has(run.status)) await pause(300,undefined,{signal});
      }
      if (!terminal.has(run.status)) throw new CollectionError('linkedin_timeout');
      const failure = run.status === 'SUCCEEDED' ? null : run.status === 'TIMED-OUT' ? 'linkedin_timeout' : 'linkedin_provider_failed';
      if (!run.defaultDatasetId) throw new CollectionError(failure || 'linkedin_schema_changed');
      const items = await this.json(`datasets/${run.defaultDatasetId}/items?format=json&clean=true&limit=${limit}`,{signal});
      if (!Array.isArray(items) || items.length > limit) throw new CollectionError('linkedin_schema_changed');
      const collectedAt = new Date(this.now()).toISOString(), unique = new Map();
      for (const item of items) {
        const row = normalizeApifyLinkedInPost(item,collectedAt);
        if (row && !unique.has(row.sourceId)) unique.set(row.sourceId,row);
      }
      const rows = [...unique.values()];
      if (items.length && !rows.length) throw new CollectionError('linkedin_schema_changed');
      if (failure && !rows.length) throw new CollectionError(failure);
      return {rows,coverage:{provider:this.id,actor:'harvestapi/linkedin-post-search',partial:true,complete:false,
        observedPosts:items.length,skippedPosts:items.length-rows.length,comments:'not_collected',dates:'provider_reported',
        undatedPosts:rows.filter(row => !row.publishedAt).length,maxPosts:limit,runStatus:run.status,
        maxChargeUsd:0.10,reportedCostUsd:Number.isFinite(run.usageTotalUsd) ? run.usageTotalUsd : null,costFinal:false,
        errors:failure ? [failure] : [],cacheHit:false}};
    } catch (error) {
      if (run && !terminal.has(run.status)) try {
        await this.json(`actor-runs/${run.id}/abort`,{method:'POST',timeout:2_000});
      } catch { /* The remote 45-second timeout and charge cap still apply. */ }
      if (signal.aborted || ['TimeoutError','AbortError'].includes(error?.name)) throw new CollectionError('linkedin_timeout');
      throw error instanceof CollectionError ? error : new CollectionError('linkedin_provider_failed');
    } finally {if (acquired) this.release();}
  }
  async search({query,signal,limit = 30,datePosted = null}) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 30 ||
      ![null,'past-month'].includes(datePosted)) throw new CollectionError('invalid_request',400);
    signal?.throwIfAborted();
    const key = JSON.stringify([query.trim(),limit,datePosted]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return structuredClone({...cached.value,coverage:{...cached.value.coverage,cacheHit:true}});
    if (this.pending.has(key)) return structuredClone(await this.pending.get(key));
    const deadline = AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(50_000)]);
    const operation = this.collect({query:query.trim(),limit,datePosted,signal:deadline});
    this.pending.set(key,operation);
    try {
      const value = await operation;
      if (!value.coverage.errors.length) {
        if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key,{expires:this.now()+300_000,value:structuredClone(value)});
      }
      return structuredClone(value);
    } finally {this.pending.delete(key);}
  }
}
