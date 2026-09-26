import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import {Environment,SignedDataVerifier,VerificationException,VerificationStatus,type JWSTransactionDecodedPayload} from '@apple/app-store-server-library';
import {Store,documentKey} from './database.js';
import {ServiceError} from './firebase.js';
import type {AuthenticatedRequest} from './auth.js';
import {AppleVerificationError,loadAppleRootCertificates,verifyAppleNotification,type VerifiedAppleNotification} from './apple.js';

export const MARKETING_PRODUCTS={
  'com.kozr.quest.marketing.one.monthly':1,
  'com.kozr.quest.marketing.one.annual':1,
  'com.kozr.quest.marketing.three.monthly':3,
  'com.kozr.quest.marketing.three.annual':3,
} as const;
type ProductID=keyof typeof MARKETING_PRODUCTS;
interface MarketingAccount {user_id:string;appAccountToken:string;appIDs:string[];originalIDs:string[]}
export interface MarketingTransaction {
  originalID:string;transactionID:string;productID:ProductID;environment:'Production'|'Sandbox';
  appAccountToken:string;purchaseDate:number;expiresAt:number;signedDate:number;revoked:boolean;
}
interface SubscriptionRecord {user_id:string|null;transaction:MarketingTransaction|null}
export interface MarketingSubscription {
  enabled:boolean;active:boolean;appLimit:number;appIDs:string[];appAccountToken:string;productID:ProductID|null;expiresAt:number|null;
}
const uuid=z.string().uuid();
const appIDsInput=z.array(uuid).max(3).refine(values=>new Set(values).size===values.length,'Choose each app only once.');
function configuration(env:NodeJS.ProcessEnv) {
  const appAppleId=Number(env.MARKETING_APP_APPLE_ID);
  return {enabled:env.MARKETING_BILLING_ENABLED==='true'&&Number.isSafeInteger(appAppleId)&&appAppleId>0,
    appAppleId,allowSandbox:env.MARKETING_ALLOW_SANDBOX==='true'};
}
export const marketingBillingEnabled=(env:NodeJS.ProcessEnv=process.env)=>configuration(env).enabled;
const originalKey=(transaction:Pick<MarketingTransaction,'environment'|'originalID'>)=>documentKey(transaction.environment,transaction.originalID);
const tokenKey=(token:string)=>documentKey(token.toLowerCase());
function invalid(message='This purchase could not be verified.'):never {throw new ServiceError(422,message,'INVALID_MARKETING_TRANSACTION');}
function timestamp(value:unknown):value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}

/** Called only after Apple's official signature/app/environment verifier succeeds. */
export function marketingTransaction(payload:JWSTransactionDecodedPayload,env:NodeJS.ProcessEnv=process.env,now=Date.now()):MarketingTransaction {
  const config=configuration(env);
  if(payload.bundleId!=='com.kozr.quest'||payload.type!=='Auto-Renewable Subscription'||payload.inAppOwnershipType!=='PURCHASED'||
    !(payload.productId&&Object.hasOwn(MARKETING_PRODUCTS,payload.productId))||
    !['Production',...(config.allowSandbox?['Sandbox']:[])].includes(payload.environment??'')||
    !uuid.safeParse(payload.appAccountToken).success||!payload.originalTransactionId||!payload.transactionId||
    !/^[0-9]{1,64}$/.test(payload.originalTransactionId)||!/^[0-9]{1,64}$/.test(payload.transactionId)||
    !timestamp(payload.purchaseDate)||!timestamp(payload.expiresDate)||!timestamp(payload.signedDate)||
    payload.expiresDate<=payload.purchaseDate||payload.purchaseDate>now+300_000||payload.signedDate>now+300_000) invalid();
  return {originalID:payload.originalTransactionId,transactionID:payload.transactionId,productID:payload.productId as ProductID,
    environment:payload.environment as 'Production'|'Sandbox',appAccountToken:payload.appAccountToken!.toLowerCase(),
    purchaseDate:payload.purchaseDate,expiresAt:payload.expiresDate,signedDate:payload.signedDate,
    revoked:payload.isUpgraded===true||payload.revocationDate!==undefined};
}

