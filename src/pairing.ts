import {randomBytes,randomInt} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import {Router,type Request,type Response,type NextFunction} from 'express';
import QRCode from 'qrcode';
import {z} from 'zod';
import type {Store} from './database.js';
import {authenticate,browserSessionUser,createSession,rateLimit,readCookie,setSessionCookie,tokenHash,type AuthenticatedRequest} from './auth.js';

const PAIRING_COOKIE='iap_pairing';const PAIRING_LIFETIME_MS=120000;
const opaqueToken=z.string().regex(/^[A-Za-z0-9_-]{43}$/);const pairingId=z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const browserInput=z.object({id:pairingId}).strict();const phoneInput=z.object({id:pairingId,token:opaqueToken}).strict();
type PairingState='pending'|'approved'|'denied'|'consumed'|'cancelled';
export interface PairingRow {
  id:string;browser_secret_hash:string;approval_token_hash:string;code:string;browser_name:string;
  created_at:string;expires_at:number;expireAt:Timestamp;state:PairingState;
  approved_user_id:string|null;approver_session_hash:string|null;
}
export class PairingError extends Error {constructor(public status:number,message:string) {super(message);}}
function clearPairingCookie(res:Response,secure:boolean) {res.clearCookie(PAIRING_COOKIE,{httpOnly:true,secure,sameSite:'strict',path:'/'});}
const cancelled={state:'cancelled',approved_user_id:null,approver_session_hash:null,approval_token_hash:''};
export async function cancelBrowserPairing(store:Store,req:Request,res:Response,secure:boolean,clearCookie=true) {
  const secret=readCookie(req,PAIRING_COOKIE);
  if(secret && opaqueToken.safeParse(secret).success) await store.atomic(async s=>{
    const rows=await s.list<PairingRow>('browser_pairings',[['browser_secret_hash','==',tokenHash(secret)]]);
    for(const row of rows) if(row.state==='pending' || row.state==='approved') await s.set('browser_pairings',row.id,cancelled,true);
  });
  if(secret && clearCookie) clearPairingCookie(res,secure);
}
function browserName(agent:string) {
  const browser=/Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /(?:Chrome|CriOS)\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  const platform=/iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Macintosh|Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : undefined;
  return platform ? `${browser} on ${platform}` : browser;
}
export function pairingRouter(store:Store,publicUrl:string) {
  const router=Router();const secure=publicUrl.startsWith('https://');
  const limit=(scope:string,max:number,ms:number)=>rateLimit(store,`pairing-${scope}`,max,ms);
  const browserOrigin=(req:Request,_res:Response,next:NextFunction)=>{if(req.headers.origin!==publicUrl) throw new PairingError(403,'Open this service’s own page to sign in on a computer.');next();};
  const signedOut=async(req:Request,_res:Response,next:NextFunction)=>{if(await browserSessionUser(store,req)) throw new PairingError(409,'This browser is already signed in. Reload the page to continue.');next();};
  async function boundBrowser(s:Store,req:Request,id:string) {
    const secret=readCookie(req,PAIRING_COOKIE);
    if(!secret || !opaqueToken.safeParse(secret).success) throw new PairingError(404,'This QR code is no longer connected to this browser. Get a new code.');
    const row=await s.get<PairingRow>('browser_pairings',id);
    if(!row || row.browser_secret_hash!==tokenHash(secret)) throw new PairingError(404,'This QR code is no longer connected to this browser. Get a new code.');return row;
  }
  async function phonePairing(s:Store,req:Request) {
    const input=phoneInput.parse(req.body);const row=await s.get<PairingRow>('browser_pairings',input.id);
    if(!row || row.expires_at<=Date.now() || row.approval_token_hash!==tokenHash(input.token)) throw new PairingError(404,'This QR code is invalid or expired. Get a new code on your computer.');
    if(row.state!=='pending') throw new PairingError(409,'This QR code has already been used or cancelled. Get a new code on your computer.');return row;
  }
  async function approval(s:Store,row:PairingRow) {
    const session=row.approver_session_hash ? await s.session(row.approver_session_hash) : undefined;
    return session?.user_id===row.approved_user_id ? session : undefined;
  }
  router.post('/start',limit('start',30,300000),browserOrigin,signedOut,async(req,res)=>{
    z.object({}).strict().parse(req.body);
    const id=randomBytes(16).toString('base64url');const browserSecret=randomBytes(32).toString('base64url');const token=randomBytes(32).toString('base64url');
    const code=randomInt(1000000).toString().padStart(6,'0');const qr=new URL('iapnotifications://pair');
    qr.search=new URLSearchParams({v:'1',server:publicUrl,id,token}).toString();
    const qrImageUrl=await QRCode.toDataURL(qr.toString(),{errorCorrectionLevel:'M',margin:4,width:320});
    const now=Date.now();const expiresAt=now+PAIRING_LIFETIME_MS;
    await store.atomic(async s=>{
      await cancelBrowserPairing(s,req,res,secure,false);
      const row:PairingRow={id,browser_secret_hash:tokenHash(browserSecret),approval_token_hash:tokenHash(token),code,browser_name:browserName(req.headers['user-agent'] ?? ''),created_at:new Date(now).toISOString(),expires_at:expiresAt,expireAt:Timestamp.fromMillis(expiresAt),state:'pending',approved_user_id:null,approver_session_hash:null};
      await s.set('browser_pairings',id,row);
    });
    res.cookie(PAIRING_COOKIE,browserSecret,{httpOnly:true,secure,sameSite:'strict',path:'/',maxAge:PAIRING_LIFETIME_MS+60000});
    res.status(201).json({pairing:{id,qrUrl:qr.toString(),qrImageUrl,code,expiresAt:new Date(expiresAt).toISOString(),publicUrl,pollIntervalMs:2000}});
  });
  router.get('/status',limit('status',120,60000),async(req,res)=>{
    const {id}=browserInput.parse(req.query);
    const result=await store.atomic(async s=>{
      const row=await boundBrowser(s,req,id);let status:PairingState|'expired'=row.expires_at<=Date.now() ? 'expired' : row.state;
      if(status==='approved' && !await approval(s,row)) {await s.set('browser_pairings',id,cancelled,true);status='cancelled';}
      return {status,expiresAt:new Date(row.expires_at).toISOString()};
    });res.json(result);
  });
  router.post('/redeem',limit('redeem',30,60000),browserOrigin,signedOut,async(req,res)=>{
    const {id}=browserInput.parse(req.body);
    const result=await store.atomic(async s=>{
      const row=await boundBrowser(s,req,id);
      if(row.expires_at<=Date.now()) throw new PairingError(404,'This QR code expired. Get a new code.');
      if(row.state!=='approved') throw new PairingError(409,'This QR code has not been approved or has already been used.');
      const session=await approval(s,row);
      if(!session) throw new PairingError(401,'The phone’s sign-in expired. Sign in on your phone and get a new code.');
      // Inherit the original Firebase auth_time so password resets revoke QR-derived sessions too.
      const token=await createSession(s,session.user_id,session.auth_time);
      await s.set('browser_pairings',id,{state:'consumed',approved_user_id:null,approver_session_hash:null,approval_token_hash:''},true);
      return {user:session.user,token};
    });
    setSessionCookie(res,result.token,secure);clearPairingCookie(res,secure);res.json({user:result.user});
  });
  router.post('/cancel',limit('cancel',30,60000),browserOrigin,async(req,res)=>{
    const {id}=browserInput.parse(req.body);
    await store.atomic(async s=>{const row=await boundBrowser(s,req,id);if(row.state==='pending' || row.state==='approved') await s.set('browser_pairings',id,cancelled,true);});
    clearPairingCookie(res,secure);res.json({ok:true});
  });
  router.use(['/inspect','/approve','/deny'],limit('phone',60,60000),(req,_res,next)=>{
    if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? '')) throw new PairingError(401,'Sign in on your phone before scanning this QR code.');next();
  },authenticate(store,publicUrl),rateLimit(store,'pairing-user',30,60000,req=>(req as AuthenticatedRequest).user.id));
  router.post('/inspect',async(req,res)=>{const row=await phonePairing(store,req);res.json({pairing:{id:row.id,code:row.code,expiresAt:new Date(row.expires_at).toISOString(),publicUrl,browserName:row.browser_name}});});
  for(const action of ['approve','deny'] as const) router.post(`/${action}`,async(req,res)=>{
    await store.atomic(async s=>{
      const [row,session]=await Promise.all([phonePairing(s,req),s.session((req as AuthenticatedRequest).sessionHash)]);
      if(!session) throw new PairingError(401,'Sign in on your phone again.');
      await s.set('browser_pairings',row.id,action==='approve' ? {state:'approved',approved_user_id:session.user_id,approver_session_hash:session.token_hash} : {state:'denied',approval_token_hash:''},true);
    });res.json({ok:true});
  });
  return router;
}
