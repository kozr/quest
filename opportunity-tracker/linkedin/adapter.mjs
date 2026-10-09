import {setTimeout as pause} from 'node:timers/promises';
import {CollectionError, readText} from '../reddit/http.mjs';
import {ApifyLinkedInAdapter} from './apify.mjs';

export {ApifyLinkedInAdapter} from './apify.mjs';

function provider(env) {
  return env.LINKEDIN_PROVIDER || (env.APIFY_TOKEN ? 'apify' : 'linkedin-mcp');
}

export function linkedinConfigured(env = process.env) {
  if (provider(env) === 'apify') return Boolean(env.APIFY_TOKEN?.trim());
  return provider(env) === 'linkedin-mcp' && Boolean(env.REDLIB_BRIDGE_URL && env.REDLIB_BRIDGE_TOKEN);
}

// The existing authenticated gateway is shared; neither MCP nor the LinkedIn
// session is exposed to a browser or copied into this application.
export class LinkedInBridgeAdapter {
  id = 'linkedin-mcp';
  constructor({baseURL, token, fetchImpl = fetch} = {}) {
    if (!baseURL || typeof token !== 'string' || token.length < 32) throw new Error('Configure the existing server-only bridge.');
    const url = new URL(baseURL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS for the remote bridge.');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a bridge origin without credentials or a path.');
    this.baseURL = url.origin; this.token = token; this.fetchImpl = fetchImpl;
    this.active = false; this.waiters = [];
  }
  async acquire(signal) {
    signal?.throwIfAborted();
    if (!this.active) {this.active = true; return;}
    await new Promise((resolve, reject) => {
      const abort = () => {this.waiters = this.waiters.filter(entry => entry !== waiter); reject(signal.reason);};
      const waiter = {resolve: () => {signal?.removeEventListener('abort', abort); resolve();}};
      signal?.addEventListener('abort', abort, {once: true});
      this.waiters.push(waiter);
    });
  }
  release() {
    const next = this.waiters.shift();
    if (next) next.resolve(); else this.active = false;
  }
  async search({query, signal, limit = 30, datePosted = null, preserveText = false}) {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      for (let attempt = 0; ; attempt++) {
        const response = await this.fetchImpl(`${this.baseURL}/v1/linkedin/search`, {method: 'POST', signal, redirect: 'error',
          headers: {'Content-Type': 'application/json', Authorization: `Bearer ${this.token}`},
          body: JSON.stringify({query, limit, datePosted, ...(preserveText === true ? {preserveText: true} : {})})});
        if (response.status === 429 && attempt < 2) {
          await response.body?.cancel(); await pause(2_000, undefined, {signal}); continue;
        }
        if (!response.ok) {
          let code;
          try {code = (await response.json()).error;} catch { /* Safe status below. */ }
          throw new CollectionError(['linkedin_session_required', 'linkedin_timeout', 'linkedin_provider_failed', 'linkedin_schema_changed'].includes(code) ? code : `upstream_http_${response.status}`);
        }
        const body = JSON.parse(await readText(response));
        if (!Array.isArray(body.rows) || body.rows.length > 30 || body.coverage?.provider !== this.id) throw new CollectionError('unexpected_response');
        return body;
      }
    } finally { this.release(); }
  }
}

let shared;
export function createLinkedInAdapter({env = process.env, fetchImpl = fetch} = {}) {
  const selected = provider(env);
  if (selected === 'apify') {
    // Reuse only the production instance so warm workers share paid requests
    // and validated results. A credential change creates a fresh instance.
    if (env === process.env && fetchImpl === fetch && shared?.token === env.APIFY_TOKEN) return shared;
    const adapter = new ApifyLinkedInAdapter({token:env.APIFY_TOKEN,fetchImpl});
    if (env === process.env && fetchImpl === fetch) shared = adapter;
    return adapter;
  }
  if (selected !== 'linkedin-mcp') throw new Error('Choose apify or linkedin-mcp for LINKEDIN_PROVIDER.');
  return new LinkedInBridgeAdapter({baseURL:env.REDLIB_BRIDGE_URL,token:env.REDLIB_BRIDGE_TOKEN,fetchImpl});
}
