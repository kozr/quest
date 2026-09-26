import {hasMarketingAccess,requireMarketingAccess} from './marketing-billing.js';
import {researchInputBytes,researchReservation,MarketResearchResponseError,type MarketResearch} from './market-research.js';
import {SEARCH_CALL_MICRO_USD} from './leads-types.js';
import {createHash,randomUUID} from 'node:crypto';
import {Timestamp,FieldPath} from 'firebase-admin/firestore';
import {Store,documentKey,type AppRow} from './database.js';
import {ServiceError} from './firebase.js';
import type {LeadProfile} from './leads-types.js';
import type {MarketAIProvider,MarketAnalysisGroup,MarketObservation,MarketProblemRecord,MarketScanRow,MarketSnapshot,MarketSource} from './market-types.js';
import {aggregateMarketEvidence,makeMarketObservation,resolveCanonicalProblems,validateMarketOutput,MARKET_PROMPT_VERSION} from './market-aggregation.js';
import {actualMarketAICostMicroUsd,estimateMarketInputBytes,MARKET_AI_OUTPUT_TOKENS,marketAISettings,maximumMarketAICostMicroUsd} from './market-ai.js';
import {collectRelevantMarketSources,MARKET_APIFY_MAX_CALL_USD,MARKET_MAX_COMMENTS_PER_THREAD,MARKET_MAX_COMMENT_THREADS,MarketRedditSource,
  MARKET_MAX_SEARCH_POSTS,normalizeMarketRedditRows,selectRelevantMarketThreads} from './market-sources.js';
import {monthlyRedditBudget} from './reddit-collector.js';
import type {ApifyRun} from './reddit-apify.js';
import {redditAccess} from './reddit.js';

const DAY=86400000;const SCAN_RETENTION=30*DAY;const LEASE_MS=470000;const MAX_ANALYSIS_SOURCES=80;
const OPEN_RUNS=new Set(['READY','RUNNING','TIMING-OUT','ABORTING']);
const TERMINAL=new Set(['complete','failed','cancelled']);
type Budget={reserved:number;spent:number};
type AIBudget={reservedMicroUsd:number;spentMicroUsd:number;account_hash?:string};
type RedditReservation={scan_id:string;user_id:string;app_id:string;month:string;phase:'search'|'comments';reservedUsd:number;state:'reserved'|'settled'|'uncertain';dispatched:boolean;settledUsd?:number};
type AIReservation={scan_id:string;user_id:string;app_id:string;account_hash:string;month:string;reservedMicroUsd:number;state:'reserved'|'settled'|'uncertain';settledMicroUsd?:number};
type AppAndProfile={app:AppRow;profile:LeadProfile};

const monthKey=(now:number)=>new Date(now).toISOString().slice(0,7);
const accountHash=(userId:string)=>createHash('sha256').update(userId).digest('hex');
const inputHash=(userId:string,appId:string,revision:number)=>createHash('sha256').update(JSON.stringify([userId,appId,revision,'market-v1'])).digest('hex');
const active=(row:MarketScanRow)=>row.state==='queued'||row.state==='collecting'||row.state==='analyzing';
const failCanRetry=(code:string)=>!['COLLECTION_START_UNCERTAIN','AI_RESULT_UNCERTAIN','AI_MODEL_MISMATCH','AI_COST_LIMIT_BREACH'].includes(code);

export function marketFeatureEnabledFor(userId:string,env:NodeJS.ProcessEnv=process.env) {
  const access=redditAccess(env);
  return env.MARKET_ENABLED==='true'&&access.enabled&&access.allows(userId);
}

function snapshotHeadID(userId:string,appId:string,revision:number) {return documentKey(userId,appId,String(revision));}
function idempotencyID(userId:string,appId:string,key:string) {return documentKey(userId,appId,key);}

export async function queueMarketScan(store:Store,userId:string,appId:string,input:{expectedRevision:number;idempotencyKey:string},env=process.env,now=Date.now()) {
  await requireMarketingAccess(store,userId,appId,env,now);
  if(!marketFeatureEnabledFor(userId,env)) throw new ServiceError(403,'Market insights are not enabled for this account yet.','FEATURE_UNAVAILABLE');
  if(!env.APIFY_TOKEN?.trim()) throw new ServiceError(503,'Market collection is not configured yet.','FEATURE_UNAVAILABLE');
  const ai=marketAISettings(env,false);
  if(!ai.configured||!env.OPENAI_API_KEY?.trim()) throw new ServiceError(503,'Market analysis is not configured yet.','FEATURE_UNAVAILABLE');
  const idKey=idempotencyID(userId,appId,input.idempotencyKey),headKey=snapshotHeadID(userId,appId,input.expectedRevision),stamp=new Date(now).toISOString();
  try {
    return await store.atomic(async s=>{
      const [app,profile,key,head]=await Promise.all([s.getApp(appId,userId),s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),
        s.get<{scanId:string;inputHash:string;expiresAt:number;user_id:string;app_id:string}>('market_scan_keys',idKey),s.get<{activeScanId?:string;latestScanId?:string}>('market_scan_heads',headKey)]);
      await s.assertAccountActive(userId);
      if(!app) throw new ServiceError(404,'App not found.','APP_NOT_FOUND');
      if(!profile||profile.revision!==input.expectedRevision) throw new ServiceError(409,'The app profile changed. Refresh Market and try again.','STALE_PROFILE');
      if(!profile.problems.length||!profile.capabilities.length||!profile.communities.length) throw new ServiceError(409,'Confirm the app problems, capabilities, and communities before scanning.','MISSING_PROFILE');
      const hash=inputHash(userId,appId,input.expectedRevision);
      if(key) {
        if(key.inputHash!==hash||key.expiresAt<=now||key.user_id!==userId||key.app_id!==appId) throw new ServiceError(409,'This scan request key was already used. Start a new scan request.','IDEMPOTENCY_CONFLICT');
        const existing=await s.get<MarketScanRow>('market_scans',key.scanId);if(existing) return existing;
      }
      if(head?.activeScanId) {
        const current=await s.get<MarketScanRow>('market_scans',head.activeScanId);
        if(current&&active(current)&&current.expireAt.toMillis()>now) {
          // Coalesced requests are still idempotent: bind this caller's key to
          // the active scan, so retrying after it finishes cannot buy another run.
          await s.set('market_scan_keys',idKey,{scanId:current.id,inputHash:hash,user_id:userId,app_id:appId,
            expiresAt:now+SCAN_RETENTION,expireAt:Timestamp.fromMillis(now+SCAN_RETENTION)});
          return current;
        }
      }
      const id=randomUUID(),row:MarketScanRow={id,user_id:userId,app_id:appId,profileRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey,
        inputHash:hash,state:'queued',requestedAt:stamp,windowStart:new Date(now-30*DAY).toISOString(),windowEnd:stamp,nextAttemptAt:now,
        researchMode:true,collectionPhase:'analyzing',fence:0,sourceIds:[],observationIds:[],coverage:'partial',canRetry:false,expireAt:Timestamp.fromMillis(now+SCAN_RETENTION),updatedAt:stamp};
      await s.set('market_scans',id,row);
      await s.set('market_scan_keys',idKey,{scanId:id,inputHash:hash,user_id:userId,app_id:appId,expiresAt:now+SCAN_RETENTION,expireAt:Timestamp.fromMillis(now+SCAN_RETENTION)});
      await s.set('market_scan_heads',headKey,{user_id:userId,app_id:appId,profileRevision:input.expectedRevision,activeScanId:id,latestScanId:id,updatedAt:stamp,expireAt:Timestamp.fromMillis(now+SCAN_RETENTION)});
      return row;
    });
  } catch(error) {throw error;}
}

