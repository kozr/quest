import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { FieldPath, Timestamp, type Firestore, type Transaction, type Query, type DocumentData, type WhereFilterOp } from 'firebase-admin/firestore';
import type { FirebaseIdentity } from './firebase.js';
import { ServiceError } from './firebase.js';
import type { ActivityEvent, ConnectedApp, Preferences, RegisteredDevice } from './types.js';
import type {ForwardingJob,ForwardingTarget} from './forwarding.js';
import type {LeadNotification} from './leads-notifications.js';

export interface AppRow {
  id:string; user_id:string; name:string; bundle_id:string; apple_id:string; source:'apple'|'revenuecat';
  icon_url:string|null; webhook_secret:string; created_at:string; last_production_at:string|null; last_sandbox_at:string|null; active:boolean;
  forwarding?:{production:ForwardingTarget|null;sandbox:ForwardingTarget|null};
}
export interface DeviceRow {
  id:string; user_id:string; session_hash:string; token:string; name:string; environment:'production'|'sandbox';
  created_at:string; last_seen_at:string; active:number; generation:number;
}
export interface EventRow extends ActivityEvent { user_id:string; economic_key:string|null; signed_date:number }
export interface SessionRow { token_hash:string; user_id:string; auth_time:number; provider:'apple.com'; created_at:string; expires_at:string; expireAt:Timestamp }
export interface Job {
  id:string; user_id:string; event_id:string|null; app_id:string|null; device_id:string; device_name:string;
  session_hash:string; device_generation:number; kind:'event'|'test'|'lead'; lead?:LeadNotification; state:'pending'|'processing'|'sent'|'failed'|'cancelled';
  attempts:number; last_error:string|null; next_attempt_at:number; lease_until:number|null; lease_id:string|null;
  created_at:string; updated_at:string;
}
type Filter=[string,WhereFilterOp,unknown];
export const defaultPreferences:Preferences={sales:true,refunds:true,lifecycle:false,sandbox:false,hideAmounts:false};
const preferenceGroups = {
  sales: ['renewals'], refunds: ['refundReversals'],
  lifecycle: ['trials','autoRenewDisabled','autoRenewEnabled','billingIssues','expirations','otherUpdates'],
} as const;
export function resolvePreferences(stored: Partial<Preferences> = {}): Preferences {
  const result = {...defaultPreferences, ...stored};
  for (const [group, keys] of Object.entries(preferenceGroups)) {
    for (const key of keys) result[key] = result[key] ?? result[group as keyof Preferences]!;
  }
  return result;
}
export function patchPreferences(current: Preferences, patch: Partial<Preferences>): Preferences {
  const result = {...current, ...patch};
  // Older clients can still change whole groups; explicit individual choices win.
  for (const [group, keys] of Object.entries(preferenceGroups)) {
    const value = patch[group as keyof Preferences];
    if (value !== undefined && value !== current[group as keyof Preferences]) {
      for (const key of keys) if (patch[key] === undefined) result[key] = value;
    }
  }
  return resolvePreferences(result);
}

