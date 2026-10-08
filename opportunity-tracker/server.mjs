import {conversationCurrentState} from './conversation-feed.mjs';
import {stageSnapshot,validateStageRecords} from './pipeline-stages.mjs';
import {createStageProvider} from './pipeline-provider.mjs';
import {validateListeningSettings,listeningReady,activeSearchPlan,plannedQueries} from './search-plan.mjs';
import {evidenceFor,pendingEvidence,pendingEvidenceCount,currentOpportunityFit,currentConversationRelevant,relevantEvidence,validateEvidence,qualificationInputHash,qualificationDue,REVIEW_QUEUE_LIMIT,REVIEW_WORKSPACE_LIMIT} from './conversation-evidence.mjs';
import {discoveryProgress} from './discovery-progress.mjs';
import {collectionSettings,collectionDueIds,collectionPublicState,createCollectionProvider,processCollection,COLLECTION_VERSION} from './collection.mjs';
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Store } from './store.mjs';
import { importMetadata, publicUrl } from './metadata.mjs';
import { discover } from './discovery.mjs';
import { configuredFirestore, FirestoreBackend, FirestoreStore } from './firestore-store.mjs';
import { createAuth } from './auth.mjs';
import {suggestProfile, checkCommunities, validateProfile, profileInput} from './profile.mjs';
import {businessProfileInput,businessProfileHash,businessProfileSelection,freshBusinessProfile,validateBusinessProfile} from './business-profile.mjs';
import {createBusinessProfileProvider,businessProfileReservation} from './business-profile-provider.mjs';
import {createRedditAdapter} from './reddit/adapters.mjs';
import {linkedinConfigured} from './linkedin/adapter.mjs';
import {dueProducts, startLocalMonitoring, MONITOR_INTERVAL_MS, LINKEDIN_TIME_ZONE, LINKEDIN_HOURS} from './monitor.mjs';
import {qualificationSettings, qualificationPublicState, qualificationBackup, validateQualificationHistory, createQualificationProvider, processQualification} from './qualification.mjs';
import {analysisConfiguration, analysisSnapshot, researchProduct, analyzeMatch, productHash, matchHash, validateResearch, validateFit, freshAnalysis, ANALYSIS_DAILY_LIMIT} from './analysis.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const list = (value, max = 12) => {
  if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || x.length > 160)) throw new Error(`Use up to ${max} phrases, each under 160 characters.`);
  return [...new Set(value.map(x => x.trim()).filter(Boolean))];
};
export function validateProduct(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) throw new Error('Enter a product name under 120 characters.');
  if (typeof value.description !== 'string' || value.description.length > 5000) throw new Error('Describe the product in 5,000 characters or fewer.');
  if (typeof value.url !== 'string' || value.url.length > 2048) throw new Error('Enter a website or App Store URL.');
  const url = publicUrl(value.url).href;
  const keywords = list(value.keywords);
  if (!keywords.length) throw new Error('Add at least one phrase describing a problem your product solves.');
  const selection=businessProfileSelection(value,{...value,url});
  return { name: value.name.trim(), description: value.description.trim(), url, type: new URL(url).hostname === 'apps.apple.com' ? 'app_store' : 'website', keywords, aliases: list(value.aliases || [value.name]), competitorNames:list(value.competitorNames||[],8), exclusions: list(value.exclusions || []), ...validateProfile({...value,...selection}),...selection,...validateListeningSettings({...value,...selection}) };
}

