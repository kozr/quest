import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { Configuration } from './config.js';
import type { User } from './types.js';
import { createHash } from 'node:crypto';

export class ServiceError extends Error { constructor(public status:number,message:string) {super(message);} }
export interface Identity { user:User; authTime:number }
export interface FirebaseServices { app:App; db:Firestore; identity:FirebaseIdentity }
/** Exchange native Apple credentials using Firebase's OAuth credential protocol.
 * Apple/Firebase tokens are transient; only our own opaque session is persisted. */
export class FirebaseIdentity {
  constructor(readonly auth:Auth,private apiKey:string) {}
  async signInWithApple(idToken:string,rawNonce:string):Promise<Identity> {
    // These untrusted claims can only REJECT a request. Firebase below verifies
    // Apple's signature, issuer, audience and nonce before admitting any user.
    try {
      const claims=JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString());
      const now=Math.floor(Date.now()/1000);
      if (claims.iss!=='https://appleid.apple.com' || claims.nonce!==createHash('sha256').update(rawNonce).digest('hex') ||
          !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat<now-300 || claims.iat>now+60 || claims.exp<=now) throw new Error();
    } catch {throw new ServiceError(401,'Apple sign-in expired or could not be verified. Sign in with Apple again.');}
    const emulator=process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const base=emulator ? `http://${emulator}/identitytoolkit.googleapis.com/v1` : 'https://identitytoolkit.googleapis.com/v1';
    const response=await fetch(`${base}/accounts:signInWithIdp?key=${encodeURIComponent(this.apiKey)}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        requestUri:'http://localhost', // Firebase's documented native credential exchange; not a network redirect.
        postBody:new URLSearchParams({providerId:'apple.com',id_token:idToken,nonce:rawNonce}).toString(),returnSecureToken:true,
      }),signal:AbortSignal.timeout(15000),
    });
    const result=await response.json() as {idToken?:string;error?:{message?:string}};
    if (!response.ok) {
      const code=result.error?.message ?? '';
      if (/EMAIL_EXISTS|FEDERATED_USER_ID_ALREADY_LINKED/.test(code)) throw new ServiceError(409,'This Apple account could not be connected. Contact the server owner; accounts are not linked automatically.');
      if (/TOO_MANY_ATTEMPTS/.test(code)) throw new ServiceError(429,'Too many attempts. Please wait before trying again.');
      if (/INVALID_IDP_RESPONSE|INVALID_CREDENTIAL|MISSING_OR_INVALID_NONCE|USER_DISABLED/.test(code)) throw new ServiceError(401,'Apple sign-in could not be verified. Sign in with Apple again.');
      throw new ServiceError(503,'Apple sign-in is unavailable. The server owner must finish the Firebase Apple provider setup.');
    }
    if (!result.idToken) throw new ServiceError(503,'Firebase did not return a sign-in token.');
    let token;
    try {token=await this.auth.verifyIdToken(result.idToken,true);}
    catch {throw new ServiceError(401,'Apple sign-in could not be verified. Please try again.');}
    if (token.firebase.sign_in_provider!=='apple.com' || !token.email || !token.email_verified) throw new ServiceError(401,'A verified Sign in with Apple account is required.');
    return {user:{id:token.uid,email:token.email},authTime:token.auth_time};
  }
  async valid(userId:string,authTime:number):Promise<User|undefined> {
    try {
      const user=await this.auth.getUser(userId);
      if (user.disabled || !user.email || !user.providerData.some(provider=>provider.providerId==='apple.com') || authTime*1000<Date.parse(user.tokensValidAfterTime ?? '1970-01-01')) return;
      return {id:user.uid,email:user.email};
    } catch(error) {if ((error as {code?:string}).code==='auth/user-not-found') return;throw error;}
  }
}
export function firebaseServices(config:Pick<Configuration,'firebaseProjectId'|'firebaseWebApiKey'>):FirebaseServices {
  const name=`iap-${config.firebaseProjectId}`;
  const app=getApps().find(app=>app.name===name) ?? initializeApp({projectId:config.firebaseProjectId},name);
  return {app,db:getFirestore(app),identity:new FirebaseIdentity(getAuth(app),config.firebaseWebApiKey)};
}
