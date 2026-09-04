import { Store, shouldNotify, type DeviceRow, type EventRow } from './database.js';
import { pushPayload, type PushTransport, type PushResult } from './apns.js';

interface Job { id: string; event_id: string | null; device_id: string; attempts: number; created_at: string }
export class DeliveryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private inFlight: Promise<void> | undefined;
  constructor(private store: Store, private transport: PushTransport | null) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(()=>{void this.tick().catch(()=>console.error('Delivery worker failed; queued jobs will be retried.'));},1500);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer=undefined;
    await this.inFlight;
    this.transport?.close?.();
  }
  async tick() {
    if (this.running || !this.transport) return;
    this.running=true;
    this.inFlight=this.processBatch();
    try { await this.inFlight; } finally { this.running=false; this.inFlight=undefined; }
  }
  private async processBatch() {
    for (let index=0;index<10;index++) {
      const now=Date.now();
      const job=this.store.transaction(()=>{
        const row=this.store.db.prepare(`SELECT * FROM delivery_jobs WHERE (state='pending' AND next_attempt_at<=?)
          OR (state='processing' AND lease_until<=?) ORDER BY next_attempt_at ASC LIMIT 1`).get(now,now) as unknown as Job | undefined;
        if (!row) return;
        this.store.db.prepare(`UPDATE delivery_jobs SET state='processing',attempts=attempts+1,lease_until=?,updated_at=? WHERE id=?`)
          .run(now+60000,new Date(now).toISOString(),row.id);
        return {...row,attempts:row.attempts+1};
      });
      if (!job) return;
      const device=this.store.db.prepare(`SELECT devices.* FROM devices JOIN sessions ON sessions.token_hash=devices.session_hash
        WHERE devices.id=? AND devices.active=1 AND sessions.expires_at>?`).get(job.device_id,new Date().toISOString()) as unknown as DeviceRow | undefined;
      if (!device) { this.finish(job.id,'cancelled','Device disconnected or session expired.'); continue; }
      if (Date.now()-Date.parse(job.created_at)>24*60*60*1000) { this.finish(job.id,'cancelled','Notification is more than 24 hours old.'); continue; }
      const row=job.event_id ? this.store.db.prepare('SELECT * FROM events WHERE id=?').get(job.event_id) as unknown as EventRow | undefined : undefined;
      const event=row ? this.store.eventResponse(row) : null;
      const preferences=this.store.preferences(device.user_id);
      if (job.event_id && (!event || !shouldNotify(event,preferences))) {this.finish(job.id,'cancelled','Notification preferences changed.'); continue;}
      let result: PushResult;
      try { result=await this.transport!.send(device,pushPayload(event,preferences),job.id); }
      catch { result={ok:false,retryable:true,error:'Push transport unavailable.'}; }
      if (result.ok) this.finish(job.id,'sent',null);
      else if (result.invalidDevice) {
        this.store.transaction(()=>{
          this.finish(job.id,'failed',result.error ?? 'Device token is invalid.');
          const current=this.store.db.prepare('SELECT last_seen_at FROM devices WHERE id=?').get(device.id);
          if (current?.last_seen_at===device.last_seen_at &&
              (result.invalidatedAt===undefined || Date.parse(String(current.last_seen_at))<=result.invalidatedAt)) {
            this.store.disableDevice(device.id);
          }
        });
      } else if (result.retryable && job.attempts<8) {
        const retryAt=Date.now()+Math.min(3600000,5000*2**(job.attempts-1));
        this.store.db.prepare(`UPDATE delivery_jobs SET state='pending',last_error=?,next_attempt_at=?,lease_until=NULL,updated_at=?
          WHERE id=? AND state='processing'`).run(result.error ?? 'Temporary push failure.',retryAt,new Date().toISOString(),job.id);
      } else this.finish(job.id,'failed',result.error ?? 'APNs rejected this notification.');
    }
  }
  private finish(id: string, state: 'sent'|'failed'|'cancelled', error: string | null) {
    this.store.db.prepare(`UPDATE delivery_jobs SET state=?,last_error=?,lease_until=NULL,updated_at=? WHERE id=? AND state='processing'`)
      .run(state,error,new Date().toISOString(),id);
  }
}
