import {hasMarketingAccess,requireMarketingAccess} from './marketing-billing.js';
import {LEAD_REPLY_PROMPT_VERSION,MAX_REPLY_OUTPUT,leadReplyPlanSchema,type LeadReplyPlan} from './lead-replies.js';
import {createHash,randomUUID} from 'node:crypto';
import {FieldPath,Timestamp} from 'firebase-admin/firestore';
import {Store,documentKey} from './database.js';
import type {AppRow} from './database.js';
import type {LeadAIProvider,LeadAssessment,LeadDraft,LeadDraftProposal,LeadJob,LeadProfile} from './leads-types.js';
import {LEAD_PROMPT_VERSION,LEAD_PROFILE_PROMPT_VERSION,LEAD_QUALIFICATION_VERSION,MAX_DESCRIPTION,MAX_OUTPUT_TOKENS,MAX_DISCOVERY_OUTPUT,SEARCH_CALL_MICRO_USD} from './leads-types.js';
import {configuredLeadProvider,contentHash,leadAISettings,maximumCostMicroUsd,normalizeSuggestedCommunities} from './leads-ai.js';
import {containsPromptInjection,createQualificationAssessment,enqueueLeadCandidates,leadContentHash,prefilterLeadCandidate,validateQualifiedEvidence} from './leads-candidates.js';
import {leadsEnabledFor,publicAIConfigFingerprint} from './lead-access.js';
import type {StoredRedditPost} from './reddit.js';
import {discoveryLimits} from './leads-discovery-config.js';
import {claimLeadSlot,releaseLeadSlot} from './leads-worker-slots.js';
import {queueLeadReadyNotification} from './leads-notifications.js';
import {normalizedPostImages,IMAGE_INPUT_TOKEN_ALLOWANCE} from './reddit-images.js';
import type {InitialLeadScan} from './leads-initial-scan.js';

const DAY=86400000;const CALL_LIMIT=20;const PER_APP_LIMIT=5;const WORKER_LEASE_MS=60000;const discoveryLease=(kind:LeadJob['kind'])=>kind==='discover'?180000:WORKER_LEASE_MS;const WORKER_TICK_MS=7*60*1000;
const hashUser=(uid:string)=>createHash('sha256').update(uid).digest('hex');
const monthKey=(time:number)=>new Date(time).toISOString().slice(0,7);
const dayKey=(time:number)=>new Date(time).toISOString().slice(0,10);
interface Budget {reservedMicroUsd:number;spentMicroUsd:number}
interface Reservation {month:string;account_hash:string;app_id?:string;job_id?:string;reservedMicroUsd:number;state:'reserved'|'settled'|'uncertain'|'cancelled';settledMicroUsd?:number}
interface DailyUsage {user_id?:string;app_id?:string;draftAccount?:number;draftApp?:number;qualify?:number;onboardingQualify?:number;reply?:number;
  operatorHistoricalAllowance?:{appId:string;limit:number;used:number;reason:string}}
interface ProviderHealth {ready:boolean;configFingerprint:string;checkedAt:number;reasonCode?:string}

export async function queueLeadReply(store:Store,userId:string,appId:string,postId:string,revision:number,env=process.env,now=Date.now()) {
  await requireMarketingAccess(store,userId,appId,env,now);
  const settings=leadAISettings(env,false);
  if(!settings.configured||!settings.model) throw new Error('AI_UNAVAILABLE');
  return store.atomic(async s=>{
    const [app,profile,post,daily]=await Promise.all([s.getApp(appId,userId),s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),
      s.get<StoredRedditPost>('reddit_posts',postId),s.get<DailyUsage>('lead_daily_usage',documentKey(userId,dayKey(now)))]);
    if(!app||!profile?.enabled||profile.revision!==revision||!post||post.expireAt.toMillis()<=now||!profile.communities.includes(post.subreddit)) throw new Error('STALE_CANDIDATE');
    const postHash=leadContentHash(post),inputHash=contentHash(JSON.stringify([revision,postHash,app.name,settings.model,LEAD_REPLY_PROMPT_VERSION]));
    const id=documentKey(userId,appId,'reply',postId,inputHash),existing=await s.get<LeadJob>('lead_jobs',id);
    if(existing&&existing.expireAt.toMillis()>now) return existing;
    if(existing) throw new Error('EXPIRED');
    if((daily?.reply??0)>=20) throw new Error('DAILY_LIMIT');
    const job:LeadJob={id,user_id:userId,app_id:appId,kind:'reply',inputHash,postId,postContentHash:postHash,profileRevision:revision,
      state:'pending',nextAttemptAt:now,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),expireAt:post.expireAt};
    await s.set('lead_jobs',id,job);
    await s.set('lead_daily_usage',documentKey(userId,dayKey(now)),{...daily,user_id:userId,reply:(daily?.reply??0)+1,expireAt:Timestamp.fromMillis(now+40*DAY)});
    return job;
  });
}

export async function processLeadReplyJob(store:Store,jobId:string,provider:LeadAIProvider|undefined,env=process.env,now=Date.now()) {
  return processSingleLeadJob(store,jobId,'reply',provider,env,now);
}

