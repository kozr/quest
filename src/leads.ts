import {marketingBillingEnabled,hasMarketingAccess,requireMarketingAccess} from './marketing-billing.js';
import {Router} from 'express';
import {readOnboarding,hasQuestAccess,pinFreeQuest,requireQuestAccess} from './onboarding.js';
import {randomUUID} from 'node:crypto';
import {FieldPath,Timestamp} from 'firebase-admin/firestore';
import {z} from 'zod';
import {Store,documentKey} from './database.js';
import {ServiceError} from './firebase.js';
import {rateLimit,type AuthenticatedRequest} from './auth.js';
import type {LeadProfile,LeadProfileDTO,LeadDraft,LeadAssessment,LeadDismissal,LeadJob} from './leads-types.js';
import {leadDraftInput,leadDismissInput,leadListInput,leadProfileInput} from './leads-types.js';
import type {LeadAIProvider} from './leads-types.js';
import type {lookupAppDescription} from './metadata.js';
import {leadAccess,leadsFeatureReason} from './lead-access.js';
import {leadDraftStatus,queueLeadDraft,queueLeadReply,queueRecentProfileCandidates} from './leads-jobs.js';
import {canonicalRedditURL,leadContentHash} from './leads-candidates.js';
import type {StoredRedditPost,RedditSettings} from './reddit.js';
import {readLeadProgress,type LeadCollectorProgress} from './leads-progress.js';
import {queueInitialLeadScan} from './leads-initial-scan.js';

interface Description {appleId:string;country:string;description:string;appName:string;bundleId:string;fetchedAt:string}
export interface LeadsRouterOptions {
  lookupDescription?:typeof lookupAppDescription;
  provider?:LeadAIProvider;
  /** Description provider is injectable for contract tests; never selected by request parameters. */
  descriptionLookup?:(appleId:string,country:string)=>Promise<Description|null>;
}
const uid=(req:unknown)=>(req as AuthenticatedRequest).user.id;
const appParam=(v:unknown)=>z.string().uuid().parse(v);
const postParam=(v:unknown)=>z.string().regex(/^[a-z0-9]{1,20}$/).parse(v);
function profileDTO(row:LeadProfile):LeadProfileDTO {const {user_id:_user,app_id,...rest}=row;return {...rest,appId:app_id};}
function safeReason(error:unknown):string|undefined {return error instanceof Error&&/^[A-Z_]{2,48}$/.test(error.message)?error.message:undefined;}
function stableRows<T extends {id:string;text:string}>(incoming:Array<{id?:string;text:string}>,prior:Array<T>|undefined):Array<T> {
  return incoming.map(row=>{
    const same=(prior??[]).find(old=>old.text.trim().toLocaleLowerCase()===row.text.trim().toLocaleLowerCase());
    const selected=row.id?(prior??[]).find(old=>old.id===row.id&&old.text.trim().toLocaleLowerCase()===row.text.trim().toLocaleLowerCase()):undefined;
    return {id:selected?.id??same?.id??randomUUID(),text:row.text.trim()} as T;
  });
}
function normalizedProfile(profile:LeadProfile) {
  // Firestore map order and editor display order are not matching criteria.
  return JSON.stringify({enabled:profile.enabled,
    problems:profile.problems.map(({id,text})=>({id,text})).sort((a,b)=>a.id.localeCompare(b.id)),
    capabilities:profile.capabilities.map(({id,text,source,evidenceQuote})=>({id,text,source,evidenceQuote:evidenceQuote??null})).sort((a,b)=>a.id.localeCompare(b.id)),
    communities:[...profile.communities].sort(),keywords:[...profile.keywords].sort(),
    descriptionSource:profile.descriptionSource?{appleId:profile.descriptionSource.appleId,country:profile.descriptionSource.country,contentHash:profile.descriptionSource.contentHash}:null});
}

