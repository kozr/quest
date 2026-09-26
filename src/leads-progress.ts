import {Store} from './database.js';
import type {LeadJob,LeadProfile} from './leads-types.js';
import type {StoredRedditPost} from './reddit.js';
import {leadContentHash} from './leads-candidates.js';
import {initialScanId,type InitialLeadScan} from './leads-initial-scan.js';
import {ONBOARDING_WAIT_MS} from './leads-discovery-config.js';

export interface LeadCollectorProgress {
  active?:{runId:string|null;startedAt:number;communities:string[]}|null;
  lastCompletedAt?:string;
}
export interface LeadScanProgress {
  phase:'collecting'|'assessing'|'queued'|'complete'|'waiting'|'paused'|'interrupted'|'unavailable';
  batchId:string|null;
  fraction:number|null;
  post:{id:string;community:string;title:string;excerpt:string;state:'reviewing'|'reviewed'}|null;
  canStart?:boolean;
  background?:boolean;
}
const MAX_JOBS=500;

/** One enqueue pass stamps its jobs with a common createdAt. Use that fixed
 * batch, never a moving denominator across the app's entire retained history. */
export function summarizeLeadProgress(input:{profile:LeadProfile;jobs:LeadJob[];collector?:LeadCollectorProgress;initialScan?:InitialLeadScan;limited?:boolean;truncated?:boolean;scanComplete?:boolean;now:number}):{progress:LeadScanProgress;previewJob?:LeadJob} {
  const {profile,collector,now}=input;
  const empty=(phase:LeadScanProgress['phase']):{progress:LeadScanProgress}=>({progress:{phase,batchId:null,fraction:null,post:null}});
  if(!profile.enabled) return empty('paused');
  if(input.limited) return empty('paused');
  if(input.truncated) return empty('unavailable'); // A partial query cannot establish whether work is active or complete.
  const jobs=input.jobs.filter(j=>j.user_id===profile.user_id&&j.app_id===profile.app_id&&j.profileRevision===profile.revision&&j.kind==='qualify'&&j.expireAt.toMillis()>now);
  const unfinished=jobs.filter(j=>j.state==='pending'||j.state==='running').sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const anchor=unfinished[0]??jobs.toSorted((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  if(anchor) {
    const batch=jobs.filter(j=>j.createdAt===anchor.createdAt);
    const running=batch.find(j=>j.state==='running'&&(j.leaseUntil??0)>now);
    const pending=batch.filter(j=>j.state==='pending');
    const completed=batch.filter(j=>j.state==='succeeded'||j.state==='cancelled').length;
    const blocked=batch.some(j=>j.state==='uncertain'||j.state==='failed'||j.state==='running'&&(j.leaseUntil??0)<=now);
    const paused=pending.some(j=>j.reasonCode==='BUDGET_PAUSED'||j.reasonCode==='DAILY_LIMIT');
    const phase=paused?'paused':running?'assessing':pending.length?'queued':blocked?'interrupted':'complete';
    const previewJob=running??(['assessing','queued'].includes(phase)?batch.filter(j=>j.state==='succeeded').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]:undefined);
    if(phase!=='complete') return {progress:{phase,batchId:`${profile.revision}:${anchor.createdAt}`,fraction:completed/batch.length,post:null},previewJob};
  }
  if(input.initialScan&&input.initialScan.state!=='complete'&&input.initialScan.state!=='cancelled') {
    return empty(now-input.initialScan.requestedAt>30*60_000&&['queued','collecting'].includes(input.initialScan.state)?'interrupted':input.initialScan.state);
  }
  // The shared collector is relevant only when it includes this app's communities.
  const active=collector?.active;
  if(active&&active.communities.some(c=>profile.communities.includes(c))) {
    if((!active.runId&&now-active.startedAt>120_000)||now-active.startedAt>15*60_000) return empty('interrupted');
    return empty('collecting');
  }
  const result=empty(anchor||input.scanComplete||input.initialScan?.state==='complete'?'complete':input.initialScan?.state==='cancelled'?'paused':'waiting');
  result.progress.canStart=!input.initialScan;
  return result;
}

export async function readLeadProgress(store:Store,profile:LeadProfile,collector:LeadCollectorProgress|undefined,limited:boolean,now=Date.now(),scanComplete=false):Promise<LeadScanProgress> {
  const [jobs,initialScan]=await Promise.all([store.query<LeadJob>(store.collection('lead_jobs').where('user_id','==',profile.user_id).where('app_id','==',profile.app_id)
    .where('profileRevision','==',profile.revision).limit(MAX_JOBS+1)),store.get<InitialLeadScan>('lead_scans',initialScanId(profile.user_id,profile.app_id,profile.revision))]);
  const setupActive=initialScan&&['queued','collecting'].includes(initialScan.state);
  const sourceIds=new Set([...(initialScan?.fetchedPostIds??[]),...(initialScan?.allFetchedPostIds??[])]);
  // A regular monitoring queue at its daily limit must not mask setup progress.
  const relevantJobs=setupActive?jobs.filter(j=>sourceIds.has(j.postId??'')):jobs;
  const {progress,previewJob}=summarizeLeadProgress({profile,jobs:relevantJobs,collector,initialScan,limited,truncated:jobs.length>MAX_JOBS,scanComplete,now});
  progress.background=initialScan?.discoveryMode==='progressive'&&['queued','collecting','assessing'].includes(progress.phase)
    &&((initialScan.searchRound??0)>0||!!initialScan.firstMatchAt||now-initialScan.requestedAt>=ONBOARDING_WAIT_MS);
  if(previewJob?.postId) {
    const post=await store.get<StoredRedditPost>('reddit_posts',previewJob.postId);
    if(post&&post.expireAt.toMillis()>now&&profile.communities.includes(post.subreddit)&&leadContentHash(post)===previewJob.postContentHash) {
      progress.post={id:post.id,community:post.subreddit,title:post.title,excerpt:post.body.replace(/\s+/g,' ').trim().slice(0,220),state:previewJob.state==='running'?'reviewing':'reviewed'};
    }
  }
  return progress;
}
