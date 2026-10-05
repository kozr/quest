import {CollectionError, readText} from '../reddit/http.mjs';
import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';

// Fetch rewrites Host on this Node runtime. A bounded HTTP request preserves
// the upstream authority, supports cancellation, and never follows redirects.
function privateMCPFetch(url, {method, headers, body, signal}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {method, headers, signal}, response => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      const noBody = [204, 205, 304].includes(response.statusCode);
      if (noBody) response.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(response), {status: response.statusCode, headers: responseHeaders}));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
function referenceURL(value) {
  try {
    const url = new URL(value, 'https://www.linkedin.com');
    if (url.protocol !== 'https:' || !['www.linkedin.com', 'linkedin.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    url.hostname = 'www.linkedin.com'; url.search = ''; url.hash = '';
    return url;
  } catch {return null;}
}

/** Provider references are unordered. Never zip text blocks to permalink order.
 * Only a unique observed author profile slug + matching /posts/ author slug can
 * establish an association. Ambiguous, company-newsletter, and URN-only rows
 * stay in coverage counts, never become falsely attributed inbox records. */
export function normalizeLinkedInSearch(data, {limit = 30, collectedAt = new Date().toISOString()} = {}) {
  if (!data || typeof data !== 'object' || !data.sections || typeof data.sections !== 'object') throw new CollectionError('linkedin_schema_changed');
  const errors = Object.values(data.section_errors || {});
  if (errors.some(error => /auth|session|login/i.test(error?.error_type || ''))) throw new CollectionError('linkedin_session_required');
  const text = data.sections.search_results;
  if (typeof text !== 'string' || text.length > 1_000_000) throw new CollectionError(errors.length ? 'linkedin_provider_failed' : 'linkedin_schema_changed');
  if (/^(?:no results found|no posts found|we couldn.t find any results|no results for)/i.test(clean(text))) {
    if (errors.length) throw new CollectionError('linkedin_provider_failed');
    return {rows: [], coverage: {provider: 'linkedin-mcp', partial: false, complete: false, observedPosts: 0, skippedPosts: 0, comments: 'not_collected', maxPages: 1}};
  }
  const blocks = text.split(/(?:^|\n)Feed post\s*\n/).slice(1);
  if (!blocks.length) throw new CollectionError(errors.length ? 'linkedin_provider_failed' : 'linkedin_schema_changed');
  const refs = data.references?.search_results;
  if (!Array.isArray(refs) || refs.length > 2000) throw new CollectionError('linkedin_schema_changed');
  const authors = refs.filter(ref => ['person', 'company'].includes(ref?.kind)).flatMap(ref => {
    const url = referenceURL(ref.url);
    const match = url?.pathname.match(/^\/(?:in|company)\/([a-z0-9%._-]+)\/?$/i);
    return match && clean(ref.text) ? [{name: clean(ref.text), slug: match[1].toLowerCase()}] : [];
  });
  const links = refs.filter(ref => ref?.kind === 'feed_post').flatMap(ref => {
    const url = referenceURL(ref.url);
    const match = url?.pathname.match(/^\/posts\/([a-z0-9%._-]+)_([a-z0-9%._-]+)-(\d{10,20})-([a-z0-9_-]+)\/?$/i);
    return match ? [{slug: match[1].toLowerCase(), id: match[3], url: url.href}] : [];
  });
  const lines = blocks.map(block => block.split('\n').map(clean).filter(Boolean));
  const counts = new Map();
  for (const block of lines) counts.set(block[0], (counts.get(block[0]) || 0) + 1);
  const rows = new Map();
  for (const block of lines) {
    const name = block[0];
    if (counts.get(name) !== 1) continue;
    const identities = [...new Set(authors.filter(author => author.name === name).map(author => author.slug))];
    if (identities.length !== 1) continue;
    const candidates = [...new Map(links.filter(link => link.slug === identities[0]).map(link => [link.id, link])).values()];
    if (candidates.length !== 1) continue;
    const start = block.findIndex(line => line === 'Follow');
    if (start < 0 || /reposted|repost of/i.test(block.slice(0, start).join(' '))) continue;
    const end = block.findIndex((line, index) => index > start && /^(?:\d[\d,.]*\s+(?:reactions?|comments?|reposts?)|Like|Comment|Repost|Send|Are these results helpful\?)/i.test(line));
    const body = block.slice(start + 1, end < 0 ? undefined : end).filter(line => !/^…\s*more$/.test(line)).join('\n').trim();
    if (!body || body.length > 20_000) continue;
    const link = candidates[0];
    rows.set(link.id, {source: 'LinkedIn', provider: 'linkedin-mcp', sourceId: `li_${link.id}`, postId: link.id, parentId: null,
      type: 'post', url: link.url, author: name, title: body.split('\n')[0].slice(0, 500), snippet: body.slice(0, 8000),
      publishedAt: null, collectedAt});
  }
  const kept = [...rows.values()].slice(0, limit);
  return {rows: kept, coverage: {provider: 'linkedin-mcp', partial: true, complete: false, maxPages: 1,
    observedPosts: blocks.length, skippedPosts: blocks.length - kept.length, comments: 'not_collected',
    sectionErrors: errors.length, dates: 'unverified', truncated: rows.size > limit}};
}

function rpcMessage(text, id, contentType) {
  const messages = contentType.includes('text/event-stream') ? text.replace(/\r\n/g, '\n').split('\n\n').flatMap(event => {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    return data ? [JSON.parse(data)] : [];
  }) : [JSON.parse(text)];
  const message = messages.find(message => message.id === id);
  if (!message || message.error) throw new CollectionError('linkedin_provider_failed');
  return message.result;
}

export class LinkedInCollector {
  constructor({endpoint = process.env.LINKEDIN_MCP_URL, fetchImpl = privateMCPFetch, now = Date.now} = {}) {
    if (!endpoint) throw new Error('Configure the private LINKEDIN_MCP_URL on OVH.');
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'mcp', 'querylane-linkedin-mcp-mcp-1'].includes(url.hostname) || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Use the existing private LinkedIn MCP endpoint.');
    this.endpoint = url.href; this.authority = `127.0.0.1:${url.port || '80'}`;
    this.fetchImpl = fetchImpl; this.now = now; this.cache = new Map();
  }
  async search({query, limit = 30, datePosted = null, signal}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\u0000-\u001f]/.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 30 || ![null, 'past-month'].includes(datePosted)) throw new CollectionError('invalid_linkedin_search', 400);
    const key = JSON.stringify([query.trim(), datePosted]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return structuredClone({...cached.value, rows: cached.value.rows.slice(0, limit), coverage: {...cached.value.coverage, cacheHit: true}});
    let session, protocol = '2025-03-26';
    // Like an ordinary reverse proxy, retain the upstream's existing loopback
    // authority while connecting on its private Docker network. Its Host/Origin
    // guard and public loopback binding remain unchanged.
    const headers = () => ({Host: this.authority, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(session ? {'Mcp-Session-Id': session, 'MCP-Protocol-Version': protocol} : {})});
    const send = async (method, params, id) => {
      const response = await this.fetchImpl(this.endpoint, {method: 'POST', redirect: 'error', signal, headers: headers(),
        body: JSON.stringify({jsonrpc: '2.0', ...(id ? {id} : {}), method, ...(params ? {params} : {})})});
      session ||= response.headers.get('mcp-session-id');
      if (!id && response.status === 202) {await response.body?.cancel(); return;}
      return rpcMessage(await readText(response), id, response.headers.get('content-type') || '');
    };
    try {
      const init = await send('initialize', {protocolVersion: protocol, capabilities: {}, clientInfo: {name: 'opportunity-tracker', version: '1.0'}}, 1);
      protocol = init.protocolVersion;
      await send('notifications/initialized');
      const result = await send('tools/call', {name: 'search_posts', arguments: {keywords: query.trim(), max_pages: 1, ...(datePosted ? {date_posted: datePosted} : {})}}, 2);
      if (result.isError) throw new CollectionError(result.content?.some(block => block.type === 'text' && /authentication|session expired|log.?in required/i.test(block.text)) ? 'linkedin_session_required' : 'linkedin_provider_failed');
      const data = result.structuredContent || result.content?.filter(block => block.type === 'text').map(block => {try {return JSON.parse(block.text);} catch {return null;}}).find(Boolean);
      const normalized = normalizeLinkedInSearch(data, {limit: 30, collectedAt: new Date(this.now()).toISOString()});
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, {expires: this.now() + 300_000, value: normalized});
      return {...normalized, rows: normalized.rows.slice(0, limit), coverage: {...normalized.coverage, cacheHit: false}};
    } catch (error) {
      if (signal?.aborted) throw new CollectionError('linkedin_timeout', 504);
      throw error instanceof CollectionError ? error : new CollectionError('linkedin_provider_failed');
    } finally {
      if (session) try {
        const response = await this.fetchImpl(this.endpoint, {method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(2000), headers: headers()});
        await response.body?.cancel();
      } catch { /* Session cleanup must not mask collection outcome. */ }
    }
  }
}
