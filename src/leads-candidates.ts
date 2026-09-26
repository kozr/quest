import {hasMarketingAccess} from './marketing-billing.js';
import {createHash,randomUUID} from 'node:crypto';
import {Timestamp,FieldPath} from 'firebase-admin/firestore';
import {Store,documentKey} from './database.js';
import type {LeadAssessment,LeadJob,LeadProfile,LeadImageEvidence} from './leads-types.js';
import {LEAD_QUALIFICATION_VERSION,MAX_FIT_SUMMARY} from './leads-types.js';
import type {InitialLeadScan} from './leads-initial-scan.js';
import type {StoredRedditPost} from './reddit.js';
import {normalizedPostImages,MAX_POST_IMAGES} from './reddit-images.js';

const DAY=86400000;
export function leadContentHash(post:{id:string;subreddit:string;title:string;body:string;createdAt:string;images?:string[]}) {
  const images=normalizedPostImages(post.images);
  // Preserve legacy text-only identities; include the inspected attachments in
  // image-post receipts so a changed photo cannot reuse stale visual evidence.
  return createHash('sha256').update(JSON.stringify([post.id,post.subreddit,post.title,post.body.slice(0,4000),post.createdAt,...(images.length?[images]:[])])).digest('hex');
}
const PROMPT_INJECTION=/(ignore|disregard|override|forget|bypass).{0,50}(previous|prior|above|system|developer|all)\s+(instructions|rules|prompts)|follow the (new|next) instructions|reveal (the )?(system|developer) prompt/i;
export function containsPromptInjection(text:string) {return PROMPT_INJECTION.test(text);}
/** Select material for semantic review, not qualified leads. Community, freshness
 * and existing daily/spend caps bound work; phrasing and keyword overlap must not
 * hide needs such as requests for a checklist or frustration with duplicate buys. */