export async function marketScanStatus(store:Store,userId:string,appId:string,scanId:string,now=Date.now()) {
  const row=await store.get<MarketScanRow>('market_scans',scanId);
  if(!row||row.user_id!==userId||row.app_id!==appId||row.expireAt.toMillis()<=now) return undefined;
  return marketScanDTO(row,now);
}

export function marketScanDTO(row:MarketScanRow,now=Date.now()) {
  const next=row.nextAttemptAt>now?new Date(row.nextAttemptAt).toISOString():null;
  return {id:row.id,status:row.state,profileRevision:row.profileRevision,requestedAt:row.requestedAt,startedAt:row.startedAt??null,
    finishedAt:row.finishedAt??null,nextRunAt:active(row)?next:null,retryAfter:active(row)?next:null,
    reasonCode:row.reasonCode??null,canRetry:row.state==='failed'?row.canRetry&&failCanRetry(row.reasonCode??''):false};
}

export interface MarketRunProvider {
  startSearch(input:{communities:string[];keywords:string[];after:string;before:string;maxPosts?:number},maxChargeUsd:number):Promise<ApifyRun>;
  startThreadComments(posts:MarketSource[],options:{maxCommentsPerThread:number},maxChargeUsd:number):Promise<ApifyRun>;
  status(runId:string):Promise<ApifyRun>;
  datasetRows(datasetId:string,maxRows?:number):Promise<unknown[]>;
}

class MarketWorkerPending extends Error {constructor(){super('Market scan remains in progress.');}}

/** Fence a scan and conservatively settle paid work before it can be purged. */
async function settleAndCancelMarketScan(store:Store,scanId:string,reasonCode:string,now:number) {
  return store.atomic(async s=>{
    const [job,ai,collection]=await Promise.all([
      s.get<MarketScanRow>('market_scans',scanId),s.get<AIReservation>('market_ai_reservations',documentKey(scanId,'market-ai')),
      s.query<RedditReservation>(s.collection('market_collection_reservations').where('scan_id','==',scanId))
    ]);
    const actualHeadID=job?snapshotHeadID(job.user_id,job.app_id,job.profileRevision):undefined;
    const actualHead=actualHeadID?await s.get<{activeScanId?:string;latestScanId?:string}>('market_scan_heads',actualHeadID):undefined;
    const redditMonths=[...new Set(collection.filter(item=>item.state==='reserved').map(item=>item.month))];
    const redditBudgets=new Map<string,Budget|undefined>();
    for(const month of redditMonths) redditBudgets.set(month,await s.get<Budget>('reddit_budgets',month));
    let globalAI: AIBudget|undefined,accountAI:AIBudget|undefined;
    if(ai?.state==='reserved') {
      [globalAI,accountAI]=await Promise.all([s.get<AIBudget>('lead_ai_budgets',ai.month),s.get<AIBudget>('lead_ai_budgets',`${ai.month}-${ai.account_hash}`)]);
    }

    for(const reservation of collection) if(reservation.state==='reserved') {
      const budget=redditBudgets.get(reservation.month)??{reserved:reservation.reservedUsd,spent:0};
      const uncertain=job?.collectionDispatched!==false;
      const charge=uncertain?reservation.reservedUsd:0;
      await s.set('reddit_budgets',reservation.month,{reserved:Math.max(0,budget.reserved-reservation.reservedUsd),spent:budget.spent+charge});
      await s.set('market_collection_reservations',documentKey(scanId,reservation.phase),{...reservation,
        state:uncertain?'uncertain':'settled',settledUsd:charge,expireAt:Timestamp.fromMillis(now+SCAN_RETENTION)});
    }
    if(ai?.state==='reserved') {
      const uncertain=job?.aiDispatched!==false,charge=uncertain?ai.reservedMicroUsd:0;
      const g=globalAI??{reservedMicroUsd:ai.reservedMicroUsd,spentMicroUsd:0},a=accountAI??{reservedMicroUsd:ai.reservedMicroUsd,spentMicroUsd:0};
      await s.set('lead_ai_budgets',ai.month,{reservedMicroUsd:Math.max(0,g.reservedMicroUsd-ai.reservedMicroUsd),spentMicroUsd:g.spentMicroUsd+charge});
      await s.set('lead_ai_budgets',`${ai.month}-${ai.account_hash}`,{account_hash:ai.account_hash,
        reservedMicroUsd:Math.max(0,a.reservedMicroUsd-ai.reservedMicroUsd),spentMicroUsd:a.spentMicroUsd+charge});
      await s.set('market_ai_reservations',documentKey(scanId,'market-ai'),{...ai,state:uncertain?'uncertain':'settled',settledMicroUsd:charge,
        expireAt:Timestamp.fromMillis(now+SCAN_RETENTION)});
    }
    if(job&&!TERMINAL.has(job.state)) {
      const cancelled={...job,state:'cancelled' as const,reasonCode,finishedAt:new Date(now).toISOString(),leaseToken:'',leaseUntil:0,
        nextAttemptAt:0,fence:(job.fence??0)+1,canRetry:false,updatedAt:new Date(now).toISOString()};
      await s.set('market_scans',scanId,cancelled);
      if(actualHead?.activeScanId===scanId) await clearActiveHead(s,cancelled,actualHead);
      return cancelled;
    }
    return job;
  });
}

async function claimMarketScan(store:Store,scanId:string,now:number,env=process.env) {
  const result=await store.atomic(async s=>{
    const job=await s.get<MarketScanRow>('market_scans',scanId);if(!job||TERMINAL.has(job.state)) return {job};
    if(job.expireAt.toMillis()<=now) return {job,cleanupReason:'SCAN_EXPIRED'};
    if((job.leaseUntil??0)>now) return {job,busy:true};
    if(job.nextAttemptAt>now) return {job,busy:true};
    const [app,profile,head,deleting]=await Promise.all([s.getApp(job.app_id,job.user_id),s.get<LeadProfile>('lead_profiles',documentKey(job.user_id,job.app_id)),
      s.get<{activeScanId?:string;latestScanId?:string}>('market_scan_heads',snapshotHeadID(job.user_id,job.app_id,job.profileRevision)),s.accountDeleting(job.user_id)]);
    if(!await hasMarketingAccess(s,job.user_id,job.app_id,env,now)) return {job,cleanupReason:'MARKETING_SUBSCRIPTION_REQUIRED'};
    if(!app||!profile||profile.revision!==job.profileRevision||deleting) return {job,cleanupReason:deleting?'ACCOUNT_DELETED':app?'STALE_PROFILE':'APP_REMOVED'};
    const token=randomUUID(),updated={...job,state:job.state==='queued'?(job.researchMode?'analyzing' as const:'collecting' as const):job.state,startedAt:job.startedAt??new Date(now).toISOString(),
      leaseToken:token,leaseUntil:now+LEASE_MS,fence:(job.fence??0)+1,nextAttemptAt:now+5_000,updatedAt:new Date(now).toISOString()};
    await s.set('market_scans',job.id,updated);
    return {job:updated,context:{app,profile},token};
  });
  if(result.cleanupReason) {
    const cancelled=await settleAndCancelMarketScan(store,scanId,result.cleanupReason,now);
    return {job:cancelled,context:null};
  }
  return result;
}

