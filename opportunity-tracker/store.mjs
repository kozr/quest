import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {dueSources} from './monitor.mjs';
import {stageQualifications, claimQualification, finishQualification, mergeQualificationHistory, budgetDay, reserveAnalysis, settleAnalysis, retireAnalysis} from './qualification.mjs';
import {ANALYSIS_DAILY_LIMIT, productHash, matchHash} from './analysis.mjs';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'tracker.json');
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { version: 1, products: [], items: [], searches: {} };
    if (this.data.version !== 1 || !Array.isArray(this.data.products) || !Array.isArray(this.data.items)) throw new Error('The saved tracker data could not be read. Restore a backup before restarting.');
  }
  commit(next) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.data = next;
  }
  snapshot() { return structuredClone(this.data); }
  saveProduct(product, id) {
    const next = this.snapshot();
    const prior = id ? next.products.find(p => p.id === id) : null;
    if (id && !prior) return null;
    const record = { ...prior, ...product, id: id || randomUUID(), createdAt: prior?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    next.products = [record, ...next.products.filter(p => p.id !== record.id)];
    this.commit(next);
    return record;
  }
  deleteProduct(id) {
    const next = this.snapshot();
    next.products = next.products.filter(p => p.id !== id);
    next.items = next.items.filter(p => p.productId !== id);
    delete next.searches[id];
    if (next.research) delete next.research[id];
    for (const [key, lease] of Object.entries(next.analysisLeases || {})) if (lease.productId === id) {settleAnalysis(next, lease); delete next.analysisLeases[key];}
    this.commit(next);
  }
  markMonitorAttempt(id, now = Date.now()) {
    const next = this.snapshot();
    const product = next.products.find(row => row.id === id);
    if (!product) return null;
    const sources = dueSources(product, next, now);
    if (!sources.length) return null;
    const attemptedAt = new Date(now).toISOString();
    product.monitorAttempts = {...product.monitorAttempts, ...Object.fromEntries(sources.map(source => [source, attemptedAt]))};
    if (sources.includes('reddit')) product.lastMonitorAttemptAt = attemptedAt;
    this.commit(next);
    return {sources, attemptedAt};
  }
  recordSearch(productId, result) {
    const next = this.snapshot();
    const product = next.products.find(p => p.id === productId);
    if (!product) return null;
    const qualification = result.semantic ? stageQualifications(next, product, result.candidates || [], result.searchedAt, result.trigger) : undefined;
    for (const item of result.items) {
      const id = createHash('sha256').update(`${productId}:${item.url}`).digest('hex').slice(0, 24);
      const previous = next.items.find(i => i.id === id);
      const record = { ...item, ...(previous?.analysis ? {analysis:previous.analysis} : {}), ...(previous?.qualification ? {qualification:previous.qualification} : {}), id, productId, status: previous?.status || 'new', note: previous?.note || '', foundAt: previous?.foundAt || result.searchedAt, lastSeenAt: result.searchedAt };
      next.items = [record, ...next.items.filter(i => i.id !== id)];
    }
    const prior = next.searches[productId];
    const sources = (result.sources || []).map(source => ({...source, checkedAt: result.searchedAt}));
    const updatedNames = new Set(sources.map(source => source.name));
    const lastChecks = {...prior?.lastChecks};
    if (sources.some(source => ['Reddit', 'Reddit watchlist'].includes(source.name))) lastChecks.reddit = result.searchedAt;
    if (sources.some(source => source.name === 'LinkedIn')) lastChecks.linkedin = result.searchedAt;
    next.searches[productId] = { ...result, items: undefined, candidates:undefined, ...(qualification ? {qualification} : {}), found: result.items.length, lastChecks,
      sources: [...sources, ...(prior?.sources || []).filter(source => !updatedNames.has(source.name)).map(source => ({...source, checkedAt: source.checkedAt || prior.searchedAt}))] };
    this.commit(next);
    return next.searches[productId];
  }
  updateItem(id, update) {
    const next = this.snapshot();
    const item = next.items.find(i => i.id === id);
    if (!item) return null;
    Object.assign(item, update);
    this.commit(next);
    return item;
  }
  importData(value) {
    if (Object.values(this.data.qualifications || {}).some(job => job.status === 'running' && job.leaseUntil > Date.now())) throw new Error('Wait for the running AI check to finish before restoring a backup.');
    if (Object.values(this.data.analysisLeases || {}).some(lease => lease.expiresAt > Date.now())) throw new Error('Wait for the running analysis to finish before restoring a backup.');
    value = {...value, analysisUsage:this.data.analysisUsage || {}};
    this.commit(this.data.qualifications || value.qualifications ? mergeQualificationHistory(this.data, value) : structuredClone(value));
  }
  claimQualification(settings, now, productId) {
    const next = this.snapshot(), result = claimQualification(next, settings, now, productId);
    this.commit(next); return result;
  }
  finishQualification(key, token, outcome, now) {
    const next = this.snapshot(), result = finishQualification(next, key, token, outcome, now);
    this.commit(next); return result;
  }
  claimAnalysis(productId, itemId = null, now = Date.now(), settings = null) {
    const next = this.snapshot(), product = next.products.find(row => row.id === productId);
    const item = itemId ? next.items.find(row => row.id === itemId && row.productId === productId) : null;
    const error = (message, status) => {const result = new Error(message); result.status = status; throw result;};
    if (!product || itemId && !item) error('Product or match not found.', 404);
    next.analysisLeases ||= {};
    retireAnalysis(next, now);
    if (Object.values(next.analysisLeases).some(lease => lease.productId === productId)) error('Analysis is already running for this product. Try again after it finishes.', 409);
    const day = budgetDay(now);
    next.analysisUsage = Object.fromEntries(Object.entries(next.analysisUsage || {}).filter(([key]) => key >= day));
    if ((next.analysisUsage[day] || 0) >= ANALYSIS_DAILY_LIMIT) error(`The daily limit of ${ANALYSIS_DAILY_LIMIT} analysis requests has been reached. Try again tomorrow.`, 429);
    const token = randomUUID();
    const lease = {token, productId, itemId, profileHash: productHash(product), sourceHash: item ? matchHash(item) : null, expiresAt: now + (itemId ? 90000 : 180000)};
    if (settings) reserveAnalysis(next, lease, settings, now);
    next.analysisLeases[token] = lease;
    next.analysisUsage[day] = (next.analysisUsage[day] || 0) + 1;
    this.commit(next);
    return structuredClone(lease);
  }
  finishAnalysis(lease, result, now = Date.now()) {
    const next = this.snapshot(), current = next.analysisLeases?.[lease.token];
    const product = next.products.find(row => row.id === lease.productId);
    const item = lease.itemId ? next.items.find(row => row.id === lease.itemId && row.productId === lease.productId) : null;
    if (!current || current.expiresAt <= now || !product || productHash(product) !== lease.profileHash || lease.itemId && (!item || matchHash(item) !== lease.sourceHash)) {
      const error = new Error('The product or conversation changed during analysis. Run it again using the current details.'); error.status = 409; throw error;
    }
    const record = {...result, profileHash: lease.profileHash, generatedAt: new Date(now).toISOString(), ...(item ? {sourceHash: lease.sourceHash} : {})};
    if (item) item.analysis = record;
    else {next.research ||= {}; next.research[lease.productId] = record;}
    settleAnalysis(next, current, result.costMicroUsd);
    delete next.analysisLeases[lease.token];
    this.commit(next);
    return record;
  }
  releaseAnalysis(token) {
    if (!this.data.analysisLeases?.[token]) return;
    const next = this.snapshot(); settleAnalysis(next, next.analysisLeases[token]); delete next.analysisLeases[token]; this.commit(next);
  }
}
