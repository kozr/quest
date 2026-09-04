import {randomUUID} from 'node:crypto';
import {firebaseServices} from '../src/firebase.js';
import {Store} from '../src/database.js';
import {appleCredential} from './apple-auth-fixture.js';
import assert from 'node:assert/strict';

export async function appleIdentity(store:Store,email:string) {
  const credential=appleCredential(email);
  return store.identity.signInWithApple(credential.idToken,credential.rawNonce);
}

/** Exercise the actual QR endpoints to get a browser cookie from a phone. */
export async function pairBrowser(request:(path:string,options:any)=>Promise<any>,token:string,origin:string) {
  const start=await request('/api/pairing/start',{method:'POST',body:{},origin});
  assert.equal(start.status,201);
  const cookie=start.headers.getSetCookie().find((value:string)=>value.startsWith('iap_pairing='))!.split(';')[0];
  const {id,qrUrl}=start.body.pairing;
  const approval=await request('/api/pairing/approve',{method:'POST',token,body:{id,token:new URL(qrUrl).searchParams.get('token')}});
  assert.equal(approval.status,200);
  const result=await request('/api/pairing/redeem',{method:'POST',body:{id},cookie,origin});
  assert.equal(result.status,200);
  return result;
}

export const firebaseOptions={firebaseProjectId:'demo-iap-notifications',firebaseWebApiKey:'demo-key'};
export function testStore(prefix=`tests/${randomUUID()}/`) {
  if(!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') || !/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '') || process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT!==firebaseOptions.firebaseProjectId) throw new Error('Integration tests require local Firebase emulators. Run npm run test:firebase.');
  const services=firebaseServices(firebaseOptions);return new Store(services.db,services.identity,prefix);
}
/** Delete only named fixture accounts in the isolated demo project's Auth emulator. */
export async function resetAccounts(store:Store,emails:string[]) {
  for(const email of emails) try {await store.identity.auth.deleteUser((await store.identity.auth.getUserByEmail(email)).uid);}
  catch(error) {if((error as {code?:string}).code!=='auth/user-not-found') throw error;}
}
export async function rows(store:Store,collection:string) {return store.list<any>(collection);}
export async function jobs(store:Store) {return (await rows(store,'delivery_jobs')).sort((a,b)=>a.created_at.localeCompare(b.created_at));}