export function createTrackerApp({ dataDirectory = process.env.TRACKER_DATA_DIR || join(directory, '.local'), discoverFn = discover, metadataFn = importMetadata, profileFn = product => suggestProfile(product,{env:{}}), businessProfileProvider, stageProvider, analysisProvider, redditAdapter, linkedinAvailable = linkedinConfigured(), monitorToken = process.env.TRACKER_MONITOR_TOKEN, qualificationEnv = process.env, collectionProvider = createCollectionProvider({env:qualificationEnv}), qualificationProvider = createQualificationProvider({env:qualificationEnv}), store: providedStore, hosted = false, googleClientId = process.env.TRACKER_GOOGLE_CLIENT_ID, googleAllowedEmails = process.env.TRACKER_GOOGLE_ALLOWED_EMAILS, googleAllowedSubjects = process.env.TRACKER_GOOGLE_ALLOWED_SUBJECTS, verifyGoogleIdToken, sessionSecret = process.env.TRACKER_SESSION_SECRET, firebaseProjectId = process.env.FIREBASE_PROJECT_ID, firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON, workspace = process.env.TRACKER_WORKSPACE || (process.env.VERCEL_ENV === 'preview' ? 'preview' : 'personal') } = {}) {
  const auth = hosted ? createAuth({clientId:googleClientId,allowedEmails:googleAllowedEmails,allowedSubjects:googleAllowedSubjects,secret:sessionSecret,verifyIdToken:verifyGoogleIdToken}) : null;
  const store = providedStore || (hosted ? new FirestoreStore(new FirestoreBackend(configuredFirestore({projectId:firebaseProjectId,serviceAccountJson:firebaseServiceAccountJson}),workspace)) : new Store(dataDirectory));
  const app = express();
  const token = randomBytes(24).toString('hex');
  const busy = new Set();
  const loginAttempts = [];
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const busyIds = async () => store.activeSearches ? await store.activeSearches() : [...busy];
  const monitoringAvailable = !hosted || typeof monitorToken === 'string' && monitorToken.length >= 32;
  const collector=collectionSettings(qualificationEnv);
  const config = analysisConfiguration(qualificationEnv);
  const analysis = analysisProvider || {available: config.available, research: product => researchProduct(product, {config}), match: (product, item) => analyzeMatch(product, item, {config})};
  const businessProfiles=businessProfileProvider || createBusinessProfileProvider({env:qualificationEnv});
  const stages=stageProvider||createStageProvider({env:qualificationEnv});
  const actionsEnabled=qualificationEnv.TRACKER_ACTIONS_ENABLED!=='false';
  async function runStage(productId,stage,refresh=false){
    if(!actionsEnabled&&['actions','drafts'].includes(stage))throw Object.assign(new Error('The action tier is disabled on this server.'),{status:403});
    if(!stages.available)throw Object.assign(new Error('AI stages are paused. Check the server key and daily budget settings.'),{status:503});
    const claimed=await store.claimStage(productId,stage,stageProvider?null:qualificationSettings(qualificationEnv),refresh);
    if(claimed.cached)return {result:claimed.cached,cached:true};
    try{return {result:await store.finishStage(claimed.lease,await stages.run(stage,claimed.input)),cached:false};}
    finally{await store.releaseAnalysis(claimed.lease.token);}
  }
  async function runAnalysis(productId, itemId, refresh) {
    if (!analysis.available) {const error = new Error('AI analysis is paused. Check the server key and daily budget settings.'); error.status = 503; throw error;}
    const snapshot = await store.snapshot(), product = snapshot.products.find(row => row.id === productId);
    const item = itemId ? snapshot.items.find(row => row.id === itemId && row.productId === productId) : null;
    if (!product || itemId && !item) {const error = new Error('Product or match not found.'); error.status = 404; throw error;}
    const cached = item ? item.analysis : snapshot.research?.[productId];
    if (!refresh && freshAnalysis(cached) && cached.profileHash === productHash(product) && (!item || cached.sourceHash === matchHash(item))) return {result: cached, cached: true};
    const lease = await store.claimAnalysis(productId, itemId, Date.now(), analysisProvider ? null : qualificationSettings(qualificationEnv));
    try {
      if (lease.profileHash !== productHash(product) || item && lease.sourceHash !== matchHash(item)) {const error = new Error('The product or conversation changed. Refresh and run analysis again.'); error.status = 409; throw error;}
      const result = item ? await analysis.match(structuredClone(product), structuredClone(item)) : await analysis.research(structuredClone(product));
      return {result: await store.finishAnalysis(lease, result), cached: false};
    } finally {await store.releaseAnalysis(lease.token);}
  }
  async function runQualification(productId) {
    const settings = qualificationSettings(qualificationEnv);
    if (!productId && settings.mode !== 'ongoing') return {status:'disabled'};
    const snapshot=await store.snapshot();
    const selected=productId?snapshot.products.find(p=>p.id===productId):snapshot.products.find(p=>p.listeningVersion==='v2'&&(p.monitoring||snapshot.collection?.cycles?.[p.id]?.trigger==='manual'||snapshot.collection?.backfills?.[p.id]?.trigger==='onboarding')&&listeningReady(p)&&qualificationDue(snapshot,p));
    if(selected?.listeningVersion==='v2')return pendingEvidence(snapshot,selected).length?runStage(selected.id,'qualify'):{status:'complete'};
    return processQualification(store,settings,qualificationProvider,{productId});
  }
  async function runSearch(id, scheduled = false) {
    const snapshot = await store.snapshot();
    const product = snapshot.products.find(row => row.id === id);
    if (!product) {const error = new Error('Product not found.'); error.status = 404; throw error;}
    if(product.listeningVersion==='v2'){activeSearchPlan(product);if(!collector.enabled)throw Object.assign(new Error('V2 listening requires the configured collection pipeline.'),{status:503});}
    const continuing=collector.enabled && collectionDueIds(snapshot).includes(id);
    if (scheduled && !continuing && !dueProducts(snapshot).some(row => row.id === id)) return null;
    if(collector.enabled) {
      if(!collector.configured)throw new Error('ScrapeBadger collection is not configured.');
      const needsRegular=snapshot.collection?.cycles?.[id]?.status==='running' || !scheduled || dueProducts(snapshot).some(row=>row.id===id);
      if(needsRegular) {
        await store.beginCollection(id,scheduled?'scheduled':'manual',Date.now());
      }
      await processCollection(store,collector,collectionProvider,id);
      // Preserve the existing independent LinkedIn slots.
      if(product.linkedin && (!scheduled || (await import('./monitor.mjs')).dueSources(product,snapshot).includes('linkedin'))) {
        const lease=store.claimSearch?await store.claimSearch(id):true;
        if(lease)try {
          if(scheduled)await store.markMonitorAttempt(id);
          const result=await discoverFn(structuredClone(product),{watchOnly:true,scheduledSources:['linkedin'],paidWeb:false,semantic:qualificationSettings(qualificationEnv).enabled});
          await store.recordSearch(id,{...result,trigger:scheduled?'scheduled':'manual'});
        }finally{if(store.releaseSearch)await store.releaseSearch(id,lease);}
      }
      const current=await store.snapshot();
      return {search:current.searches[id],items:current.items.filter(row=>row.productId===id),collection:collectionPublicState(current).cycles[id]};
    }
    let lease;
    if (store.claimSearch) lease = await store.claimSearch(id);
    else if (!busy.has(id)) {busy.add(id); lease = true;}
    if (!lease) {const error = new Error('A search is already running for this product.');error.status = 409;throw error;}
    try {
      const attempt = scheduled ? await store.markMonitorAttempt(id) : null;
      if (scheduled && !attempt) return null;
      const currentProduct = (await store.snapshot()).products.find(row => row.id === id);
      if (!currentProduct) return null;
      const recentThreads = snapshot.items.filter(row => row.productId === id && row.source?.startsWith('Reddit') && Date.parse(row.lastSeenAt || row.foundAt) > Date.now() - 7 * 86400000).slice(0, 4).map(row => row.url);
      // Paid profile suggestions and web tools are outside this qualification
      // allowance. Their old optional credentials cannot bypass the ledger.
      const result = await discoverFn(structuredClone(currentProduct), {watchOnly: scheduled, recentThreads, paidWeb:false, semantic:qualificationSettings(qualificationEnv).enabled, ...(scheduled ? {scheduledSources: attempt.sources} : {})});
      await store.recordSearch(id, {...result, trigger: scheduled ? 'scheduled' : 'manual', ...(scheduled ? {checkedSources: attempt.sources} : {})});
      const data = await store.snapshot();
      return {search: data.searches[id], items: data.items.filter(row => row.productId === id)};
    } finally {if (store.releaseSearch) await store.releaseSearch(id, lease);else busy.delete(id);}
  }
  app.disable('x-powered-by');
  if(hosted) app.set('trust proxy',1);
  app.use((req,res,next) => {
    if (!hosted && !allowedHosts.has(req.hostname)) return res.status(403).json({error:'Open this tracker using localhost.'});
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups', 'Content-Security-Policy': "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data:; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if(req.path.startsWith('/api/')) {
      res.set('Cache-Control','no-store');
      if (req.path === '/api/monitor' || req.path.startsWith('/api/monitor/')) {
        const expected = Buffer.from(typeof monitorToken === 'string' && monitorToken.length >= 32 ? `Bearer ${monitorToken}` : '');
        const provided = Buffer.from(req.get('authorization') || '');
        if (!expected.length || provided.length !== expected.length || !timingSafeEqual(provided, expected)) return res.status(401).json({error: 'unauthorized'});
        return next();
      }
      if(req.method!=='GET' && req.get('origin') && req.get('origin')!==`${req.protocol}://${req.get('host')}`) return res.status(403).json({error:'This request came from another website.'});
      if(req.path==='/api/auth' || req.path==='/api/login/google') return next();
      if(auth&&!auth.authenticated(req)) return res.status(401).json({error:'Sign in to open your tracker.'});
      if(req.method!=='GET' && req.get('X-Tracker-Token')!==(auth ? auth.csrf(req) : token)) return res.status(403).json({error:'Refresh the page and try again.'});
    }
    next();
  });
  app.use(express.json({limit:'2mb'}));
  app.get('/api/auth',(req,res)=>{
    const authenticated = !auth || auth.authenticated(req);
    res.json({hosted,authenticated,storage:hosted?'cloud':'local',...(!authenticated ? {google:auth.challenge(req,res)} : {})});
  });
  app.post('/api/login/google',async(req,res)=>{
    if(!auth) return res.status(400).json({error:'Local mode does not require sign-in.'});
    const allowed=store.allowLoginAttempt ? await store.allowLoginAttempt() : (()=>{while(loginAttempts[0]<Date.now()-300000) loginAttempts.shift(); if(loginAttempts.length>=15)return false; loginAttempts.push(Date.now());return true;})();
    if(!allowed) return res.status(429).json({error:'Too many sign-in attempts. Wait five minutes and try again.'});
    await auth.login(req,res); res.json({ok:true});
  });
  app.post('/api/logout',(_req,res)=>{auth?.logout(res);res.json({ok:true});});
  app.get('/api/state',async(req,res)=>{
    const snapshot = await store.snapshot();
    const publicAnalysis=analysisSnapshot(snapshot),v2Products=new Set(snapshot.products.filter(p=>p.listeningVersion==='v2').map(p=>p.id));
    res.json({...qualificationPublicState(snapshot,qualificationSettings(qualificationEnv)),...publicAnalysis,items:publicAnalysis.items.map(item=>({...item,...conversationCurrentState(snapshot,item)})),pipeline:{available:stages.available,actionsEnabled,stages:stageSnapshot(snapshot),products:Object.fromEntries(snapshot.products.map(p=>[p.id,{ready:listeningReady(p),retained:evidenceFor(snapshot,p).length,pending:pendingEvidenceCount(snapshot,p),relevant:relevantEvidence(snapshot,p).length,conversations:evidenceFor(snapshot,p).map(r=>({...r,classificationCurrent:p.listeningVersion==='v2'&&r.qualification?.profileHash===qualificationInputHash(p)}))}]))},discovery:Object.fromEntries(snapshot.products.map(p=>[p.id,discoveryProgress(snapshot,p,{settings:qualificationSettings(qualificationEnv),available:stages.available})])),analysis:{available:analysis.available,dailyLimit:ANALYSIS_DAILY_LIMIT},businessProfiles:{versions:['v1','v2'],v2Available:businessProfiles.available},token:auth?auth.csrf(req):token,busy:await busyIds(),storage:hosted?'cloud':'local',collection:collector.enabled?collectionPublicState(snapshot):null,sources:{x:{available:collector.enabled&&collector.configured},linkedin:{available:linkedinAvailable}},monitoring:{available:monitoringAvailable,intervalMinutes:MONITOR_INTERVAL_MS / 60000,linkedin:{timeZone:LINKEDIN_TIME_ZONE,hours:LINKEDIN_HOURS}}});
  });
  app.get('/api/monitor', async(_req, res) => {
    const snapshot=await store.snapshot(),settings=qualificationSettings(qualificationEnv);
    res.json({ids:[...new Set([...dueProducts(snapshot).map(product=>product.id),...(collector.enabled?collectionDueIds(snapshot):[])])],analysis:{available:analysis.available,model:config.model},qualifications:{available:settings.active&&settings.mode==='ongoing',model:settings.model,pending:Object.values(snapshot.qualifications||{}).filter(job=>job.status==='pending').length},
      collection:collector.enabled?{...collectionPublicState(snapshot),provider:'scrapebadger'}:null,schedules:{x:{intervalMinutes:MONITOR_INTERVAL_MS / 60000},reddit:{intervalMinutes:MONITOR_INTERVAL_MS / 60000},linkedin:{timeZone:LINKEDIN_TIME_ZONE,hours:LINKEDIN_HOURS}}});
  });
  app.post('/api/monitor/qualifications',async(_req,res)=>res.json(await runQualification()));
  app.post('/api/monitor/:id', async(req, res) => {
    const result = await runSearch(req.params.id, true);
    if (!result) return res.status(204).end();
    res.json({ok:true, found:result.search?.found || 0});
  });
  app.post('/api/metadata',async(req,res)=>{if(typeof req.body.url!=='string') throw new Error('Enter a URL.');res.json(await metadataFn(req.body.url));});
  app.post('/api/profile', async(req,res) => {
    if(req.body?.version!==undefined && !['v1','v2'].includes(req.body.version))throw new Error('Choose a supported business profile version.');
    if(req.body?.version==='v2') {
      const input=businessProfileInput(req.body),inputHash=businessProfileHash(input);
      const cached=await store.getBusinessProfile(inputHash);
      if(req.body.refresh!==true && cached && freshBusinessProfile(cached,input))return res.json({version:'v2',profile:validateBusinessProfile(cached,input,{requireCurrent:true}),cached:true});
      if(!businessProfiles.available)return res.status(503).json({error:'V2 business breakdowns are paused. Check the existing AI settings and budget.'});
      const prepared=await businessProfiles.prepare(input);
      const lease=await store.claimBusinessProfile(inputHash,businessProfileReservation(input,prepared),Date.now(),businessProfileProvider?null:qualificationSettings(qualificationEnv),req.body.refresh===true);
      if(lease.cached)return res.json({version:'v2',profile:validateBusinessProfile(lease.cached,input,{requireCurrent:true}),cached:true});
      try {
        const result=await businessProfiles.generate(input,prepared);
        result.profile=validateBusinessProfile(result.profile,input,{requireCurrent:true});
        result.profile.reviewed=false;
        return res.json({version:'v2',profile:await store.finishBusinessProfile(lease,result),cached:false});
      } finally {await store.releaseAnalysis(lease.token);}
    }
    const product = profileInput(req.body);
    const profile = await profileFn(product);
    let adapter = redditAdapter;
    try {adapter ||= createRedditAdapter();} catch { /* Leave suggestions explicitly unverified. */ }
    const checks = await checkCommunities(profile.communities, {adapter});
    res.json({...profile, checks});
  });
  app.post('/api/communities/check', async(req,res) => {
    let adapter = redditAdapter;
    try {adapter ||= createRedditAdapter();} catch { /* Leave unavailable checks visible. */ }
    res.json({checks: await checkCommunities(req.body.communities, {adapter})});
  });
  app.post('/api/products',async(req,res)=>{
    if((await store.snapshot()).products.length>=100) throw new Error('The tracker supports up to 100 products.');
    const product=validateProduct(req.body);
    if(product.linkedin && !linkedinAvailable) throw new Error('LinkedIn collection is not configured on this server.');
    if(product.monitoring && !monitoringAvailable) throw new Error('Automatic checks are not configured yet. Turn them off to save this product.');
    res.status(201).json({product:await store.saveProduct(product,undefined,{backfill:collector.enabled&&collector.configured})});
  });
  app.put('/api/products/:id',async(req,res)=>{
    const prior=(await store.snapshot()).products.find(p=>p.id===req.params.id);
    if(!prior)return res.status(404).json({error:'Product not found.'});
    const edited={...prior,...req.body};
    if(edited.profileVersion==='v1' && prior.profileVersion!=='v2' && req.body.profileV1===undefined)edited.profileV1={capabilities:edited.capabilities || [],needs:edited.needs || []};
    const input=validateProduct(edited);
    if(input.linkedin && !linkedinAvailable) throw new Error('LinkedIn collection is not configured on this server.');
    if(input.monitoring && !monitoringAvailable) throw new Error('Automatic checks are not configured yet. Turn them off to save this product.');
    const product=await store.saveProduct(input,req.params.id);
    if(!product) return res.status(404).json({error:'Product not found.'}); res.json({product});
  });
  app.post('/api/products/:id/stages/:stage',async(req,res)=>res.json(await runStage(req.params.id,req.params.stage,req.body.refresh===true)));
  app.put('/api/products/:id/search-plan',async(req,res)=>res.json({product:await store.saveSearchPlan(req.params.id,req.body.plan,req.body.version)}));
  app.put('/api/products/:id/stages/drafts',async(req,res)=>{if(!actionsEnabled)return res.status(403).json({error:'The action tier is disabled on this server.'});res.json({result:await store.saveDrafts(req.params.id,req.body)});});
  app.delete('/api/products/:id',async(req,res)=>{await store.deleteProduct(req.params.id);res.json({ok:true});});
  app.post('/api/products/:id/backfill',async(req,res)=>{
    if(!collector.enabled||!collector.configured)return res.status(503).json({error:'Historical collection is not configured.'});
    const job=await store.beginBackfill(req.params.id,Date.now());
    if(!job)return res.status(404).json({error:'Product not found.'});
    res.json({backfill:collectionPublicState(await store.snapshot()).backfills[req.params.id]});
  });
  app.post('/api/products/:id/search',async(req,res)=>{
    res.json(await runSearch(req.params.id));
  });
  app.post('/api/products/:id/research',async(req,res)=>res.json(await runAnalysis(req.params.id, null, req.body?.refresh === true)));
  app.post('/api/items/:id/analysis',async(req,res)=>{
    const item = (await store.snapshot()).items.find(row => row.id === req.params.id);
    if (!item) return res.status(404).json({error: 'Match not found.'});
    res.json(await runAnalysis(item.productId, item.id, req.body?.refresh === true));
  });
  app.post('/api/qualification/run',async(req,res)=>{
    const id=req.body.productId;
    if(typeof id!=='string'||!(await store.snapshot()).products.some(product=>product.id===id)) return res.status(404).json({error:'Product not found.'});
    res.json(await runQualification(id));
  });
  app.patch('/api/items/:id',async(req,res)=>{
    const update={};
    if(req.body.status!==undefined) {if(!['new','saved','dismissed'].includes(req.body.status)) throw new Error('Choose New, Saved, or Dismissed.');update.status=req.body.status;}
    if(req.body.note!==undefined) {if(typeof req.body.note!=='string'||req.body.note.length>3000) throw new Error('Notes must be under 3,000 characters.');update.note=req.body.note;}
    if(req.body.draft!==undefined) {if(typeof req.body.draft!=='string'||req.body.draft.length>5000) throw new Error('Drafts must be under 5,000 characters.');update.draft=req.body.draft;}
    const item=await store.updateItem(req.params.id,update);
    if(!item) return res.status(404).json({error:'Match not found.'});res.json({item});
  });
  app.get('/api/export',async(_req,res)=>{
    const snapshot=await store.snapshot();
    res.set('Content-Disposition','attachment; filename="product-tracker.json"').json({...analysisSnapshot(snapshot),...qualificationBackup(snapshot),pipelineStages:snapshot.pipelineStages||{},conversationEvidence:snapshot.conversationEvidence||{},conversationReviewQueue:snapshot.conversationReviewQueue||{}});
  });
  app.post('/api/import',async(req,res)=>{
    if((await busyIds()).length) throw new Error('Wait for the running searches to finish before restoring a backup.');
    const data=req.body;
    if(data?.version!==1||!Array.isArray(data.products)||data.products.length>100||!Array.isArray(data.items)||data.items.length>10000) throw new Error('Choose a tracker JSON backup.');
    const history=validateQualificationHistory(data);
    const products=data.products.map(p=>{
      if(typeof p.id!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(p.id)||['__proto__','constructor','prototype'].includes(p.id)) throw new Error('The backup has invalid product IDs.');
      const monitorAttempts = Object.fromEntries(['reddit','linkedin'].flatMap(source => {
        const at = p.monitorAttempts?.[source];
        return typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.now() ? [[source, new Date(at).toISOString()]] : [];
      }));
      return {...validateProduct(p),id:p.id,createdAt:typeof p.createdAt==='string'?p.createdAt:new Date().toISOString(),updatedAt:typeof p.updatedAt==='string'?p.updatedAt:new Date().toISOString(),
        ...(Object.keys(monitorAttempts).length ? {monitorAttempts} : {}), ...(typeof p.lastMonitorAttemptAt === 'string' && Number.isFinite(Date.parse(p.lastMonitorAttemptAt)) && Date.parse(p.lastMonitorAttemptAt) <= Date.now() ? {lastMonitorAttemptAt:p.lastMonitorAttemptAt} : {})};
    });
    if(products.some(p=>!p.id)||new Set(products.map(p=>p.id)).size!==products.length) throw new Error('The backup has invalid product IDs.');
    const ids=new Set(products.map(p=>p.id));
    const items=data.items.map(i=>{
      if(!ids.has(i.productId)||!['opportunity','mention','conversation'].includes(i.kind)||!['new','saved','dismissed'].includes(i.status)||typeof i.id!=='string'||!i.id||typeof i.title!=='string'||typeof i.note!=='string'||i.note.length>3000) throw new Error('The backup has invalid matches.');
      const provenance = {};
      for (const key of ['sourceId', 'postId', 'parentId']) if (i[key] != null) {
        if (typeof i[key] !== 'string' || !(['linkedin-mcp','linkedin-apify'].includes(i.provider) ? /^(?:li_)?\d{10,20}$/.test(i[key]) : /^(?:(?:t[13]_)?[a-z0-9]{1,20}|x_\d{1,30})$/i.test(i[key]))) throw new Error('The backup has invalid source IDs.');
        provenance[key] = i[key];
      }
      if (i.parentId === null) provenance.parentId = null;
      if (['scrapebadger', 'redlib', 'public-json', 'linkedin-mcp', 'linkedin-apify'].includes(i.provider)) provenance.provider = i.provider;
      if (['post', 'comment'].includes(i.type)) provenance.type = i.type;
      if(i.draft!==undefined){if(typeof i.draft!=='string'||i.draft.length>5000)throw new Error('The backup has an invalid draft.');provenance.draft=i.draft;}
      if(i.historical===true)provenance.historical=true;
      if(typeof i.discussionClosed==='boolean')provenance.discussionClosed=i.discussionClosed;
      if (typeof i.collectedAt === 'string' && Number.isFinite(Date.parse(i.collectedAt))) provenance.collectedAt = new Date(i.collectedAt).toISOString();
      const item = {...provenance,id:i.id,productId:i.productId,kind:i.kind,status:i.status,note:i.note,url:publicUrl(i.url).href,title:i.title.slice(0,500),snippet:String(i.snippet||'').slice(0,10000),reason:String(i.reason||'').slice(0,3000),source:typeof i.source==='string'?i.source.slice(0,100):'Imported',author:typeof i.author==='string'?i.author.slice(0,120):null,publishedAt:typeof i.publishedAt==='string'?i.publishedAt:null,foundAt:typeof i.foundAt==='string'?i.foundAt:new Date().toISOString(),lastSeenAt:typeof i.lastSeenAt==='string'?i.lastSeenAt:new Date().toISOString(),matchedTerms:Array.isArray(i.matchedTerms)?i.matchedTerms.filter(t=>typeof t==='string').slice(0,20):[]};
      const product = products.find(row => row.id === item.productId);
      if (i.analysis && i.analysis.profileHash === productHash(product) && i.analysis.sourceHash === matchHash(item)) item.analysis = {...validateFit(i.analysis, product, item), profileHash: productHash(product), sourceHash: matchHash(item), imported: true, generatedAt: typeof i.analysis.generatedAt === 'string' ? i.analysis.generatedAt.slice(0,40) : null};
      return item;
    });
    if(new Set(items.map(i=>i.id)).size!==items.length) throw new Error('The backup has duplicate matches.');
    const research = {};
    if (data.research !== undefined && (!data.research || Array.isArray(data.research) || typeof data.research !== 'object' || Object.keys(data.research).length > 100)) throw new Error('The backup has invalid research records.');
    for (const product of products) {
      const row = Object.hasOwn(data.research || {}, product.id) ? data.research[product.id] : null;
      if (row) research[product.id] = {...validateResearch(row, product), profileHash: typeof row.profileHash === 'string' ? row.profileHash.slice(0,64) : '', imported: true, generatedAt: typeof row.generatedAt === 'string' ? row.generatedAt.slice(0,40) : null};
    }
    // Qualification evidence comes from validated receipts, not arbitrary
    // imported item metadata. Human status and notes retain backup semantics.
    const receipts=new Map(Object.values(history.qualifications||{}).filter(job=>job.status==='qualified').map(job=>[`${job.productId}:${job.url}`,job]));
    for(const item of items) {
      const receipt=receipts.get(`${item.productId}:${item.url}`);
      if(receipt?.assessment)item.qualification={model:receipt.model,promptVersion:receipt.promptVersion,...receipt.assessment};
    }
    await store.importData({version:1,products,items,searches:{},research,...history,pipelineStages:validateStageRecords(data.pipelineStages,products),conversationEvidence:validateEvidence(data.conversationEvidence,products),conversationReviewQueue:validateEvidence(data.conversationReviewQueue,products,{limit:REVIEW_QUEUE_LIMIT,totalLimit:REVIEW_WORKSPACE_LIMIT})});res.json({ok:true});
  });
  app.use(express.static(join(directory,'public')));
  app.use((err,_req,res,_next)=>res.status(err.status||400).json({error:err.type==='entity.too.large'?'The backup is too large.':err.message||'The request failed. Try again.'}));
  return {app,store,runSearch,runQualification,runStage};
}

// Vercel imports the default Express export. Configuration is evaluated on the
// first request, so builds do not need secrets or create an ephemeral store.
const vercelApp=express();
let hostedApp;
vercelApp.use((req,res,next)=>{
  try {hostedApp ||= createTrackerApp({hosted:true}).app;return hostedApp(req,res,next);}
  catch {res.status(503).json({error:'Configure the Firebase connection, Google sign-in client ID and allowed accounts, and TRACKER_SESSION_SECRET (32+ characters) for this Vercel project.'});}
});
export default vercelApp;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port=Number(process.env.TRACKER_PORT||4322);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Use a TRACKER_PORT between 1024 and 65535.');
  const tracker=createTrackerApp();
  tracker.app.listen(port,'127.0.0.1',()=>console.log(`Product tracker: http://127.0.0.1:${port}`));
  startLocalMonitoring({...tracker,onError:()=>console.error('Local monitoring could not complete a check; retrying later.')});
}
