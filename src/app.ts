import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Configuration } from './config.js';
import { Store, newWebhookSecret, type AppRow, type DeviceRow, type EventRow } from './database.js';
import { authenticate, clearSessionCookie, createSession, hashPassword, rateLimit, setSessionCookie, verifyPassword, type AuthenticatedRequest } from './auth.js';
import { AppleVerificationError, loadAppleRootCertificates, verifyAppleNotification, type AppleNotificationContext, type VerifiedAppleNotification } from './apple.js';
import { normalizeAppleNotification } from './normalize.js';
import { lookupApp, safeIconUrl } from './metadata.js';
import { ApnsClient, type PushTransport } from './apns.js';
import { DeliveryWorker } from './worker.js';
import { cancelBrowserPairing, PairingError, pairingRouter } from './pairing.js';
import type { ActivityEvent, AppleEnvironment } from './types.js';

export interface ApplicationOptions extends Configuration {
  /** Dependency injection for local automated tests, never configurable via HTTP or an environment flag. */
  verify?: (payload: string, context: AppleNotificationContext) => Promise<VerifiedAppleNotification>;
  lookup?: typeof lookupApp;
  pushTransport?: PushTransport | null;
  webDirectory?: string;
}
class HttpError extends Error { constructor(public status: number, message: string) {super(message);} }
const credentials = z.object({email:z.string().trim().email().max(254).transform(v=>v.toLowerCase()),password:z.string().min(12).max(128),client:z.literal('ios').optional()}).strict();
const appInput = z.object({
  name:z.string().trim().min(1).max(80), bundleId:z.string().trim().min(3).max(255).regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
  appleId:z.string().trim().regex(/^[1-9]\d{0,14}$/), source:z.enum(['apple','revenuecat']),
  iconUrl:z.string().max(2048).nullable().optional(),
}).strict();
const preferenceInput=z.object({sales:z.boolean().optional(),refunds:z.boolean().optional(),lifecycle:z.boolean().optional(),sandbox:z.boolean().optional(),hideAmounts:z.boolean().optional()}).strict();
const deviceInput=z.object({token:z.string().regex(/^[a-fA-F0-9]{64,512}$/).refine(v=>v.length%2===0),name:z.string().trim().min(1).max(80),environment:z.enum(['production','sandbox'])}).strict();
const authenticated=(req: Request)=>req as AuthenticatedRequest;