export function prefilterLeadCandidate(post:{subreddit:string;title:string;body:string;createdAt:string;expireAt?:Timestamp;images?:string[]},profile:Pick<LeadProfile,'communities'|'keywords'|'problems'|'capabilities'|'enabled'>,now=Date.now(),historical=false) {
  if(!profile.enabled || !profile.communities.includes(post.subreddit)) return false;
  const created=Date.parse(post.createdAt);if(!Number.isFinite(created) || created>now+5*60*1000 || (!historical&&now-created>30*DAY)) return false;
  if(post.expireAt && post.expireAt.toMillis()<=now) return false;
  const text=`${post.title}\n${post.body}`.slice(0,4000).trim();
  return (text.length>=12||text.length>0&&normalizedPostImages(post.images).length>0) && !containsPromptInjection(text);
}
export function validateQualifiedEvidence(result:{decision:string;explicitIntent:boolean;intentQuote:string;capabilityIds:string[];fitEvidenceQuotes:string[];whyItFits:string;imageEvidence?:LeadImageEvidence[]},post:{title:string;body:string;images?:string[]},profile:LeadProfile) {
  if(result.decision!=='qualified') return {decision:'rejected' as const,explicitIntent:false,intentQuote:'',capabilityIds:[],sourceEvidenceQuotes:[],whyItFits:''};
  const text=`${post.title}\n${post.body}`.slice(0,4000);
  const caps=new Map(profile.capabilities.map(c=>[c.id,c]));
  const images=normalizedPostImages(post.images),visual=result.imageEvidence??[];
  const invalidVisual=!Array.isArray(visual)||visual.length>MAX_POST_IMAGES||visual.some(e=>!e||!Number.isInteger(e.imageIndex)||e.imageIndex<1||e.imageIndex>images.length||typeof e.observation!=='string'||e.observation.trim().length<3||e.observation.length>500||containsPromptInjection(e.observation));
  const textEvidence=!!result.intentQuote.trim()&&result.fitEvidenceQuotes.length>0;
  if(invalidVisual||!result.explicitIntent || (!textEvidence&&!visual.length) || (result.intentQuote!==''&&!text.includes(result.intentQuote)) ||
     containsPromptInjection(text) || result.capabilityIds.length===0 ||
     result.capabilityIds.some(id=>!caps.has(id)) ||
     result.fitEvidenceQuotes.some(quote=>!quote.trim() || !text.includes(quote))) {
    return {decision:'rejected' as const,explicitIntent:false,intentQuote:'',capabilityIds:[],sourceEvidenceQuotes:[],whyItFits:''};
  }
  // Source evidence and confirmed capability IDs anchor the model's semantic fit
  // decision. Equivalent needs need not share words with the app description.
  if(/\bandroid\b/i.test([text,...visual.map(e=>e.observation)].join('\n')) && !profile.capabilities.filter(c=>result.capabilityIds.includes(c.id)).some(c=>/android/i.test(c.text))) return {decision:'rejected' as const,explicitIntent:false,intentQuote:'',capabilityIds:[],sourceEvidenceQuotes:[],whyItFits:''};
  const why=result.whyItFits.replace(/[<>`*_#]/g,'').replace(/\s+/g,' ').trim().slice(0,MAX_FIT_SUMMARY);
  if(why.length<12) return {decision:'rejected' as const,explicitIntent:false,intentQuote:'',capabilityIds:[],sourceEvidenceQuotes:[],whyItFits:''};
  return {decision:'qualified' as const,explicitIntent:true,intentQuote:result.intentQuote,
    capabilityIds:result.capabilityIds,sourceEvidenceQuotes:result.fitEvidenceQuotes,whyItFits:why,
    ...(visual.length?{imageEvidence:visual.map(e=>({imageIndex:e.imageIndex,observation:e.observation.trim()}))}:{})};
}
export function canonicalRedditURL(subreddit:string,id:string):string|undefined {
  if(!/^[a-z0-9_]{2,21}$/.test(subreddit) || !/^[a-z0-9]{1,20}$/.test(id)) return;
  return `https://www.reddit.com/r/${subreddit}/comments/${id}/`;
}

/** Queue-only reconciliation. This function never calls a paid provider. */
export async function enqueueLeadCandidates(store:Store,userId:string,appId:string,profile:LeadProfile,options:{hours?:number;communityLimit?:number;now?:number}={}) {
  if(!profile.enabled||!await hasMarketingAccess(store,userId,appId,process.env,options.now??Date.now())) return 0;
  const now=options.now ?? Date.now(),after=now-(options.hours ?? 24)*60*60*1000,perCommunity=options.communityLimit ?? 100;
  let queued=0;
  for(const community of profile.communities) {
    const posts=await store.query<StoredRedditPost>(store.collection('reddit_posts').where('subreddit','==',community).orderBy('createdAt','desc').limit(perCommunity));
    for(const post of posts) {
      if(Date.parse(post.createdAt)<after || !prefilterLeadCandidate(post,profile,now)) continue;
      const postId=post.id,contentHash=leadContentHash(post),id=documentKey(userId,appId,String(profile.revision),postId,contentHash,'questline-leads-v1');
      const job:LeadJob={id,user_id:userId,app_id:appId,kind:'qualify',inputHash:contentHash,profileRevision:profile.revision,postId,postContentHash:contentHash,
        state:'pending',nextAttemptAt:now,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),expireAt:post.expireAt};
      const inserted=await store.atomic(async s=>{
        const [existing,currentProfile,app]=await Promise.all([s.get('lead_jobs',id),s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),s.getApp(appId,userId)]);
        if(existing||!app||!currentProfile?.enabled||currentProfile.revision!==profile.revision||!currentProfile.communities.includes(community)||!await hasMarketingAccess(s,profile.user_id,profile.app_id,process.env,now)) return false;
        await s.set('lead_jobs',id,job);return true;
      });if(inserted) queued++;
    }
  }
  return queued;
}