export async function queueLeadDraft(store:Store,input:{userId:string;app:AppRow;description:string;country:string;requestId:string;env?:NodeJS.ProcessEnv;now?:number}) {
  const now=input.now ?? Date.now(),env=input.env ?? process.env,settings=leadAISettings(env,false);
  if(!settings.configured || !settings.model) throw new Error('AI_UNAVAILABLE');
  if(input.description.length>MAX_DESCRIPTION) throw new Error('DESCRIPTION_TOO_LARGE');
  const sourceHash=contentHash(input.description);
  const inputHash=contentHash(JSON.stringify([sourceHash,settings.model,LEAD_PROMPT_VERSION]));
  const id=documentKey(input.userId,input.app.id,'draft',input.requestId);
  const source={appleId:input.app.apple_id,country:input.country.toLowerCase(),fetchedAt:new Date(now).toISOString()};
  return store.atomic(async s=>{
    const [existing,app,dailyAccount,dailyApp]=await Promise.all([
      s.get<LeadJob>('lead_jobs',id),s.getApp(input.app.id,input.userId),
      s.get<DailyUsage>('lead_daily_usage',documentKey(input.userId,dayKey(now))),
      s.get<DailyUsage>('lead_daily_usage',documentKey(input.userId,input.app.id,dayKey(now))),
    ]);
    if(!app) throw new Error('APP_NOT_FOUND');
    if(existing) {
      if(existing.kind!=='draft'||existing.inputHash!==inputHash) throw new Error('REQUEST_ID_CONFLICT');
      if(existing.expireAt.toMillis()<=now) throw new Error('REQUEST_ID_EXPIRED');
      return {jobId:existing.id,status:existing.state==='succeeded'?'succeeded' as const:existing.state==='failed'?'failed' as const:'pending' as const};
    }
    const cached=await s.query<LeadDraft>(s.collection('lead_drafts').where('user_id','==',input.userId).where('app_id','==',input.app.id).where('sourceHash','==',sourceHash).limit(10));
    const previous=cached.find(d=>d.expireAt.toMillis()>now && d.promptVersion===LEAD_PROFILE_PROMPT_VERSION && (d as LeadDraft & {modelVersion?:string}).modelVersion===settings.model);
    if(previous) {
      const cachedId=(previous as LeadDraft & {jobId?:string}).jobId;
      const cachedJob=cachedId?await s.get<LeadJob>('lead_jobs',cachedId):undefined;
      if(cachedId&&cachedJob?.user_id===input.userId&&cachedJob.app_id===input.app.id&&cachedJob.kind==='draft'&&cachedJob.state==='succeeded'&&cachedJob.expireAt.toMillis()>now) return {jobId:cachedId,status:'succeeded' as const,draftId:cachedId};
    }
    if((dailyApp?.draftApp ?? 0)>=3 || (dailyAccount?.draftAccount ?? 0)>=10) throw new Error('DAILY_LIMIT');
    const expires=now+DAY;
    const job:LeadJob={id,user_id:input.userId,app_id:input.app.id,kind:'draft',inputHash,requestId:input.requestId,sourceDescription:input.description,
      source,state:'pending',nextAttemptAt:now,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),expireAt:Timestamp.fromMillis(expires)};
    await s.set('lead_jobs',id,job);
    await s.set('lead_daily_usage',documentKey(input.userId,dayKey(now)),{...dailyAccount,user_id:input.userId,draftAccount:(dailyAccount?.draftAccount??0)+1,expireAt:Timestamp.fromMillis(now+40*DAY)});
    await s.set('lead_daily_usage',documentKey(input.userId,input.app.id,dayKey(now)),{...dailyApp,user_id:input.userId,app_id:input.app.id,draftApp:(dailyApp?.draftApp??0)+1,expireAt:Timestamp.fromMillis(now+40*DAY)});
    return {jobId:id,status:'pending' as const};
  });
}

export async function leadDraftStatus(store:Store,userId:string,appId:string,jobId:string,now=Date.now()) {
  const job=await store.get<LeadJob>('lead_jobs',jobId);
  if(!job || job.user_id!==userId || job.app_id!==appId || job.kind!=='draft' || job.expireAt.toMillis()<=now) return undefined;
  const row=await store.get<LeadDraft>('lead_drafts',jobId);
  return {status:job.state,draft:row && row.expireAt.toMillis()>now?{
    id:jobId,problems:row.problems,capabilities:row.capabilities,suggestedCommunities:row.suggestedCommunities,
    source:{appleId:row.source.appleId,country:row.source.country,fetchedAt:row.source.fetchedAt},sourceHash:row.sourceHash,
  }:undefined,reasonCode:job.reasonCode};
}

export async function processLeadJobs(store:Store,provider:LeadAIProvider|undefined,env:NodeJS.ProcessEnv=process.env,now=Date.now()) {
  const settings=leadAISettings(env);const fingerprint=publicAIConfigFingerprint(env);
  const hasSecret=!!env.OPENAI_API_KEY?.trim();
  const health=await store.atomic(async s=>{
    const prior=await s.get<ProviderHealth & {paused?:boolean}>('lead_control','provider');
    const paused=prior?.paused===true,configured=settings.enabled&&settings.configured&&hasSecret&&!!provider&&!!fingerprint,ready=configured&&!paused;
    const value:ProviderHealth & {paused?:boolean}={ready,paused,configFingerprint:fingerprint ?? '',checkedAt:now,...(!ready?{reasonCode:paused?(prior?.reasonCode??'OPERATOR_PAUSE'):!settings.enabled?'AI_DISABLED':!fingerprint?'AI_CONFIGURATION_REQUIRED':!hasSecret||!provider?'AI_SECRET_MISSING':'AI_UNAVAILABLE'}:{})};
    await s.set('lead_control','provider',value);return value;
  });
  if(!health.ready) return {processed:0,reasonCode:health.reasonCode};
  const lease=randomUUID();
  const acquired=await store.atomic(async s=>{
    const current=await s.get<{leaseToken?:string;leaseUntil?:number}>('lead_control','worker');
    if((current?.leaseUntil??0)>Math.max(now,Date.now())) return false;
    await s.set('lead_control','worker',{leaseToken:lease,leaseUntil:Date.now()+WORKER_LEASE_MS,updatedAt:new Date(Math.max(now,Date.now())).toISOString()});return true;
  });
  if(!acquired) return {processed:0,reasonCode:'WORKER_BUSY'};
  let processed=0,qualifications=0;const perApp=new Map<string,number>();
  try {
    const access=(await import('./reddit.js')).redditAccess(env);
    const inviteIds=access.allAccounts?null:[...access.allowed];
    if(!env.LEADS_ENABLED || env.LEADS_ENABLED!=='true') return {processed:0,reasonCode:'LEADS_DISABLED'};
    const reconciliation=await (await import('./leads-candidates.js')).reconcileLeadCandidates(store,inviteIds,now,20);
    await reconcileUncertainLeadJobs(store,Math.max(now,Date.now()));
    const scan=await store.get<{nextAttemptAt?:number;createdAt?:string;id?:string}>('lead_control','jobs-scan');
    const buildJobsQuery=(kind?:LeadJob['kind'])=>{
      let q=store.collection('lead_jobs').where('state','==','pending').where('nextAttemptAt','<=',now);
      if(kind) q=q.where('kind','==',kind);
      return q.orderBy('nextAttemptAt','asc').orderBy('createdAt','asc').orderBy(FieldPath.documentId(),'asc');
    };
    let query=buildJobsQuery();
    if(scan?.nextAttemptAt!==undefined&&scan.createdAt&&scan.id) query=query.startAfter(scan.nextAttemptAt,scan.createdAt,scan.id);
    let jobs=await store.query<LeadJob>(buildJobsQuery('draft').limit(CALL_LIMIT));
    if(!jobs.length) jobs=await store.query<LeadJob>(buildJobsQuery('reply').limit(CALL_LIMIT));
    let scanningDrafts=jobs.length>0;
    if(!jobs.length) jobs=await store.query<LeadJob>(query.limit(1000));
    if(!jobs.length&&scan?.createdAt) jobs=await store.query<LeadJob>(buildJobsQuery().limit(1000));
    let scanned:LeadJob|undefined;const deadline=Date.now()+WORKER_TICK_MS;
    for(const job of jobs) {
      scanned=job;
      if(processed>=CALL_LIMIT || Date.now()>=deadline) break;
      const dispatchNow=Math.max(now,Date.now());
      if(job.expireAt.toMillis()<=dispatchNow) {await store.set('lead_jobs',job.id,{state:'cancelled',reasonCode:'EXPIRED',updatedAt:new Date(dispatchNow).toISOString()},true);continue;}
      if(!leadsEnabledFor(job.user_id,env)) continue;
      if(job.kind==='qualify') {
        if(qualifications>=CALL_LIMIT || (perApp.get(job.app_id)??0)>=PER_APP_LIMIT) continue;
        perApp.set(job.app_id,(perApp.get(job.app_id)??0)+1);qualifications++;
      }
      const ownsLease=await store.atomic(async s=>{const current=await s.get<{leaseToken?:string}>('lead_control','worker');if(current?.leaseToken!==lease||Date.now()>=deadline)return false;await s.set('lead_control','worker',{leaseToken:lease,leaseUntil:Date.now()+discoveryLease(job.kind),updatedAt:new Date(Math.max(now,Date.now())).toISOString()});return true;});
      if(!ownsLease) break;
      const healthBefore=await store.get<ProviderHealth & {paused?:boolean}>('lead_control','provider');if(healthBefore?.paused) break;
      if(await executeLeadJob(store,provider!,job,env,Math.max(now,Date.now()))) processed++;
    }
    if(scanned&&!scanningDrafts) await store.set('lead_control','jobs-scan',{nextAttemptAt:scanned.nextAttemptAt,createdAt:scanned.createdAt,id:scanned.id,updatedAt:new Date(now).toISOString()});
    return {processed,queued:reconciliation.queued,partial:reconciliation.partial,reasonCode:null};
  } finally {
    await store.atomic(async s=>{const current=await s.get<{leaseToken?:string}>('lead_control','worker');if(current?.leaseToken===lease) await s.set('lead_control','worker',{leaseToken:'',leaseUntil:0});});
  }
}

