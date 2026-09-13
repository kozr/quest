import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList,isIP} from 'node:net';
import {randomUUID} from 'node:crypto';
import type {LookupFunction} from 'node:net';
import type {Timestamp} from 'firebase-admin/firestore';
import {Store} from './database.js';
import {ServiceError} from './firebase.js';
import {RetryDelivery} from './worker.js';
import type {AppleEnvironment} from './types.js';

export interface ForwardingTarget {url:string;generation:string}
export interface ForwardingJob {
  id:string;app_id:string;user_id:string;environment:AppleEnvironment;notification_uuid:string;
  destination:string|null;generation:string;body:string|null;
  state:'pending'|'processing'|'sent'|'failed'|'cancelled';attempts:number;
  next_attempt_at:number;lease_until:number|null;lease_id:string|null;
  last_error:string|null;status_code:number|null;created_at:string;updated_at:string;expireAt:Timestamp;
}
export type ResolveHost=(hostname:string)=>Promise<{address:string;family:number}[]>;
const resolveHost:ResolveHost=hostname=>lookup(hostname,{all:true,verbatim:true});
const blocked=new BlockList();
for(const [address,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
] as const) blocked.addSubnet(address,prefix,'ipv4');
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) blocked.addSubnet(address,prefix,'ipv6');
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
export function isPublicAddress(address:string):boolean {
  const family=isIP(address);
  return family===4 ? !blocked.check(address,'ipv4') : family===6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
export function forwardingUrl(value:string,publicUrl:string):URL {
  let url:URL;
  try {url=new URL(value);} catch {throw new ServiceError(400,'Enter a valid HTTPS forwarding URL.');}
  const hostname=url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
  const ownHostname=new URL(publicUrl).hostname.replace(/\.$/,'').toLowerCase();
  if(url.protocol!=='https:' || url.username || url.password || url.hash || (url.port && url.port!=='443')) throw new ServiceError(400,'Forwarding requires HTTPS on port 443, without a username, password, or fragment.');
  if(hostname===ownHostname || /\/webhooks\/apple\//i.test(url.pathname)) throw new ServiceError(400,'Use your existing server’s URL, not a Quest notification URL.');
  if(hostname==='localhost' || !hostname.includes('.') && !isIP(hostname) || /\.(localhost|local|internal|test|invalid)$/.test(hostname) || isIP(hostname) && !isPublicAddress(hostname)) throw new ServiceError(400,'Use a publicly reachable server for forwarding.');
  return url;
}
export async function forwardingAddresses(url:URL,resolve:ResolveHost=resolveHost) {
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const addresses=isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await Promise.race([
      resolve(hostname),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout')),5000);}),
    ]);
    if(!addresses.length || addresses.some(item=>!isPublicAddress(item.address))) throw new ServiceError(400,'Forwarding must resolve only to public IP addresses.');
    return addresses;
  } catch(error) {
    if(error instanceof ServiceError) throw error;
    throw new ServiceError(422,'The forwarding server could not be resolved. Check the URL and try again.');
  } finally {clearTimeout(timer);}
}
export interface ForwardResult {ok:boolean;retryable:boolean;status:number|null;error?:string}
export interface ForwardTransport {send(url:string,body:string):Promise<ForwardResult>}
/** Resolve at every attempt, pin the vetted address to the socket, and never follow redirects. */
export class HttpsForwardTransport implements ForwardTransport {
  constructor(private publicUrl:string,private dependencies:{resolve?:ResolveHost;request?:typeof request}={}) {}
  async send(destination:string,body:string):Promise<ForwardResult> {
    let url:URL;let addresses:Awaited<ReturnType<typeof forwardingAddresses>>;
    try {url=forwardingUrl(destination,this.publicUrl);addresses=await forwardingAddresses(url,this.dependencies.resolve);}
    catch(error) {return {ok:false,retryable:!(error instanceof ServiceError && error.status===400),status:null,error:'Forwarding destination is unavailable or is not a public HTTPS server.'};}
    const pinned=addresses[0];
    const lookupPinned:LookupFunction=(_hostname,options,callback)=>{
      if(options.all) callback(null,[pinned]);else callback(null,pinned.address,pinned.family);
    };
    return new Promise(resolve=>{
      const req=(this.dependencies.request ?? request)(url,{method:'POST',agent:false,lookup:lookupPinned,minVersion:'TLSv1.2',maxHeaderSize:16384,
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'User-Agent':'Quest-Notification-Forwarder/1.0'},
      },res=>{
        const status=res.statusCode ?? 0;
        // No response data or headers are logged, stored, or exposed. Stop reading immediately.
        res.destroy();clearTimeout(timer);
        resolve({ok:status>=200 && status<=206,retryable:status<300 || status>=400,status,error:status>=200 && status<=206 ? undefined : `Forwarding server returned HTTP ${status}.`});
      });
      const timer=setTimeout(()=>req.destroy(new Error('Timeout')),10000);
      req.on('error',()=>{clearTimeout(timer);resolve({ok:false,retryable:true,status:null,error:'Forwarding timed out or the HTTPS connection failed.'});});
      req.end(body);
    });
  }
}

