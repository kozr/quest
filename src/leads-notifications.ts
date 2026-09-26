import {marketingBillingEnabled,hasMarketingAccess} from './marketing-billing.js';
import {readOnboarding,hasQuestAccess} from './onboarding.js';
import {documentKey,type Store,type DeviceRow,type Job} from './database.js';
import type {InitialLeadScan} from './leads-initial-scan.js';
import type {LeadAssessment,LeadProfile,LeadDismissal} from './leads-types.js';
import type {StoredRedditPost} from './reddit.js';
import {leadContentHash} from './leads-candidates.js';

export interface LeadNotification {scanId?:string;profileRevision:number;assessmentId:string}

/** Queue each newly qualified post once per app. A new assessment must be saved in
 * the same transaction, with this call before any writes (Firestore read ordering). */
export async function queueLeadReadyNotification(store:Store,assessmentId:string,now=Date.now(),newAssessment?:LeadAssessment) {
  await store.atomic(async s=>{
    const assessment=newAssessment??await s.get<LeadAssessment>('lead_assessments',assessmentId);
    if(!assessment||assessment.decision!=='qualified') return;
    const {user_id:userId,app_id:appId,postId,profileRevision}=assessment;
    if(!await hasMarketingAccess(s,userId,appId,process.env,now)) return;
    const notificationId=documentKey(userId,appId,postId),scanId=documentKey(userId,appId,String(profileRevision),'initial-scan');
    const [app,profile,post,dismissal,deleting,devices,previous,scan]=await Promise.all([
      s.getApp(appId,userId),s.get<LeadProfile>('lead_profiles',documentKey(userId,appId)),
      s.get<StoredRedditPost>('reddit_posts',assessment.postId),
      s.get<LeadDismissal>('lead_dismissals',notificationId),
      s.accountDeleting(userId),s.list<DeviceRow>('devices',[['user_id','==',userId],['active','==',1]],20),
      s.get('lead_notifications',notificationId),s.get<InitialLeadScan>('lead_scans',scanId),
    ]);
    if(previous||!app||deleting||!profile?.enabled||profile.revision!==profileRevision||!post||!profile.communities.includes(post.subreddit)
      ||post.expireAt.toMillis()<=now||assessment.expireAt.toMillis()<=now||assessment.postContentHash!==leadContentHash(post)
      ||dismissal&&dismissal.expireAt.toMillis()>now) return;
    if(scan) await s.set('lead_scans',scanId,{firstMatchAt:scan.firstMatchAt??now,
      ...(devices.length?{notificationQueuedAt:scan.notificationQueuedAt??now}:{})},true);
    if(!devices.length) return;
    // The receipt survives profile/model/content changes, so requalification
    // cannot send the same post again. It is purged with the app/account.
    await s.set('lead_notifications',notificationId,{user_id:userId,app_id:appId,postId,assessmentId,queuedAt:now});
    for(const device of devices) {
      const job:Job={...s.makeJob(device,null),kind:'lead',app_id:appId,
        lead:{profileRevision,assessmentId}};
      await s.set('delivery_jobs',job.id,job);
    }
  });
}

/** Revalidate the evidence and ownership at delivery, after any profile edit or dismissal. */
export async function leadReadyPayload(store:Store,job:Job,now=Date.now()):Promise<Record<string,unknown>|null> {
  if(job.kind!=='lead'||!job.lead||!job.app_id) return null;
  if(!await hasMarketingAccess(store,job.user_id,job.app_id,process.env,now)) return null;
  const [app,profile,assessment,deleting]=await Promise.all([
    store.getApp(job.app_id,job.user_id),store.get<LeadProfile>('lead_profiles',documentKey(job.user_id,job.app_id)),
    store.get<LeadAssessment>('lead_assessments',job.lead.assessmentId),
    store.accountDeleting(job.user_id),
  ]);
  if(!app||deleting||!profile?.enabled||profile.revision!==job.lead.profileRevision
    ||!assessment||assessment.user_id!==job.user_id||assessment.app_id!==job.app_id||assessment.profileRevision!==profile.revision
    ||assessment.decision!=='qualified'||assessment.expireAt.toMillis()<=now) return null;
  const onboarding=await readOnboarding(store,job.user_id);
  if(!marketingBillingEnabled()&&!hasQuestAccess(onboarding,now)&&onboarding?.freeQuest&&
    (onboarding.freeQuest.appId!==job.app_id||onboarding.freeQuest.postId!==assessment.postId)) return null;
  const [post,dismissal]=await Promise.all([store.get<StoredRedditPost>('reddit_posts',assessment.postId),
    store.get<LeadDismissal>('lead_dismissals',documentKey(job.user_id,job.app_id,assessment.postId))]);
  if(!post||post.expireAt.toMillis()<=now||!profile.communities.includes(post.subreddit)||assessment.postContentHash!==leadContentHash(post)
    ||dismissal&&dismissal.expireAt.toMillis()>now) return null;
  return {aps:{alert:{title:`A lead for ${app.name}`,body:'A matching conversation is ready. Open your board to take a look.'},sound:'default','thread-id':`leads-${app.id}`},
    kind:'lead',appId:app.id,postId:post.id};
}