async function clearActiveHead(store:Store,row:MarketScanRow,headRow:{activeScanId?:string;latestScanId?:string}|undefined) {
  const id=snapshotHeadID(row.user_id,row.app_id,row.profileRevision);
  if(headRow?.activeScanId===row.id) await store.set('market_scan_heads',id,{...headRow,activeScanId:null,latestScanId:row.id,updatedAt:row.updatedAt},true);
}

async function reserveCollection(store:Store,row:MarketScanRow,token:string,env:NodeJS.ProcessEnv,now:number) {
  const month=monthKey(now),phase:'search'|'comments'=row.collectionPhase==='comments'?'comments':'search',reservationId=documentKey(row.id,phase),reservation:RedditReservation={scan_id:row.id,user_id:row.user_id,app_id:row.app_id,
    month,phase,reservedUsd:MARKET_APIFY_MAX_CALL_USD,state:'reserved',dispatched:false};
  let reasonCode:string|undefined;
  const ok=await store.atomic(async s=>{
    const [current,budget,existing,app,profile]=await Promise.all([s.get<MarketScanRow>('market_scans',row.id),s.get<Budget>('reddit_budgets',month),
      s.get<RedditReservation>('market_collection_reservations',reservationId),s.getApp(row.app_id,row.user_id),s.get<LeadProfile>('lead_profiles',documentKey(row.user_id,row.app_id))]);
    if(!current||current.leaseToken!==token||!active(current)) return false;
    if(existing) {
      if(existing.state==='reserved'&&existing.dispatched) reasonCode='COLLECTION_START_UNCERTAIN';
      return false;
    }
    if(!await hasMarketingAccess(s,row.user_id,row.app_id,env,now)) {reasonCode='MARKETING_SUBSCRIPTION_REQUIRED';return false;}
    if(!app||!profile||profile.revision!==current.profileRevision||await s.accountDeleting(current.user_id)) {reasonCode='STALE_PROFILE';return false;}
    const currentBudget=budget??{reserved:0,spent:0},cap=monthlyRedditBudget(env);
    if(currentBudget.spent+currentBudget.reserved+reservation.reservedUsd>cap+1e-8) {reasonCode='REDDIT_BUDGET_EXHAUSTED';return false;}
    await s.set('reddit_budgets',month,{...currentBudget,reserved:currentBudget.reserved+reservation.reservedUsd});
    await s.set('market_collection_reservations',reservationId,reservation);
    await s.set('market_scans',current.id,{...current,collectionMonth:month,collectionReservationUsd:reservation.reservedUsd,
      collectionClaim:randomUUID(),collectionDispatched:true,updatedAt:new Date(now).toISOString()},true);
    return true;
  });
  return {ok,reasonCode,reservationId,month,phase};
}

async function settleCollection(store:Store,scanId:string,phase:'search'|'comments',run:ApifyRun|undefined,uncertain:boolean,now:number) {
  const reservationId=documentKey(scanId,phase);
  await store.atomic(async s=>{
    const reservation=await s.get<RedditReservation>('market_collection_reservations',reservationId);if(!reservation||reservation.state!=='reserved') return;
    const budget=await s.get<Budget>('reddit_budgets',reservation.month)??{reserved:reservation.reservedUsd,spent:0};
    // An unknown result retains the full reservation. A known missing usage is
    // also charged in full, matching the established Reddit collector policy.
    const cost=!uncertain&&typeof run?.usageTotalUsd==='number'&&Number.isFinite(run.usageTotalUsd)&&run.usageTotalUsd>=0?run.usageTotalUsd:reservation.reservedUsd;
    await s.set('reddit_budgets',reservation.month,{reserved:Math.max(0,budget.reserved-reservation.reservedUsd),spent:budget.spent+cost});
    await s.set('market_collection_reservations',reservationId,{...reservation,state:uncertain?'uncertain':'settled',settledUsd:cost,
      expireAt:Timestamp.fromMillis(now+SCAN_RETENTION)});
  });
}

async function releaseLease(store:Store,row:MarketScanRow,token:string,now:number,fields:Partial<MarketScanRow>={}) {
  return store.atomic(async s=>{
    const current=await s.get<MarketScanRow>('market_scans',row.id);if(!current||current.leaseToken!==token) return current;
    const updated={...current,...fields,leaseUntil:0,nextAttemptAt:now+5_000,updatedAt:new Date(now).toISOString()};await s.set('market_scans',row.id,updated);return updated;
  });
}

async function terminalize(store:Store,row:MarketScanRow,token:string,state:'failed'|'cancelled',reasonCode:string,now:number,canRetry=state==='failed'&&failCanRetry(reasonCode)) {
  const next=await store.atomic(async s=>{
    const [current,head]=await Promise.all([s.get<MarketScanRow>('market_scans',row.id),
      s.get<{activeScanId?:string;latestScanId?:string}>('market_scan_heads',snapshotHeadID(row.user_id,row.app_id,row.profileRevision))]);
    if(!current||current.leaseToken!==token||TERMINAL.has(current.state)) return current;
    const updated={...current,state,reasonCode,finishedAt:new Date(now).toISOString(),leaseUntil:0,nextAttemptAt:0,canRetry,updatedAt:new Date(now).toISOString()};
    await s.set('market_scans',row.id,updated);await clearActiveHead(s,updated,head);return updated;
  });
  return next;
}

async function applyMarketInvalidations(store:Store,row:MarketScanRow,token:string,ids:MarketSource['id'][],now:number) {
  for(let offset=0;offset<ids.length;offset+=300) {
    const chunk=ids.slice(offset,offset+300);
    const ok=await store.atomic(async s=>{
      const current=await s.get<MarketScanRow>('market_scans',row.id);
      const [app,profile]=await Promise.all([s.getApp(row.app_id,row.user_id),s.get<LeadProfile>('lead_profiles',documentKey(row.user_id,row.app_id))]);
      if(!current||current.leaseToken!==token||!active(current)||!app||!profile||profile.revision!==current.profileRevision||await s.accountDeleting(row.user_id)) return false;
      for(const id of chunk) await s.delete('market_sources',id);
      return true;
    });
    if(!ok) return false;
  }
  return true;
}