/** Cloud Tasks fast path for a single queued onboarding draft; scheduled recovery handles stragglers. */
export async function processLeadDraftJob(store:Store,jobId:string,provider:LeadAIProvider|undefined,env:NodeJS.ProcessEnv=process.env,now=Date.now()) {
  return processSingleLeadJob(store,jobId,'draft',provider,env,now);
}

/** Immediate qualification uses the same leases, reservations and daily caps as scheduled recovery. */
export async function processLeadQualificationJob(store:Store,jobId:string,provider:LeadAIProvider|undefined,env:NodeJS.ProcessEnv=process.env,now=Date.now()) {
  return processSingleLeadJob(store,jobId,'qualify',provider,env,now);
}

export async function queueLeadDiscovery(store:Store,scanId:string,profile:LeadProfile,now=Date.now(),context?:import('./leads-types.js').LeadDiscoveryContext) {
  const id=context?documentKey(scanId,'historical-discovery-v2',String(context.round)):documentKey(scanId,'historical-discovery-v1');
  await store.atomic(async s=>{
    const [existing,current,app]=await Promise.all([s.get('lead_jobs',id),s.get<LeadProfile>('lead_profiles',documentKey(profile.user_id,profile.app_id)),s.getApp(profile.app_id,profile.user_id)]);
    if(existing||!app||!current?.enabled||current.revision!==profile.revision||!await hasMarketingAccess(s,profile.user_id,profile.app_id,process.env,now)) return;
    const job:LeadJob={id,user_id:profile.user_id,app_id:profile.app_id,kind:'discover',inputHash:contentHash(JSON.stringify([profile.revision,profile.problems,profile.capabilities,profile.communities])),
      ...(context?{discoveryContext:context}:{}),profileRevision:profile.revision,state:'pending',nextAttemptAt:now,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),expireAt:Timestamp.fromMillis(now+DAY)};
    await s.set('lead_jobs',id,job);
  });
  return id;
}
export async function processLeadDiscoveryJob(store:Store,jobId:string,provider:LeadAIProvider|undefined,env:NodeJS.ProcessEnv=process.env,now=Date.now()) {
  return processSingleLeadJob(store,jobId,'discover',provider,env,now);
}

