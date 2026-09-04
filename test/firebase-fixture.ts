import {randomUUID} from 'node:crypto';
import {firebaseServices} from '../src/firebase.js';
import {Store} from '../src/database.js';

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