/** Old restores cannot undo newer renewals, refunds or upgrades. A revoked transaction stays revoked. */
export function mergeMarketingTransaction(previous:MarketingTransaction|null|undefined,incoming:MarketingTransaction):MarketingTransaction {
  if(!previous) return incoming;
  if(previous.originalID!==incoming.originalID||previous.environment!==incoming.environment) invalid();
  if(incoming.purchaseDate<previous.purchaseDate) return previous;
  if(incoming.transactionID===previous.transactionID) {
    if(incoming.signedDate<previous.signedDate) return previous;
    return {...incoming,revoked:previous.revoked||incoming.revoked};
  }
  if(incoming.purchaseDate===previous.purchaseDate) return previous; // Conflicting same-time purchases never expand access.
  return incoming;
}

async function account(store:Store,userId:string):Promise<MarketingAccount> {
  return store.atomic(async s=>{
    await s.assertAccountActive(userId);
    const existing=await s.get<MarketingAccount>('marketing_accounts',userId);
    if(existing) return existing;
    const value:MarketingAccount={user_id:userId,appAccountToken:randomUUID(),appIDs:[],originalIDs:[]};
    await s.set('marketing_accounts',userId,value);
    await s.set('marketing_tokens',tokenKey(value.appAccountToken),{user_id:userId});
    return value;
  });
}
async function state(store:Store,userId:string,env:NodeJS.ProcessEnv,now:number,create=false):Promise<MarketingSubscription> {
  const enabled=marketingBillingEnabled(env);
  const owner=create?await account(store,userId):await store.get<MarketingAccount>('marketing_accounts',userId);
  const records=await Promise.all((owner?.originalIDs??[]).map(id=>store.get<SubscriptionRecord>('marketing_subscriptions',id)));
  // The most recent purchase determines the tier. Do not resurrect an older tier after a refund or upgrade.
  const latest=records.filter(row=>row?.user_id===userId&&row.transaction&&(row.transaction.environment==='Production'||configuration(env).allowSandbox)).map(row=>row!.transaction!)
    .sort((a,b)=>b.purchaseDate-a.purchaseDate||b.signedDate-a.signedDate)[0];
  const active=!!(enabled&&latest&&!latest.revoked&&latest.expiresAt>now&&latest.purchaseDate<=now&&
    (latest.environment==='Production'||configuration(env).allowSandbox));
  const appLimit=active?MARKETING_PRODUCTS[latest.productID]:0;
  const apps=(await Promise.all((owner?.appIDs??[]).map(async id=>await store.getApp(id,userId)?id:null))).filter((id):id is string=>id!==null);
  return {enabled,active,appLimit,appIDs:active?apps.slice(0,appLimit):[],appAccountToken:owner?.appAccountToken??'',
    productID:latest?.productID??null,expiresAt:latest?.expiresAt??null};
}
export async function marketingSubscription(store:Store,userId:string,env=process.env,now=Date.now()) {
  return state(store,userId,env,now,true);
}
export async function hasMarketingAccess(store:Store,userId:string,appId:string,env=process.env,now=Date.now()) {
  // Billing availability must never grant unpaid access (including beta installs).
  if(!marketingBillingEnabled(env)) return false;
  const [access,app]=await Promise.all([state(store,userId,env,now),store.getApp(appId,userId)]);
  return !!app&&access.active&&access.appIDs.includes(appId);
}
export async function requireMarketingAccess(store:Store,userId:string,appId:string,env=process.env,now=Date.now()) {
  if(!await hasMarketingAccess(store,userId,appId,env,now)) throw new ServiceError(403,'Subscribe to Marketing and select this app to continue. Sales tracking stays free.','MARKETING_SUBSCRIPTION_REQUIRED');
}