async function saveMarketSources(store:Store,row:MarketScanRow,token:string,sources:MarketSource[],invalidations:MarketSource['id'][],phase:'search'|'comments',now:number,coveragePartial=false,invalidationsAlreadyApplied=false) {
  return store.atomic(async s=>{
    const current=await s.get<MarketScanRow>('market_scans',row.id);
    const [app,profile]=await Promise.all([s.getApp(row.app_id,row.user_id),s.get<LeadProfile>('lead_profiles',documentKey(row.user_id,row.app_id))]);
    if(!current||current.leaseToken!==token||!active(current)||!app||!profile||profile.revision!==current.profileRevision||await s.accountDeleting(row.user_id)) return false;
    if(!invalidationsAlreadyApplied) for(const id of invalidations) await s.delete('market_sources',id);
    for(const source of sources) if(source.expireAt.toMillis()>now) await s.set('market_sources',source.id,source);
    const currentIDs=new Set(current.sourceIds??[]);for(const id of invalidations) currentIDs.delete(id);for(const source of sources) currentIDs.add(source.id);
    const updated={...current,sourceIds:[...currentIDs].slice(0,MARKET_MAX_COMMENT_THREADS*(MARKET_MAX_COMMENTS_PER_THREAD+1)+100),
      // Persist the transition with the dataset checkpoint. A crash after this
      // write resumes at analysis instead of attempting a paid comments run.
      collectionPhase:(phase==='comments'?'analyzing':'comments') as NonNullable<MarketScanRow['collectionPhase']>,
      state:(phase==='comments'?'analyzing':current.state) as MarketScanRow['state'],coverage:coveragePartial?'partial' as const:current.coverage,
      collectionTruncated:current.collectionTruncated||coveragePartial,
      runId:null,datasetId:null,collectionDispatched:false,nextAttemptAt:now+5_000,updatedAt:new Date(now).toISOString()};
    await s.set('market_scans',row.id,updated);
    return updated;
  });
}

function keywordMatches(source:MarketSource,keywords:string[]) {
  if(!keywords.length) return true;const text=`${source.title??''}\n${source.text}`.toLowerCase();return keywords.some(keyword=>text.includes(keyword.toLowerCase()));
}
function sourceInWindow(source:MarketSource,profile:LeadProfile,row:MarketScanRow,now:number) {
  const time=Date.parse(source.createdAt);return source.provider==='reddit'&&profile.communities.includes(source.community)&&time>=Date.parse(row.windowStart)&&
    time<=Date.parse(row.windowEnd)&&source.expireAt.toMillis()>now&&(source.kind==='comment'||keywordMatches(source,profile.keywords));
}

