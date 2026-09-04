import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { Configuration } from './config.js';
import type { User } from './types.js';

export class ServiceError extends Error { constructor(public status:number,message:string) {super(message);} }
export interface Identity { user:User; authTime:number }
export interface FirebaseServices { app:App; db:Firestore; identity:FirebaseIdentity }
/** Firebase handles passwords. This service never stores passwords or refresh tokens. */
export class FirebaseIdentity {
  constructor(readonly auth:Auth,private apiKey:string) {}
  async signIn(email:string,password:string,register=false):Promise<Identity> {
    const emulator=process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const base=emulator ? `http://${emulator}/identitytoolkit.googleapis.com/v1` : 'https://identitytoolkit.googleapis.com/v1';
    const response=await fetch(`${base}/accounts:${register ? 'signUp' : 'signInWithPassword'}?key=${encodeURIComponent(this.apiKey)}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true}),signal:AbortSignal.timeout(15000),
    });
    const result=await response.json() as {idToken?:string;error?:{message?:string}};
    if (!response.ok) {
      const code=result.error?.message ?? '';
      if (code.startsWith('EMAIL_EXISTS')) throw new ServiceError(409,'An account with this email already exists. Sign in instead.');
      if (/TOO_MANY_ATTEMPTS/.test(code)) throw new ServiceError(429,'Too many attempts. Please wait before trying again.');
      if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|USER_DISABLED/.test(code)) throw new ServiceError(401,'Email or password is incorrect.');
      if (/WEAK_PASSWORD|PASSWORD_DOES_NOT_MEET_REQUIREMENTS/.test(code)) throw new ServiceError(400,'Choose a stronger password that meets the account password policy.');
      throw new ServiceError(503,'Firebase sign-in is unavailable. Check that Email/Password authentication is enabled.');
    }
    if (!result.idToken) throw new ServiceError(503,'Firebase did not return a sign-in token.');
    const token=await this.auth.verifyIdToken(result.idToken,true);
    if (!token.email) throw new ServiceError(401,'An email account is required.');
    return {user:{id:token.uid,email:token.email},authTime:token.auth_time};
  }
  async valid(userId:string,authTime:number):Promise<User|undefined> {
    try {
      const user=await this.auth.getUser(userId);
      if (user.disabled || !user.email || authTime*1000<Date.parse(user.tokensValidAfterTime ?? '1970-01-01')) return;
      return {id:user.uid,email:user.email};
    } catch(error) {if ((error as {code?:string}).code==='auth/user-not-found') return;throw error;}
  }
}
export function firebaseServices(config:Pick<Configuration,'firebaseProjectId'|'firebaseWebApiKey'>):FirebaseServices {
  const name=`iap-${config.firebaseProjectId}`;
  const app=getApps().find(app=>app.name===name) ?? initializeApp({projectId:config.firebaseProjectId},name);
  return {app,db:getFirestore(app),identity:new FirebaseIdentity(getAuth(app),config.firebaseWebApiKey)};
}