async function ownedApps(store:Store,userId:string,appIDs:string[],limit:number) {
  if(appIDs.length>limit) throw new ServiceError(409,'This plan does not cover that many apps.','MARKETING_APP_LIMIT');
  for(const id of appIDs) if(!await store.getApp(id,userId)) throw new ServiceError(404,'App not found.','APP_NOT_FOUND');
}
export async function syncMarketingTransaction(store:Store,userId:string,incoming:MarketingTransaction,appIDs:string[]|undefined,env=process.env,now=Date.now()) {
  if(!marketingBillingEnabled(env)) throw new ServiceError(503,'Marketing subscriptions are not available yet.','MARKETING_BILLING_UNAVAILABLE');
  await account(store,userId);
  await store.atomic(async s=>{
    await s.assertAccountActive(userId);
    const [owner,previous]=await Promise.all([s.get<MarketingAccount>('marketing_accounts',userId),s.get<SubscriptionRecord>('marketing_subscriptions',originalKey(incoming))]);
    if(!owner||owner.appAccountToken!==incoming.appAccountToken) throw new ServiceError(409,'This purchase belongs to a different Quest account. Sign in to the account used for the purchase.','MARKETING_ACCOUNT_MISMATCH');
    if(previous&&previous.user_id!==userId) throw new ServiceError(409,'This subscription is already linked to another account.','MARKETING_ACCOUNT_MISMATCH');
    const merged=mergeMarketingTransaction(previous?.transaction,incoming);
    const ids=[...new Set([...owner.originalIDs,originalKey(incoming)])];
    if(ids.length>100) throw new ServiceError(409,'Contact support to restore this subscription.','MARKETING_RESTORE_REQUIRED');
    const others=await Promise.all(owner.originalIDs.filter(id=>id!==originalKey(incoming)).map(id=>s.get<SubscriptionRecord>('marketing_subscriptions',id)));
    const latest=[merged,...others.filter(row=>row?.user_id===userId&&row.transaction&&(row.transaction.environment==='Production'||configuration(env).allowSandbox)).map(row=>row!.transaction!)].sort((a,b)=>b.purchaseDate-a.purchaseDate||b.signedDate-a.signedDate)[0];
    const limit=MARKETING_PRODUCTS[latest.productID];
    // Lifecycle sync must settle refunds/renewals even if a previously selected app was deleted.
    // Coverage edits have their own strict endpoint; sync safely preserves only owned app slots.
    const selected=(await Promise.all((appIDs??owner.appIDs).map(async id=>await s.getApp(id,userId)?id:null)))
      .filter((id):id is string=>id!==null).filter((id,index,ids)=>ids.indexOf(id)===index).slice(0,limit);
    await s.set('marketing_subscriptions',originalKey(incoming),{user_id:userId,transaction:merged});
    await s.set('marketing_accounts',userId,{...owner,originalIDs:ids,appIDs:selected});
  });
  return state(store,userId,env,now);
}
export async function selectMarketingApps(store:Store,userId:string,appIDs:string[],env=process.env,now=Date.now()) {
  await store.atomic(async s=>{
    await s.assertAccountActive(userId);
    const access=await state(s,userId,env,now);
    if(!access.enabled||!access.active) throw new ServiceError(403,'An active Marketing subscription is required.','MARKETING_SUBSCRIPTION_REQUIRED');
    await ownedApps(s,userId,appIDs,access.appLimit);
    await s.set('marketing_accounts',userId,{appIDs},true);
  });
  return state(store,userId,env,now);
}

