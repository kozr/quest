import express from 'express';
import {timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RedlibAdapter} from './adapters.mjs';
import {CollectionError} from './http.mjs';
import {LinkedInCollector} from '../linkedin/collector.mjs';

export function createRedlibBridge({token = process.env.REDLIB_BRIDGE_TOKEN, adapter, linkedinCollector, maxConcurrent = 2} = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Set a server-only REDLIB_BRIDGE_TOKEN of at least 32 characters.');
  adapter ||= new RedlibAdapter({baseURL: process.env.REDLIB_BASE_URL || 'http://127.0.0.1:18080'});
  const app = express();
  const calls = [];
  let active = 0;
  let linkedinActive = false;
  const linkedinCalls = [];
  if (!linkedinCollector && process.env.LINKEDIN_MCP_URL) linkedinCollector = new LinkedInCollector();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ok: true, provider: 'redlib', linkedin: Boolean(linkedinCollector)}));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const provided = Buffer.from(req.get('authorization') || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return res.status(401).json({error: 'unauthorized'});
    while (calls[0] < Date.now() - 60_000) calls.shift();
    if (calls.length >= 60 || active >= maxConcurrent) return res.status(429).set('Retry-After', '2').json({error: 'collector_busy'});
    calls.push(Date.now()); next();
  });
  app.use(express.json({limit: '8kb'}));
  app.post('/v1/linkedin/search', async (req, res) => {
    if (!linkedinCollector) return res.status(503).json({error: 'linkedin_unconfigured'});
    const {query, limit = 30, datePosted = null} = req.body || {};
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\u0000-\u001f]/.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 30 || ![null, 'past-month'].includes(datePosted) || Object.keys(req.body).some(key => !['query', 'limit', 'datePosted'].includes(key))) return res.status(400).json({error: 'invalid_linkedin_search'});
    while (linkedinCalls[0] < Date.now() - 60_000) linkedinCalls.shift();
    if (linkedinActive || linkedinCalls.length >= 12) return res.status(429).set('Retry-After', '2').json({error: 'collector_busy'});
    linkedinCalls.push(Date.now()); linkedinActive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 22_000);
    const disconnect = () => {if (!res.writableEnded) controller.abort();};
    res.on('close', disconnect);
    try {res.json(await linkedinCollector.search({query, limit, datePosted, signal: controller.signal}));}
    catch (error) {
      const code = error instanceof CollectionError ? error.code : 'linkedin_provider_failed';
      res.status(error instanceof CollectionError ? error.status : 502).json({error: code});
    } finally {clearTimeout(timer); res.off('close', disconnect); linkedinActive = false;}
  });
  for (const method of ['search', 'list', 'thread']) {
    app.post(`/v1/${method}`, async (req, res) => {
      const limit = req.body.limit ?? (method === 'thread' ? 200 : 30);
      if (!Number.isInteger(limit) || limit < 1 || limit > (method === 'thread' ? 200 : 30)) return res.status(400).json({error: 'invalid_limit'});
      // A small queue serializes client searches upstream; callers retry busy jobs.
      active++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      const disconnect = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', disconnect);
      try {
        const result = await adapter[method]({...req.body, limit, signal: controller.signal});
        res.json(result);
      } catch (error) {
        const code = error instanceof CollectionError ? error.code : 'collection_failed';
        res.status(error instanceof CollectionError ? error.status : 502).json({error: code});
      } finally { clearTimeout(timer); res.off('close', disconnect); active--; }
    });
  }
  app.use((_req, res) => res.status(404).json({error: 'not_found'}));
  app.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({error: 'invalid_request'}));
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createRedlibBridge().listen(Number(process.env.PORT || 8081), process.env.BIND_ADDRESS || '127.0.0.1', () => console.log('Redlib bridge ready'));
}
