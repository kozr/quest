import { createHash, randomBytes } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import type { Request,Response,NextFunction } from 'express';
import type { Store,SessionRow } from './database.js';
import type { User } from './types.js';

const SESSION_SECONDS=60*60*24*30;
const COOKIE_NAME='iap_session';
export interface AuthenticatedRequest extends Request {user:User;sessionHash:string}
export function tokenHash(token:string) {return createHash('sha256').update(token).digest('hex');}
export async function createSession(store:Store,userId:string,authTime:number) {
  const token=randomBytes(32).toString('base64url');
  const now=new Date();const expiry=now.getTime()+SESSION_SECONDS*1000;
  const row:SessionRow={token_hash:tokenHash(token),user_id:userId,auth_time:authTime,created_at:now.toISOString(),expires_at:new Date(expiry).toISOString(),expireAt:Timestamp.fromMillis(expiry)};
  await store.set('sessions',row.token_hash,row);return token;
}
export function setSessionCookie(res:Response,token:string,secure:boolean) {res.cookie(COOKIE_NAME,token,{httpOnly:true,secure,sameSite:'strict',path:'/',maxAge:SESSION_SECONDS*1000});}
export function clearSessionCookie(res:Response,secure:boolean) {res.clearCookie(COOKIE_NAME,{httpOnly:true,secure,sameSite:'strict',path:'/'});}
export function readCookie(req:Request,name:string):string|undefined {return req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(`${name}=`))?.slice(name.length+1);}
export async function browserSessionUser(store:Store,req:Request):Promise<User|undefined> {
  const token=readCookie(req,COOKIE_NAME);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  return (await store.session(tokenHash(token)))?.user;
}
export function authenticate(store:Store,publicUrl:string) {
  return async(req:Request,res:Response,next:NextFunction)=>{
    const bearer=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const token=bearer ?? readCookie(req,COOKIE_NAME);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(401).json({error:'Sign in to continue.'});
    const hash=tokenHash(token);const row=await store.session(hash);
    if (!row) return res.status(401).json({error:'Your session expired. Sign in again.'});
    if (!bearer && !['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin!==publicUrl) return res.status(403).json({error:'This request must come from this app. Reload the page and try again.'});
    (req as AuthenticatedRequest).user=row.user;(req as AuthenticatedRequest).sessionHash=hash;next();
  };
}
/** Shared fixed-window limiter: hashed keys and TTL records, no raw IPs in Firestore. */
export function rateLimit(store:Store,scope:string,max:number,windowMs:number,keyFor:(req:Request)=>string=req=>req.ip ?? 'unknown') {
  return async(req:Request,res:Response,next:NextFunction)=>{
    const now=Date.now();const window=Math.floor(now/windowMs);const reset=(window+1)*windowMs;
    const key=tokenHash(`${scope}:${keyFor(req)}:${window}`);
    const allowed=await store.atomic(async s=>{
      const bucket=await s.get<{count:number}>('rate_limits',key);
      if ((bucket?.count ?? 0)>=max) return false;
      await s.set('rate_limits',key,{count:(bucket?.count ?? 0)+1,expireAt:Timestamp.fromMillis(reset)});return true;
    });
    if (!allowed) {res.setHeader('Retry-After',String(Math.ceil((reset-now)/1000)));return res.status(429).json({error:'Too many attempts. Please wait before trying again.'});}
    next();
  };
}
