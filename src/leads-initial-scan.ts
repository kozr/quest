import {hasMarketingAccess,requireMarketingAccess} from './marketing-billing.js';
import {randomUUID} from 'node:crypto';
import {Store,documentKey} from './database.js';
import {ServiceError} from './firebase.js';
import type {LeadProfile,LeadJob,LeadAIProvider,LeadAssessment,LeadDismissal} from './leads-types.js';
import {MAX_DISCOVERY_ROUNDS,LEAD_PROMPT_VERSION} from './leads-types.js';
import {leadsEnabledFor} from './lead-access.js';
import {queueRecentProfileCandidates,queueLeadDiscovery,processLeadDiscoveryJob} from './leads-jobs.js';
import {enqueueHistoricalCandidates,leadContentHash} from './leads-candidates.js';
import type {StoredRedditPost} from './reddit.js';
import {collectReddit} from './reddit-collector.js';
import type {RedditApify} from './reddit-apify.js';
import {queueLeadReadyNotification} from './leads-notifications.js';

export interface InitialLeadScan {
  id:string;user_id:string;app_id:string;profileRevision:number;
  state:'queued'|'collecting'|'complete'|'paused'|'interrupted'|'cancelled';
  requestedAt:number;updatedAt:number;collectionClaim?:string;leaseToken?:string;leaseUntil?:number;
  mode?:'historical';discoveryJobId?:string;searchURLs?:string[];fetchedPostIds?:string[];retrievalSucceeded?:boolean|null;
  discoveryMode?:'progressive';firstMatchAt?:number;notificationQueuedAt?:number;
  // Older multi-round receipts used targetMatches; read it only as a legacy marker.
  targetMatches?:number;maxSearchRounds?:number;searchRound?:number;searchedURLs?:string[];allFetchedPostIds?:string[];previousQueries?:string[];
  discoveryJobIds?:string[];qualifiedCount?:number;stopReason?:'target_reached'|'search_limit'|'provider_failure';
  nextSearchAt?:number;
}
export const initialScanId=(userId:string,appId:string,revision:number)=>documentKey(userId,appId,String(revision),'initial-scan');
const terminal=(scan:InitialLeadScan)=>!['queued','collecting'].includes(scan.state);
interface Collection {
  leaseUntil?:number;
  active?:{claim:string;runId:string|null;startedAt:number;communities:string[]}|null;
  lastCompletedAt?:string;lastCompletedCommunities?:string[];lastFinishedClaim?:string;lastFinishedSucceeded?:boolean;
}

/** The persistent per-revision receipt prevents reopen, concurrent devices and empty results from starting another scan. */
export async function queueInitialLeadScan(store:Store,userId:string,appId:string,revision:number,now=Date.now(),env=process.env) {
  await requireMarketingAccess(store,userId,appId,env,now);
  if(!leadsEnabledFor(userId,env)) throw new ServiceError(403,'Lead discovery is unavailable.','LEADS_DISABLED');
  const id=initialScanId(userId,appId,revision);
  return store.atomic(async s=>{
    const [app,profile,existing]=await Promise.all([s.getApp(appId,userId),s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),s.get<InitialLeadScan>('lead_scans',id)]);
    if(!app) throw new ServiceError(404,'App not found.','APP_NOT_FOUND');
    if(!profile?.enabled) throw new ServiceError(409,'Enable a lead profile before scanning.','PROFILE_DISABLED');
    if(profile.revision!==revision) throw new ServiceError(409,'The profile changed. Refresh the board.','STALE_PROFILE');
    if(existing) return {started:false,scan:existing};
    // Recent monitoring/cache scans do not establish historical-search coverage.
    const scan:InitialLeadScan={id,user_id:userId,app_id:appId,profileRevision:revision,mode:'historical',discoveryMode:'progressive',maxSearchRounds:MAX_DISCOVERY_ROUNDS,searchRound:0,state:'queued',requestedAt:now,updatedAt:now};
    await s.set('lead_scans',id,scan);
    return {started:true,scan};
  });
}