async function processSingleLeadJob(store:Store,jobId:string,kind:LeadJob['kind'],provider:LeadAIProvider|undefined,env:NodeJS.ProcessEnv,now:number) {
  const settings=leadAISettings(env),fingerprint=publicAIConfigFingerprint(env),hasSecret=!!env.OPENAI_API_KEY?.trim();
  const health=await store.atomic(async s=>{
    const prior=await s.get<ProviderHealth & {paused?:boolean}>('lead_control','provider');
    const paused=prior?.paused===true,configured=settings.enabled&&settings.configured&&hasSecret&&!!provider&&!!fingerprint,ready=configured&&!paused;
    const value:ProviderHealth & {paused?:boolean}={ready,paused,configFingerprint:fingerprint??'',checkedAt:now,...(!ready?{reasonCode:paused?(prior?.reasonCode??'OPERATOR_PAUSE'):!settings.enabled?'AI_DISABLED':!fingerprint?'AI_CONFIGURATION_REQUIRED':!hasSecret||!provider?'AI_SECRET_MISSING':'AI_UNAVAILABLE'}:{})};
    await s.set('lead_control','provider',value);return value;
  });
  if(!health.ready||!provider) return {processed:0,reasonCode:health.reasonCode??'AI_UNAVAILABLE'};
  if(kind==='qualify'||kind==='discover') {
    const job=await store.get<LeadJob>('lead_jobs',jobId),at=Math.max(now,Date.now());
    if(!job||job.kind!==kind||job.state!=='pending'||job.expireAt.toMillis()<=at) return {processed:0,reasonCode:'QUALIFICATION_NOT_PENDING'};
    if(job.nextAttemptAt>at) return {processed:0,reasonCode:'NOT_DUE'};
    if(!leadsEnabledFor(job.user_id,env)) return {processed:0,reasonCode:'LEADS_DISABLED'};
    const ran=await executeLeadJob(store,provider,job,env,at);
    return {processed:ran?1:0,reasonCode:ran?null:'WORKER_BUSY'};
  }
  const id=randomUUID(),at=Math.max(now,Date.now());
  const acquired=await store.atomic(async s=>{
    const [lease,status]=await Promise.all([s.get<{leaseToken?:string;leaseUntil?:number}>('lead_control','worker'),s.get<ProviderHealth & {paused?:boolean}>('lead_control','provider')]);
    if(status?.paused||status?.ready!==true||(lease?.leaseUntil??0)>at) return false;
    await s.set('lead_control','worker',{leaseToken:id,leaseUntil:Date.now()+discoveryLease(kind),updatedAt:new Date(at).toISOString()});return true;
  });
  if(!acquired) return {processed:0,reasonCode:'WORKER_BUSY'};
  try {
    const job=await store.get<LeadJob>('lead_jobs',jobId);
    if(!job||job.kind!==kind||job.state!=='pending'||job.expireAt.toMillis()<=Math.max(now,Date.now())) return {processed:0,reasonCode:kind==='draft'?'DRAFT_NOT_PENDING':'QUALIFICATION_NOT_PENDING'};
    if(job.nextAttemptAt>Math.max(now,Date.now())) return {processed:0,reasonCode:'NOT_DUE'};
    if(!leadsEnabledFor(job.user_id,env)) return {processed:0,reasonCode:'LEADS_DISABLED'};
    await executeLeadJob(store,provider,job,env,Math.max(now,Date.now()));
    return {processed:1,reasonCode:null};
  } finally {
    await store.atomic(async s=>{const current=await s.get<{leaseToken?:string}>('lead_control','worker');if(current?.leaseToken===id) await s.set('lead_control','worker',{leaseToken:'',leaseUntil:0});});
  }
}

export class LeadWorkerBusy extends Error {constructor(){super('LEAD_WORKER_BUSY_RETRY');this.name='LeadWorkerBusy';}}

async function executeLeadJob(store:Store,provider:LeadAIProvider,queued:LeadJob,env:NodeJS.ProcessEnv,now:number) {
  const kind=queued.kind;
  const slot=kind==='qualify'||kind==='discover'?await claimLeadSlot(store,kind,Math.max(now,Date.now())):undefined;
  if((kind==='qualify'||kind==='discover')&&!slot) return false;
  try {await executeClaimedLeadJob(store,provider,queued,env,now);return true;}
  finally {if(slot) await releaseLeadSlot(store,slot);}
}