export interface MarketingBillingOptions {
  env?:NodeJS.ProcessEnv;
  /** Server-only test injection. Never controlled by requests. */
  verifyTransaction?:(signed:string)=>Promise<JWSTransactionDecodedPayload>;
  verifyNotification?:(signed:string)=>Promise<VerifiedAppleNotification>;
}
async function verifyTransaction(signed:string,env:NodeJS.ProcessEnv) {
  const config=configuration(env),roots=await loadAppleRootCertificates();
  let failure:unknown,retryable:unknown;
  for(const environment of [Environment.PRODUCTION,...(config.allowSandbox?[Environment.SANDBOX]:[])]) {
    try {return await new SignedDataVerifier(roots,true,environment,'com.kozr.quest',config.appAppleId).verifyAndDecodeTransaction(signed);}
    catch(error) {failure=error;if(!(error instanceof VerificationException)||error.status===VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) retryable=error;}
  }
  // Apple OCSP/network failures remain retryable; malformed signatures grant no access either way.
  if(retryable) throw new AppleVerificationError('verifier_unavailable','Apple purchase verification is temporarily unavailable. Try again.',{cause:retryable});
  throw new AppleVerificationError('invalid_signature','Apple could not verify this purchase.',{cause:failure});
}
export function marketingBillingRouter(store:Store,options:MarketingBillingOptions={}) {
  const router=Router(),env=options.env??process.env,uid=(req:unknown)=>(req as AuthenticatedRequest).user.id;
  router.get('/marketing/subscription',async(req,res)=>res.json(await marketingSubscription(store,uid(req),env)));
  router.post('/marketing/subscription',async(req,res)=>{
    if(!marketingBillingEnabled(env)) throw new ServiceError(503,'Marketing subscriptions are not available yet.','MARKETING_BILLING_UNAVAILABLE');
    const input=z.object({signedTransaction:z.string().min(1).max(24576),appIDs:appIDsInput}).strict().parse(req.body);
    const payload=await(options.verifyTransaction??(value=>verifyTransaction(value,env)))(input.signedTransaction);
    res.json(await syncMarketingTransaction(store,uid(req),marketingTransaction(payload,env),input.appIDs,env));
  });
  router.put('/marketing/subscription/apps',async(req,res)=>{
    const {appIDs}=z.object({appIDs:appIDsInput.refine(values=>values.length>0,'Choose at least one app.')}).strict().parse(req.body);
    res.json(await selectMarketingApps(store,uid(req),appIDs,env));
  });
  return router;
}

/** A separate endpoint for Quest's own subscription lifecycle; never customer sales webhooks. */
export function marketingWebhookRouter(store:Store,options:MarketingBillingOptions={}) {
  const router=Router(),env=options.env??process.env;
  router.post('/marketing/apple',async(req,res)=>{
    if(!marketingBillingEnabled(env)) throw new ServiceError(503,'Marketing subscriptions are not enabled.');
    const {signedPayload}=z.object({signedPayload:z.string().min(1).max(131072)}).strict().parse(req.body);
    let verified:VerifiedAppleNotification|undefined;
    if(options.verifyNotification) verified=await options.verifyNotification(signedPayload);
    else {
      let failure:unknown,retryable:unknown;
      for(const environment of ['Production',...(configuration(env).allowSandbox?['Sandbox']:[])] as const) {
        try {verified=await verifyAppleNotification(signedPayload,{bundleId:'com.kozr.quest',appleId:configuration(env).appAppleId,environment:environment as 'Production'|'Sandbox'});break;}
        catch(error) {failure=error;if(error instanceof AppleVerificationError&&error.code==='verifier_unavailable') retryable=error;}
      }
      if(!verified) throw retryable??failure;
    }
    if(!verified.transaction) {res.json({ok:true});return;}
    const transaction=marketingTransaction(verified.transaction,env);
    if(['REFUND','REVOKE'].includes(verified.notification.notificationType??'')) transaction.revoked=true;
    const owner=await store.get<{user_id:string}>('marketing_tokens',tokenKey(transaction.appAccountToken));
    // Notifications may arrive before the phone's first sync. GET creates the token before purchase.
    if(owner&&!await store.accountDeleting(owner.user_id)) await syncMarketingTransaction(store,owner.user_id,transaction,undefined,env);
    res.json({ok:true});
  });
  return router;
}

/** Keep only a hashed original-ID tombstone to prevent deleted subscriptions being reassigned. */
export async function purgeMarketingAccount(store:Store,userId:string) {
  const owner=await store.get<MarketingAccount>('marketing_accounts',userId);
  if(!owner) return;
  for(const id of owner.originalIDs) await store.set('marketing_subscriptions',id,{user_id:null,transaction:null});
  await store.delete('marketing_tokens',tokenKey(owner.appAccountToken));
  await store.delete('marketing_accounts',userId);
}