/** One bounded Cloud Task step. Pending collection is retried by the queue, never by a new paid start. */
export async function advanceInitialLeadScan(store:Store,id:string,provider:RedditApify,env=process.env,now=Date.now(),ai?:LeadAIProvider):Promise<boolean> {
  const token=randomUUID();
  const claim=await store.atomic<{done:boolean}|{scan:InitialLeadScan;profile:LeadProfile}>(async s=>{
    const scan=await s.get<InitialLeadScan>('lead_scans',id);
    if(!scan||terminal(scan)) return {done:true as const};
    const [profile,app]=await Promise.all([s.get<LeadProfile>('lead_profiles',documentKey(scan.user_id,scan.app_id)),s.getApp(scan.app_id,scan.user_id)]);
    if(!app||!profile?.enabled||profile.revision!==scan.profileRevision||!leadsEnabledFor(scan.user_id,env)||!await hasMarketingAccess(s,scan.user_id,scan.app_id,env,now)) {
      await s.set('lead_scans',id,{...scan,state:'cancelled',updatedAt:now});return {done:true as const};
    }
    if(now-scan.requestedAt>30*60_000) {await s.set('lead_scans',id,{...scan,state:'interrupted',updatedAt:now});return {done:true as const};}
    if((scan.nextSearchAt??0)>now) return {done:false as const};
    if((scan.leaseUntil??0)>now) return {done:false as const};
    await s.set('lead_scans',id,{...scan,leaseToken:token,leaseUntil:now+240_000,updatedAt:now});
    return {scan,profile};
  });
  if('done' in claim) return claim.done;
  const {scan,profile}=claim;
  const maxSearchRounds=scan.maxSearchRounds??(scan.targetMatches?MAX_DISCOVERY_ROUNDS:1);
  async function patch(fields:Partial<InitialLeadScan>) {
    return store.atomic(async s=>{
      const current=await s.get<InitialLeadScan>('lead_scans',id);
      if(current?.leaseToken!==token||terminal(current)) return false;
      await s.set('lead_scans',id,{...current,...fields,updatedAt:now});return true;
    });
  }
  const update=(state:InitialLeadScan['state'],collectionClaim?:string)=>patch({state,...(collectionClaim?{collectionClaim}:{})});
  async function finishRound(current:InitialLeadScan,at:number) {
    if(!current.maxSearchRounds&&!current.targetMatches) {await update('complete');return true;}
    const fetched=[...new Set([...(current.allFetchedPostIds??[]),...(current.fetchedPostIds??[])])];
    const results=await Promise.all(fetched.map(async postId=>{
      const post=await store.get<StoredRedditPost>('reddit_posts',postId);
      if(!post||post.expireAt.toMillis()<=at) return {qualified:false};
      const hash=leadContentHash(post),key=[scan.user_id,scan.app_id,String(scan.profileRevision),postId,hash,LEAD_PROMPT_VERSION];
      const [job,assessment,dismissal]=await Promise.all([
        store.get<LeadJob>('lead_jobs',documentKey(...key)),
        store.get<LeadAssessment>('lead_assessments',documentKey(...key,env.LEADS_MODEL_ID??'')),
        store.get<LeadDismissal>('lead_dismissals',documentKey(scan.user_id,scan.app_id,postId)),
      ]);
      return {job,assessmentId:documentKey(...key,env.LEADS_MODEL_ID??''),qualified:assessment?.decision==='qualified'&&assessment.expireAt.toMillis()>at&&(!dismissal||dismissal.expireAt.toMillis()<=at)};
    }));
    const qualifiedCount=results.filter(r=>r.qualified).length;
    await patch({allFetchedPostIds:fetched,qualifiedCount});
    for(const result of results) if(result.qualified&&result.assessmentId) await queueLeadReadyNotification(store,result.assessmentId,at);
    const pending=results.flatMap(r=>r.job&&['pending','running'].includes(r.job.state)?[r.job]:[]);
    if(pending.some(j=>['DAILY_LIMIT','BUDGET_PAUSED'].includes(j.reasonCode??''))) {await update('paused');return true;}
    if(pending.length) return false;
    if(results.some(r=>r.job&&['failed','uncertain'].includes(r.job.state))) {await patch({state:'interrupted',stopReason:'provider_failure'});return true;}
    const round=current.searchRound??0;
    if(round+1>=maxSearchRounds) {await patch({state:'complete',stopReason:'search_limit'});return true;}
    // Each round gets its own durable paid-job identity. Never reset or replay a
    // prior search/collection; only clear the current round's collector fields.
    await patch({state:'queued',searchRound:round+1,nextSearchAt:qualifiedCount===0?at+Math.min(5*60_000,30_000*2**round):at,
      discoveryJobId:'',searchURLs:[],fetchedPostIds:[],retrievalSucceeded:null,collectionClaim:''});
    return false;
  }
  try {
    if(scan.mode==='historical') {
      if(typeof scan.retrievalSucceeded==='boolean') {
        if(!scan.retrievalSucceeded) {await update('interrupted');return true;}
        await enqueueHistoricalCandidates(store,profile,scan.fetchedPostIds??[],now);
        return await finishRound(scan,now);
      }
      const context=scan.maxSearchRounds||scan.targetMatches?{round:scan.searchRound??0,totalRounds:maxSearchRounds,excludeURLs:scan.searchedURLs??[],previousQueries:scan.previousQueries??[],
        ...(scan.discoveryMode==='progressive'?{phase:(scan.searchRound??0)===0?'quick' as const:'background' as const}:{})}:undefined;
      const jobId=scan.discoveryJobId||await queueLeadDiscovery(store,id,profile,now,context);
      if(!await patch({discoveryJobId:jobId})) return true;
      const outcome=await processLeadDiscoveryJob(store,jobId,ai,env,now);
      if(outcome.reasonCode&&outcome.reasonCode!=='WORKER_BUSY'&&outcome.reasonCode!=='QUALIFICATION_NOT_PENDING') {await update('paused');return true;}
      const job=await store.get<LeadJob>('lead_jobs',jobId);
      if(!job||['failed','uncertain','cancelled'].includes(job.state)) {await update('interrupted');return true;}
      if(job.state!=='succeeded') {
        if(job.reasonCode==='BUDGET_PAUSED'||job.reasonCode==='DAILY_LIMIT') {await update('paused');return true;}
        return false;
      }
      const current=await store.get<InitialLeadScan>('lead_scans',id);
      if(!current||terminal(current)) return true;
      const previous=new Set(current.searchedURLs??[]);
      const urls=current.searchURLs?.length?current.searchURLs:[...new Set(job.discoveryURLs??[])].filter(url=>!previous.has(url));
      if(!await patch({searchURLs:urls,searchedURLs:[...new Set([...previous,...urls])],
        previousQueries:[...new Set([...(current.previousQueries??[]),...(job.discoveryTrace?.queries??[])])].slice(0,72),
        discoveryJobIds:[...new Set([...(current.discoveryJobIds??[]),jobId])]})) return true;
      if(!urls.length) return await finishRound({...current,fetchedPostIds:[]},now);
      const at=Math.max(now,Date.now());
      const before=await store.get<Collection>('reddit_control','collector');
      if(!before?.active&&(before?.leaseUntil??0)>at) return false;
      await collectReddit(store,provider,env,at,{initialScanId:id});
      const latest=await store.get<InitialLeadScan>('lead_scans',id);
      if(!latest||terminal(latest)) return true;
      if(typeof latest.retrievalSucceeded==='boolean') {
        if(latest.retrievalSucceeded) await enqueueHistoricalCandidates(store,profile,latest.fetchedPostIds??[],at);
        if(!latest.retrievalSucceeded) {await update('interrupted');return true;}
        return await finishRound(latest,at);
      }
      const collection=await store.get<Collection>('reddit_control','collector');
      if(collection?.active) {
        if(collection.active.claim!==latest.collectionClaim) return false;
        if((!collection.active.runId&&at-collection.active.startedAt>120000)||at-collection.active.startedAt>15*60000) {await update('interrupted');return true;}
        return false;
      }
      if(before?.active?.claim&&before.active.claim!==latest.collectionClaim) return false;
      if((collection?.leaseUntil??0)>at) return false;
      if(!latest?.collectionClaim) {await update('paused');return true;}
      return false;
    }
    await queueRecentProfileCandidates(store,scan.user_id,scan.app_id,profile,now);
    let collection=await store.get<Collection>('reddit_control','collector');
    const covered=()=>!!collection?.lastCompletedAt&&Date.parse(collection.lastCompletedAt)>=now-2*60*60_000&&profile.communities.every(c=>collection!.lastCompletedCommunities?.includes(c));
    if(covered()) {await update('complete');return true;}
    if(!collection?.active&&(collection?.leaseUntil??0)>now) return false;
    if(collection?.active) {
      if(!profile.communities.every(c=>collection!.active!.communities.includes(c))) return false;
      if((!collection.active.runId&&now-collection.active.startedAt>120_000)||now-collection.active.startedAt>15*60_000) {await update('interrupted');return true;}
      await update('collecting',collection.active.claim);
    }
    await collectReddit(store,provider,env,now,{initialScanId:id});
    collection=await store.get<Collection>('reddit_control','collector');
    const current=await store.get<InitialLeadScan>('lead_scans',id);
    if(covered()) {
      await queueRecentProfileCandidates(store,scan.user_id,scan.app_id,profile,now);
      await update('complete');return true;
    }
    if(current?.collectionClaim&&collection?.lastFinishedClaim===current.collectionClaim&&!collection.lastFinishedSucceeded) {await update('interrupted');return true;}
    if(collection?.active&&profile.communities.every(c=>collection!.active!.communities.includes(c))) {
      await update('collecting',collection.active.claim);return false;
    }
    // A busy shared collector is retried. A budget/configuration stop is displayed explicitly.
    if(collection?.active) return false;
    await update(current?.collectionClaim?'interrupted':'paused');return true;
  } finally {
    await store.atomic(async s=>{
      const current=await s.get<InitialLeadScan>('lead_scans',id);
      if(current?.leaseToken===token) await s.set('lead_scans',id,{...current,leaseUntil:0,leaseToken:''});
    });
  }
}
