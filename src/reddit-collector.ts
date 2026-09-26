import {hasMarketingAccess} from './marketing-billing.js';
import {randomUUID} from 'node:crypto';
import {Timestamp,FieldPath} from 'firebase-admin/firestore';
import {Store,documentKey} from './database.js';
import type {InitialLeadScan} from './leads-initial-scan.js';
import {RedditApify,type ApifyRun} from './reddit-apify.js';
import {redditAccess,type RedditSettings} from './reddit.js';
import type {LeadProfile} from './leads-types.js';
import {enqueueLeadCandidatesForPosts,enqueueHistoricalCandidates} from './leads-candidates.js';
const INTERVAL=2*60*60*1000;
const RESERVATION=0.5;
interface ActiveRun {claim:string;runId:string|null;startedAt:number;after:string;before:string;communities:string[];month:string;historical?:{scanId:string;userId:string;appId:string;revision:number;postIds:string[]}}
interface Control {active:ActiveRun|null;nextCheckAt:number;lastCompletedAt?:string;lastCompletedCommunities?:string[];lastFinishedClaim?:string;lastFinishedSucceeded?:boolean;message:string;leaseUntil?:number;leaseId?:string}
interface Budget {reserved:number;spent:number}
export function monthlyRedditBudget(env=process.env) {
  const amount=Number(env.REDDIT_MONTHLY_BUDGET_USD ?? '15');
  if(!Number.isFinite(amount) || amount<RESERVATION || amount>1000) throw new Error('REDDIT_MONTHLY_BUDGET_USD must be between 0.50 and 1000.');
  return amount;
}
/** Frequent lightweight ticks reconcile existing runs; only one paid batch starts every two hours. */
export async function collectReddit(store:Store,provider:RedditApify,env=process.env,now=Date.now(),options:{initialScanId?:string}={}) {
  const access=redditAccess(env);if(!access.enabled || (!access.allAccounts&&!access.allowed.size)) return;
  const monthlyCap=monthlyRedditBudget(env);const leaseId=randomUUID();
  const claimed=await store.atomic(async s=>{
    const control=await s.get<Control>('reddit_control','collector') ?? {active:null,nextCheckAt:0,message:''};
    if((control.leaseUntil ?? 0)>now) return null;
    await s.set('reddit_control','collector',{...control,leaseUntil:now+240000,leaseId});return control;
  });
  if(!claimed) return;
  try {
    if(claimed.active) {
      const active=claimed.active;
      // A crash after POST but before persisting its ID is ambiguous. Never repeat that paid start.
      if(!active.runId) {
        await update({message:'Collection needs operator review after an interrupted start. Monitoring is paused.'});return;
      }
      const run=await provider.status(active.runId);
      if(['READY','RUNNING','TIMING-OUT','ABORTING'].includes(run.status)) return;
      // Provider costs can be preliminary for ten seconds after completion.
      if(!run.finishedAt || now-Date.parse(run.finishedAt)<15000) return;
      if(run.status==='SUCCEEDED') {
        const posts=await provider.posts(run.defaultDatasetId);
        const after=Date.parse(active.after);const before=Date.parse(active.before);
        const valid=posts.filter(p=>active.communities.includes(p.subreddit) && Date.parse(p.createdAt)>=after && Date.parse(p.createdAt)<=before && (!active.historical||active.historical.postIds.includes(p.id)))
          .map(post=>({...post,expireAt:Timestamp.fromMillis((active.historical?now:Date.parse(post.createdAt))+30*86400000)}));
        for(let offset=0;offset<valid.length;offset+=400) {
          const batch=store.db.batch();
          for(const post of valid.slice(offset,offset+400)) batch.set(store.collection('reddit_posts').doc(post.id),post);
          await batch.commit();
        }
        const possibleTruncation=posts.length>=100 || (run.usageTotalUsd ?? RESERVATION)>=RESERVATION-0.005;
        await finish(active,run,active.historical?{message:'Historical search retrieved its source threads.'}:{lastCompletedAt:active.before,lastCompletedCommunities:active.communities,message:possibleTruncation ? 'Last check reached a collection limit; some posts may be missing.' : 'Checks run every two hours. Posts are retained for 30 days.'},valid.map(p=>p.id));
        // Collection cost and the completed watermark are committed first.
        // Candidate enqueue failures are recovered by the bounded scheduler scan.
        if(env.LEADS_ENABLED==='true') {
          if(active.historical) {
            const profile=await store.get<LeadProfile>('lead_profiles',documentKey(active.historical.userId,active.historical.appId));
            if(profile?.enabled&&profile.revision===active.historical.revision) await enqueueHistoricalCandidates(store,profile,valid.map(p=>p.id),now);
          } else await enqueueLeadCandidatesForPosts(store,valid,access.allAccounts?null:[...access.allowed],now,active.before);
        }
      } else {
        await finish(active,run,{message:'The last collection failed. A later check will retry the recent time window.'});
      }
      return;
    }
    const initial=options.initialScanId?await store.get<InitialLeadScan>('lead_scans',options.initialScanId):undefined;
    const initialProfile=initial?await store.get<LeadProfile>('lead_profiles',documentKey(initial.user_id,initial.app_id)):undefined;
    if(initial&&!await hasMarketingAccess(store,initial.user_id,initial.app_id,env,now)) return;
    const historical=initial?.mode==='historical'&&!!initial.searchURLs?.length;
    const firstAttempt=!!initial&&initial.state==='queued'&&!initial.collectionClaim&&initialProfile?.enabled===true&&initialProfile.revision===initial.profileRevision&&access.allows(initial.user_id)&&!!await store.getApp(initial.app_id,initial.user_id);
    if(initial?.mode==='historical'&&(!historical||!firstAttempt)) return;
    if(claimed.nextCheckAt>now&&!firstAttempt) return;
    if(initial?.collectionClaim) return; // A retry may reconcile a paid start, but must never start it twice.
    const communitySet=new Set<string>();
    if(historical&&initialProfile) {
      for(const community of initialProfile.communities) communitySet.add(community);
    } else if(access.allAccounts) {
      // Query only opt-in settings/profiles, in pages; do not enumerate account identities.
      for(const collection of (env.LEADS_ENABLED==='true'?['lead_profiles']:[])) {
        let after:string|undefined;
        while(true) {
          let query=store.collection(collection).where('enabled','==',true).orderBy(FieldPath.documentId());
          if(after) query=query.startAfter(after);
          const page=await query.limit(250).get();
          for(const doc of page.docs) {
            const row=doc.data() as RedditSettings & Partial<LeadProfile>;
            if(!row.user_id || await store.accountDeleting(row.user_id)) continue;
            if(collection==='lead_profiles'&&(!row.app_id||!await store.getApp(row.app_id,row.user_id)||!await hasMarketingAccess(store,row.user_id,row.app_id,env,now))) continue;
            for(const community of row.communities??[]) communitySet.add(community);
          }
          if(page.size<250) break;
          after=page.docs.at(-1)!.id;
        }
      }
    } else {
      for(const userId of [...access.allowed].slice(0,100)) {
        if(await store.accountDeleting(userId)) continue;
        if(env.LEADS_ENABLED==='true') {
          const profiles=await store.list<LeadProfile>('lead_profiles',[['user_id','==',userId],['enabled','==',true]],100);
          for(const profile of profiles) if(await store.getApp(profile.app_id,userId)&&await hasMarketingAccess(store,userId,profile.app_id,env,now))
            for(const community of profile.communities) communitySet.add(community);
        }
      }
    }
    const communities=[...communitySet].sort();
    if(!communities.length) {await update({nextCheckAt:now+INTERVAL,message:'Waiting for customers to choose communities.'});return;}
    if(communities.length>100) {await update({message:'The beta community limit has been reached. Contact support.'});return;}
    const month=new Date(now).toISOString().slice(0,7);
    // Re-read up to 24h after downtime; a small overlap handles timestamp boundaries.
    const after=new Date(historical?0:firstAttempt?now-86400000:Math.max(now-86400000,claimed.lastCompletedAt ? Date.parse(claimed.lastCompletedAt)-60000 : now-INTERVAL)).toISOString();
    const active:ActiveRun={claim:randomUUID(),runId:null,startedAt:now,after,before:new Date(now).toISOString(),communities,month,
      ...(historical?{historical:{scanId:initial!.id,userId:initial!.user_id,appId:initial!.app_id,revision:initial!.profileRevision,postIds:initial!.searchURLs!.map(url=>url.split('/')[6])}}:{})};
    const reserved=await store.atomic(async s=>{
      const [control,budget,scan,profile,app]=await Promise.all([s.get<Control>('reddit_control','collector'),s.get<Budget>('reddit_budgets',month),
        initial?s.get<InitialLeadScan>('lead_scans',initial.id):undefined,initial?s.get<LeadProfile>('lead_profiles',documentKey(initial.user_id,initial.app_id)):undefined,
        initial?s.getApp(initial.app_id,initial.user_id):undefined]);
      if(control?.leaseId!==leaseId || control.active) return false;
      if(initial&&!await hasMarketingAccess(s,initial.user_id,initial.app_id,env,now)) return false;
      if(initial&&(!scan||scan.collectionClaim||scan.state!=='queued'||!app||!profile?.enabled||profile.revision!==scan.profileRevision)) return false;
      const b=budget ?? {reserved:0,spent:0};
      if(b.spent+b.reserved+RESERVATION>monthlyCap+1e-8) {
        await s.set('reddit_control','collector',{...control,nextCheckAt:now+INTERVAL,message:'Monitoring is paused because the beta scraping budget has been reached.'});return false;
      }
      await s.set('reddit_budgets',month,{...b,reserved:b.reserved+RESERVATION});
      if(scan) await s.set('lead_scans',scan.id,{...scan,state:'collecting',collectionClaim:active.claim,updatedAt:now});
      await s.set('reddit_control','collector',{...control,active,nextCheckAt:historical?control.nextCheckAt:now+INTERVAL,message:historical?'Reading historical search results…':'Checking for new posts…'});return true;
    });
    if(!reserved) return;
    const run=historical?await provider.startThreads(initial!.searchURLs!,RESERVATION):await provider.start(communities,after,active.before,RESERVATION);
    await update({active:{...active,runId:run.id}});
  } catch {
    await update({message:'Reddit collection is unavailable. Existing posts remain available.'});
    // Do not log provider bodies, tokens, or customer keyword lists.
  } finally {
    await store.atomic(async s=>{
      const control=await s.get<Control>('reddit_control','collector');
      if(control?.leaseId===leaseId) await s.set('reddit_control','collector',{...control,leaseUntil:0,leaseId:''});
    });
  }
  async function update(fields:Partial<Control>) {
    await store.atomic(async s=>{
      const current=await s.get<Control>('reddit_control','collector');
      if(current?.leaseId===leaseId) await s.set('reddit_control','collector',{...current,...fields});
    });
  }
  async function finish(active:ActiveRun,run:ApifyRun,fields:Partial<Control>,postIds:string[]=[] ) {
    await store.atomic(async s=>{
      const [control,budget,scan]=await Promise.all([s.get<Control>('reddit_control','collector'),s.get<Budget>('reddit_budgets',active.month),active.historical?s.get<InitialLeadScan>('lead_scans',active.historical.scanId):undefined]);
      if(control?.leaseId!==leaseId || control.active?.claim!==active.claim) return;
      // Missing costs retain the full reservation as spent; do not undercount uncertain runs.
      const cost=typeof run.usageTotalUsd==='number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd>=0 ? run.usageTotalUsd : RESERVATION;
      await s.set('reddit_budgets',active.month,{reserved:Math.max(0,(budget?.reserved ?? RESERVATION)-RESERVATION),spent:(budget?.spent ?? 0)+cost});
      if(scan) await s.set('lead_scans',scan.id,{...scan,retrievalSucceeded:run.status==='SUCCEEDED',fetchedPostIds:postIds,updatedAt:now});
      await s.set('reddit_control','collector',{...control,...fields,lastFinishedClaim:active.claim,lastFinishedSucceeded:run.status==='SUCCEEDED',active:null});
    });
  }
}
