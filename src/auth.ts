import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Store } from './database.js';
import type { User } from './types.js';

const SESSION_SECONDS = 60 * 60 * 24 * 30;
const COOKIE_NAME = 'iap_session';
export interface AuthenticatedRequest extends Request { user: User; sessionHash: string }
export function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

async function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve,reject) => scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},
    (error,key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password,salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, stored?: string): Promise<boolean> {
  const [,salt,key] = (stored ?? `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`).split('$');
  if (!salt || !key) return false;
  const actual = await derive(password,salt); const expected = Buffer.from(key,'hex');
  return actual.length === expected.length && timingSafeEqual(actual,expected) && !!stored;
}

export function createSession(store: Store, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date(); const expiresAt = new Date(now.getTime()+SESSION_SECONDS*1000).toISOString();
  store.db.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(tokenHash(token),userId,now.toISOString(),expiresAt);
  return token;
}
export function setSessionCookie(response: Response, token: string, secure: boolean) {
  response.cookie(COOKIE_NAME,token,{httpOnly:true,secure,sameSite:'strict',path:'/',maxAge:SESSION_SECONDS*1000});
}
export function clearSessionCookie(response: Response, secure: boolean) {
  response.clearCookie(COOKIE_NAME,{httpOnly:true,secure,sameSite:'strict',path:'/'});
}
export function readCookie(request: Request, name: string): string | undefined {
  return request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(`${name}=`))?.slice(name.length+1);
}
/** Read-only lookup used to prevent a pending QR from switching an already signed-in browser. */
export function browserSessionUser(store: Store, request: Request): User | undefined {
  const token=readCookie(request,COOKIE_NAME);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  const row=store.db.prepare(`SELECT users.id,users.email FROM sessions JOIN users ON users.id=sessions.user_id
    WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(tokenHash(token),new Date().toISOString());
  return row ? {id:String(row.id),email:String(row.email)} : undefined;
}
export function authenticate(store: Store, publicUrl: string) {
  return (req: Request,res: Response,next: NextFunction) => {
    const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const token = bearer ?? readCookie(req,COOKIE_NAME);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(401).json({error:'Sign in to continue.'});
    const hash = tokenHash(token);
    const row = store.db.prepare(`SELECT users.id,users.email FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(hash,new Date().toISOString());
    if (!row) return res.status(401).json({error:'Your session expired. Sign in again.'});
    if (!bearer && !['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin !== publicUrl) {
      return res.status(403).json({error:'This request must come from this app. Reload the page and try again.'});
    }
    (req as AuthenticatedRequest).user = {id:String(row.id),email:String(row.email)};
    (req as AuthenticatedRequest).sessionHash = hash;
    next();
  };
}

/** Process-local limiting for one MVP instance; use a shared limiter before scaling horizontally. */
export function rateLimit(max: number, windowMs: number, keyFor: (req: Request) => string = req=>req.ip ?? 'unknown') {
  const buckets = new Map<string,{count:number,reset:number}>();
  let requests = 0;
  return (req: Request,res: Response,next: NextFunction) => {
    const now = Date.now();
    if (++requests % 100 === 0 || buckets.size > 10000) for (const [key,bucket] of buckets) if (bucket.reset <= now) buckets.delete(key);
    const key = keyFor(req); const previous = buckets.get(key);
    const bucket = previous && previous.reset > now ? previous : {count:0,reset:now+windowMs};
    bucket.count++; buckets.set(key,bucket);
    if (bucket.count > max) {
      res.setHeader('Retry-After',String(Math.ceil((bucket.reset-now)/1000)));
      return res.status(429).json({error:'Too many attempts. Please wait before trying again.'});
    }
    next();
  };
}