export function leadsRouter(store:Store,options:LeadsRouterOptions={}) {
  const router=Router();
  const byUser=(scope:string,max:number,window:number)=>rateLimit(store,scope,max,window,req=>uid(req));
  router.get('/leads/access',async(req,res)=>res.json(await leadAccess(store,uid(req))));
  router.use('/apps/:appId/leads',byUser('leads-read',120,60000));
  router.use('/apps/:appId/leads',async(req,_res,next)=>{
    // App/profile preparation is allowed before purchase; research results and actions require coverage.
    if(!['/profile','/draft'].includes(req.path)&&!req.path.startsWith('/drafts/')) await requireMarketingAccess(store,uid(req),appParam(req.params.appId));
    next();
  });
  router.get('/apps/:appId/leads/profile',async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId);await requireAccess(store,userId);await requireApp(store,appId,userId);
    const [profile,legacy,status,limitedJob,collector,provider]=await Promise.all([
      store.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),store.get<RedditSettings>('reddit_settings',userId),
      store.get<any>('lead_status',documentKey(userId,appId)),
      store.query<LeadJob>(store.collection('lead_jobs').where('user_id','==',userId).where('app_id','==',appId).where('state','==','pending').limit(20)),
      store.get<{lastCompletedAt?:string;nextCheckAt?:number}>('reddit_control','collector'),
      store.get<{paused?:boolean}>('lead_control','provider'),
    ]);
    const queuePaused=provider?.paused===true||limitedJob.some(job=>job.reasonCode==='BUDGET_PAUSED'||job.reasonCode==='DAILY_LIMIT');
    res.json({profile:profile?profileDTO(profile):null,
      ...(!profile&&legacy?{legacySuggestions:{communities:legacy.communities,keywords:legacy.keywords}}:{}),
      status:{code:status?.code??(profile?.enabled?'waiting':'needs_profile'),lastCollectedAt:collector?.lastCompletedAt??null,
        lastQualifiedAt:status?.lastQualifiedAt??null,nextCheckAt:Number.isFinite(collector?.nextCheckAt)?new Date(collector!.nextCheckAt!).toISOString():null,partial:status?.partial??false,limited:queuePaused}});
  });
  router.post('/apps/:appId/leads/draft',byUser('leads-draft',13,86400000),async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),{requestId}=leadDraftInput.parse(req.body);
    const access=await leadAccess(store,userId);if(!access.enabled) throw new ServiceError(403,'High-intent leads are not enabled for this account.',access.reasonCode??'LEADS_DISABLED');
    if(!access.aiAvailable) throw new ServiceError(503,'AI-assisted setup is unavailable. Enter problems and capabilities manually.',access.reasonCode??'AI_UNAVAILABLE');
    const app=await requireApp(store,appId,userId);
    let lookup:Description|null;
    try {
      lookup=options.descriptionLookup?await options.descriptionLookup(app.apple_id,'us'):await (options.lookupDescription??(await import('./metadata.js')).lookupAppDescription)(app.apple_id,'us');
    } catch {throw new ServiceError(503,'The App Store description could not be loaded. Enter problems and capabilities manually.','DESCRIPTION_UNAVAILABLE');}
    if(!lookup?.description) {res.json({status:'manual',reasonCode:'DESCRIPTION_UNAVAILABLE'});return;}
    let result;
    try {result=await queueLeadDraft(store,{userId,app,description:lookup.description,country:lookup.country,requestId});}
    catch(error) {
      const code=safeReason(error);
      if(code==='REQUEST_ID_CONFLICT') throw new ServiceError(409,'This setup request ID was already used with different app data.',code);
      if(code==='REQUEST_ID_EXPIRED') throw new ServiceError(409,'This setup request ID expired. Start a new setup request.','REQUEST_ID_EXPIRED');
      if(code==='DAILY_LIMIT') throw new ServiceError(429,'Setup suggestions are limited. Try again tomorrow.',code);
      if(code==='APP_NOT_FOUND') throw new ServiceError(404,'App not found.','APP_NOT_FOUND');
      if(code==='AI_UNAVAILABLE') throw new ServiceError(503,'AI-assisted setup is unavailable. Enter problems and capabilities manually.',code);
      throw error;
    }
    res.status(result.status==='succeeded'?200:202).json({jobId:result.jobId,status:result.status});
  });
  router.get('/apps/:appId/leads/drafts/:jobId',async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),jobId=z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.jobId);
    await requireAccess(store,userId);await requireApp(store,appId,userId);
    const result=await leadDraftStatus(store,userId,appId,jobId);
    if(!result) throw new ServiceError(404,'Setup draft not found.','DRAFT_NOT_FOUND');res.json(result);
  });
  router.put('/apps/:appId/leads/profile',byUser('leads-profile-write',30,60000),async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),input=leadProfileInput.parse(req.body);
    const reason=leadsFeatureReason(userId);if(reason) throw new ServiceError(403,'High-intent leads are not enabled for this account.',reason);
    const now=Date.now(),profile=await store.atomic(async s=>{
      const [app,current,draft]=await Promise.all([s.getApp(appId,userId),s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),
        input.draftId?s.get<LeadDraft>('lead_drafts',input.draftId):Promise.resolve(undefined)]);
      if(!app) throw new ServiceError(404,'App not found.','APP_NOT_FOUND');
      if((current?.revision??0)!==input.expectedRevision) throw new ServiceError(409,'This app profile changed on another device. Reload and review it before saving.','STALE_PROFILE');
      if(input.draftId&&(!draft||draft.user_id!==userId||draft.app_id!==appId||draft.expireAt.toMillis()<=now)) throw new ServiceError(409,'These setup suggestions expired. Create a new draft or continue manually.','STALE_DRAFT');
      const problems=stableRows(input.problems,current?.problems);
      const baseCapabilities=stableRows(input.capabilities,current?.capabilities);
      const capabilities=baseCapabilities.map(cap=>{
        const suggested=draft?.capabilities.find(item=>item.text.trim().toLowerCase()===cap.text.toLowerCase()&&draft.sourceDescription.includes(item.evidenceQuote));
        const prior=current?.capabilities.find(item=>item.id===cap.id&&item.text.trim().toLowerCase()===cap.text.toLowerCase());
        if(suggested) return {...cap,source:'app_store' as const,evidenceQuote:suggested.evidenceQuote};
        if(prior) return {...cap,source:prior.source,...(prior.evidenceQuote?{evidenceQuote:prior.evidenceQuote}:{})};
        return {...cap,source:'user_confirmed' as const};
      });
      const descriptionSource=draft?{appleId:draft.source.appleId,country:draft.source.country,fetchedAt:draft.source.fetchedAt,contentHash:draft.sourceHash}:current?.descriptionSource??null;
      const candidate:LeadProfile={user_id:userId,app_id:appId,schemaVersion:1,revision:current?.revision??1,enabled:input.enabled,problems,capabilities,
        communities:input.communities,keywords:input.keywords,descriptionSource,confirmedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
      const changed=!current||normalizedProfile(candidate)!==normalizedProfile(current);
      const saved={...candidate,revision:current?(current.revision+(changed?1:0)):1,confirmedAt:changed?new Date(now).toISOString():current.confirmedAt};
      await s.set('lead_profiles',documentKey(userId,appId),saved);
      return saved;
    });
    // The scheduled candidate reconciler is the durable recovery path. A
    // transient enqueue failure must not turn a committed save into an API
    // error that encourages an unsafe duplicate retry.
    let candidatesQueued=true;
    if(profile.enabled&&await hasMarketingAccess(store,userId,appId)) try {
      await queueInitialLeadScan(store,userId,appId,profile.revision,now);
      await queueRecentProfileCandidates(store,userId,appId,profile,now);
    } catch {candidatesQueued=false;}
    res.json({profile:profileDTO(profile),candidateScanQueued:candidatesQueued});
  });
  router.post('/apps/:appId/leads/scan',byUser('leads-first-scan',20,60000),async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId);
    const {expectedRevision}=z.object({expectedRevision:z.number().int().positive()}).strict().parse(req.body);
    await requireAccess(store,userId);await requireApp(store,appId,userId);
    const result=await queueInitialLeadScan(store,userId,appId,expectedRevision);
    res.status(result.started?202:200).json({started:result.started,progress:{phase:result.scan.state==='cancelled'?'paused':result.scan.state,
      batchId:result.scan.id,fraction:null,post:null,canStart:false}});
  });
  router.get('/apps/:appId/leads',async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),query=leadListInput.parse(req.query);await requireAccess(store,userId);await requireApp(store,appId,userId);
    const profile=await store.get<LeadProfile>('lead_profiles',documentKey(userId,appId));
    if(!profile?.enabled) {res.json({leads:[],nextCursor:null,status:{code:'needs_profile',partial:false}});return;}
    const onboarding=await readOnboarding(store,userId),locked=!marketingBillingEnabled()&&!hasQuestAccess(onboarding);
    const cursor=!locked&&query.cursor?decodeCursor(query.cursor,appId,profile.revision):undefined;
    let request=store.collection('lead_assessments').where('user_id','==',userId).where('app_id','==',appId)
      .where('profileRevision','==',profile.revision).where('decision','==','qualified')
      .orderBy('postCreatedAt','desc').orderBy(FieldPath.documentId(),'desc');
    if(cursor) request=request.startAfter(cursor.createdAt,cursor.id);
    const snapshot=await request.limit(100).get(),now=Date.now(),leads=[] as Array<Record<string,unknown>>;
    const documents=[...snapshot.docs];
    // Keep the original free quest reachable even after newer results push it off the first page.
    if(locked&&onboarding?.freeQuest?.appId===appId&&!documents.some(doc=>doc.id===onboarding.freeQuest?.assessmentId)) {
      const pinned=await store.collection('lead_assessments').doc(onboarding.freeQuest.assessmentId).get();
      const value=pinned.data() as LeadAssessment|undefined;
      if(pinned.exists&&value?.user_id===userId&&value.app_id===appId&&value.profileRevision===profile.revision&&value.decision==='qualified') documents.push(pinned as typeof documents[number]);
    }
    let lastScanned: {id:string;createdAt:string}|undefined;
    for(const doc of documents) {
      const assessment=doc.data() as LeadAssessment;lastScanned={id:doc.id,createdAt:assessment.postCreatedAt};
      if(assessment.expireAt.toMillis()<=now) continue;
      const [post,dismissal]=await Promise.all([store.get<StoredRedditPost>('reddit_posts',assessment.postId),store.get<LeadDismissal>('lead_dismissals',documentKey(userId,appId,assessment.postId))]);
      if(!post||post.expireAt.toMillis()<=now||assessment.postContentHash!==leadContentHash(post)||!profile.communities.includes(post.subreddit)||dismissal&&dismissal.expireAt.toMillis()>now) continue;
      const url=canonicalRedditURL(post.subreddit,post.id);if(!url) continue;
      const excerpt=(post.body.trim()||post.title).replace(/\s+/g,' ').slice(0,500);
      leads.push({id:doc.id,appId,postId:post.id,community:post.subreddit,title:post.title,excerpt,url,createdAt:post.createdAt,whyItFits:assessment.whyItFits,qualifiedAt:assessment.assessedAt});
      if(!locked&&leads.length>=query.limit) break;
    }
    const freshProfile=await store.get<LeadProfile>('lead_profiles',documentKey(userId,appId));
    if(freshProfile?.revision!==profile.revision) throw new ServiceError(409,'This app profile changed. Refresh leads to use the current criteria.','STALE_PROFILE');
    const nextCursor=lastScanned&&(leads.length>=query.limit||snapshot.size===100)?encodeCursor({appId,revision:profile.revision,...lastScanned}):null;
    const [status,collector,provider,limitedJobs]=await Promise.all([store.get<any>('lead_status',documentKey(userId,appId)),
      store.get<LeadCollectorProgress & {nextCheckAt?:number}>('reddit_control','collector'),store.get<{paused?:boolean}>('lead_control','provider'),
      store.query<LeadJob>(store.collection('lead_jobs').where('user_id','==',userId).where('app_id','==',appId).where('state','==','pending').limit(20))]);
    const budgetLimited=provider?.paused===true;
    const scanComplete=Boolean(status?.candidateScanRevision===profile.revision&&status?.candidateScanAt);
    const progress=await readLeadProgress(store,profile,collector,budgetLimited,Date.now(),scanComplete);
    const finalState=await pinFreeQuest(store,userId,appId,leads);
    const restricted=!marketingBillingEnabled()&&!hasQuestAccess(finalState);
    const free=(lead:Record<string,unknown>)=>lead.postId===finalState?.freeQuest?.postId&&appId===finalState?.freeQuest?.appId;
    const remaining=restricted?leads.filter(lead=>!free(lead)):[];
    const visible=restricted?leads.filter(free):leads;
    res.json({leads:visible,nextCursor:restricted?null:nextCursor,
      locked:restricted?{count:remaining.length,hasMore:snapshot.size===100,previews:remaining.slice(0,2).map(lead=>({id:lead.id,community:lead.community}))}:null,
      status:{code:status?.code??(collector?.lastCompletedAt?'ready':'waiting'),partial:status?.partial??false,
      progress:restricted?{...progress,post:null}:progress,
      limited:budgetLimited||progress.phase==='paused'||snapshot.size===100,lastCollectedAt:collector?.lastCompletedAt??null,lastQualifiedAt:status?.lastQualifiedAt??null,
      nextCheckAt:Number.isFinite(collector?.nextCheckAt)?new Date(collector!.nextCheckAt!).toISOString():null}});
  });
  router.post('/apps/:appId/leads/:postId/replies',byUser('leads-replies',30,60000),async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),postId=postParam(req.params.postId);
    const {expectedRevision}=z.object({expectedRevision:z.number().int().positive()}).strict().parse(req.body);
    const access=await requireAccess(store,userId);await requireApp(store,appId,userId);
    if(!access.aiAvailable) throw new ServiceError(503,'Reply suggestions are currently unavailable. You can still open the original post.','AI_UNAVAILABLE');
    await requireReplyLead(store,userId,appId,postId,expectedRevision);
    try {
      const job=await queueLeadReply(store,userId,appId,postId,expectedRevision);
      res.status(job.state==='succeeded'?200:202).json(replyDTO(job));
    } catch(error) {
      const code=safeReason(error);
      if(code==='DAILY_LIMIT') throw new ServiceError(429,'You have reached today’s reply limit. Try again tomorrow.',code);
      if(code==='STALE_CANDIDATE'||code==='EXPIRED') throw new ServiceError(409,'This quest changed. Refresh the board before trying again.',code);
      if(code==='AI_UNAVAILABLE') throw new ServiceError(503,'Reply suggestions are currently unavailable.',code);
      throw error;
    }
  });
  router.get('/apps/:appId/leads/:postId/replies/:jobId',async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),postId=postParam(req.params.postId);
    const jobId=z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.jobId);
    await requireAccess(store,userId);await requireApp(store,appId,userId);
    const job=await store.get<LeadJob>('lead_jobs',jobId);
    if(!job||job.user_id!==userId||job.app_id!==appId||job.postId!==postId||job.kind!=='reply'||job.expireAt.toMillis()<=Date.now()) throw new ServiceError(404,'Reply suggestions not found.','REPLY_NOT_FOUND');
    const post=await requireReplyLead(store,userId,appId,postId,job.profileRevision!);
    if(leadContentHash(post)!==job.postContentHash) throw new ServiceError(409,'This post changed. Refresh the board before trying again.','STALE_CANDIDATE');
    res.json(replyDTO(job));
  });
  router.put('/apps/:appId/leads/:postId/dismissal',byUser('leads-dismiss',60,60000),async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),postId=postParam(req.params.postId),{mutationId}=leadDismissInput.parse(req.body);
    await requireAccess(store,userId);
    await store.atomic(async s=>{
      const [app,profile,post,dismissal]=await Promise.all([s.getApp(appId,userId),s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),
        s.get<StoredRedditPost>('reddit_posts',postId),s.get<LeadDismissal>('lead_dismissals',documentKey(userId,appId,postId))]);
      if(!app||!profile) throw new ServiceError(404,'App not found.','APP_NOT_FOUND');
      if(!post||post.expireAt.toMillis()<=Date.now()||!profile.enabled) throw new ServiceError(404,'Lead not found.','LEAD_NOT_FOUND');
      if(!profile.communities.includes(post.subreddit)) throw new ServiceError(404,'Lead not found.','LEAD_NOT_FOUND');
      const assessments=await s.query<LeadAssessment>(s.collection('lead_assessments').where('user_id','==',userId).where('app_id','==',appId)
        .where('profileRevision','==',profile.revision).where('postId','==',postId).where('decision','==','qualified').limit(1));
      if(!assessments.some(row=>row.expireAt.toMillis()>Date.now()&&row.postContentHash===leadContentHash(post))) throw new ServiceError(404,'Lead not found.','LEAD_NOT_FOUND');
      if(dismissal&&dismissal.expireAt.toMillis()>Date.now()&&dismissal.mutationId===mutationId) return;
      const row:LeadDismissal={user_id:userId,app_id:appId,post_id:postId,dismissedAt:new Date().toISOString(),mutationId,expireAt:post.expireAt};
      await s.set('lead_dismissals',documentKey(userId,appId,postId),row);
    });
    res.json({ok:true,mutationId});
  });
  router.delete('/apps/:appId/leads/:postId/dismissal',byUser('leads-dismiss',60,60000),async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),postId=postParam(req.params.postId),{mutationId}=leadDismissInput.parse(req.body);
    await requireAccess(store,userId);
    await store.atomic(async s=>{
      const [app,profile,dismissal,post]=await Promise.all([s.getApp(appId,userId),s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),
        s.get<LeadDismissal>('lead_dismissals',documentKey(userId,appId,postId)),s.get<StoredRedditPost>('reddit_posts',postId)]);
      if(!app||!profile||!post||post.expireAt.toMillis()<=Date.now()||!dismissal||dismissal.expireAt.toMillis()<=Date.now()) throw new ServiceError(404,'Dismissal not found.','DISMISSAL_NOT_FOUND');
      if(dismissal.mutationId!==mutationId) throw new ServiceError(409,'This lead was dismissed again on another device. Refresh the feed before undoing.','STALE_UNDO');
      await s.delete('lead_dismissals',documentKey(userId,appId,postId));
    });
    res.json({ok:true});
  });
  return router;
}