async function processCollection(store:Store,row:MarketScanRow,context:AppAndProfile,token:string,provider:MarketRunProvider,env:NodeJS.ProcessEnv,now:number) {
  const phase:'search'|'comments'=row.collectionPhase==='comments'?'comments':'search';
  if(!row.runId) {
    if(phase==='comments') {
      const threads=await selectedMarketThreads(store,row,context.profile,now);
      if(!threads.length) {
        await releaseLease(store,row,token,now,{state:'analyzing',collectionPhase:'analyzing',coverage:row.collectionTruncated?'partial':'complete_for_configured_scan',
          runId:null,datasetId:null,collectionDispatched:false});
        return {continueAI:true};
      }
    }
    if(row.collectionDispatched) {
      await settleCollection(store,row.id,phase,undefined,true,now);
      await terminalize(store,row,token,'failed','COLLECTION_START_UNCERTAIN',now,false);return {done:true};
    }
    const reserve=await reserveCollection(store,row,token,env,now);
    if(!reserve.ok) {
      if(reserve.reasonCode==='COLLECTION_START_UNCERTAIN') {
        await settleCollection(store,row.id,phase,undefined,true,now);await terminalize(store,row,token,'failed','COLLECTION_START_UNCERTAIN',now,false);
      } else if(reserve.reasonCode==='REDDIT_BUDGET_EXHAUSTED') await terminalize(store,row,token,'failed',reserve.reasonCode,now,true);
      else await terminalize(store,row,token,'cancelled',reserve.reasonCode??'STALE_PROFILE',now,false);
      return {done:true};
    }
    try {
      const latest=await store.get<MarketScanRow>('market_scans',row.id);if(!latest||latest.leaseToken!==token||!active(latest)) return {done:true};
      const run=phase==='search'
        ?await provider.startSearch({communities:context.profile.communities,keywords:context.profile.keywords,after:row.windowStart,before:row.windowEnd,maxPosts:100},MARKET_APIFY_MAX_CALL_USD)
        :await provider.startThreadComments(await selectedMarketThreads(store,row,context.profile,now),{maxCommentsPerThread:10},MARKET_APIFY_MAX_CALL_USD);
      await store.atomic(async s=>{
        const [current,reservation]=await Promise.all([s.get<MarketScanRow>('market_scans',row.id),s.get<RedditReservation>('market_collection_reservations',reserve.reservationId)]);
        if(!current||current.leaseToken!==token||!active(current)) return;
        await s.set('market_scans',row.id,{...current,runId:run.id,datasetId:run.defaultDatasetId,collectionDispatched:true,
          leaseUntil:0,nextAttemptAt:now+5_000,updatedAt:new Date(now).toISOString()});
        if(reservation) await s.set('market_collection_reservations',reserve.reservationId,{...reservation,dispatched:true});
      });
      return {pending:true};
    } catch {
      await settleCollection(store,row.id,phase,undefined,true,now);
      if(phase==='comments') {await releaseLease(store,row,token,now,{state:'analyzing',coverage:'partial',runId:null,datasetId:null,collectionDispatched:false,collectionPhase:'analyzing'});return {continueAI:true};}
      await terminalize(store,row,token,'failed','COLLECTION_START_UNCERTAIN',now,false);return {done:true};
    }
  }

  let status:ApifyRun;
  try {status=await provider.status(row.runId);} catch {await releaseLease(store,row,token,now);return {pending:true};}
  if(OPEN_RUNS.has(status.status)) {await releaseLease(store,row,token,now);return {pending:true};}
  if(!['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(status.status)) {await releaseLease(store,row,token,now);return {pending:true};}
  if(status.finishedAt&&now-Date.parse(status.finishedAt)<15_000) {await releaseLease(store,row,token,now);return {pending:true};}
  await settleCollection(store,row.id,phase,status,false,now);
  const partialRun=status.status!=='SUCCEEDED';
  let rows:unknown[];
  try {rows=await provider.datasetRows(status.defaultDatasetId,1500);} catch {
    if(phase==='comments') {await releaseLease(store,row,token,now,{state:'analyzing',coverage:'partial',runId:null,datasetId:null,collectionDispatched:false,collectionPhase:'analyzing'});return {continueAI:true};}
    await terminalize(store,row,token,'failed','SOURCE_DATA_UNAVAILABLE',now,true);return {done:true};
  }
  const fetchedAt=new Date(now).toISOString();
  if(phase==='search') {
    const normalized=normalizeMarketRedditRows(rows,fetchedAt,1500);
    const eligible=normalized.sources.filter(source=>source.kind==='post'&&sourceInWindow(source,context.profile,row,now))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    if(partialRun&&!eligible.length) {
      await terminalize(store,row,token,'failed','SOURCE_RUN_FAILED',now,true);return {done:true};
    }
    const truncated=partialRun||eligible.length>MARKET_MAX_SEARCH_POSTS,fresh=eligible.slice(0,MARKET_MAX_SEARCH_POSTS);
    const invalidationIDs=normalized.invalidations.map(item=>item.sourceId);
    if(!await applyMarketInvalidations(store,row,token,invalidationIDs,now)) {await terminalize(store,row,token,'cancelled','STALE_PROFILE',now,false);return {done:true};}
    const saved=await saveMarketSources(store,row,token,fresh,invalidationIDs,'search',now,truncated,true);
    if(!saved) {await terminalize(store,row,token,'cancelled','STALE_PROFILE',now,false);return {done:true};}
    const updated=await store.get<MarketScanRow>('market_scans',row.id);
    const posts=fresh.filter(source=>source.kind==='post');
    const threads=selectRelevantMarketThreads(posts,context.profile.keywords,Math.min(8,MARKET_MAX_COMMENT_THREADS));
    if(!threads.length) {await releaseLease(store,{...row,...updated,collectionPhase:'analyzing'},token,now,{state:'analyzing',collectionPhase:'analyzing',
      coverage:updated?.collectionTruncated?'partial':'complete_for_configured_scan',runId:null,datasetId:null,collectionDispatched:false});return {continueAI:true};}
    await releaseLease(store,{...row,...updated},token,now,{collectionPhase:'comments',runId:null,datasetId:null,collectionDispatched:false});return {pending:true};
  }
  const posts=await selectedMarketThreads(store,row,context.profile,now);
  const normalized=collectRelevantMarketSources(rows,posts,{keywords:context.profile.keywords,maxThreads:Math.min(8,MARKET_MAX_COMMENT_THREADS),maxCommentsPerThread:10,fetchedAt});
  const fresh=normalized.sources.filter(source=>sourceInWindow(source,context.profile,row,now));
  const saved=await saveMarketSources(store,row,token,fresh,normalized.invalidations.map(item=>item.sourceId),'comments',now,partialRun);
  if(!saved) {await terminalize(store,row,token,'cancelled','STALE_PROFILE',now,false);return {done:true};}
  await releaseLease(store,{...row,collectionPhase:'analyzing'},token,now,{state:'analyzing',collectionPhase:'analyzing',
    coverage:saved.collectionTruncated?'partial':'complete_for_configured_scan',runId:null,datasetId:null,collectionDispatched:false});
  return {continueAI:true};
}

async function selectedMarketThreads(store:Store,row:MarketScanRow,profile:LeadProfile,now:number) {
  const posts:MarketSource[]=[];
  for(const id of row.sourceIds??[]) {const source=await store.get<MarketSource>('market_sources',id);if(source&&source.kind==='post'&&sourceInWindow(source,profile,row,now)) posts.push(source);}
  return selectRelevantMarketThreads(posts,profile.keywords,Math.min(8,MARKET_MAX_COMMENT_THREADS));
}

async function reserveAI(store:Store,row:MarketScanRow,token:string,profile:LeadProfile,appName:string,sources:MarketSource[],env:NodeJS.ProcessEnv,now:number) {
  const settings=marketAISettings(env,false),acctHash=accountHash(row.user_id),month=monthKey(now),id=documentKey(row.id,'market-ai');
  if(!settings.configured||!settings.model||!env.OPENAI_API_KEY?.trim()) return {ok:false as const,reasonCode:'AI_CONFIGURATION_REQUIRED',settings,id};
  const problems=await store.list<MarketProblemRecord>('market_problems',[['user_id','==',row.user_id],['app_id','==',row.app_id]],100);
  const aiInput={appName,profile,existingProblems:problems,sources:sources.slice(0,MAX_ANALYSIS_SOURCES)};
  const inputBytes=row.researchMode?researchInputBytes(aiInput):estimateMarketInputBytes(aiInput),reservationMicro=row.researchMode?researchReservation(inputBytes,settings):maximumMarketAICostMicroUsd(inputBytes,settings);
  if(!Number.isFinite(reservationMicro)||reservationMicro<=0) return {ok:false as const,reasonCode:'AI_CONFIGURATION_REQUIRED',settings,id};
  let reasonCode:string|undefined;
  const ok=await store.atomic(async s=>{
    const [current,prior,global,account,app,freshProfile,providerHealth,accountLimit]=await Promise.all([s.get<MarketScanRow>('market_scans',row.id),s.get<AIReservation>('market_ai_reservations',id),
      s.get<AIBudget>('lead_ai_budgets',month),s.get<AIBudget>('lead_ai_budgets',`${month}-${acctHash}`),s.getApp(row.app_id,row.user_id),s.get<LeadProfile>('lead_profiles',documentKey(row.user_id,row.app_id)),
      s.get<{paused?:boolean;reasonCode?:string}>('lead_control','provider'),s.get<{capMicroUsd?:number}>('market_account_limits',acctHash)]);
    if(!current||current.leaseToken!==token||current.state!=='analyzing'||!app||!freshProfile||freshProfile.revision!==row.profileRevision||await s.accountDeleting(row.user_id)) return false;
    if(!await hasMarketingAccess(s,row.user_id,row.app_id,env,now)) {reasonCode='MARKETING_SUBSCRIPTION_REQUIRED';return false;}
    if(prior) {if(prior.state==='reserved') reasonCode='AI_RESULT_UNCERTAIN';return false;}
    if(providerHealth?.paused) {reasonCode=providerHealth.reasonCode??'AI_PAUSED';return false;}
    const g=global??{reservedMicroUsd:0,spentMicroUsd:0},a=account??{reservedMicroUsd:0,spentMicroUsd:0};
    const override=accountLimit?.capMicroUsd;
    const accountCap=Number.isSafeInteger(override)&&override!>0?Math.min(override!,settings.globalCapMicroUsd):settings.accountCapMicroUsd;
    if(g.reservedMicroUsd+g.spentMicroUsd+reservationMicro>settings.globalCapMicroUsd||a.reservedMicroUsd+a.spentMicroUsd+reservationMicro>accountCap) {reasonCode='AI_BUDGET_EXHAUSTED';return false;}
    await s.set('lead_ai_budgets',month,{reservedMicroUsd:g.reservedMicroUsd+reservationMicro,spentMicroUsd:g.spentMicroUsd});
    await s.set('lead_ai_budgets',`${month}-${acctHash}`,{account_hash:acctHash,reservedMicroUsd:a.reservedMicroUsd+reservationMicro,spentMicroUsd:a.spentMicroUsd});
    const reservation:AIReservation={scan_id:row.id,user_id:row.user_id,app_id:row.app_id,account_hash:acctHash,month,reservedMicroUsd:reservationMicro,state:'reserved'};
    await s.set('market_ai_reservations',id,reservation);
    await s.set('market_scans',row.id,{...current,aiBudgetMonth:month,aiReservationMicroUsd:reservationMicro,aiDispatched:true,updatedAt:new Date(now).toISOString()},true);
    return true;
  });
  return {ok,reasonCode,settings,id,acctHash,month,reservationMicro,problems,inputBytes,aiInput};
}

async function settlementAI(store:Store,row:MarketScanRow,token:string,id:string,actual:number,uncertain:boolean,now:number) {
  return store.atomic(async s=>{
    const reservation=await s.get<AIReservation>('market_ai_reservations',id);if(!reservation||reservation.state!=='reserved') return false;
    const [global,account,job,provider]=await Promise.all([s.get<AIBudget>('lead_ai_budgets',reservation.month),s.get<AIBudget>('lead_ai_budgets',`${reservation.month}-${reservation.account_hash}`),
      s.get<MarketScanRow>('market_scans',row.id),s.get<any>('lead_control','provider')]);
    const g=global??{reservedMicroUsd:reservation.reservedMicroUsd,spentMicroUsd:0},a=account??{reservedMicroUsd:reservation.reservedMicroUsd,spentMicroUsd:0};
    const charge=uncertain?reservation.reservedMicroUsd:actual;
    await s.set('lead_ai_budgets',reservation.month,{reservedMicroUsd:Math.max(0,g.reservedMicroUsd-reservation.reservedMicroUsd),spentMicroUsd:g.spentMicroUsd+charge});
    await s.set('lead_ai_budgets',`${reservation.month}-${reservation.account_hash}`,{account_hash:reservation.account_hash,
      reservedMicroUsd:Math.max(0,a.reservedMicroUsd-reservation.reservedMicroUsd),spentMicroUsd:a.spentMicroUsd+charge});
    await s.set('market_ai_reservations',id,{...reservation,state:uncertain?'uncertain':'settled',settledMicroUsd:charge,
      expireAt:Timestamp.fromMillis(now+SCAN_RETENTION)});
    if(charge>reservation.reservedMicroUsd) await s.set('lead_control','provider',{...provider,ready:false,paused:true,reasonCode:'AI_COST_LIMIT_BREACH',checkedAt:now});
    return true;
  });
}

async function processResearch(store:Store,row:MarketScanRow,context:AppAndProfile,token:string,provider:MarketAIProvider|undefined,env:NodeJS.ProcessEnv,now:number) {
  if(row.aiDispatched) {await settlementAI(store,row,token,documentKey(row.id,'market-ai'),row.aiReservationMicroUsd??0,true,now);await terminalize(store,row,token,'failed','AI_RESULT_UNCERTAIN',now,false);return {done:true};}
  if(!provider?.research) {await terminalize(store,row,token,'failed','AI_CONFIGURATION_REQUIRED',now,true);return {done:true};}
  const reservation=await reserveAI(store,row,token,context.profile,context.app.name,[],env,now);
  if(!reservation.ok) {await terminalize(store,row,token,'failed',reservation.reasonCode??'AI_BUDGET_EXHAUSTED',now,true);return {done:true};}
  let actual=0,received=false;
  try {
    const output=await provider.research(reservation.aiInput);
    received=true;actual=actualMarketAICostMicroUsd(output.inputTokens,output.outputTokens,reservation.settings)+output.searchCalls*SEARCH_CALL_MICRO_USD+(output.detailsCostMicroUsd??0);
    if(output.model!==reservation.settings.model||output.inputBytes!==reservation.inputBytes) throw new Error('Research configuration mismatch.');
    await persistSnapshot(store,row,context,token,[],[],[],'partial',now,reservation.id,actual,false,output.value,env);
    return {done:true};
  } catch(error) {
    if(error instanceof MarketResearchResponseError) {
      received=true;actual=actualMarketAICostMicroUsd(error.usage.inputTokens,error.usage.outputTokens,reservation.settings)+error.usage.searchCalls*SEARCH_CALL_MICRO_USD;
    }
    const code=error instanceof MarketResearchResponseError?error.message:received?'INVALID_AI_OUTPUT':'AI_RESULT_UNCERTAIN';
    console.warn(JSON.stringify({event:'market_research_failed',scanId:row.id,code,diagnostics:error instanceof MarketResearchResponseError?error.diagnostics:undefined,usage:error instanceof MarketResearchResponseError?error.usage:undefined,errorType:error instanceof Error?error.name:'unknown',providerStatus:error instanceof Error&&/^RESEARCH_HTTP_[0-9]{3}$/.test(error.message)?error.message:undefined,usageReceived:received}));
    await settlementAI(store,row,token,reservation.id,received?actual:reservation.reservationMicro,!received,now);
    await terminalize(store,row,token,'failed',code,now,received);return {done:true};
  }
}

async function processAI(store:Store,row:MarketScanRow,context:AppAndProfile,token:string,provider:MarketAIProvider|undefined,env:NodeJS.ProcessEnv,now:number) {
  if(row.researchMode) return processResearch(store,row,context,token,provider,env,now);
  const sources:MarketSource[]=[];
  for(const id of row.sourceIds??[]) {const source=await store.get<MarketSource>('market_sources',id);if(source&&sourceInWindow(source,context.profile,row,now)) sources.push(source);}
  if(!sources.length) return persistSnapshot(store,row,context,token,[],[],[],row.coverage??'complete_for_configured_scan',now,undefined,0,false,undefined,env);
  const selected=sources.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)).slice(0,MAX_ANALYSIS_SOURCES);
  if(row.aiDispatched) {await settlementAI(store,row,token,documentKey(row.id,'market-ai'),row.aiReservationMicroUsd??0,true,now);await terminalize(store,row,token,'failed','AI_RESULT_UNCERTAIN',now,false);return {done:true};}
  if(!provider) {await terminalize(store,row,token,'failed','AI_CONFIGURATION_REQUIRED',now,true);return {done:true};}
  const reservation=await reserveAI(store,row,token,context.profile,context.app.name,selected,env,now);
  if(!reservation.ok) {
    if(reservation.reasonCode==='AI_RESULT_UNCERTAIN') {await settlementAI(store,row,token,reservation.id,row.aiReservationMicroUsd??0,true,now);await terminalize(store,row,token,'failed','AI_RESULT_UNCERTAIN',now,false);}
    else await terminalize(store,row,token,'failed',reservation.reasonCode??'AI_BUDGET_EXHAUSTED',now,true);
    return {done:true};
  }
  let output:Awaited<ReturnType<MarketAIProvider['analyze']>>|undefined;
  let actual=0;
  try {
    output=await provider.analyze(reservation.aiInput);
    actual=actualMarketAICostMicroUsd(output.inputTokens,output.outputTokens,reservation.settings);
    if(output.inputBytes!==reservation.inputBytes) {
      await settlementAI(store,row,token,reservation.id,actual,false,now);await terminalize(store,row,token,'failed','AI_INPUT_MISMATCH',now,false);return {done:true};
    }
    if(output.model!==reservation.settings.model) {
      await settlementAI(store,row,token,reservation.id,actual,false,now);await terminalize(store,row,token,'failed','AI_MODEL_MISMATCH',now,false);return {done:true};
    }
    const value=validateMarketOutput(output.value,selected,context.profile,reservation.problems);
    const freshSources=sources.filter(source=>source.expireAt.toMillis()>now);
    const {rows:problemRows,groupProblemIDs}=resolveCanonicalProblems(value.groups,reservation.problems,row.user_id,row.app_id,now,context.profile);
    const observations:MarketObservation[]=[];
    for(const group of value.groups) {
      const problemId=groupProblemIDs.get(group)!;
      for(const observation of group.observations) {
        const source=selected.find(candidate=>candidate.id===observation.sourceId);if(!source) continue;
        observations.push(makeMarketObservation({userId:row.user_id,appId:row.app_id,revision:row.profileRevision,problemId,source,observation,
          signalKind:group.signalKind,model:output.model,now}));
      }
    }
    const analysisCoverage=row.coverage==='partial'||sources.length>selected.length?'partial':row.coverage??'complete_for_configured_scan';
    await persistSnapshot(store,row,context,token,freshSources,problemRows,observations,analysisCoverage,now,reservation.id,actual,false,undefined,env);
    return {done:true};
  } catch(error) {
    // Provider throws after dispatch are ambiguous and must never be replayed.
    await settlementAI(store,row,token,reservation.id,output?actual:reservation.reservationMicro,!output,now);
    const code=output&&actual>reservation.reservationMicro?'AI_COST_LIMIT_BREACH':output?'INVALID_AI_OUTPUT':'AI_RESULT_UNCERTAIN';
    await terminalize(store,row,token,'failed',code,now,false);return {done:true};
  }
}

