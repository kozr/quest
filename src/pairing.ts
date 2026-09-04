import { randomBytes, randomInt } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Store } from './database.js';
import { authenticate, browserSessionUser, createSession, rateLimit, readCookie, setSessionCookie, tokenHash, type AuthenticatedRequest } from './auth.js';

const PAIRING_COOKIE='iap_pairing';
const PAIRING_LIFETIME_MS=2*60*1000;
const opaqueToken=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const pairingId=z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const browserInput=z.object({id:pairingId}).strict();
const phoneInput=z.object({id:pairingId,token:opaqueToken}).strict();
type PairingState='pending'|'approved'|'denied'|'consumed'|'cancelled';
interface PairingRow {
  id:string; browser_secret_hash:string; approval_token_hash:string; code:string; browser_name:string;
  created_at:string; expires_at:number; state:PairingState;
  approved_user_id:string|null; approver_session_hash:string|null;
}
export class PairingError extends Error {
  constructor(public status:number,message:string) {super(message);}
}

function clearPairingCookie(res:Response,secure:boolean) {
  res.clearCookie(PAIRING_COOKIE,{httpOnly:true,secure,sameSite:'strict',path:'/'});
}
/** Used on manual sign-in/logout as well as regeneration. A stale QR must not later replace that account. */
export function cancelBrowserPairing(store:Store,req:Request,res:Response,secure:boolean,clearCookie=true) {
  const secret=readCookie(req,PAIRING_COOKIE);
  if (secret && opaqueToken.safeParse(secret).success) {
    store.db.prepare(`UPDATE browser_pairings SET state='cancelled',approved_user_id=NULL,approver_session_hash=NULL
      WHERE browser_secret_hash=? AND state IN ('pending','approved')`).run(tokenHash(secret));
  }
  if (secret && clearCookie) clearPairingCookie(res,secure);
}

function browserName(userAgent:string) {
  // Display hints only, never identity or trusted evidence about the requesting browser.
  const browser=/Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' :
    /(?:Chrome|CriOS)\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  const platform=/iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' :
    /Macintosh|Mac OS X/.test(userAgent) ? 'Mac' : /Windows/.test(userAgent) ? 'Windows' : /Linux/.test(userAgent) ? 'Linux' : undefined;
  return platform ? `${browser} on ${platform}` : browser;
}