async function requireAccess(store:Store,userId:string) {
  const access=await leadAccess(store,userId);if(!access.enabled) throw new ServiceError(403,'High-intent leads are not enabled for this account.',access.reasonCode??'LEADS_DISABLED');return access;
}
function replyDTO(job:LeadJob) {
  return {jobId:job.id,status:job.state,plan:job.state==='succeeded'?job.replyPlan:null,reasonCode:job.reasonCode??null};
}
async function requireReplyLead(store:Store,userId:string,appId:string,postId:string,revision:number) {
  await requireQuestAccess(store,userId,appId,postId);
  const [profile,post,dismissal]=await Promise.all([store.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),
    store.get<StoredRedditPost>('reddit_posts',postId),store.get<LeadDismissal>('lead_dismissals',documentKey(userId,appId,postId))]);
  const now=Date.now();
  if(!profile?.enabled||profile.revision!==revision) throw new ServiceError(409,'The app profile changed. Refresh the quest board.','STALE_PROFILE');
  if(!post||post.expireAt.toMillis()<=now||!profile.communities.includes(post.subreddit)||dismissal&&dismissal.expireAt.toMillis()>now) throw new ServiceError(404,'Quest not found.','LEAD_NOT_FOUND');
  const assessments=await store.query<LeadAssessment>(store.collection('lead_assessments').where('user_id','==',userId).where('app_id','==',appId)
    .where('profileRevision','==',revision).where('postId','==',postId).where('decision','==','qualified').limit(10));
  if(!assessments.some(a=>a.expireAt.toMillis()>now&&a.postContentHash===leadContentHash(post))) throw new ServiceError(404,'Quest not found.','LEAD_NOT_FOUND');
  return post;
}
async function requireApp(store:Store,appId:string,userId:string) {
  const app=await store.getApp(appId,userId);if(!app) throw new ServiceError(404,'App not found.','APP_NOT_FOUND');return app;
}
interface Cursor {appId:string;revision:number;createdAt:string;id:string}
function encodeCursor(value:Cursor) {return Buffer.from(JSON.stringify(value)).toString('base64url');}
function decodeCursor(input:string,appId:string,revision:number):Cursor {
  try {const value=JSON.parse(Buffer.from(input,'base64url').toString('utf8')) as Cursor;
    if(value.appId!==appId||value.revision!==revision||!Number.isFinite(Date.parse(value.createdAt))||!/^[a-f0-9]{64}$/.test(value.id)) throw new Error();return value;
  } catch {throw new ServiceError(409,'This leads page expired after the app profile changed. Refresh the board.','STALE_CURSOR');}
}