async function executeClaimedLeadJob(store:Store,provider:LeadAIProvider,queued:LeadJob,env:NodeJS.ProcessEnv,now:number) {
  const settings=leadAISettings(env);if(!settings.configured||!settings.model) return;
  const currentJob=await store.get<LeadJob>('lead_jobs',queued.id);if(!currentJob || currentJob.state!=='pending') return;
  const app=await store.getApp(currentJob.app_id,currentJob.user_id);if(!app) {await store.set('lead_jobs',currentJob.id,{state:'cancelled',reasonCode:'APP_REMOVED',updatedAt:new Date(now).toISOString()},true);return;}
  let profile:LeadProfile|undefined,post:StoredRedditPost|undefined;
  if(currentJob.kind==='discover') {
    profile=await store.get<LeadProfile>('lead_profiles',documentKey(currentJob.user_id,currentJob.app_id));
    if(!profile?.enabled||profile.revision!==currentJob.profileRevision||!provider.discoverThreads) {await store.set('lead_jobs',currentJob.id,{state:'cancelled',reasonCode:'DISCOVERY_UNAVAILABLE',updatedAt:new Date(now).toISOString()},true);return;}
  }
  if((currentJob.kind==='qualify'||currentJob.kind==='reply')) {
    profile=await store.get<LeadProfile>('lead_profiles',documentKey(currentJob.user_id,currentJob.app_id));
    post=currentJob.postId?await store.get<StoredRedditPost>('reddit_posts',currentJob.postId):undefined;
    if(!profile?.enabled||profile.revision!==currentJob.profileRevision||!post||post.expireAt.toMillis()<=now||leadContentHash(post)!==currentJob.postContentHash||!prefilterLeadCandidate(post,profile,now,currentJob.historical===true||currentJob.kind==='reply')||(currentJob.kind==='reply'&&!provider.draftReplies)) {
      await store.set('lead_jobs',currentJob.id,{state:'cancelled',reasonCode:'STALE_CANDIDATE',updatedAt:new Date(now).toISOString()},true);return;
    }
  }
  const promptBytes=currentJob.kind==='draft'
    ? Buffer.byteLength(currentJob.sourceDescription??'')+Buffer.byteLength(app.name)+18000
    : Buffer.byteLength(JSON.stringify({post:post&&{title:post.title,body:post.body.slice(0,4000)},profile:profile&&{problems:profile.problems,capabilities:profile.capabilities},discovery:currentJob.discoveryContext}))+18000;
  const discovery=currentJob.kind==='discover',outputLimit=discovery?MAX_DISCOVERY_OUTPUT:currentJob.kind==='reply'?MAX_REPLY_OUTPUT:MAX_OUTPUT_TOKENS;
  const searchCallLimit=discoveryLimits(currentJob.discoveryContext).maxToolCalls;
  // Reserve a full search context for each possible reasoning/tool step, plus tool fees.
  const imageTokens=currentJob.kind==='qualify'?normalizedPostImages(post?.images).length*IMAGE_INPUT_TOKEN_ALLOWANCE:0;
  const reservationMicro=maximumCostMicroUsd(promptBytes+(discovery?128000*(searchCallLimit+1):0),settings,outputLimit,imageTokens)+(discovery?searchCallLimit*SEARCH_CALL_MICRO_USD:0);
  if(!Number.isFinite(reservationMicro)||reservationMicro<=0) return;
  const token=randomUUID(),month=monthKey(now),acctHash=hashUser(currentJob.user_id);
  const globalBudgetId=month,accountBudgetId=`${month}-${acctHash}`,reservationId=documentKey(currentJob.id);
  const dailyId=documentKey(currentJob.user_id,dayKey(now));
  const claim=await store.atomic(async s=>{
    const [job,ownedApp,currentProfile,currentPost,accountDeleting,globalBudget,userBudget,reservation,daily,providerHealth,initialScan]=await Promise.all([
      s.get<LeadJob>('lead_jobs',currentJob.id),s.getApp(currentJob.app_id,currentJob.user_id),
      currentJob.kind!=='draft'?s.get<LeadProfile>('lead_profiles',documentKey(currentJob.user_id,currentJob.app_id)):Promise.resolve(undefined),
      (currentJob.kind==='qualify'||currentJob.kind==='reply')&&currentJob.postId?s.get<StoredRedditPost>('reddit_posts',currentJob.postId):Promise.resolve(undefined),
      s.accountDeleting(currentJob.user_id),s.get<Budget>('lead_ai_budgets',globalBudgetId),s.get<Budget>('lead_ai_budgets',accountBudgetId),
      s.get<Reservation>('lead_ai_reservations',reservationId),s.get<DailyUsage>('lead_daily_usage',dailyId),s.get<ProviderHealth & {paused?:boolean}>('lead_control','provider'),
      currentJob.kind==='qualify'?s.get<InitialLeadScan>('lead_scans',documentKey(currentJob.user_id,currentJob.app_id,String(currentJob.profileRevision),'initial-scan')):Promise.resolve(undefined),
    ]);
    if(!job||job.state!=='pending') return {ok:false as const};
    if(providerHealth?.paused||providerHealth?.ready!==true) return {ok:false as const};
    if(!leadsEnabledFor(job.user_id,env)||!settings.enabled||!settings.configured) {await s.set('lead_jobs',job.id,{state:'cancelled',reasonCode:'GATE_DISABLED',updatedAt:new Date(now).toISOString()},true);return {ok:false as const};}
    if(job.kind!=='draft'&&!await hasMarketingAccess(s,job.user_id,job.app_id,env,now)) {await s.set('lead_jobs',job.id,{state:'cancelled',reasonCode:'MARKETING_SUBSCRIPTION_REQUIRED',updatedAt:new Date(now).toISOString()},true);return {ok:false as const};}
    if(accountDeleting||!ownedApp) {await s.set('lead_jobs',job.id,{state:'cancelled',reasonCode:'APP_REMOVED',updatedAt:new Date(now).toISOString()},true);return {ok:false as const};}
    if((job.kind==='qualify'||job.kind==='reply')&&(!currentProfile?.enabled||currentProfile.revision!==job.profileRevision||!currentPost||currentPost.expireAt.toMillis()<=now||leadContentHash(currentPost)!==job.postContentHash)) {
      await s.set('lead_jobs',job.id,{state:'cancelled',reasonCode:'STALE_CANDIDATE',updatedAt:new Date(now).toISOString()},true);return {ok:false as const};
    }
    if(job.kind==='discover'&&(!currentProfile?.enabled||currentProfile.revision!==job.profileRevision)) {await s.set('lead_jobs',job.id,{state:'cancelled',reasonCode:'STALE_PROFILE',updatedAt:new Date(now).toISOString()},true);return {ok:false as const};}
    if(reservation) {await s.set('lead_jobs',job.id,{state:'uncertain',reasonCode:'PRIOR_RESERVATION',updatedAt:new Date(now).toISOString()},true);return {ok:false as const};}
    // An audited, date/account/app-scoped operator allowance supports an owner-
    // requested historical rerun without resetting usage or lifting cost caps.
    const allowance=daily?.operatorHistoricalAllowance;
    // Only source posts from this app/revision's durable setup scan are exempt.
    // Monitoring and arbitrary historical reruns retain their daily allowance.
    const onboarding=job.kind==='qualify'&&initialScan?.mode==='historical'
      &&initialScan.user_id===job.user_id&&initialScan.app_id===job.app_id&&initialScan.profileRevision===job.profileRevision
      &&initialScan.state!=='cancelled'&&[...(initialScan.fetchedPostIds??[]),...(initialScan.allFetchedPostIds??[])].includes(job.postId??'');
    const extra=job.kind==='qualify'&&!onboarding&&(daily?.qualify??0)>=300;
    const allowedExtra=job.historical===true&&allowance?.appId===job.app_id&&Number.isSafeInteger(allowance.limit)&&Number.isSafeInteger(allowance.used)&&allowance.used>=0&&allowance.used<Math.min(60,allowance.limit);
    if(extra&&!allowedExtra) {const next=Date.parse(`${dayKey(now)}T00:00:00.000Z`)+DAY;await s.set('lead_jobs',job.id,{state:'pending',reasonCode:'DAILY_LIMIT',nextAttemptAt:next,updatedAt:new Date(now).toISOString()},true);return {ok:false as const};}
    const global=globalBudget??{reservedMicroUsd:0,spentMicroUsd:0},account=userBudget??{reservedMicroUsd:0,spentMicroUsd:0};
    if(global.spentMicroUsd+global.reservedMicroUsd+reservationMicro>settings.globalCapMicroUsd || account.spentMicroUsd+account.reservedMicroUsd+reservationMicro>settings.accountCapMicroUsd) {
      const [year,monthNum]=month.split('-').map(Number);const next=Date.UTC(year,monthNum,1);await s.set('lead_jobs',job.id,{state:'pending',reasonCode:'BUDGET_PAUSED',nextAttemptAt:next,updatedAt:new Date(now).toISOString()},true);return {ok:false as const};
    }
    const reservationRow:Reservation={month,account_hash:acctHash,app_id:job.app_id,job_id:job.id,reservedMicroUsd:reservationMicro,state:'reserved'};
    await s.set('lead_ai_budgets',globalBudgetId,{reservedMicroUsd:global.reservedMicroUsd+reservationMicro,spentMicroUsd:global.spentMicroUsd});
    await s.set('lead_ai_budgets',accountBudgetId,{account_hash:acctHash,reservedMicroUsd:account.reservedMicroUsd+reservationMicro,spentMicroUsd:account.spentMicroUsd});
    await s.set('lead_ai_reservations',reservationId,reservationRow);
    await s.set('lead_jobs',job.id,{state:'running',reasonCode:'',leaseToken:token,leaseUntil:Date.now()+discoveryLease(job.kind),budgetMonth:month,reservationMicroUsd:reservationMicro,dispatchedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()},true);
    if(job.kind==='qualify') await s.set('lead_daily_usage',dailyId,{...daily,user_id:job.user_id,
      ...(onboarding?{onboardingQualify:(daily?.onboardingQualify??0)+1}:{qualify:(daily?.qualify??0)+1}),
      ...(extra&&allowance?{operatorHistoricalAllowance:{...allowance,used:allowance.used+1}}:{}),expireAt:Timestamp.fromMillis(now+40*DAY)});
    return {ok:true as const,app:ownedApp,profile:currentProfile,post:currentPost,job};
  });
  if(!claim.ok) return;
  try {
    const result=currentJob.kind==='draft'
      ? await provider.draftProfile(currentJob.sourceDescription!,{appName:claim.app.name,appleId:currentJob.source!.appleId,country:currentJob.source!.country})
      : currentJob.kind==='discover'?await provider.discoverThreads!(claim.profile!,claim.app.name,currentJob.discoveryContext)
      : currentJob.kind==='reply'?await provider.draftReplies!({title:claim.post!.title,body:claim.post!.body,subreddit:claim.post!.subreddit},claim.profile!,claim.app.name)
      : await provider.qualifyPost({id:claim.post!.id,subreddit:claim.post!.subreddit,title:claim.post!.title,body:claim.post!.body.slice(0,4000),createdAt:claim.post!.createdAt,...(claim.post!.images?.length?{images:normalizedPostImages(claim.post!.images)}:{})},claim.profile!);
    if(result.model!==settings.model) {await settleUncertain(store,currentJob,token,'MODEL_MISMATCH',true,now);return;}
    if(!Number.isSafeInteger(result.usage.inputTokens)||!Number.isSafeInteger(result.usage.outputTokens)||result.usage.inputTokens<0||result.usage.outputTokens<0||result.usage.outputTokens>outputLimit) throw new Error('MODEL_OR_USAGE_MISMATCH');
    const searches=discovery?result.usage.searchCalls:0;
    if(!Number.isSafeInteger(searches)||searches!<0||searches!>searchCallLimit) throw new Error('SEARCH_USAGE_MISSING');
    const actualMicro=Math.ceil(result.usage.inputTokens*settings.inputPriceCeiling!+result.usage.outputTokens*settings.outputPriceCeiling!)+searches!*SEARCH_CALL_MICRO_USD;
    if(actualMicro>reservationMicro) {await settleUncertain(store,currentJob,token,'COST_CEILING_BREACH',true,now);return;}
    const value=currentJob.kind==='reply'?leadReplyPlanSchema.parse(result.value):currentJob.kind==='discover'?result.value as {urls:string[]}:currentJob.kind==='draft'?validateDraftProposal(result.value as LeadDraftProposal,currentJob.sourceDescription!):
      validateQualifiedEvidence(result.value as any,{title:claim.post!.title,body:claim.post!.body,images:claim.post!.images},claim.profile!);
    await settleSuccess(store,{job:currentJob,token,month,acctHash,reservationMicro,actualMicro,model:result.model,providerRequestId:result.requestId,
      value,app:claim.app,profile:claim.profile,post:claim.post,env,now});
  } catch {
    await settleUncertain(store,currentJob,token,'PROVIDER_UNCERTAIN',false,now);
  }
}