export function pairingRouter(store:Store,publicUrl:string) {
  const router=Router();
  const secure=publicUrl.startsWith('https://');
  const browserOrigin=(req:Request,_res:Response,next:NextFunction)=>{
    if (req.headers.origin!==publicUrl) throw new PairingError(403,'Open this service’s own page to sign in on a computer.');
    next();
  };
  const signedOut=(req:Request,_res:Response,next:NextFunction)=>{
    if (browserSessionUser(store,req)) throw new PairingError(409,'This browser is already signed in. Reload the page to continue.');
    next();
  };
  function boundBrowser(req:Request,id:string):PairingRow {
    const secret=readCookie(req,PAIRING_COOKIE);
    if (!secret || !opaqueToken.safeParse(secret).success) throw new PairingError(404,'This QR code is no longer connected to this browser. Get a new code.');
    const row=store.db.prepare('SELECT * FROM browser_pairings WHERE id=? AND browser_secret_hash=?')
      .get(id,tokenHash(secret)) as unknown as PairingRow|undefined;
    if (!row) throw new PairingError(404,'This QR code is no longer connected to this browser. Get a new code.');
    return row;
  }
  function phonePairing(req:Request):PairingRow {
    const input=phoneInput.parse(req.body);
    const row=store.db.prepare('SELECT * FROM browser_pairings WHERE id=? AND approval_token_hash=?')
      .get(input.id,tokenHash(input.token)) as unknown as PairingRow|undefined;
    if (!row || row.expires_at<=Date.now()) throw new PairingError(404,'This QR code is invalid or expired. Get a new code on your computer.');
    if (row.state!=='pending') throw new PairingError(409,'This QR code has already been used or cancelled. Get a new code on your computer.');
    return row;
  }
  function approvalValid(row:PairingRow):boolean {
    return !!row.approved_user_id && !!row.approver_session_hash && !!store.db.prepare(
      'SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?'
    ).get(row.approver_session_hash,row.approved_user_id,new Date().toISOString());
  }

  router.post('/start',rateLimit(30,5*60000),browserOrigin,signedOut,async(req,res)=>{
    z.object({}).strict().parse(req.body);
    const id=randomBytes(16).toString('base64url');
    const browserSecret=randomBytes(32).toString('base64url');
    const approvalToken=randomBytes(32).toString('base64url');
    const code=randomInt(1_000_000).toString().padStart(6,'0');
    const qr=new URL('iapnotifications://pair');
    qr.search=new URLSearchParams({v:'1',server:publicUrl,id,token:approvalToken}).toString();
    // Generate locally. No QR service or analytics ever receives the approval token.
    const qrImageUrl=await QRCode.toDataURL(qr.toString(),{errorCorrectionLevel:'M',margin:4,width:320});
    const createdAt=Date.now();
    const expiresAt=createdAt+PAIRING_LIFETIME_MS;
    store.transaction(()=>{
      // Short-lived records are removed on subsequent starts, including spent approval hashes.
      store.db.prepare('DELETE FROM browser_pairings WHERE expires_at<=?').run(Date.now());
      cancelBrowserPairing(store,req,res,secure,false);
      store.db.prepare(`INSERT INTO browser_pairings
        (id,browser_secret_hash,approval_token_hash,code,browser_name,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id,tokenHash(browserSecret),tokenHash(approvalToken),code,browserName(req.headers['user-agent'] ?? ''),new Date(createdAt).toISOString(),expiresAt);
    });
    // An extra minute lets a still-open page report expiry; authorization always checks the DB's two-minute TTL.
    res.cookie(PAIRING_COOKIE,browserSecret,{httpOnly:true,secure,sameSite:'strict',path:'/',maxAge:PAIRING_LIFETIME_MS+60000});
    res.status(201).json({pairing:{id,qrUrl:qr.toString(),qrImageUrl,code,expiresAt:new Date(expiresAt).toISOString(),publicUrl,pollIntervalMs:2000}});
  });

  router.get('/status',rateLimit(120,60000),(req,res)=>{
    const {id}=browserInput.parse(req.query);
    const row=boundBrowser(req,id);
    let status:PairingState|'expired'=row.expires_at<=Date.now() ? 'expired' : row.state;
    if (status==='approved' && !approvalValid(row)) {
      store.db.prepare(`UPDATE browser_pairings SET state='cancelled',approved_user_id=NULL,approver_session_hash=NULL WHERE id=?`).run(id);
      status='cancelled';
    }
    // No user/account information or approval token is returned to a waiting browser.
    res.json({status,expiresAt:new Date(row.expires_at).toISOString()});
  });

  router.post('/redeem',rateLimit(30,60000),browserOrigin,signedOut,(req,res)=>{
    const {id}=browserInput.parse(req.body);
    const result=store.transaction(()=>{
      const row=boundBrowser(req,id);
      if (row.expires_at<=Date.now()) throw new PairingError(404,'This QR code expired. Get a new code.');
      if (row.state!=='approved') throw new PairingError(409,'This QR code has not been approved or has already been used.');
      if (!approvalValid(row)) throw new PairingError(401,'The phone’s sign-in expired. Sign in on your phone and get a new code.');
      const user=store.db.prepare('SELECT id,email FROM users WHERE id=?').get(row.approved_user_id!)!;
      const token=createSession(store,String(user.id));
      store.db.prepare(`UPDATE browser_pairings SET state='consumed',approved_user_id=NULL,approver_session_hash=NULL WHERE id=?`).run(id);
      return {user:{id:String(user.id),email:String(user.email)},token};
    });
    setSessionCookie(res,result.token,secure);
    clearPairingCookie(res,secure);
    res.json({user:result.user});
  });

  router.post('/cancel',rateLimit(30,60000),browserOrigin,(req,res)=>{
    const {id}=browserInput.parse(req.body);
    const row=boundBrowser(req,id);
    if (row.state==='pending' || row.state==='approved') {
      store.db.prepare(`UPDATE browser_pairings SET state='cancelled',approved_user_id=NULL,approver_session_hash=NULL WHERE id=?`).run(id);
    }
    clearPairingCookie(res,secure);
    res.json({ok:true});
  });

  // Approval is possible only through a signed-in native bearer client, never by the QR or browser cookie alone.
  router.use(['/inspect','/approve','/deny'],rateLimit(60,60000),(req,_res,next)=>{
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? '')) throw new PairingError(401,'Sign in on your phone before scanning this QR code.');
    next();
  },authenticate(store,publicUrl),rateLimit(30,60000,req=>(req as AuthenticatedRequest).user.id));
  router.post('/inspect',(req,res)=>{
    const row=phonePairing(req);
    res.json({pairing:{id:row.id,code:row.code,expiresAt:new Date(row.expires_at).toISOString(),publicUrl,browserName:row.browser_name}});
  });
  router.post('/approve',(req,res)=>{
    store.transaction(()=>{
      const row=phonePairing(req);const auth=req as AuthenticatedRequest;
      store.db.prepare(`UPDATE browser_pairings SET state='approved',approved_user_id=?,approver_session_hash=? WHERE id=?`)
        .run(auth.user.id,auth.sessionHash,row.id);
    });
    res.json({ok:true});
  });
  router.post('/deny',(req,res)=>{
    const row=phonePairing(req);
    store.db.prepare(`UPDATE browser_pairings SET state='denied' WHERE id=?`).run(row.id);
    res.json({ok:true});
  });
  return router;
}