/** Historical eligibility is scoped to the owner/revision that requested discovery. */
export async function enqueueHistoricalCandidates(store:Store,profile:LeadProfile,postIds:string[],now=Date.now()) {
  let queued=0;
  for(const postId of [...new Set(postIds)].slice(0,20)) {
    const post=await store.get<StoredRedditPost>('reddit_posts',postId);
    if(!post||!prefilterLeadCandidate(post,profile,now,true)) continue;
    const hash=leadContentHash(post),id=documentKey(profile.user_id,profile.app_id,String(profile.revision),post.id,hash,'questline-leads-v1');
    const inserted=await store.atomic(async s=>{
      const [existing,current,app,scan]=await Promise.all([s.get<LeadJob>('lead_jobs',id),s.get<LeadProfile>('lead_profiles',documentKey(profile.user_id,profile.app_id)),s.getApp(profile.app_id,profile.user_id),
        s.get<InitialLeadScan>('lead_scans',documentKey(profile.user_id,profile.app_id,String(profile.revision),'initial-scan'))]);
      if(!app||!current?.enabled||current.revision!==profile.revision||!await hasMarketingAccess(s,profile.user_id,profile.app_id,process.env,now)) return false;
      if(existing) {
        if(existing.state==='pending'&&existing.reasonCode==='DAILY_LIMIT'&&scan?.mode==='historical'&&scan.state!=='cancelled'
          &&[...(scan.fetchedPostIds??[]),...(scan.allFetchedPostIds??[])].includes(postId)) {
          await s.set('lead_jobs',id,{historical:true,reasonCode:'',nextAttemptAt:now,updatedAt:new Date(now).toISOString()},true);
        }
        return false;
      }
      const job:LeadJob={id,user_id:profile.user_id,app_id:profile.app_id,kind:'qualify',historical:true,inputHash:hash,profileRevision:profile.revision,postId:post.id,postContentHash:hash,
        state:'pending',nextAttemptAt:now,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),expireAt:post.expireAt};
      await s.set('lead_jobs',id,job);return true;
    });if(inserted) queued++;
  }
  return queued;
}

/** Enqueue only newly collected posts for matching invited app profiles. */
export async function enqueueLeadCandidatesForPosts(store:Store,posts:StoredRedditPost[],invitedUsers:string[]|null,now=Date.now(),collectionAt=new Date(now).toISOString()) {
  if(invitedUsers!==null&&!invitedUsers.length) return 0;
  const invited=new Set(invitedUsers??[]),byCommunity=new Map<string,StoredRedditPost[]>();
  for(const post of posts) {const rows=byCommunity.get(post.subreddit)??[];rows.push(post);byCommunity.set(post.subreddit,rows);}
  const profiles=await store.query<LeadProfile>(store.collection('lead_profiles').where('enabled','==',true).orderBy(FieldPath.documentId()).limit(5000));
  let queued=0;
  for(const profile of profiles) {
    if(!await hasMarketingAccess(store,profile.user_id,profile.app_id,process.env,now)) continue;
    if((invitedUsers!==null&&!invited.has(profile.user_id))||!profile.app_id||await store.accountDeleting(profile.user_id)||!await store.getApp(profile.app_id,profile.user_id)) continue;
    for(const community of profile.communities) for(const post of byCommunity.get(community)??[]) {
      if(!prefilterLeadCandidate(post,profile,now)) continue;
      const hash=leadContentHash(post),id=documentKey(profile.user_id,profile.app_id,String(profile.revision),post.id,hash,'questline-leads-v1');
      const job:LeadJob={id,user_id:profile.user_id,app_id:profile.app_id,kind:'qualify',inputHash:hash,profileRevision:profile.revision,postId:post.id,postContentHash:hash,
        state:'pending',nextAttemptAt:now,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),expireAt:post.expireAt};
      const inserted=await store.atomic(async s=>{
        const [existing,currentProfile,app]=await Promise.all([s.get('lead_jobs',id),s.get<LeadProfile>('lead_profiles',documentKey(profile.user_id,profile.app_id)),s.getApp(profile.app_id,profile.user_id)]);
        if(existing||!app||!currentProfile?.enabled||currentProfile.revision!==profile.revision||!currentProfile.communities.includes(community)||!await hasMarketingAccess(s,profile.user_id,profile.app_id,process.env,now)) return false;
        await s.set('lead_jobs',id,job);return true;
      });if(inserted) queued++;
    }
    await markCandidateScan(store,profile.user_id,profile.app_id,profile.revision,collectionAt,now);
  }
  return queued;
}

