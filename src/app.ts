import express,{type Request,type Response,type NextFunction} from 'express';
import {randomUUID} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import {resolve} from 'node:path';
import {z} from 'zod';
import type {Configuration} from './config.js';
import {Store,newWebhookSecret,type AppRow,type DeviceRow} from './database.js';
import {authenticate,clearSessionCookie,createSession,rateLimit,tokenHash,type AuthenticatedRequest} from './auth.js';
import {firebaseServices,ServiceError} from './firebase.js';
import {AppleVerificationError,loadAppleRootCertificates,verifyAppleNotification,type AppleNotificationContext,type VerifiedAppleNotification} from './apple.js';
import {normalizeAppleNotification} from './normalize.js';
import {lookupApp,safeIconUrl} from './metadata.js';
import {ApnsClient,type PushTransport} from './apns.js';
import {DeliveryWorker} from './worker.js';
import {cancelBrowserPairing,PairingError,pairingRouter} from './pairing.js';
import type {ActivityEvent,AppleEnvironment} from './types.js';

export interface ApplicationOptions extends Configuration {
  verify?:(payload:string,context:AppleNotificationContext)=>Promise<VerifiedAppleNotification>;
  lookup?:typeof lookupApp;
  pushTransport?:PushTransport|null;
  webDirectory?:string;
  /** Test-only repository injection, never selected via an HTTP parameter. */
  store?:Store;
}
const appleCredentials=z.object({idToken:z.string().min(1).max(16384),rawNonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),client:z.literal('ios')}).strict();
const appInput=z.object({name:z.string().trim().min(1).max(80),bundleId:z.string().trim().min(3).max(255).regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),appleId:z.string().trim().regex(/^[1-9]\d{0,14}$/),source:z.enum(['apple','revenuecat']),iconUrl:z.string().max(2048).nullable().optional()}).strict();
const preferenceInput=z.object({sales:z.boolean().optional(),refunds:z.boolean().optional(),lifecycle:z.boolean().optional(),sandbox:z.boolean().optional(),hideAmounts:z.boolean().optional()}).strict();
const deviceInput=z.object({token:z.string().regex(/^[a-fA-F0-9]{64,512}$/).refine(v=>v.length%2===0).transform(v=>v.toLowerCase()),name:z.string().trim().min(1).max(80),environment:z.enum(['production','sandbox'])}).strict();
const authenticated=(req:Request)=>req as AuthenticatedRequest;