function validateDraftProposal(value:LeadDraftProposal,description:string):LeadDraftProposal {
  const proposals={...value,
    problems:value.problems.map(v=>({text:plain(v.text,240),rationale:plain(v.rationale,240)})),
    capabilities:value.capabilities.map(v=>({text:plain(v.text,240),evidenceQuote:plain(v.evidenceQuote,500),rationale:plain(v.rationale,240)})),
    suggestedCommunities:normalizeSuggestedCommunities(value.suggestedCommunities)};
  if(!proposals.problems.length||!proposals.capabilities.length||proposals.capabilities.some(c=>{
    const capabilityTerms=[...new Set(c.text.toLowerCase().split(/[^a-z0-9]+/).filter(v=>v.length>=4))];
    const quoteTerms=new Set(c.evidenceQuote.toLowerCase().split(/[^a-z0-9]+/).filter(v=>v.length>=4));
    const overlap=capabilityTerms.filter(term=>quoteTerms.has(term)).length;
    return !c.evidenceQuote||!description.includes(c.evidenceQuote)||containsPromptInjection(c.evidenceQuote)||overlap<Math.min(2,capabilityTerms.length);
  })) throw new Error('INVALID_DRAFT_EVIDENCE');
  return proposals;
}
function plain(value:string,max:number) {return value.replace(/[<>`*_#]/g,'').replace(/\s+/g,' ').trim().slice(0,max);}

async function settleSuccess(store:Store,input:{job:LeadJob;token:string;month:string;acctHash:string;reservationMicro:number;actualMicro:number;model:string;providerRequestId?:string;
  value:LeadDraftProposal|LeadReplyPlan|{urls:string[]}|ReturnType<typeof validateQualifiedEvidence>;app:AppRow;profile?:LeadProfile;post?:StoredRedditPost;env:NodeJS.ProcessEnv;now:number}) {
  const reservationId=documentKey(input.job.id),globalId=input.month,accountId=`${input.month}-${input.acctHash}`;
  await store.atomic(async s=>{
    const [job,reservation,globalBudget,accountBudget,app,profile,post,accountDeleting]=await Promise.all([
      s.get<LeadJob>('lead_jobs',input.job.id),s.get<Reservation>('lead_ai_reservations',reservationId),s.get<Budget>('lead_ai_budgets',globalId),
      s.get<Budget>('lead_ai_budgets',accountId),s.getApp(input.job.app_id,input.job.user_id),
      input.job.kind!=='draft'?s.get<LeadProfile>('lead_profiles',documentKey(input.job.user_id,input.job.app_id)):Promise.resolve(undefined),
      (input.job.kind==='qualify'||input.job.kind==='reply')&&input.job.postId?s.get<StoredRedditPost>('reddit_posts',input.job.postId):Promise.resolve(undefined),
      s.accountDeleting(input.job.user_id),
    ]);
    if(!job||job.state!=='running'||job.leaseToken!==input.token||!reservation||reservation.state!=='reserved') return;
    const g=globalBudget??{reservedMicroUsd:input.reservationMicro,spentMicroUsd:0},a=accountBudget??{reservedMicroUsd:input.reservationMicro,spentMicroUsd:0};
    const fresh=(job.kind==='draft'||await hasMarketingAccess(s,input.job.user_id,input.job.app_id,input.env,Math.max(input.now,Date.now())))&&!!app&&!accountDeleting&&(!input.profile||(profile?.enabled&&profile.revision===input.profile.revision&&(input.job.kind==='discover'||(!!post&&post.expireAt.toMillis()>input.now&&leadContentHash(post)===input.job.postContentHash))))&&leadsEnabledFor(input.job.user_id,input.env);
    const charge=Math.min(input.actualMicro,input.reservationMicro);
    const assessment=fresh&&job.kind==='qualify'?createQualificationAssessment({userId:job.user_id,appId:job.app_id,profile:input.profile!,post:input.post!,
      contentHash:job.postContentHash!,result:input.value as ReturnType<typeof validateQualifiedEvidence>,model:input.model,historical:job.historical,now:input.now}):undefined;
    const assessmentId=assessment?documentKey(job.user_id,job.app_id,String(assessment.profileRevision),assessment.postId,job.postContentHash!,LEAD_PROMPT_VERSION,input.model):undefined;
    // Save the notification outbox and assessment together. A crash cannot leave
    // a successful qualification without its push, and retries cannot duplicate it.
    // This performs reads, so it must precede every write in this transaction.
    if(assessment&&assessmentId) await queueLeadReadyNotification(s,assessmentId,Math.max(input.now,Date.now()),assessment);
    await s.set('lead_ai_budgets',globalId,{reservedMicroUsd:Math.max(0,g.reservedMicroUsd-input.reservationMicro),spentMicroUsd:g.spentMicroUsd+charge});
    await s.set('lead_ai_budgets',accountId,{account_hash:input.acctHash,reservedMicroUsd:Math.max(0,a.reservedMicroUsd-input.reservationMicro),spentMicroUsd:a.spentMicroUsd+charge});
    await s.set('lead_ai_reservations',reservationId,{...reservation,state:'settled',settledMicroUsd:charge});
    if(!fresh) {await s.set('lead_jobs',job.id,{state:'cancelled',reasonCode:'OWNER_OR_PROFILE_CHANGED',...(input.providerRequestId?{providerRequestId:input.providerRequestId}:{}),updatedAt:new Date(input.now).toISOString()},true);return;}
    if(job.kind==='draft') {
      const draft=input.value as LeadDraftProposal;const sourceDescription=job.sourceDescription!;
      const row:LeadDraft= {user_id:job.user_id,app_id:job.app_id,status:'succeeded',sourceDescription,sourceHash:contentHash(sourceDescription),source:job.source!,
        problems:draft.problems,capabilities:draft.capabilities,suggestedCommunities:draft.suggestedCommunities,promptVersion:LEAD_PROFILE_PROMPT_VERSION,createdAt:new Date(input.now).toISOString(),expireAt:Timestamp.fromMillis(input.now+DAY)};
      await s.set('lead_drafts',job.id,{...row,modelVersion:input.model,jobId:job.id});
    } else if(job.kind==='qualify') {
      await s.set('lead_assessments',assessmentId!,assessment!);
      const statusId=documentKey(job.user_id,job.app_id);
      await s.set('lead_status',statusId,{user_id:job.user_id,app_id:job.app_id,lastQualifiedAt:new Date(input.now).toISOString(),partial:false,code:'ready'},true);
    }
    const discovery=input.value as import('./leads-types.js').LeadDiscoveryResult;
    await s.set('lead_jobs',job.id,{state:'succeeded',...(job.kind==='reply'?{replyPlan:input.value as LeadReplyPlan}:{}),...(job.kind==='discover'?{discoveryURLs:discovery.urls,...(discovery.trace?{discoveryTrace:discovery.trace}:{})}:{}),...(input.providerRequestId?{providerRequestId:input.providerRequestId}:{}),updatedAt:new Date(input.now).toISOString()},true);
  });
}

async function settleUncertain(store:Store,job:LeadJob,token:string,reasonCode:string,breach:boolean,now:number) {
  const reservationId=documentKey(job.id);
  await store.atomic(async s=>{
    const reservation=await s.get<Reservation>('lead_ai_reservations',reservationId);if(!reservation||reservation.state!=='reserved') return;
    const [globalBudget,accountBudget,current,provider]=await Promise.all([
      s.get<Budget>('lead_ai_budgets',reservation.month),s.get<Budget>('lead_ai_budgets',`${reservation.month}-${reservation.account_hash}`),s.get<LeadJob>('lead_jobs',job.id),s.get<ProviderHealth & {paused?:boolean}>('lead_control','provider'),
    ]);
    const g=globalBudget??{reservedMicroUsd:reservation.reservedMicroUsd,spentMicroUsd:0},a=accountBudget??{reservedMicroUsd:reservation.reservedMicroUsd,spentMicroUsd:0};
    await s.set('lead_ai_budgets',reservation.month,{reservedMicroUsd:Math.max(0,g.reservedMicroUsd-reservation.reservedMicroUsd),spentMicroUsd:g.spentMicroUsd+reservation.reservedMicroUsd});
    await s.set('lead_ai_budgets',`${reservation.month}-${reservation.account_hash}`,{account_hash:reservation.account_hash,reservedMicroUsd:Math.max(0,a.reservedMicroUsd-reservation.reservedMicroUsd),spentMicroUsd:a.spentMicroUsd+reservation.reservedMicroUsd});
    await s.set('lead_ai_reservations',reservationId,{...reservation,state:'uncertain',settledMicroUsd:reservation.reservedMicroUsd});
    if(current?.leaseToken===token) await s.set('lead_jobs',job.id,{state:'uncertain',reasonCode,updatedAt:new Date(now).toISOString()},true);
    if(breach) await s.set('lead_control','provider',{...provider,ready:false,paused:true,reasonCode,checkedAt:now,configFingerprint:publicAIConfigFingerprint()??''});
  });
}

/** Recover interrupted charged calls conservatively; it never retries them. */
export async function reconcileUncertainLeadJobs(store:Store,now=Date.now()) {
  const running=await store.query<LeadJob>(store.collection('lead_jobs').where('state','==','running').where('leaseUntil','<=',now).limit(100));
  for(const job of running) await settleUncertain(store,job,job.leaseToken??'','WORKER_INTERRUPTED',false,now);
  return running.length;
}

/** Fence work and conservatively settle any outstanding provider reservation before data purge. */
async function settleLeadReservationForDeletion(store:Store,reservationId:string,jobId:string|undefined,options:{stripApp?:boolean;stripAccount?:boolean;reason:string;now?:number}) {
  const now=options.now??Date.now();
  await store.atomic(async s=>{
    const [reservation,job]=await Promise.all([s.get<Reservation>('lead_ai_reservations',reservationId),jobId?s.get<LeadJob>('lead_jobs',jobId):Promise.resolve(undefined)]);
    const budgets=reservation?await Promise.all([
      s.get<Budget>('lead_ai_budgets',reservation.month),s.get<Budget>('lead_ai_budgets',`${reservation.month}-${reservation.account_hash}`)
    ]):[];
    if(reservation?.state==='reserved') {
      const [globalBudget,accountBudget]=budgets as [Budget|undefined,Budget|undefined];
      const global=globalBudget??{reservedMicroUsd:reservation.reservedMicroUsd,spentMicroUsd:0};
      const account=accountBudget??{reservedMicroUsd:reservation.reservedMicroUsd,spentMicroUsd:0};
      await s.set('lead_ai_budgets',reservation.month,{reservedMicroUsd:Math.max(0,global.reservedMicroUsd-reservation.reservedMicroUsd),spentMicroUsd:global.spentMicroUsd+reservation.reservedMicroUsd});
      await s.set('lead_ai_budgets',`${reservation.month}-${reservation.account_hash}`,{account_hash:reservation.account_hash,
        reservedMicroUsd:Math.max(0,account.reservedMicroUsd-reservation.reservedMicroUsd),spentMicroUsd:account.spentMicroUsd+reservation.reservedMicroUsd});
    }
    if(reservation) {
      const next:Record<string,unknown>={...reservation,...(reservation.state==='reserved'?{state:'uncertain',settledMicroUsd:reservation.reservedMicroUsd}: {})};
      if(options.stripApp) {delete next.app_id;delete next.job_id;}
      if(options.stripAccount) {delete next.account_hash;}
      await s.set('lead_ai_reservations',reservationId,next);
    }
    if(job&&(job.state==='pending'||job.state==='running')) await s.set('lead_jobs',job.id,{state:'cancelled',reasonCode:options.reason,updatedAt:new Date(now).toISOString()},true);
  });
}

export async function purgeLeadAppData(store:Store,appId:string,now=Date.now()) {
  let after:string|undefined;
  for(;;) {
    let query=store.collection('lead_jobs').where('app_id','==',appId).orderBy(FieldPath.documentId());
    if(after) query=query.startAfter(after);
    const page=await query.limit(400).get();if(page.empty) break;
    for(const doc of page.docs) await settleLeadReservationForDeletion(store,documentKey(doc.id),doc.id,{reason:'APP_REMOVED',now});
    after=page.docs.at(-1)!.id;
  }
  after=undefined;
  for(;;) {
    let query=store.collection('lead_ai_reservations').where('app_id','==',appId).orderBy(FieldPath.documentId());
    if(after) query=query.startAfter(after);
    const page=await query.limit(400).get();if(page.empty) break;
    for(const doc of page.docs) await settleLeadReservationForDeletion(store,doc.id,doc.data().job_id,{stripApp:true,reason:'APP_REMOVED',now});
    after=page.docs.at(-1)!.id;
  }
}

/** Called by account cleanup after app cleanup; strip account linkage only after every reserve is spent. */
export async function purgeLeadAccountAccounting(store:Store,userId:string,now=Date.now()) {
  const acctHash=hashUser(userId);let after:string|undefined;
  for(;;) {
    let query=store.collection('lead_jobs').where('user_id','==',userId).orderBy(FieldPath.documentId());
    if(after) query=query.startAfter(after);
    const page=await query.limit(400).get();if(page.empty) break;
    for(const doc of page.docs) await settleLeadReservationForDeletion(store,documentKey(doc.id),doc.id,{reason:'ACCOUNT_DELETED',now});
    after=page.docs.at(-1)!.id;
  }
  after=undefined;
  for(;;) {
    let query=store.collection('lead_ai_reservations').where('account_hash','==',acctHash).orderBy(FieldPath.documentId());
    if(after) query=query.startAfter(after);
    const page=await query.limit(400).get();if(page.empty) break;
    for(const doc of page.docs) await settleLeadReservationForDeletion(store,doc.id,doc.data().job_id,{stripApp:true,stripAccount:true,reason:'ACCOUNT_DELETED',now});
    after=page.docs.at(-1)!.id;
  }
  for(;;) {
    const page=await store.collection('lead_ai_budgets').where('account_hash','==',acctHash).limit(400).get();
    if(page.empty) break;const batch=store.db.batch();for(const doc of page.docs) batch.delete(doc.ref);await batch.commit();
  }
}

export async function queueRecentProfileCandidates(store:Store,userId:string,appId:string,profile:LeadProfile,now=Date.now()) {
  if(!await hasMarketingAccess(store,userId,appId,process.env,now)) return 0;
  const collector=await store.get<{lastCompletedAt?:string}>('reddit_control','collector'),collectionAt=collector?.lastCompletedAt??'never';
  const status=await store.get<{candidateScanRevision?:number;candidateScanCollectionAt?:string;candidateScanVersion?:string}>('lead_status',documentKey(userId,appId));
  if(status?.candidateScanRevision===profile.revision&&status.candidateScanCollectionAt===collectionAt&&status.candidateScanVersion===LEAD_QUALIFICATION_VERSION) return 0;
  const queued=await enqueueLeadCandidates(store,userId,appId,profile,{hours:24,communityLimit:30,now});
  await store.atomic(async s=>{
    const [fresh,current]=await Promise.all([s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),s.get<Record<string,unknown>>('lead_status',documentKey(userId,appId))]);
    const previous=typeof current?.candidateScanCollectionAt==='string'?current.candidateScanCollectionAt:undefined;
    const older=previous!==undefined&&previous!=='never'&&(collectionAt==='never'||(Number.isFinite(Date.parse(previous))&&Number.isFinite(Date.parse(collectionAt))&&Date.parse(collectionAt)<Date.parse(previous)));
    if(fresh?.enabled&&fresh.revision===profile.revision&&!(current?.candidateScanRevision===profile.revision&&older)) await s.set('lead_status',documentKey(userId,appId),{
      ...current,user_id:userId,app_id:appId,candidateScanRevision:profile.revision,candidateScanCollectionAt:collectionAt,candidateScanAt:new Date(now).toISOString(),candidateScanVersion:LEAD_QUALIFICATION_VERSION
    },true);
  });
  return queued;
}
