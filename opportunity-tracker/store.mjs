import {analysisCandidate,claimAnalysisCycleBatch,finishAnalysisCycleBatch} from './analysis-cycles.mjs';
import {capacityUsage,planFor,activeProduct} from './plans.mjs';
import {materializeCollectedConversations} from './conversation-pages.mjs';
import {refreshBillingCapacity} from './billing.mjs';
import {initializeAccount,changeAccount,accountSnapshot,accountRestore} from './account.mjs';
import {assertWorkspaceCapacity,assertSubscriptionActive} from './plans.mjs';
import {reserveAnalysisUnits,settleAnalysisUnits} from './usage.mjs';
import {claimScheduledLoop,finishScheduledLoop} from './schedules.mjs';
import {sourceIdentity,freshRows} from './incremental.mjs';
import {claimStage,finishStage,failStage,saveSearchPlan,saveDrafts,saveVideos} from './pipeline-runtime.mjs';
import {captureEvidence} from './conversation-evidence.mjs';
import {beginBackfill, beginCollection, claimCollection, finishCollection} from './collection.mjs';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {dueSources} from './monitor.mjs';
import {stageQualifications, claimQualification, finishQualification, claimQualificationBatch, finishQualificationBatch, mergeQualificationHistory, budgetDay, reserveAnalysis, settleAnalysis, retireAnalysis} from './qualification.mjs';
import {ANALYSIS_DAILY_LIMIT, productHash, matchHash} from './analysis.mjs';
import {BUSINESS_PROFILE_TTL_MS} from './business-profile.mjs';