/** Candidate discovery is app-owner scoped and round-robin across enabled profiles. */
export async function reconcileLeadCandidates(store:Store,invitedUsers:string[]|null,now=Date.now(),maxProfiles=20) {
  if(invitedUsers!==null&&!invitedUsers.length) return {profiles:0,queued:0,partial:false};
  const marker=await store.get<{after?:string}>('lead_control','scan');
  const collector=await store.get<{lastCompletedAt?:string}>('reddit_control','collector');
  const collectionAt=collector?.lastCompletedAt??'never';
  const build=()=>store.collection('lead_profiles').where('enabled','==',true).orderBy(FieldPath.documentId());
  let page=await store.query<LeadProfile>(marker?.after?build().startAfter(marker.after).limit(1000):build().limit(1000));
  if(!page.length&&marker?.after) page=await store.query<LeadProfile>(build().limit(1000));
  if(!page.length) return {profiles:0,queued:0,partial:false};
  const invited=new Set(invitedUsers??[]),matching=page.filter(p=>(invitedUsers===null||invited.has(p.user_id))&&p.app_id),selected=matching.slice(0,maxProfiles);
  let queued=0;
  for(const profile of selected) {
    if(!await hasMarketingAccess(store,profile.user_id,profile.app_id,process.env,now)) continue;
    if(await store.accountDeleting(profile.user_id) || !await store.getApp(profile.app_id,profile.user_id)) continue;
    const status=await store.get<{candidateScanRevision?:number;candidateScanCollectionAt?:string;candidateScanVersion?:string}>('lead_status',documentKey(profile.user_id,profile.app_id));
    if(status?.candidateScanRevision===profile.revision&&status.candidateScanCollectionAt===collectionAt&&status.candidateScanVersion===LEAD_QUALIFICATION_VERSION) continue;
    queued+=await enqueueLeadCandidates(store,profile.user_id,profile.app_id,profile,{hours:24,communityLimit:100,now});
    await markCandidateScan(store,profile.user_id,profile.app_id,profile.revision,collectionAt,now);
  }
  const lastExamined=selected.at(-1)??page.at(-1)!;
  await store.set('lead_control','scan',{after:documentKey(lastExamined.user_id,lastExamined.app_id),updatedAt:new Date(now).toISOString()});
  return {profiles:selected.length,queued,partial:page.length===1000||matching.length>selected.length};
}

async function markCandidateScan(store:Store,userId:string,appId:string,revision:number,collectionAt:string,now:number) {
  await store.atomic(async s=>{
    const [profile,status]=await Promise.all([s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),s.get<Record<string,unknown>>('lead_status',documentKey(userId,appId))]);
    const previous=typeof status?.candidateScanCollectionAt==='string'?status.candidateScanCollectionAt:undefined;
    const older=previous!==undefined&&previous!=='never'&&(collectionAt==='never'||(Number.isFinite(Date.parse(previous))&&Number.isFinite(Date.parse(collectionAt))&&Date.parse(collectionAt)<Date.parse(previous)));
    if(profile?.enabled&&profile.revision===revision&&!(status?.candidateScanRevision===revision&&older)) await s.set('lead_status',documentKey(userId,appId),{
      ...status,user_id:userId,app_id:appId,candidateScanRevision:revision,candidateScanCollectionAt:collectionAt,candidateScanAt:new Date(now).toISOString(),candidateScanVersion:LEAD_QUALIFICATION_VERSION
    },true);
  });
}

export function createQualificationAssessment(input:{userId:string;appId:string;profile:LeadProfile;post:StoredRedditPost;contentHash:string;result:ReturnType<typeof validateQualifiedEvidence>;model:string;historical?:boolean;now?:number}):LeadAssessment {
  const now=input.now ?? Date.now(),expires=Math.min(input.post.expireAt.toMillis(),(input.historical?now:Date.parse(input.post.createdAt))+30*DAY);
  return {user_id:input.userId,app_id:input.appId,profileRevision:input.profile.revision,postId:input.post.id,postContentHash:input.contentHash,
    postCreatedAt:input.post.createdAt,decision:input.result.decision,explicitIntent:input.result.explicitIntent,intentQuote:input.result.intentQuote,
    capabilityIds:input.result.capabilityIds,sourceEvidenceQuotes:input.result.sourceEvidenceQuotes,whyItFits:input.result.whyItFits,
    ...(input.result.decision==='qualified'&&input.result.imageEvidence?.length?{imageEvidence:input.result.imageEvidence}:{}),
    modelVersion:input.model,promptVersion:LEAD_QUALIFICATION_VERSION,assessedAt:new Date(now).toISOString(),expireAt:Timestamp.fromMillis(expires)};
}
