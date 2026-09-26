import {purgeMarketingAccount} from './marketing-billing.js';
import {Timestamp} from 'firebase-admin/firestore';
import {purgeLeadAccountAccounting,purgeLeadAppData} from './leads-jobs.js';
import {purgeMarketAccountData,purgeMarketAppData} from './market-jobs.js';
import {Store,documentKey,type AppRow,type DeviceRow} from './database.js';

export interface AccountDeletion {state:'pending'|'complete';requested_at:string;receipt_hash?:string;completed_at?:string;expireAt?:Timestamp}

/** The marker participates in write transactions and immediately revokes service access. */
export async function requestAccountDeletion(store:Store,userId:string,receipt?:string) {
  await store.atomic(async s=>{
    if(await s.get('account_deletions',userId)) return;
    await s.set('account_deletions',userId,{state:'pending',requested_at:new Date().toISOString(),...(receipt ? {receipt_hash:documentKey(receipt)} : {})});
  });
}

async function deleteMatching(store:Store,collection:string,field:string,value:string) {
  for(;;) {
    const page=await store.collection(collection).where(field,'==',value).limit(400).get();
    if(page.empty) return;
    const batch=store.db.batch();for(const doc of page.docs) batch.delete(doc.ref);await batch.commit();
  }
}

export async function purgeAppData(store:Store,appId:string) {
  await purgeMarketAppData(store,appId);
  await purgeLeadAppData(store,appId);
  for(const [collection,field] of [['events','appId'],['notifications','app_id'],['economic_events','app_id'],['delivery_jobs','app_id'],['forwarding_jobs','app_id'],
    ['lead_profiles','app_id'],['lead_drafts','app_id'],['lead_assessments','app_id'],['lead_notifications','app_id'],['lead_dismissals','app_id'],['lead_jobs','app_id'],['lead_scans','app_id'],['lead_status','app_id'],['lead_daily_usage','app_id']]) {
    await deleteMatching(store,collection,field,appId);
  }
}

async function purgeLeadAccountData(store:Store,userId:string) {
  await purgeLeadAccountAccounting(store,userId);
  for(const collection of ['lead_profiles','lead_drafts','lead_assessments','lead_notifications','lead_dismissals','lead_jobs','lead_scans','lead_status','lead_daily_usage']) await deleteMatching(store,collection,'user_id',userId);
}

async function deleteMapping(store:Store,collection:string,key:string,field:string,value:string) {
  await store.atomic(async s=>{
    const mapping=await s.get<Record<string,string>>(collection,key);
    // A shared APNs token may already belong to a different signed-in account.
    if(mapping?.[field]===value) await s.delete(collection,key);
  });
}

/** Idempotent, bounded batches; retried by Firestore and a recovery schedule. */
export async function purgeAccount(store:Store,userId:string) {
  const job=await store.get<AccountDeletion>('account_deletions',userId);
  if(job?.state!=='pending') return;
  try {await store.identity.auth.updateUser(userId,{disabled:true});}
  catch(error) {if((error as {code?:string}).code!=='auth/user-not-found') throw error;}
  for(;;) {
    const apps=await store.list<AppRow>('apps',[['user_id','==',userId]],20);
    if(!apps.length) break;
    for(const app of apps) {
      await purgeAppData(store,app.id);
      await deleteMapping(store,'app_keys',documentKey(userId,app.bundle_id),'app_id',app.id);
      await deleteMapping(store,'webhook_keys',documentKey(app.webhook_secret),'app_id',app.id);
      await store.delete('apps',app.id);
    }
  }
  for(;;) {
    const devices=await store.list<DeviceRow>('devices',[['user_id','==',userId]],100);
    if(!devices.length) break;
    for(const device of devices) {
      await deleteMapping(store,'device_tokens',documentKey(device.token,device.environment),'device_id',device.id);
      await store.delete('devices',device.id);
    }
  }
  for(const collection of ['sessions','events','delivery_jobs','forwarding_jobs','reddit_post_states']) await deleteMatching(store,collection,'user_id',userId);
  await deleteMatching(store,'browser_pairings','approved_user_id',userId);
  await purgeMarketAccountData(store,userId);
  await purgeLeadAccountData(store,userId);
  await store.delete('reddit_settings',userId);
  await store.delete('preferences',userId);
  await purgeMarketingAccount(store,userId);
  await store.delete('users',userId);
  try {await store.identity.auth.deleteUser(userId);}
  catch(error) {if((error as {code?:string}).code!=='auth/user-not-found') throw error;}
  // No email, credentials, transaction data, device tokens or URLs survive in the receipt.
  // Pending jobs deliberately have no TTL: failure cannot silently drop a deletion request.
  await store.set('account_deletions',userId,{state:'complete',requested_at:job.requested_at,
    ...(job.receipt_hash ? {receipt_hash:job.receipt_hash} : {}),
    completed_at:new Date().toISOString(),expireAt:Timestamp.fromMillis(Date.now()+7*86400000)});
}