async function persistSnapshot(store:Store,row:MarketScanRow,context:AppAndProfile,token:string,sources:MarketSource[],problemRows:MarketProblemRecord[],observations:MarketObservation[],coverage:MarketScanRow['coverage']&{},now:number,
  reservationID?:string,actualCost=0,uncertain=false,research?:MarketResearch,env=process.env) {
  const snapshotId=randomUUID(),headID=snapshotHeadID(row.user_id,row.app_id,row.profileRevision),sourceContentHashes=Object.fromEntries(sources.map(source=>[source.id,source.contentHash]));
  return store.atomic(async s=>{
    const current=await s.get<MarketScanRow>('market_scans',row.id);
    const [app,profile,deleting]=await Promise.all([s.getApp(row.app_id,row.user_id),s.get<LeadProfile>('lead_profiles',documentKey(row.user_id,row.app_id)),s.accountDeleting(row.user_id)]);
    const paidAccess=await hasMarketingAccess(s,row.user_id,row.app_id,env,Math.max(now,Date.now()));
    const existingSourceRows=await Promise.all(sources.map(source=>s.get<MarketSource>('market_sources',source.id)));
    const reservation=reservationID?await s.get<AIReservation>('market_ai_reservations',reservationID):undefined;
    const [global,account,head,providerHealth]=reservation?await Promise.all([s.get<AIBudget>('lead_ai_budgets',reservation.month),
      s.get<AIBudget>('lead_ai_budgets',`${reservation.month}-${reservation.account_hash}`),s.get<any>('market_scan_heads',headID),s.get<any>('lead_control','provider')]):
      [undefined,undefined,await s.get<any>('market_scan_heads',headID),undefined];
    if(reservation?.state==='reserved') {
      const g=global??{reservedMicroUsd:reservation.reservedMicroUsd,spentMicroUsd:0},a=account??{reservedMicroUsd:reservation.reservedMicroUsd,spentMicroUsd:0};
      const charge=uncertain?reservation.reservedMicroUsd:actualCost;
      await s.set('lead_ai_budgets',reservation.month,{reservedMicroUsd:Math.max(0,g.reservedMicroUsd-reservation.reservedMicroUsd),spentMicroUsd:g.spentMicroUsd+charge});
      await s.set('lead_ai_budgets',`${reservation.month}-${reservation.account_hash}`,{account_hash:reservation.account_hash,
        reservedMicroUsd:Math.max(0,a.reservedMicroUsd-reservation.reservedMicroUsd),spentMicroUsd:a.spentMicroUsd+charge});
      await s.set('market_ai_reservations',reservationID!,{...reservation,state:uncertain?'uncertain':'settled',settledMicroUsd:charge,
        expireAt:Timestamp.fromMillis(now+SCAN_RETENTION)});
      if(charge>reservation.reservedMicroUsd) await s.set('lead_control','provider',{...providerHealth,ready:false,paused:true,
        reasonCode:'AI_COST_LIMIT_BREACH',checkedAt:now,configFingerprint:providerHealth?.configFingerprint??''});
    }
    const valid=current&&current.leaseToken===token&&current.state==='analyzing'&&paidAccess&&app&&profile?.revision===row.profileRevision&&!deleting;
    if(!valid) {
      if(current&&current.leaseToken===token&&!TERMINAL.has(current.state)) {
        const reasonCode=deleting?'ACCOUNT_DELETED':!app?'APP_REMOVED':!profile||profile.revision!==row.profileRevision?'STALE_PROFILE':'SCAN_CANCELLED';
        const cancelled={...current,state:'cancelled' as const,reasonCode,finishedAt:new Date(now).toISOString(),leaseToken:'',leaseUntil:0,
          nextAttemptAt:0,fence:(current.fence??0)+1,canRetry:false,updatedAt:new Date(now).toISOString()};
        await s.set('market_scans',row.id,cancelled);await clearActiveHead(s,cancelled,head);
        return {cancelled:true};
      }
      return false;
    }
    if(reservation&&actualCost>reservation.reservedMicroUsd&&!uncertain) {
      const failed={...current,state:'failed' as const,reasonCode:'AI_COST_LIMIT_BREACH',finishedAt:new Date(now).toISOString(),leaseUntil:0,
        nextAttemptAt:0,canRetry:false,updatedAt:new Date(now).toISOString()};
      await s.set('market_scans',row.id,failed);await clearActiveHead(s,failed,head);return {failed:true};
    }
    const currentSources=sources.filter((source,index)=>{
      const stored=existingSourceRows[index];return !!stored&&stored.contentHash===source.contentHash&&stored.expireAt.toMillis()>now;
    });
    const validSourceIDs=new Set(currentSources.map(source=>source.id));
    const validObservations=observations.filter(observation=>validSourceIDs.has(observation.sourceId));
    for(const problem of problemRows) await s.set('market_problems',problem.id,problem);
    for(const observation of validObservations) await s.set('market_observations',observation.id,observation);
    const aggregate=aggregateMarketEvidence({sources:currentSources,observations:validObservations,problemRows,
      userId:row.user_id,appId:row.app_id,revision:row.profileRevision,now});
    const sourceIDs=aggregate.validSources.map(source=>source.id),observationIDs=aggregate.validObservations.map(item=>item.id);
    const snapshot:MarketSnapshot={...(research?{research}:{}),id:snapshotId,user_id:row.user_id,app_id:row.app_id,profileRevision:row.profileRevision,generatedAt:new Date(now).toISOString(),
      windowStart:row.windowStart,windowEnd:row.windowEnd,coverage:coverage??'partial',sourceIds:sourceIDs,
      sourceContentHashes:Object.fromEntries(aggregate.validSources.map(source=>[source.id,source.contentHash])),observationIds:observationIDs,problems:aggregate.problems,
      expireAt:Timestamp.fromMillis(now+SCAN_RETENTION)};
    const {reasonCode:_previousReason,...prior}=current;
    const finished={...prior,state:'complete' as const,finishedAt:new Date(now).toISOString(),snapshotId,coverage:snapshot.coverage,
      sourceIds:sourceIDs,observationIds:observationIDs,leaseUntil:0,nextAttemptAt:0,canRetry:false,updatedAt:new Date(now).toISOString()};
    await s.set('market_snapshots',snapshotId,snapshot);await s.set('market_snapshot_heads',headID,{user_id:row.user_id,app_id:row.app_id,
      profileRevision:row.profileRevision,snapshotId,generatedAt:snapshot.generatedAt,expireAt:snapshot.expireAt});
    await s.set('market_scans',row.id,finished);await s.set('market_scan_heads',headID,{...head,activeScanId:null,latestScanId:row.id,updatedAt:finished.updatedAt},true);
    return {snapshot,overview:aggregate};
  });
}