export const documentKey=(...parts:string[])=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Server-only Firestore repository. Transaction callbacks must complete reads before writes. */
export class Store {
  constructor(readonly db:Firestore,readonly identity:FirebaseIdentity,readonly prefix='',private tx?:Transaction) {}
  collection(name:string) {return this.db.collection(`${this.prefix}${name}`);}
  async get<T>(name:string,id:string):Promise<T|undefined> {
    if (!id || id.includes('/') || id.length>1500) return;
    const ref=this.collection(name).doc(id);
    const snapshot=this.tx ? await this.tx.get(ref) : await ref.get();
    return snapshot.exists ? snapshot.data() as T : undefined;
  }
  async query<T>(query:Query):Promise<T[]> {
    const snapshot=this.tx ? await this.tx.get(query) : await query.get();
    return snapshot.docs.map(doc=>doc.data() as T);
  }
  list<T>(name:string,filters:Filter[]=[],limit=1000) {
    let query:Query=this.collection(name);
    for (const [field,op,value] of filters) query=query.where(field,op,value);
    return this.query<T>(query.limit(limit));
  }
  async set(name:string,id:string,value:object,merge=false) {
    const ref=this.collection(name).doc(id);
    if (this.tx) {this.tx.set(ref,value as DocumentData,{merge});return;}
    await ref.set(value,{merge});
  }
  async delete(name:string,id:string) {
    const ref=this.collection(name).doc(id);
    if (this.tx) {this.tx.delete(ref);return;}
    await ref.delete();
  }
  atomic<T>(fn:(store:Store)=>Promise<T>):Promise<T> {return this.tx ? fn(this) : this.db.runTransaction(tx=>fn(new Store(this.db,this.identity,this.prefix,tx)));}
  // Admin SDK connections belong to the process, not an individual request/store.
  close() {}
  async accountDeleting(userId:string) {return !!await this.get('account_deletions',userId);}
  async assertAccountActive(userId:string) {
    if(await this.accountDeleting(userId)) throw new ServiceError(409,'Account deletion is in progress. Please wait before signing in again.');
  }
  async getApp(id:string,userId?:string) {
    const app=await this.get<AppRow>('apps',id);
    return app?.active && (!userId || app.user_id===userId) && !await this.accountDeleting(app.user_id) ? app : undefined;
  }
  async appForSecret(secret:string) {
    const mapping=await this.get<{app_id:string}>('webhook_keys',documentKey(secret));
    const app=mapping ? await this.getApp(mapping.app_id) : undefined;
    return app?.webhook_secret===secret ? app : undefined;
  }
  apps(userId:string) {return this.list<AppRow>('apps',[['user_id','==',userId],['active','==',true]],20);}
  appResponse(row:AppRow,publicUrl:string):ConnectedApp & {forwardingUrl:string} {
    const base=`${publicUrl}/webhooks/apple/${row.webhook_secret}`;
    return {id:row.id,name:row.name,bundleId:row.bundle_id,appleId:row.apple_id,source:row.source,iconUrl:row.icon_url,createdAt:row.created_at,
      webhookUrls:{production:`${base}/production`,sandbox:`${base}/sandbox`},forwardingUrl:`${base}/forward`,
      forwarding:{productionUrl:row.forwarding?.production?.url ?? null,sandboxUrl:row.forwarding?.sandbox?.url ?? null},
      lastProductionEventAt:row.last_production_at,lastSandboxEventAt:row.last_sandbox_at};
  }
  async preferences(userId:string):Promise<Preferences> {return resolvePreferences(await this.get<Preferences>('preferences',userId) ?? {});}
  eventResponse(row:EventRow):ActivityEvent {const {user_id:_owner,economic_key:_key,signed_date:_signed,...event}=row;return event;}
  async session(hash:string):Promise<(SessionRow & {user:{id:string;email:string}})|undefined> {
    const row=await this.get<SessionRow>('sessions',hash);
    if (!row || row.provider!=='apple.com' || row.expires_at<=new Date().toISOString() || await this.accountDeleting(row.user_id)) return;
    const user=await this.identity.valid(row.user_id,row.auth_time);
    return user ? {...row,user} : undefined;
  }
  async createApp(row:AppRow) {
    await this.atomic(async s=>{
      await s.assertAccountActive(row.user_id);
      const key=documentKey(row.user_id,row.bundle_id);
      const [owner,existing,apps]=await Promise.all([s.get('users',row.user_id),s.get('app_keys',key),s.apps(row.user_id)]);
      if (!owner) throw new ServiceError(401,'Sign in again.');
      if (existing) throw new ServiceError(409,'This bundle ID is already connected to your account.');
      if (apps.length>=20) throw new ServiceError(400,'This MVP supports up to 20 apps per account.');
      await s.set('users',row.user_id,{updated_at:new Date().toISOString()},true);
      await s.set('apps',row.id,row);
      await s.set('app_keys',key,{app_id:row.id});
      await s.set('webhook_keys',documentKey(row.webhook_secret),{app_id:row.id});
    });
  }
  async removeApp(id:string,userId:string) {
    await this.atomic(async s=>{
      const app=await s.getApp(id,userId);
      if (!app) throw new ServiceError(404,'App not found.');
      await s.set('apps',id,{active:false,forwarding:{production:null,sandbox:null},deleted_at:new Date().toISOString()},true);
      await s.delete('app_keys',documentKey(userId,app.bundle_id));
      await s.delete('webhook_keys',documentKey(app.webhook_secret));
    });
    // Tombstones immediately hide activity/prevent sends; a retrying function cleans retained data.
  }
  async rotateApp(id:string,userId:string) {
    return this.atomic(async s=>{
      const row=await s.getApp(id,userId);
      if (!row) throw new ServiceError(404,'App not found.');
      const app={...row,webhook_secret:newWebhookSecret(),last_production_at:null,last_sandbox_at:null};
      await s.delete('webhook_keys',documentKey(row.webhook_secret));
      await s.set('webhook_keys',documentKey(app.webhook_secret),{app_id:id});
      await s.set('apps',id,app);return app;
    });
  }
  makeJob(device:DeviceRow,event:ActivityEvent|null):Job {
    const now=new Date().toISOString();
    return {id:randomUUID(),user_id:device.user_id,event_id:event?.id ?? null,app_id:event?.appId ?? null,device_id:device.id,
      device_name:device.name,session_hash:device.session_hash,device_generation:device.generation,kind:event ? 'event' : 'test',state:'pending',attempts:0,
      last_error:null,next_attempt_at:Date.now(),lease_until:null,lease_id:null,created_at:now,updated_at:now};
  }
  async saveEvent(event:ActivityEvent,userId:string,economicKey:string|null,signedDate:number,receipt?:{uuid:string;secret:string;body?:string},historical=false) {
    return this.atomic(async s=>{
      const receiptId=receipt ? documentKey(event.appId,event.environment,receipt.uuid) : undefined;
      const economicId=economicKey ? documentKey(event.appId,event.environment,economicKey) : undefined;
      const [app,seen,economic,prefs,devices]=await Promise.all([
        s.getApp(event.appId,userId),receiptId ? s.get<{endpoint_hash?:string|null}>('notifications',receiptId) : undefined,
        economicId ? s.get<{event_id:string}>('economic_events',economicId) : undefined,
        s.preferences(userId),s.list<DeviceRow>('devices',[['user_id','==',userId],['active','==',1]],20),
      ]);
      const previous=economic ? await s.get<EventRow>('events',economic.event_id) : undefined;
      if (!app || (receipt && receipt.secret!==app.webhook_secret)) throw new ServiceError(404,'Notification endpoint no longer exists.');
      if (receipt && !historical) await s.set('apps',app.id,{[event.environment==='Production' ? 'last_production_at' : 'last_sandbox_at']:event.receivedAt},true);
      // Forward every distinct live Apple notification, including TEST and economically
      // deduplicated updates. Historical imports never forward; a later live receipt may.
      if(receiptId && receipt?.body && !historical && !seen?.endpoint_hash && event.environment!=='Demo') {
        const target=app.forwarding?.[event.environment==='Production' ? 'production' : 'sandbox'];
        if(target) {
          const job:ForwardingJob={id:receiptId,app_id:app.id,user_id:userId,environment:event.environment,notification_uuid:receipt.uuid,
            destination:target.url,generation:target.generation,body:receipt.body,state:'pending',attempts:0,
            next_attempt_at:Date.now(),lease_until:null,lease_id:null,last_error:null,status_code:null,
            created_at:event.receivedAt,updated_at:event.receivedAt,expireAt:Timestamp.fromMillis(Date.now()+7*86400000)};
          await s.set('forwarding_jobs',job.id,job);
        }
      }
      if(seen && receiptId && receipt && !historical && !seen.endpoint_hash) await s.set('notifications',receiptId,{endpoint_hash:documentKey(receipt.secret),received_at:event.receivedAt},true);
      if (seen) return 'duplicate';
      if (receiptId) await s.set('notifications',receiptId,{app_id:app.id,environment:event.environment,notification_uuid:receipt!.uuid,endpoint_hash:historical ? null : documentKey(receipt!.secret),received_at:event.receivedAt});
      if (previous) {
        if (signedDate>previous.signed_date) {
          const currency=event.currency ?? previous.currency;
          const amount=event.amountMilliunits ?? (currency===previous.currency ? previous.amountMilliunits : null);
          await s.set('events',previous.id,{amountMilliunits:amount,currency,detail:amount!==null && event.amountMilliunits===null ? previous.detail : event.detail,signed_date:signedDate},true);
        }
        return 'duplicate';
      }
      // Event, receipt, dedupe marker and outbox jobs commit together before HTTP 200.
      const row:EventRow={...event,user_id:userId,economic_key:economicKey,signed_date:signedDate};
      await s.set('events',event.id,row);
      if (economicId) await s.set('economic_events',economicId,{event_id:event.id,app_id:app.id});
      if (!historical && shouldNotify(event,prefs)) for (const device of devices) {const job=s.makeJob(device,event);await s.set('delivery_jobs',job.id,job);}
      return 'received';
    });
  }
  async activity(userId:string,options:{appId?:string;environment:string;before?:string;limit:number}) {
    const apps=await this.apps(userId);
    const ids=apps.map(app=>app.id).filter(id=>!options.appId || id===options.appId);
    const cursor=options.before ? await this.get<EventRow>('events',options.before) : undefined;
    if (options.before && (!cursor || cursor.user_id!==userId || !apps.some(app=>app.id===cursor.appId))) throw new ServiceError(400,'This activity page has expired. Refresh the activity feed.');
    if (!ids.length) return {events:[],nextCursor:null};
    let query:Query=this.collection('events').where('user_id','==',userId).where('appId','in',ids);
    if (options.environment!=='all') query=query.where('environment','==',options.environment);
    query=query.orderBy('receivedAt','desc').orderBy(FieldPath.documentId(),'desc');
    if (cursor) query=query.startAfter(cursor.receivedAt,cursor.id);
    const rows=await this.query<EventRow>(query.limit(options.limit+1));
    return {events:rows.slice(0,options.limit).map(row=>this.eventResponse(row)),nextCursor:rows.length>options.limit ? rows[options.limit-1].id : null};
  }
  deviceResponse(row:DeviceRow):RegisteredDevice {return {id:row.id,name:row.name,environment:row.environment,createdAt:row.created_at,lastSeenAt:row.last_seen_at,active:!!row.active};}
  async registerDevice(userId:string,sessionHash:string,input:{token:string;name:string;environment:DeviceRow['environment']}) {
    return this.atomic(async s=>{
      await s.assertAccountActive(userId);
      const registryId=documentKey(input.token,input.environment);
      const [registry,session,devices,owner]=await Promise.all([
        s.get<{device_id:string}>('device_tokens',registryId),s.session(sessionHash),
        s.list<DeviceRow>('devices',[['user_id','==',userId],['active','==',1]],20),s.get('users',userId),
      ]);
      const previous=registry ? await s.get<DeviceRow>('devices',registry.device_id) : undefined;
      if (!session || session.user_id!==userId || !owner) throw new ServiceError(401,'Sign in again.');
      const same=previous?.user_id===userId && previous.session_hash===sessionHash;
      if (devices.filter(d=>d.session_hash!==sessionHash && d.id!==previous?.id).length>=20) throw new ServiceError(400,'Disconnect a device before connecting another.');
      const now=new Date().toISOString();
      const row:DeviceRow={id:same ? previous.id : randomUUID(),user_id:userId,session_hash:sessionHash,...input,
        created_at:same ? previous.created_at : now,last_seen_at:new Date(Math.max(Date.now(),Date.parse(previous?.last_seen_at ?? now)+1)).toISOString(),active:1,
        generation:same ? previous.generation+(previous.active ? 0 : 1) : 1};
      await s.set('users',userId,{updated_at:now},true);
      if (previous && !same) await s.set('devices',previous.id,{active:0},true);
      for (const old of devices) if (old.session_hash===sessionHash && old.id!==row.id) await s.set('devices',old.id,{active:0},true);
      await s.set('device_tokens',registryId,{device_id:row.id});
      await s.set('devices',row.id,row);return row;
    });
  }
  async disableDevice(id:string,userId:string,callerSession:string) {
    await this.atomic(async s=>{
      await s.assertAccountActive(userId);
      const device=await s.get<DeviceRow>('devices',id);
      if (!device || device.user_id!==userId) throw new ServiceError(404,'Device not found.');
      await s.set('devices',id,{active:0},true);
      if (device.session_hash!==callerSession) await s.delete('sessions',device.session_hash);
    });
  }
  async enqueue(deviceId:string,userId:string) {
    return this.atomic(async s=>{
      await s.assertAccountActive(userId);
      const device=await s.get<DeviceRow>('devices',deviceId);
      if (!device?.active || device.user_id!==userId) throw new ServiceError(404,'Active device not found.');
      const job=s.makeJob(device,null);await s.set('delivery_jobs',job.id,job);return job.id;
    });
  }
  async deliveries(userId:string,limit:number) {
    const rows=await this.query<Job>(this.collection('delivery_jobs').where('user_id','==',userId).orderBy('created_at','desc').limit(limit));
    return rows.map(j=>({id:j.id,eventId:j.event_id,deviceId:j.device_id,deviceName:j.device_name,state:j.state,attempts:j.attempts,lastError:j.last_error,createdAt:j.created_at,updatedAt:j.updated_at}));
  }
  async updateForwarding(id:string,userId:string,urls:{productionUrl:string|null;sandboxUrl:string|null}) {
    return this.atomic(async s=>{
      const app=await s.getApp(id,userId);
      if(!app) throw new ServiceError(404,'App not found.');
      if(app.source==='revenuecat' && (urls.productionUrl || urls.sandboxUrl)) throw new ServiceError(400,'Keep RevenueCat as the receiver and configure its forwarding URL to Quest.');
      const target=(key:'production'|'sandbox',url:string|null)=>url ? app.forwarding?.[key]?.url===url ? app.forwarding[key] : {url,generation:randomUUID()} : null;
      const updated={...app,forwarding:{production:target('production',urls.productionUrl),sandbox:target('sandbox',urls.sandboxUrl)}};
      await s.set('apps',id,updated);return updated;
    });
  }
  async forwardingDeliveries(appId:string,userId:string) {
    const rows=await this.query<ForwardingJob>(this.collection('forwarding_jobs').where('user_id','==',userId).where('app_id','==',appId).orderBy('created_at','desc').limit(20));
    return rows.map(j=>({id:j.id,environment:j.environment,state:j.state,attempts:j.attempts,statusCode:j.status_code,lastError:j.last_error,createdAt:j.created_at,updatedAt:j.updated_at}));
  }
}
export function newWebhookSecret() {return randomBytes(32).toString('base64url');}
export function shouldNotify(event:ActivityEvent,p:Preferences):boolean {
  if (event.environment==='Demo') return true;
  if (event.environment==='Sandbox' && !p.sandbox) return false;
  if (event.kind==='test') return false;
  const resolved = resolvePreferences(p);
  switch (event.kind) {
    case 'sale': return resolved.sales;
    case 'renewal': return resolved.renewals!;
    case 'refund': return resolved.refunds;
    case 'refund_reversed': return resolved.refundReversals!;
    case 'trial': return resolved.trials!;
    case 'auto_renew_disabled': return resolved.autoRenewDisabled!;
    case 'auto_renew_enabled': return resolved.autoRenewEnabled!;
    case 'billing_issue': return resolved.billingIssues!;
    case 'expired': return resolved.expirations!;
    default: return resolved.otherUpdates!;
  }
}
