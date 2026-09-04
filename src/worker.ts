import {randomUUID} from 'node:crypto';
import {Store,shouldNotify,type DeviceRow,type EventRow,type Job} from './database.js';
import {pushPayload,type PushTransport,type PushResult} from './apns.js';

export class RetryDelivery extends Error {}
export class DeliveryWorker {
  private timer:ReturnType<typeof setInterval>|undefined;
  private inFlight:Promise<void>|undefined;
  constructor(private store:Store,private transport:PushTransport|null) {}
  /** Local emulator runner only. Production dispatch is Cloud Tasks, not an interval. */
  start() {if(!this.timer) {this.timer=setInterval(()=>{void this.tick().catch(()=>console.error('Delivery retry pending.'));},1500);this.timer.unref();}}
  async stop() {if(this.timer) clearInterval(this.timer);this.timer=undefined;await this.inFlight;this.transport?.close?.();}
  async tick() {
    if(this.inFlight || !this.transport) return;
    this.inFlight=(async()=>{
      const jobs=await this.store.query<Job>(this.store.collection('delivery_jobs').where('state','in',['pending','processing']).where('next_attempt_at','<=',Date.now()).orderBy('next_attempt_at').limit(20));
      for(const job of jobs) try {await this.deliver(job.id);} catch(error) {if(!(error instanceof RetryDelivery)) throw error;}
    })();
    try {await this.inFlight;} finally {this.inFlight=undefined;}
  }
  /** Safe under concurrent task retries: a unique lease fences late completions. */
  async deliver(id:string):Promise<void> {
    if(!this.transport) throw new RetryDelivery('APNs is not configured.');
    const leaseId=randomUUID();const now=Date.now();
    const job=await this.store.atomic(async s=>{
      const row=await s.get<Job>('delivery_jobs',id);
      if(!row || !['pending','processing'].includes(row.state)) return;
      if((row.state==='processing' && (row.lease_until ?? 0)>now) || row.next_attempt_at>now) throw new RetryDelivery('Delivery is leased or not yet due.');
      const claimed:Job={...row,state:'processing',attempts:row.attempts+1,lease_until:now+60000,lease_id:leaseId,updated_at:new Date(now).toISOString()};
      await s.set('delivery_jobs',id,claimed);return claimed;
    });
    if(!job) return;
    const device=await this.store.get<DeviceRow>('devices',job.device_id);
    const session=device ? await this.store.session(device.session_hash) : undefined;
    if(!device?.active || device.user_id!==job.user_id || device.session_hash!==job.session_hash || device.generation!==job.device_generation || !session) {await this.finish(job,'cancelled','Device disconnected or session expired.');return;}
    if(now-Date.parse(job.created_at)>86400000) {await this.finish(job,'cancelled','Notification is more than 24 hours old.');return;}
    const row=job.event_id ? await this.store.get<EventRow>('events',job.event_id) : undefined;
    const app=row ? await this.store.getApp(row.appId,job.user_id) : undefined;
    const event=row && app ? this.store.eventResponse(row) : null;
    const preferences=await this.store.preferences(device.user_id);
    if(job.event_id && (!event || !shouldNotify(event,preferences))) {await this.finish(job,'cancelled','App removed or notification preferences changed.');return;}
    let result:PushResult;
    try {result=await this.transport.send(device,pushPayload(event,preferences),job.id);}
    catch {result={ok:false,retryable:true,error:'Push transport unavailable.'};}
    if(result.ok) await this.finish(job,'sent',null);
    else if(result.invalidDevice) {
      await this.store.atomic(async s=>{
        const [current,delivery]=await Promise.all([s.get<DeviceRow>('devices',device.id),s.get<Job>('delivery_jobs',job.id)]);
        if(delivery?.state!=='processing' || delivery.lease_id!==job.lease_id) return;
        await s.set('delivery_jobs',job.id,{state:'failed',last_error:result.error ?? 'Device token is invalid.',lease_until:null,lease_id:null,updated_at:new Date().toISOString()},true);
        if(current?.last_seen_at===device.last_seen_at && (result.invalidatedAt===undefined || Date.parse(current.last_seen_at)<=result.invalidatedAt)) await s.set('devices',device.id,{active:0},true);
      });
    } else if(result.retryable && job.attempts<8) {
      await this.finish(job,'pending',result.error ?? 'Temporary push failure.',Date.now()+Math.min(3600000,5000*2**(job.attempts-1)));
      throw new RetryDelivery('Retryable APNs error.');
    } else await this.finish(job,'failed',result.error ?? 'APNs rejected this notification.');
  }
  private async finish(job:Job,state:Job['state'],error:string|null,retryAt?:number) {
    await this.store.atomic(async s=>{
      const current=await s.get<Job>('delivery_jobs',job.id);
      if(current?.state!=='processing' || current.lease_id!==job.lease_id) return;
      await s.set('delivery_jobs',job.id,{state,last_error:error,lease_until:null,lease_id:null,updated_at:new Date().toISOString(),...(retryAt!==undefined ? {next_attempt_at:retryAt} : {})},true);
    });
  }
}