/** One bounded durable step. A caller can retry this safely; an uncertain paid POST is fenced and settled, never repeated. */
export async function advanceMarketScan(store:Store,scanId:string,source:MarketRunProvider,ai:MarketAIProvider|undefined,env=process.env,now=Date.now()) {
  const claim=await claimMarketScan(store,scanId,now,env);
  if(!claim.job||TERMINAL.has(claim.job.state)) return {state:claim.job?.state??'missing',done:true};
  if('busy' in claim&&claim.busy) return {state:claim.job.state,pending:true};
  if(!claim.context||!claim.token) return {state:claim.job.state,done:true};
  const row=claim.job,context=claim.context,token=claim.token;
  try {
    if(row.state==='analyzing'||row.collectionPhase==='analyzing') return await processAI(store,row,context,token,ai,env,now);
    return await processCollection(store,row,context,token,source,env,now);
  } catch(error) {
    // Validation and local storage errors contain no provider response body; keep the public code generic.
    await terminalize(store,row,token,'failed',error instanceof Error&&error.message==='AI_CONFIGURATION_REQUIRED'?'AI_CONFIGURATION_REQUIRED':'MARKET_SCAN_FAILED',now,true);
    return {state:'failed',done:true};
  }
}

export async function recoverMarketScans(store:Store,now=Date.now(),limit=50) {
  const activeStates=['queued','collecting','analyzing'];
  const [due,expired,openAI,openCollections]=await Promise.all([
    store.query<MarketScanRow>(store.collection('market_scans').where('state','in',activeStates).where('nextAttemptAt','<=',now).orderBy('nextAttemptAt','asc').limit(limit)),
    store.query<MarketScanRow>(store.collection('market_scans').where('state','in',activeStates).where('expireAt','<=',Timestamp.fromMillis(now)).orderBy('expireAt','asc').limit(limit)),
    store.query<AIReservation>(store.collection('market_ai_reservations').where('state','==','reserved').limit(limit*2)),
    store.query<RedditReservation>(store.collection('market_collection_reservations').where('state','==','reserved').limit(limit*2))
  ]);
  const expiredIDs=new Set<string>();
  for(const row of expired) if(row.expireAt.toMillis()<=now) {expiredIDs.add(row.id);await settleAndCancelMarketScan(store,row.id,'SCAN_EXPIRED',now);}
  // Scan TTL may remove an expired job before this schedule runs. Outstanding
  // reservations have no TTL, so reconcile them here and expire them only after settlement.
  const outstandingIDs=new Set([...openAI,...openCollections].map(reservation=>reservation.scan_id));
  for(const id of outstandingIDs) {
    const job=await store.get<MarketScanRow>('market_scans',id);
    if(!job||job.expireAt.toMillis()<=now||TERMINAL.has(job.state))
      await settleAndCancelMarketScan(store,id,!job||job.expireAt.toMillis()<=now?'SCAN_EXPIRED':'ORPHANED_RESERVATION',now);
  }
  return due.filter(row=>row.expireAt.toMillis()>now&&!expiredIDs.has(row.id)).map(row=>row.id).slice(0,limit);
}