export class ForwardingWorker {
  private timer:ReturnType<typeof setInterval>|undefined;
  private inFlight:Promise<void>|undefined;
  constructor(private store:Store,private transport:ForwardTransport) {}
  start() {if(!this.timer) {this.timer=setInterval(()=>{void this.tick().catch(()=>console.error('Forwarding retry pending.'));},1500);this.timer.unref();}}
  async stop() {if(this.timer) clearInterval(this.timer);this.timer=undefined;await this.inFlight;}
  async tick() {
    if(this.inFlight) return;
    this.inFlight=(async()=>{
      const jobs=await this.store.query<ForwardingJob>(this.store.collection('forwarding_jobs').where('state','in',['pending','processing']).where('next_attempt_at','<=',Date.now()).orderBy('next_attempt_at').limit(20));
      await Promise.all(jobs.map(async job=>{try {await this.deliver(job.id);} catch(error) {if(!(error instanceof RetryDelivery)) throw error;}}));
    })();
    try {await this.inFlight;} finally {this.inFlight=undefined;}
  }
  async deliver(id:string):Promise<void> {
    const now=Date.now();const leaseId=randomUUID();
    const job=await this.store.atomic(async s=>{
      const row=await s.get<ForwardingJob>('forwarding_jobs',id);
      if(!row || !['pending','processing'].includes(row.state)) return;
      const app=await s.getApp(row.app_id,row.user_id);
      const target=app?.forwarding?.[row.environment==='Production' ? 'production' : 'sandbox'];
      if(!target || target.generation!==row.generation || target.url!==row.destination || !row.body) {
        await s.set('forwarding_jobs',id,{state:'cancelled',body:null,destination:null,lease_id:null,lease_until:null,last_error:'App removed or forwarding destination changed.',updated_at:new Date(now).toISOString()},true);return;
      }
      if((row.state==='processing' && (row.lease_until ?? 0)>now) || row.next_attempt_at>now) throw new RetryDelivery('Forwarding is leased or not yet due.');
      if(now-Date.parse(row.created_at)>=86400000 || row.attempts>=30) {
        await s.set('forwarding_jobs',id,{state:'failed',body:null,destination:null,lease_id:null,lease_until:null,last_error:'Forwarding retry window expired.',updated_at:new Date(now).toISOString()},true);return;
      }
      const claimed:ForwardingJob={...row,state:'processing',attempts:row.attempts+1,lease_until:now+60000,lease_id:leaseId,updated_at:new Date(now).toISOString()};
      await s.set('forwarding_jobs',id,claimed);return claimed;
    });
    if(!job) return;
    let result:ForwardResult;
    try {result=await this.transport.send(job.destination!,job.body!);}
    catch {result={ok:false,retryable:true,status:null,error:'Forwarding transport unavailable.'};}
    const pending=!result.ok && result.retryable && job.attempts<30 && Date.now()-Date.parse(job.created_at)<86400000;
    await this.store.atomic(async s=>{
      const current=await s.get<ForwardingJob>('forwarding_jobs',id);
      if(current?.state!=='processing' || current.lease_id!==job.lease_id) return;
      await s.set('forwarding_jobs',id,{state:result.ok ? 'sent' : pending ? 'pending' : 'failed',status_code:result.status,last_error:result.ok ? null : result.error ?? 'Forwarding failed.',
        lease_id:null,lease_until:null,updated_at:new Date().toISOString(),next_attempt_at:Date.now()+Math.min(3600000,10000*2**(job.attempts-1)),
        ...(!pending ? {body:null,destination:null} : {}),
      },true);
    });
    if(pending) throw new RetryDelivery('Retryable forwarding error.');
  }
}