function enforceCapacityChange(prior,next) {
  try {assertWorkspaceCapacity(next);}
  catch(error){
    if(error.code!=='plan_capacity_exceeded')throw error;
    const before=capacityUsage(prior),after=capacityUsage(next),limits=planFor(next).limits;
    if(['products','keywordSearches','longTailThemes','seats'].some(key=>after[key]>Math.max(limits[key],before[key])))throw error;
  }
  if(next.billing)refreshBillingCapacity(next);
}

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
  mutate(change) {
    const next=this.snapshot(), result=change(next);
    if(result && typeof result.then==='function')throw new TypeError('Store mutation callbacks must be synchronous.');
    this.commit(next);return result;
  }
  initializeAccount(options) {return this.mutate(data=>initializeAccount(data,options));}
  accountAction(principal,action,input,now) {return this.mutate(data=>changeAccount(data,principal,action,input,now));}
  accountSnapshot(principal,now) {return accountSnapshot(this.data,principal,now);}
  reserveAnalysisUnits(options) {return this.mutate(data=>reserveAnalysisUnits(data,options));}
  settleAnalysisUnits(id,options) {return this.mutate(data=>settleAnalysisUnits(data,id,options));}
  claimScheduledLoop(...args) {return this.mutate(data=>claimScheduledLoop(data,...args));}
  finishScheduledLoop(...args) {return this.mutate(data=>finishScheduledLoop(data,...args));}
  saveProduct(product, id, {backfill=false} = {}) {
    const next = this.snapshot();
    const prior = id ? next.products.find(p => p.id === id) : null;
    if (id && !prior) return null;
    const record = { ...prior, ...product, id: id || randomUUID(), createdAt: prior?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    next.products = [record, ...next.products.filter(p => p.id !== record.id)];
    if(next.subscription){assertSubscriptionActive(next);enforceCapacityChange(this.data,next);}
    if(backfill && !id)beginBackfill(next,record.id);
    this.commit(next);
    return record;
  }
  deleteProduct(id) {
    const next = this.snapshot();
    next.products = next.products.filter(p => p.id !== id);
    next.items = next.items.filter(p => p.productId !== id);
    delete next.searches[id];
    if (next.research) delete next.research[id];
    if(next.pipelineStages)delete next.pipelineStages[id];
    if(next.conversationEvidence)delete next.conversationEvidence[id];
    if(next.conversationReviewQueue)delete next.conversationReviewQueue[id];
    if(next.conversationReviewReceipts)delete next.conversationReviewReceipts[id];
    if(next.conversationReviewFailures)delete next.conversationReviewFailures[id];
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
    const rows=freshRows(next,product,[...(result.candidates||[]),...(result.items||[])],{at:result.searchedAt});
    const identities=new Set(rows);result={...result,candidates:(result.candidates||[]).filter(r=>identities.has(r)),items:(result.items||[]).filter(r=>identities.has(r))};
    captureEvidence(next,product,rows,result.searchedAt);
    materializeCollectedConversations(next,product,rows,result.searchedAt);
    const qualification = result.semantic && product.listeningVersion!=='v2' ? stageQualifications(next, product, result.candidates || [], result.searchedAt, result.trigger) : undefined;
    for (const item of product.listeningVersion==='v2'?[]:result.items) {
      const previous=next.items.find(i=>i.productId===productId&&sourceIdentity(i)===sourceIdentity(item));
      const id=previous?.id||createHash('sha256').update(`${productId}:${item.url}`).digest('hex').slice(0,24);
      const record = { ...item, ...(previous?.analysis ? {analysis:previous.analysis} : {}), ...(previous?.qualification ? {qualification:previous.qualification} : {}), id, productId, status: previous?.status || 'new', note: previous?.note || '', draft: previous?.draft || '', foundAt: previous?.foundAt || result.searchedAt, lastSeenAt: result.searchedAt };
      next.items = [record, ...next.items.filter(i => i.id !== id)];
    }
    const prior = next.searches[productId];
    const sources = (result.sources || []).map(source => ({...source, checkedAt: result.searchedAt}));
    const updatedNames = new Set(sources.map(source => source.name));
    const lastChecks = {...prior?.lastChecks};
    if (sources.some(source => ['Reddit', 'Reddit watchlist'].includes(source.name))) lastChecks.reddit = result.searchedAt;
    if (sources.some(source => source.name === 'LinkedIn')) lastChecks.linkedin = result.searchedAt;
    next.searches[productId] = { ...result, items: undefined, candidates:undefined, ...(qualification ? {qualification} : {}), found: result.items.length, lastChecks, watermarks:{...prior?.watermarks,...result.checkpoints},
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
    if(this.data.collection?.active) throw new Error('Wait for the collection request to finish before restoring a backup.');
    value = {...value,...(this.data.ingestion?{ingestion:this.data.ingestion}:{}), conversationReviewReceipts:{},conversationReviewFailures:structuredClone(this.data.conversationReviewFailures||{}),...(this.data.collection?{collection:this.data.collection}:{}), analysisUsage:this.data.analysisUsage || {}};
    const merged=this.data.qualifications || value.qualifications ? mergeQualificationHistory(this.data,value) : structuredClone(value);
    delete merged.pilotBudget;if(Object.hasOwn(this.data,'pilotBudget'))merged.pilotBudget=structuredClone(this.data.pilotBudget);
    this.commit(this.data.workspace||this.data.subscription?accountRestore(this.data,merged):merged);
  }
  beginBackfill(productId, now) {const next=this.snapshot(),result=beginBackfill(next,productId,now);this.commit(next);return result;}
  beginCollection(productId, trigger, now, settings) {const next=this.snapshot(),result=beginCollection(next,productId,trigger,now,settings);this.commit(next);return result;}
  claimCollection(settings,productId,now) {const next=this.snapshot(),result=claimCollection(next,settings,productId,now);this.commit(next);return result;}
  finishCollection(token,outcome,now) {const next=this.snapshot(),result=finishCollection(next,token,outcome,now);this.commit(next);return result;}
  claimQualificationBatch(settings,now,productId) {const next=this.snapshot(),result=claimQualificationBatch(next,settings,now,productId);this.commit(next);return result;}
  finishQualificationBatch(batch,outcome,now) {const next=this.snapshot(),result=finishQualificationBatch(next,batch,outcome,now);this.commit(next);return result;}
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
    if(next.subscription){assertSubscriptionActive(next,now);if(!activeProduct(product)||product.planMonitoringBlocked)throw Object.assign(new Error('This product is paused under the current plan.'),{status:409,code:product.planMonitoringBlocked||'product_archived'});}
    next.analysisLeases ||= {};
    retireAnalysis(next, now);
    if (Object.values(next.analysisLeases).some(lease => lease.productId === productId)) error('Analysis is already running for this product. Try again after it finishes.', 409);
    let cycleClaim;
    if(next.subscription&&item) {
      const profileHash=productHash(product),version='manual-match:1';
      cycleClaim=claimAnalysisCycleBatch(next,productId,{profileHash,version,candidates:[analysisCandidate(item,{profileHash,version})],now,maxBatch:1,manual:true});
      if(cycleClaim.cached?.length){const cached=cycleClaim.cached[0].result;item.analysis=cached;this.commit(next);return {cached};}
      if(!cycleClaim.batch){this.commit(next);return {status:cycleClaim.status,blocked:cycleClaim.blocked||null,nextRunAt:cycleClaim.nextRunAt||cycleClaim.cycle?.nextRunAt||null};}
    }
    const day = budgetDay(now);
    next.analysisUsage = Object.fromEntries(Object.entries(next.analysisUsage || {}).filter(([key]) => key >= day));
    if ((next.analysisUsage[day] || 0) >= ANALYSIS_DAILY_LIMIT) error(`The daily limit of ${ANALYSIS_DAILY_LIMIT} analysis requests has been reached. Try again tomorrow.`, 429);
    const token = randomUUID();
    const lease = {token, productId, itemId, ...(cycleClaim?.batch?{analysisCycleBatchId:cycleClaim.batch.id}:{}), profileHash: productHash(product), sourceHash: item ? matchHash(item) : null, expiresAt: now + (itemId ? 90000 : 180000)};
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
    if(current.analysisCycleBatchId)finishAnalysisCycleBatch(next,current.productId,current.analysisCycleBatchId,{[current.itemId]:{status:'success',result:record}},{now});
    delete next.analysisLeases[lease.token];
    this.commit(next);
    return record;
  }
  releaseAnalysis(token) {
    if (!this.data.analysisLeases?.[token]) return;
    const next = this.snapshot(),lease=next.analysisLeases[token]; settleAnalysis(next,lease); if(lease.analysisCycleBatchId)finishAnalysisCycleBatch(next,lease.productId,lease.analysisCycleBatchId,{}); delete next.analysisLeases[token]; this.commit(next);
  }
  saveVideos(productId,value) {return this.mutate(data=>saveVideos(data,productId,value));}
  saveDrafts(productId,value) {const next=this.snapshot(),result=saveDrafts(next,productId,value);this.commit(next);return result;}
  claimStage(productId,stage,settings,refresh,now=Date.now(),expectedVersion,videoLibrary) {const next=this.snapshot(),result=claimStage(next,productId,stage,settings,refresh,now,expectedVersion,videoLibrary);this.commit(next);return result;}
  finishStage(lease,result,now=Date.now()) {const next=this.snapshot(),record=finishStage(next,lease,result,now);this.commit(next);return record;}
  failStage(lease,reason,costMicroUsd,now=Date.now()) {const next=this.snapshot();failStage(next,lease,reason,costMicroUsd,now);this.commit(next);}
  saveSearchPlan(productId,plan,version) {const next=this.snapshot(),product=saveSearchPlan(next,productId,plan,version);if(next.subscription){assertSubscriptionActive(next);enforceCapacityChange(this.data,next);if(product.listeningVersion==='v2'&&product.searchPlanV2?.reviewed)beginBackfill(next,productId);}this.commit(next);return product;}
  getBusinessProfile(inputHash) {return structuredClone(this.data.businessProfileDrafts?.[inputHash] || null);}
  claimBusinessProfile(inputHash, reservation, now=Date.now(), settings=null, refresh=false) {
    if(this.data.subscription)assertSubscriptionActive(this.data);
    const next=this.snapshot();
    const cached=next.businessProfileDrafts?.[inputHash],at=Date.parse(cached?.generatedAt);
    if(!refresh && Number.isFinite(at) && at<=now && at>now-BUSINESS_PROFILE_TTL_MS)return {cached:structuredClone(cached)};
    retireAnalysis(next,now);
    next.analysisLeases ||= {};
    const error=(message,status)=>{const e=new Error(message);e.status=status;throw e;};
    if(Object.values(next.analysisLeases).some(lease=>lease.kind==='business-profile'&&lease.inputHash===inputHash))error('This business breakdown is already running.',409);
    const day=budgetDay(now);
    next.analysisUsage=Object.fromEntries(Object.entries(next.analysisUsage || {}).filter(([key])=>key>=day));
    if((next.analysisUsage[day] || 0)>=ANALYSIS_DAILY_LIMIT)error('The daily analysis request limit has been reached.',429);
    const token=randomUUID(),lease={token,kind:'business-profile',inputHash,productId:`business-profile:${inputHash}`,expiresAt:now+120000,profileReservationMicroUsd:reservation};
    if(settings)reserveAnalysis(next,lease,settings,now);
    next.analysisLeases[token]=lease;
    next.analysisUsage[day]=(next.analysisUsage[day] || 0)+1;
    this.commit(next);return structuredClone(lease);
  }
  finishBusinessProfile(lease, result, now=Date.now()) {
    const next=this.snapshot(),current=next.analysisLeases?.[lease.token];
    if(!current || current.kind!=='business-profile' || current.inputHash!==result.profile.inputHash || current.expiresAt<=now) {
      const error=new Error('The business breakdown expired. Generate it again.');error.status=409;throw error;
    }
    const drafts=Object.entries(next.businessProfileDrafts || {}).filter(([key,p])=>key!==current.inputHash&&Date.parse(p.generatedAt)>now-BUSINESS_PROFILE_TTL_MS).sort((a,b)=>Date.parse(b[1].generatedAt)-Date.parse(a[1].generatedAt)).slice(0,9);
    next.businessProfileDrafts=Object.fromEntries([[current.inputHash,{...structuredClone(result.profile),generatedAt:new Date(now).toISOString()}],...drafts]);
    settleAnalysis(next,current,result.costMicroUsd);delete next.analysisLeases[lease.token];this.commit(next);
    return structuredClone(next.businessProfileDrafts[current.inputHash]);
  }
}