async function deleteMarketRows(store:Store,collection:string,field:string,value:string) {
  for(;;) {
    const page=await store.collection(collection).where(field,'==',value).orderBy(FieldPath.documentId()).limit(400).get();
    if(page.empty) return;
    const batch=store.db.batch();for(const doc of page.docs) batch.delete(doc.ref);await batch.commit();
  }
}

async function marketRowsBy<T>(store:Store,collection:string,field:string,value:string) {
  const rows:T[]=[];let after:string|undefined;
  for(;;) {
    let query=store.collection(collection).where(field,'==',value).orderBy(FieldPath.documentId());
    if(after) query=query.startAfter(after);
    const page=await query.limit(400).get();if(page.empty) return rows;
    rows.push(...page.docs.map(doc=>doc.data() as T));after=page.docs.at(-1)!.id;
  }
}

/** Fence running work and settle reservations before removing app-scoped Market data. */
export async function purgeMarketAppData(store:Store,appId:string,now=Date.now()) {
  const scans=await marketRowsBy<MarketScanRow>(store,'market_scans','app_id',appId);
  for(const row of scans) await settleAndCancelMarketScan(store,row.id,'APP_REMOVED',now);
  const [aiReservations,collectionReservations]=await Promise.all([
    marketRowsBy<AIReservation>(store,'market_ai_reservations','app_id',appId),
    marketRowsBy<RedditReservation>(store,'market_collection_reservations','app_id',appId)
  ]);
  const orphanScanIDs=new Set([...aiReservations,...collectionReservations].map(item=>item.scan_id));
  for(const scanId of orphanScanIDs) await settleAndCancelMarketScan(store,scanId,'APP_REMOVED',now);
  for(const collection of ['market_scan_keys','market_scan_heads','market_snapshot_heads','market_scans','market_snapshots','market_problems',
    'market_observations','market_ai_reservations','market_collection_reservations']) await deleteMarketRows(store,collection,'app_id',appId);
}

/** Final account pass also catches orphaned jobs after each owned app has been purged. */
export async function purgeMarketAccountData(store:Store,userId:string,now=Date.now()) {
  const scans=await marketRowsBy<MarketScanRow>(store,'market_scans','user_id',userId);
  const [aiReservations,collectionReservations]=await Promise.all([
    marketRowsBy<AIReservation>(store,'market_ai_reservations','user_id',userId),
    marketRowsBy<RedditReservation>(store,'market_collection_reservations','user_id',userId)
  ]);
  const scanIDs=new Set([...scans.map(row=>row.id),...aiReservations.map(item=>item.scan_id),...collectionReservations.map(item=>item.scan_id)]);
  for(const scanId of scanIDs) await settleAndCancelMarketScan(store,scanId,'ACCOUNT_DELETED',now);
  for(const collection of ['market_scan_keys','market_scan_heads','market_snapshot_heads','market_scans','market_snapshots','market_problems',
    'market_observations','market_ai_reservations','market_collection_reservations']) await deleteMarketRows(store,collection,'user_id',userId);
}

/** Exposed for job fixtures; production injects the runtime adapter from the worker function. */
export function marketSourceAdapter(token:string) {return new MarketRedditSource(token);}
