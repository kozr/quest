import { connect, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ApnsConfiguration } from './config.js';
import type { DeviceRow } from './database.js';
import type { ActivityEvent, Preferences } from './types.js';

export interface PushResult { ok: boolean; retryable?: boolean; invalidDevice?: boolean; invalidatedAt?: number; error?: string }
export interface PushTransport {
  send(device: DeviceRow, payload: Record<string,unknown>, jobId: string): Promise<PushResult>;
  close?(): void;
}

export function pushPayload(event: ActivityEvent | null, preferences: Preferences): Record<string,unknown> {
  if (!event) return {aps:{alert:{title:'Phone notifications working',body:'This is a test push. Your Apple connection is verified separately.'},sound:'default'}};
  const prefix = event.environment === 'Demo' ? '[Demo] ' : event.environment === 'Sandbox' ? '[Sandbox] ' : '';
  let amount = '';
  if (!preferences.hideAmounts && event.amountMilliunits !== null && event.currency) {
    try { amount = ` · ${new Intl.NumberFormat('en',{style:'currency',currency:event.currency,currencyDisplay:'code'}).format(event.amountMilliunits/1000)}`; }
    catch { /* Missing/unrecognized currency must never prevent the notification. */ }
  }
  return {
    aps:{alert:{title:`${prefix}${event.title}`,body:`${event.appName}${amount}${event.productId ? ` · ${event.productId}` : ''}`},sound:'default', 'thread-id':event.appId},
    eventId:event.id, appId:event.appId, environment:event.environment,
  };
}

export class ApnsClient implements PushTransport {
  private readonly key: KeyObject;
  private jwt = '';
  private jwtCreatedAt = 0;
  private sessions = new Map<string,ClientHttp2Session>();
  constructor(private readonly config: ApnsConfiguration) {
    this.key = createPrivateKey(readFileSync(config.privateKeyPath));
    if (this.key.asymmetricKeyType !== 'ec' || this.key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('APNS_PRIVATE_KEY_PATH must contain the Apple P-256 APNs private key.');
    }
  }
  private authorization(): string {
    const now = Math.floor(Date.now()/1000);
    if (!this.jwt || now-this.jwtCreatedAt >= 2400) {
      const header = Buffer.from(JSON.stringify({alg:'ES256',kid:this.config.keyId})).toString('base64url');
      const claims = Buffer.from(JSON.stringify({iss:this.config.teamId,iat:now})).toString('base64url');
      const input = `${header}.${claims}`;
      const signature = sign('sha256',Buffer.from(input),{key:this.key,dsaEncoding:'ieee-p1363'}).toString('base64url');
      this.jwt = `${input}.${signature}`; this.jwtCreatedAt = now;
    }
    return `bearer ${this.jwt}`;
  }
  private session(environment: DeviceRow['environment']) {
    let session = this.sessions.get(environment);
    if (!session || session.closed || session.destroyed) {
      session = connect(environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
      // Stream error handlers report delivery failures; an idle connection must not crash the service.
      session.on('error',()=>{});
      session.on('goaway',()=>{ session?.close(); this.sessions.delete(environment); });
      this.sessions.set(environment,session);
    }
    return session;
  }
  async send(device: DeviceRow, payload: Record<string,unknown>, jobId: string): Promise<PushResult> {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body)>4096) return {ok:false,error:'Push payload exceeds the APNs limit.',retryable:false};
    return new Promise(resolve=>{
      let settled = false;
      const finish = (result: PushResult) => { if (!settled) { settled = true; resolve(result); } };
      try {
        const stream = this.session(device.environment).request({
          ':method':'POST', ':path':`/3/device/${device.token}`, authorization:this.authorization(),
          'apns-topic':this.config.topic, 'apns-push-type':'alert', 'apns-priority':'10',
          'apns-id':jobId, 'apns-collapse-id':jobId,
          'apns-expiration':String(Math.floor(Date.now()/1000)+3600), 'content-type':'application/json',
        });
        let status = 0; let responseBody = '';
        stream.on('response',headers=>{status = Number(headers[':status']);});
        stream.setEncoding('utf8');
        stream.on('data',(chunk:string)=>{if (responseBody.length<8192) responseBody += chunk;});
        stream.on('error',()=>finish({ok:false,retryable:true,error:'APNs connection failed.'}));
        stream.on('close',()=>finish({ok:false,retryable:true,error:'APNs closed the connection before responding.'}));
        stream.setTimeout(15000,()=>{finish({ok:false,retryable:true,error:'APNs request timed out.'}); stream.close();});
        stream.on('end',()=>{
          if (status===200) return finish({ok:true});
          let reason = 'APNs rejected the request.'; let invalidatedAt: number | undefined;
          try {
            const parsed = JSON.parse(responseBody);
            if (typeof parsed.reason==='string') reason=parsed.reason.slice(0,150);
            if (status===410 && Number.isSafeInteger(parsed.timestamp) && parsed.timestamp>=0) invalidatedAt=parsed.timestamp;
          } catch {}
          if (reason==='ExpiredProviderToken') this.jwt='';
          finish({ok:false,error:reason,invalidatedAt,retryable:status===429 || status>=500 || reason==='ExpiredProviderToken',
            invalidDevice:status===410 || ['BadDeviceToken','DeviceTokenNotForTopic','Unregistered'].includes(reason)});
        });
        stream.end(body);
      } catch { finish({ok:false,retryable:true,error:'Could not open an APNs connection.'}); }
    });
  }
  close() { for (const session of this.sessions.values()) session.destroy(); this.sessions.clear(); }
}