export function createApplication(options: ApplicationOptions) {
  const store=new Store(options.databasePath);
  const transport=options.pushTransport !== undefined ? options.pushTransport : options.apns ? new ApnsClient(options.apns) : null;
  const worker=new DeliveryWorker(store,transport);
  const app=express();
  const secureCookie=options.publicUrl.startsWith('https://');
  const verify=options.verify ?? (async (payload,context)=>verifyAppleNotification(payload,context,await loadAppleRootCertificates(options.appleRootDirectory)));
  app.disable('x-powered-by');
  // Do not trust client-supplied forwarding headers. Configure a specific trusted proxy before multi-host rollout.
  app.set('trust proxy',false);
  app.use((_req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.mzstatic.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (options.production) res.setHeader('Strict-Transport-Security','max-age=31536000');
    next();
  });
  app.get('/healthz',(_req,res)=>{store.db.prepare('SELECT 1').get();res.json({ok:true});});
  app.use('/webhooks',rateLimit(3000,60000),express.json({limit:'256kb'}));
  app.post('/webhooks/apple/:secret/:environment',async(req,res)=>{
    const source=store.db.prepare('SELECT * FROM apps WHERE webhook_secret=?').get(req.params.secret) as unknown as AppRow | undefined;
    if (!source || !['production','sandbox','forward'].includes(req.params.environment)) throw new HttpError(404,'Notification endpoint not found.');
    const {signedPayload}=z.object({signedPayload:z.string().min(1).max(131072)}).strict().parse(req.body);
    let environment: AppleEnvironment=req.params.environment==='sandbox' ? 'Sandbox' : 'Production';
    if (req.params.environment==='forward') {
      // Routing hint ONLY. The complete JWS plus app/environment binding is verified below.
      try {
        const hint=JSON.parse(Buffer.from(signedPayload.split('.')[1] ?? '','base64url').toString());
        const indicated=hint.data?.environment ?? hint.summary?.environment ?? hint.appData?.environment ??
          (typeof hint.externalPurchaseToken?.externalPurchaseId==='string' ?
            (hint.externalPurchaseToken.externalPurchaseId.startsWith('SANDBOX') ? 'Sandbox' : 'Production') : undefined);
        if (indicated!=='Production' && indicated!=='Sandbox') throw new Error();
        environment=indicated;
      } catch {throw new HttpError(400,'The forwarded notification has no valid environment.');}
    }
    const verified=await verify(signedPayload,{bundleId:source.bundle_id,appleId:source.apple_id,environment});
    const normalized=normalizeAppleNotification(verified);
    const now=new Date().toISOString();
    const outcome=store.transaction(()=>{
      // The source might have been deleted/rotated during asynchronous verification.
      const current=store.getApp(source.id);
      if (!current || current.webhook_secret!==source.webhook_secret) throw new HttpError(404,'Notification endpoint no longer exists.');
      const statusColumn=environment==='Production' ? 'last_production_at' : 'last_sandbox_at';
      store.db.prepare(`UPDATE apps SET ${statusColumn}=? WHERE id=?`).run(now,source.id);
      const previous=store.db.prepare('SELECT id FROM notifications WHERE app_id=? AND environment=? AND notification_uuid=?')
        .get(source.id,environment,normalized.notificationUUID);
      if (previous) return 'duplicate';
      store.db.prepare(`INSERT INTO notifications (app_id,environment,notification_uuid,notification_type,signed_date,received_at) VALUES (?,?,?,?,?,?)`)
        .run(source.id,environment,normalized.notificationUUID,normalized.notificationType,normalized.signedDate,now);
      const economic=normalized.economicKey ? store.db.prepare('SELECT * FROM events WHERE app_id=? AND environment=? AND economic_key=?')
        .get(source.id,environment,normalized.economicKey) as unknown as EventRow | undefined : undefined;
      if (economic) {
        if (normalized.signedDate>economic.signed_date) {
          // Update a later snapshot without issuing a second push for the same economic transition.
          const currency=normalized.currency ?? economic.currency;
          const amount=normalized.amountMilliunits ?? (currency===economic.currency ? economic.amount_milliunits : null);
          store.db.prepare(`UPDATE events SET amount_milliunits=?,currency=?,detail=?,signed_date=? WHERE id=?`)
            .run(amount,currency,amount!==null && normalized.amountMilliunits===null ? economic.detail : normalized.detail,normalized.signedDate,economic.id);
        }
        return 'duplicate';
      }
      const event: ActivityEvent={...normalized,id:randomUUID(),appId:source.id,appName:source.name,receivedAt:now};
      store.insertEvent(event,normalized.economicKey,normalized.signedDate);
      store.queueEvent(event,source.user_id);
      return 'received';
    });
    res.status(200).json({ok:true,status:outcome});
  });

  app.use('/api',express.json({limit:'32kb'}),(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  app.get('/api/config',(_req,res)=>res.json({serviceName:'IAP Notifications',registrationEnabled:options.registrationEnabled,demoEnabled:options.demoEnabled,apnsConfigured:!!transport,publicUrl:options.publicUrl}));
  app.use('/api/pairing',pairingRouter(store,options.publicUrl));
  const authLimiter=rateLimit(20,15*60000);
  app.use(['/api/auth/login','/api/auth/register'],authLimiter,(req,res,next)=>{
    if (req.headers.origin && req.headers.origin!==options.publicUrl) return res.status(403).json({error:'Sign in from this app’s own page.'});
    next();
  });
  app.post('/api/auth/register',async(req,res)=>{
    if (!options.registrationEnabled) throw new HttpError(403,'New account registration is disabled on this server.');
    const input=credentials.parse(req.body);
    const passwordHash=await hashPassword(input.password); const user={id:randomUUID(),email:input.email};
    let token: string;
    try {
      token=store.transaction(()=>{
        store.db.prepare('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)').run(user.id,user.email,passwordHash,new Date().toISOString());
        store.db.prepare('INSERT INTO preferences (user_id) VALUES (?)').run(user.id);
        return createSession(store,user.id);
      });
    } catch(error) {if (isUnique(error)) throw new HttpError(409,'An account with this email already exists. Sign in instead.'); throw error;}
    if (input.client!=='ios') {cancelBrowserPairing(store,req,res,secureCookie);setSessionCookie(res,token,secureCookie);}
    res.status(201).json(input.client==='ios' ? {user,token} : {user});
  });
  app.post('/api/auth/login',async(req,res)=>{
    const input=credentials.parse(req.body);
    const user=store.db.prepare('SELECT id,email,password_hash FROM users WHERE email=?').get(input.email);
    if (!await verifyPassword(input.password,user?.password_hash as string | undefined)) throw new HttpError(401,'Email or password is incorrect.');
    const token=createSession(store,String(user!.id));
    if (input.client!=='ios') {cancelBrowserPairing(store,req,res,secureCookie);setSessionCookie(res,token,secureCookie);}
    const response={user:{id:user!.id,email:user!.email}};
    res.json(input.client==='ios' ? {...response,token} : response);
  });

  app.use('/api',authenticate(store,options.publicUrl));
  app.get('/api/auth/me',(req,res)=>res.json({user:authenticated(req).user}));
  app.post('/api/auth/logout',(req,res)=>{
    store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(authenticated(req).sessionHash);
    cancelBrowserPairing(store,req,res,secureCookie);
    clearSessionCookie(res,secureCookie);res.json({ok:true});
  });
  app.get('/api/apps',(req,res)=>{
    const rows=store.db.prepare('SELECT * FROM apps WHERE user_id=? ORDER BY created_at DESC').all(authenticated(req).user.id) as unknown as AppRow[];
    res.json({apps:rows.map(row=>store.appResponse(row,options.publicUrl))});
  });
  app.post('/api/apps/lookup',rateLimit(20,60000,req=>authenticated(req).user.id),async(req,res)=>{
    const input=z.object({url:z.string().trim().min(1).max(2048)}).strict().parse(req.body);
    try {res.json(await (options.lookup ?? lookupApp)(input.url));}
    catch(error) {throw new HttpError(422,error instanceof Error && !error.message.includes('fetch') ? error.message : 'App lookup failed. Enter your app details manually.');}
  });
  app.post('/api/apps',(req,res)=>{
    const input=appInput.parse(req.body);const userId=authenticated(req).user.id;
    if (Number(store.db.prepare('SELECT COUNT(*) AS count FROM apps WHERE user_id=?').get(userId)!.count)>=20) throw new HttpError(400,'This MVP supports up to 20 apps per account.');
    const id=randomUUID();
    try {store.db.prepare(`INSERT INTO apps (id,user_id,name,bundle_id,apple_id,source,icon_url,webhook_secret,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id,userId,input.name,input.bundleId,input.appleId,input.source,safeIconUrl(input.iconUrl),newWebhookSecret(),new Date().toISOString());}
    catch(error) {if(isUnique(error)) throw new HttpError(409,'This bundle ID is already connected to your account.');throw error;}
    res.status(201).json({app:store.appResponse(store.getApp(id)!,options.publicUrl)});
  });
  function requireApp(req: Request): AppRow {
    const record=store.getApp(String(req.params.id),authenticated(req).user.id);
    if (!record) throw new HttpError(404,'App not found.');
    return record;
  }
  app.delete('/api/apps/:id',(req,res)=>{const record=requireApp(req);store.db.prepare('DELETE FROM apps WHERE id=?').run(record.id);res.json({ok:true});});
  app.post('/api/apps/:id/rotate-webhook',(req,res)=>{
    const record=requireApp(req);
    store.db.prepare('UPDATE apps SET webhook_secret=?,last_production_at=NULL,last_sandbox_at=NULL WHERE id=?').run(newWebhookSecret(),record.id);
    res.json({app:store.appResponse(store.getApp(record.id)!,options.publicUrl)});
  });
  app.post('/api/apps/:id/demo',rateLimit(20,60000,req=>authenticated(req).user.id),(req,res)=>{
    if (!options.demoEnabled) throw new HttpError(403,'Demo events are disabled on this server.');
    const record=requireApp(req);const {kind}=z.object({kind:z.enum(['sale','refund'])}).strict().parse(req.body);
    const now=new Date().toISOString();
    const event: ActivityEvent={id:randomUUID(),appId:record.id,appName:record.name,kind,title:kind==='sale' ? 'New sale' : 'Refund issued',
      detail:'Demo only. No purchase or refund occurred, and the Apple connection has not been verified by this event.',
      amountMilliunits:kind==='sale' ? 4990 : -4990,currency:'USD',productId:'demo.product',transactionId:null,
      environment:'Demo',occurredAt:now,receivedAt:now,notificationType:'DEMO',subtype:null,isMonetary:false};
    store.transaction(()=>{store.insertEvent(event,null,Date.now());store.queueEvent(event,record.user_id);});
    res.status(201).json({event});
  });
  app.get('/api/events',(req,res)=>{
    const query=z.object({appId:z.string().optional(),environment:z.enum(['Production','Sandbox','Demo','all']).default('Production'),before:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);
    const where=['a.user_id=?'];const values:Array<string|number>=[authenticated(req).user.id];
    if(query.appId) {where.push('e.app_id=?');values.push(query.appId);}
    if(query.environment!=='all') {where.push('e.environment=?');values.push(query.environment);}
    if(query.before) {
      const cursor=store.db.prepare('SELECT e.seq FROM events e JOIN apps a ON a.id=e.app_id WHERE e.id=? AND a.user_id=?').get(query.before,authenticated(req).user.id);
      if (!cursor) throw new HttpError(400,'This activity page has expired. Refresh the activity feed.');
      where.push('e.seq<?');values.push(Number(cursor.seq));
    }
    values.push(query.limit+1);
    const rows=store.db.prepare(`SELECT e.*,a.name AS app_name FROM events e JOIN apps a ON a.id=e.app_id WHERE ${where.join(' AND ')} ORDER BY e.seq DESC LIMIT ?`).all(...values) as unknown as EventRow[];
    res.json({events:rows.slice(0,query.limit).map(row=>store.eventResponse(row)),nextCursor:rows.length>query.limit ? rows[query.limit-1].id : null});
  });
  app.get('/api/preferences',(req,res)=>res.json({preferences:store.preferences(authenticated(req).user.id)}));
  app.patch('/api/preferences',(req,res)=>{
    const patch=preferenceInput.parse(req.body);const userId=authenticated(req).user.id;const p={...store.preferences(userId),...patch};
    store.db.prepare('UPDATE preferences SET sales=?,refunds=?,lifecycle=?,sandbox=?,hide_amounts=? WHERE user_id=?')
      .run(Number(p.sales),Number(p.refunds),Number(p.lifecycle),Number(p.sandbox),Number(p.hideAmounts),userId);
    res.json({preferences:p});
  });
  app.get('/api/devices',(req,res)=>{
    const rows=store.db.prepare('SELECT * FROM devices WHERE user_id=? ORDER BY created_at DESC').all(authenticated(req).user.id) as unknown as DeviceRow[];
    res.json({devices:rows.map(row=>store.deviceResponse(row))});
  });
  app.post('/api/devices',(req,res)=>{
    const input=deviceInput.parse(req.body);const auth=authenticated(req);const token=input.token.toLowerCase();const now=new Date().toISOString();
    const device=store.transaction(()=>{
      const previous=store.db.prepare('SELECT * FROM devices WHERE token=? AND environment=?').get(token,input.environment) as unknown as DeviceRow | undefined;
      // Device tokens are scoped to the currently authenticated installation/session.
      // Account switching cancels old jobs, so no previous account data follows the device.
      if (previous && (previous.user_id!==auth.user.id || previous.session_hash!==auth.sessionHash)) store.db.prepare('DELETE FROM devices WHERE id=?').run(previous.id);
      const sameSession=previous && previous.user_id===auth.user.id && previous.session_hash===auth.sessionHash;
      const id=sameSession ? previous.id : randomUUID();
      const registrationTime=sameSession ? new Date(Math.max(Date.now(),Date.parse(previous.last_seen_at)+1)).toISOString() : now;
      // Always retire other tokens, including when a previous token returns.
      const oldDevices=store.db.prepare('SELECT id FROM devices WHERE session_hash=? AND id<>?').all(auth.sessionHash,id);
      for(const old of oldDevices) store.disableDevice(String(old.id));
      if(sameSession) store.db.prepare('UPDATE devices SET name=?,active=1,last_seen_at=? WHERE id=?').run(input.name,registrationTime,id);
      else {
        store.db.prepare(`INSERT INTO devices (id,user_id,session_hash,token,environment,name,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(id,auth.user.id,auth.sessionHash,token,input.environment,input.name,now,now);
      }
      return store.db.prepare('SELECT * FROM devices WHERE id=?').get(id) as unknown as DeviceRow;
    });
    res.json({device:store.deviceResponse(device)});
  });
  app.delete('/api/devices/:id',(req,res)=>{
    const device=store.db.prepare('SELECT id,session_hash FROM devices WHERE id=? AND user_id=?').get(String(req.params.id),authenticated(req).user.id);
    if (!device) throw new HttpError(404,'Device not found.');
    store.transaction(()=>{
      store.disableDevice(String(device.id),authenticated(req).user.id);
      // Remote revocation signs the removed installation out; it cannot simply
      // re-register with its old token. A phone removing itself can finish logout.
      if (device.session_hash!==authenticated(req).sessionHash) {
        store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(device.session_hash!);
      }
    });res.json({ok:true});
  });
  app.post('/api/devices/:id/test',rateLimit(10,60000,req=>authenticated(req).user.id),(req,res)=>{
    const device=store.db.prepare('SELECT id FROM devices WHERE id=? AND user_id=? AND active=1').get(String(req.params.id),authenticated(req).user.id);
    if (!device) throw new HttpError(404,'Active device not found.');
    if (!transport) throw new HttpError(503,'Phone push is not configured on this server. Set the APNs key, team ID, key ID, and app topic.');
    store.enqueue(String(device.id));res.status(202).json({queued:true});
  });
  app.get('/api/deliveries',(req,res)=>{
    const {limit}=z.object({limit:z.coerce.number().int().min(1).max(100).default(30)}).parse(req.query);
    const deliveries=store.db.prepare(`SELECT j.id,j.event_id AS eventId,j.device_id AS deviceId,d.name AS deviceName,j.state,j.attempts,
      j.last_error AS lastError,j.created_at AS createdAt,j.updated_at AS updatedAt FROM delivery_jobs j JOIN devices d ON d.id=j.device_id
      WHERE d.user_id=? ORDER BY j.created_at DESC LIMIT ?`).all(authenticated(req).user.id,limit);
    res.json({deliveries});
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'API route not found.'}));
  app.use(express.static(options.webDirectory ?? resolve('web'),{index:'index.html',dotfiles:'deny',maxAge:0}));
  app.use((_req,res)=>res.status(404).json({error:'Not found.'}));
  app.use((error: unknown,_req: Request,res: Response,_next: NextFunction)=>{
    if(error instanceof z.ZodError) return res.status(400).json({error:error.issues.map(issue=>`${issue.path.join('.') || 'Request'}: ${issue.message}`).slice(0,3).join(' ')});
    if(error instanceof HttpError || error instanceof PairingError) return res.status(error.status).json({error:error.message});
    if(error instanceof AppleVerificationError) return res.status(error.code==='verifier_unavailable' ? 503 : 400).json({error:error.message});
    if(error instanceof SyntaxError && 'body' in error) return res.status(400).json({error:'Invalid JSON request.'});
    if(error && typeof error==='object' && 'type' in error && error.type==='entity.too.large') return res.status(413).json({error:'Request is too large.'});
    // Never log request paths (webhook secrets), payloads, tokens, or transaction data.
    console.error('Request failed:',error instanceof Error ? error.name : 'Unknown error');
    res.status(503).json({error:'The server could not save or process this request. Please retry.'});
  });
  return {app,store,worker};
}
function isUnique(error: unknown): boolean {return error instanceof Error && /UNIQUE constraint failed/.test(error.message);}