export function createApplication(options:ApplicationOptions) {
  const services=options.store ? undefined : firebaseServices(options);
  const store=options.store ?? new Store(services!.db,services!.identity);
  const transport=options.pushTransport!==undefined ? options.pushTransport : options.apns ? new ApnsClient(options.apns) : null;
  const worker=new DeliveryWorker(store,transport);
  const app=express();const secure=options.publicUrl.startsWith('https://');
  const verify=options.verify ?? (async(payload,context)=>verifyAppleNotification(payload,context,await loadAppleRootCertificates(options.appleRootDirectory)));
  const limit=(scope:string,max:number,ms:number,byUser=false)=>rateLimit(store,scope,max,ms,byUser ? req=>authenticated(req).user.id : undefined);
  app.disable('x-powered-by');app.set('trust proxy',false);
  app.use((_req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.mzstatic.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(options.production) res.setHeader('Strict-Transport-Security','max-age=31536000');next();
  });
  app.get('/healthz',async(_req,res)=>{await store.collection('health').doc('probe').get();res.json({ok:true});});
  app.use('/webhooks',limit('webhooks',3000,60000),express.json({limit:'256kb'}));
  app.post('/webhooks/apple/:secret/:environment',async(req,res)=>{
    const source=await store.appForSecret(req.params.secret);
    if(!source || !['production','sandbox','forward'].includes(req.params.environment)) throw new ServiceError(404,'Notification endpoint not found.');
    const {signedPayload}=z.object({signedPayload:z.string().min(1).max(131072)}).strict().parse(req.body);
    let environment:AppleEnvironment=req.params.environment==='sandbox' ? 'Sandbox' : 'Production';
    if(req.params.environment==='forward') {
      // Unverified hint ONLY for routing; verification below still binds the app/environment.
      try {
        const hint=JSON.parse(Buffer.from(signedPayload.split('.')[1] ?? '','base64url').toString());
        const indicated=hint.data?.environment ?? hint.summary?.environment ?? hint.appData?.environment ??
          (typeof hint.externalPurchaseToken?.externalPurchaseId==='string' ? (hint.externalPurchaseToken.externalPurchaseId.startsWith('SANDBOX') ? 'Sandbox' : 'Production') : undefined);
        if(indicated!=='Production' && indicated!=='Sandbox') throw new Error();environment=indicated;
      } catch {throw new ServiceError(400,'The forwarded notification has no valid environment.');}
    }
    const normalized=normalizeAppleNotification(await verify(signedPayload,{bundleId:source.bundle_id,appleId:source.apple_id,environment}));
    // Persist only normalized display fields, never the signed payload or undefined values.
    const {economicKey,notificationUUID,signedDate,...fields}=normalized;
    const event:ActivityEvent={...fields,id:randomUUID(),appId:source.id,appName:source.name,receivedAt:new Date().toISOString()};
    const status=await store.saveEvent(event,source.user_id,economicKey,signedDate,{uuid:notificationUUID,secret:source.webhook_secret});
    res.json({ok:true,status});
  });
  app.use('/api',express.json({limit:'32kb'}),(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  app.get('/api/config',(_req,res)=>res.json({serviceName:'IAP Notifications',authProvider:'apple',registrationEnabled:options.registrationEnabled,demoEnabled:options.demoEnabled,apnsConfigured:!!transport,publicUrl:options.publicUrl}));
  app.use('/api/pairing',pairingRouter(store,options.publicUrl));
  app.post(['/api/auth/login','/api/auth/register'],(_req,res)=>res.status(410).json({error:'Password sign-in has been removed. Sign in with Apple on your iPhone, then scan the desktop QR code.'}));
  app.use('/api/auth/apple',limit('auth',20,15*60000),(req,res,next)=>{
    if(req.headers.origin && req.headers.origin!==options.publicUrl) return res.status(403).json({error:'Sign in from this app’s own page.'});next();
  });
  app.post('/api/auth/apple',async(req,res)=>{
    const input=appleCredentials.parse(req.body);
    const nonceHash=tokenHash(input.rawNonce);
    if(await store.get('apple_sign_ins',nonceHash)) throw new ServiceError(401,'This Apple sign-in has already been used. Sign in with Apple again.');
    const identity=await store.identity.signInWithApple(input.idToken,input.rawNonce);
    const {user,authTime}=identity;
    const token=await store.atomic(async s=>{
      const [profile,used]=await Promise.all([s.get('users',user.id),s.get('apple_sign_ins',nonceHash)]);
      if(used) throw new ServiceError(401,'This Apple sign-in has already been used. Sign in with Apple again.');
      // Firebase's public Auth API can create accounts independently of this UI.
      // A closed beta must not admit those accounts through the login endpoint.
      if(!profile && !options.registrationEnabled) throw new ServiceError(403,'This account has not been admitted to the beta.');
      // Only hashes are retained. The 24h replay record outlives the 5m
      // accepted credential age, including clock skew and asynchronous TTL.
      await s.set('apple_sign_ins',nonceHash,{expireAt:Timestamp.fromMillis(Date.now()+86400000)});
      await s.set('users',user.id,{...user,updated_at:new Date().toISOString()},true);
      return createSession(s,user.id,authTime);
    });
    res.json({user,token});
  });
  app.use('/api',authenticate(store,options.publicUrl));
  app.get('/api/auth/me',(req,res)=>res.json({user:authenticated(req).user}));
  app.post('/api/auth/logout',async(req,res)=>{
    await store.delete('sessions',authenticated(req).sessionHash);await cancelBrowserPairing(store,req,res,secure);clearSessionCookie(res,secure);res.json({ok:true});
  });
  app.get('/api/apps',async(req,res)=>res.json({apps:(await store.apps(authenticated(req).user.id)).sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(row=>store.appResponse(row,options.publicUrl))}));
  app.post('/api/apps/lookup',limit('lookup',20,60000,true),async(req,res)=>{
    const input=z.object({url:z.string().trim().min(1).max(2048)}).strict().parse(req.body);
    try {res.json(await(options.lookup ?? lookupApp)(input.url));}
    catch(error) {throw new ServiceError(422,error instanceof Error && !error.message.includes('fetch') ? error.message : 'App lookup failed. Enter your app details manually.');}
  });
  app.post('/api/apps',async(req,res)=>{
    const input=appInput.parse(req.body);
    const row:AppRow={id:randomUUID(),user_id:authenticated(req).user.id,name:input.name,bundle_id:input.bundleId,apple_id:input.appleId,source:input.source,icon_url:safeIconUrl(input.iconUrl),webhook_secret:newWebhookSecret(),created_at:new Date().toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
    await store.createApp(row);res.status(201).json({app:store.appResponse(row,options.publicUrl)});
  });
  async function requireApp(req:Request) {const app=await store.getApp(String(req.params.id),authenticated(req).user.id);if(!app) throw new ServiceError(404,'App not found.');return app;}
  app.delete('/api/apps/:id',async(req,res)=>{await store.removeApp(String(req.params.id),authenticated(req).user.id);res.json({ok:true});});
  app.post('/api/apps/:id/rotate-webhook',async(req,res)=>res.json({app:store.appResponse(await store.rotateApp(String(req.params.id),authenticated(req).user.id),options.publicUrl)}));
  app.post('/api/apps/:id/demo',limit('demo',20,60000,true),async(req,res)=>{
    if(!options.demoEnabled) throw new ServiceError(403,'Demo events are disabled on this server.');
    const record=await requireApp(req);const {kind}=z.object({kind:z.enum(['sale','refund'])}).strict().parse(req.body);const now=new Date().toISOString();
    const event:ActivityEvent={id:randomUUID(),appId:record.id,appName:record.name,kind,title:kind==='sale' ? 'New sale' : 'Refund issued',detail:'Demo only. No purchase or refund occurred, and the Apple connection has not been verified by this event.',amountMilliunits:kind==='sale' ? 4990 : -4990,currency:'USD',productId:'demo.product',transactionId:null,environment:'Demo',occurredAt:now,receivedAt:now,notificationType:'DEMO',subtype:null,isMonetary:false};
    await store.saveEvent(event,record.user_id,null,Date.now());res.status(201).json({event});
  });
  app.get('/api/events',async(req,res)=>{
    const query=z.object({appId:z.string().optional(),environment:z.enum(['Production','Sandbox','Demo','all']).default('Production'),before:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);
    res.json(await store.activity(authenticated(req).user.id,query));
  });
  app.get('/api/preferences',async(req,res)=>res.json({preferences:await store.preferences(authenticated(req).user.id)}));
  app.patch('/api/preferences',async(req,res)=>{
    const patch=preferenceInput.parse(req.body);const uid=authenticated(req).user.id;
    const preferences=await store.atomic(async s=>{const p={...await s.preferences(uid),...patch};await s.set('preferences',uid,p);return p;});res.json({preferences});
  });
  app.get('/api/devices',async(req,res)=>{
    const rows=await store.list<DeviceRow>('devices',[['user_id','==',authenticated(req).user.id]]);
    const valid=await Promise.all(rows.map(async row=>({...row,active:row.active && await store.session(row.session_hash) ? 1 : 0})));
    res.json({devices:valid.sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(row=>store.deviceResponse(row))});
  });
  app.post('/api/devices',async(req,res)=>{
    const auth=authenticated(req);const row=await store.registerDevice(auth.user.id,auth.sessionHash,deviceInput.parse(req.body));res.json({device:store.deviceResponse(row)});
  });
  app.delete('/api/devices/:id',async(req,res)=>{const auth=authenticated(req);await store.disableDevice(String(req.params.id),auth.user.id,auth.sessionHash);res.json({ok:true});});
  app.post('/api/devices/:id/test',limit('push-test',10,60000,true),async(req,res)=>{
    const device=await store.get<DeviceRow>('devices',String(req.params.id));
    if(!device?.active || device.user_id!==authenticated(req).user.id) throw new ServiceError(404,'Active device not found.');
    if(!transport) throw new ServiceError(503,'Phone push is not configured on this server. Set the APNs key, team ID, key ID, and app topic.');
    await store.enqueue(device.id,device.user_id);res.status(202).json({queued:true});
  });
  app.get('/api/deliveries',async(req,res)=>{
    const {limit}=z.object({limit:z.coerce.number().int().min(1).max(100).default(30)}).parse(req.query);res.json({deliveries:await store.deliveries(authenticated(req).user.id,limit)});
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'API route not found.'}));
  app.use(express.static(options.webDirectory ?? resolve('web'),{index:'index.html',dotfiles:'deny',maxAge:0}));
  app.use((_req,res)=>res.status(404).json({error:'Not found.'}));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(error instanceof z.ZodError) return res.status(400).json({error:error.issues.map(issue=>`${issue.path.join('.') || 'Request'}: ${issue.message}`).slice(0,3).join(' ')});
    if(error instanceof ServiceError || error instanceof PairingError) return res.status(error.status).json({error:error.message});
    if(error instanceof AppleVerificationError) return res.status(error.code==='verifier_unavailable' ? 503 : 400).json({error:error.message});
    if(error instanceof SyntaxError && 'body' in error) return res.status(400).json({error:'Invalid JSON request.'});
    if(error && typeof error==='object' && 'type' in error && error.type==='entity.too.large') return res.status(413).json({error:'Request is too large.'});
    console.error('Request failed:',error instanceof Error ? error.name : 'Unknown error');
    res.status(503).json({error:'The server could not save or process this request. Please retry.'});
  });
  return {app,store,worker};
}
