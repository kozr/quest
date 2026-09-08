import {onRequest} from 'firebase-functions/v2/https';
import {onTaskDispatched} from 'firebase-functions/v2/tasks';
import {onDocumentCreated,onDocumentUpdated} from 'firebase-functions/v2/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {getFunctions} from 'firebase-admin/functions';
import {createApplication} from './app.js';
import {readConfiguration} from './config.js';
import {firebaseServices} from './firebase.js';
import {Store,type Job} from './database.js';

const region=process.env.IAP_FUNCTION_REGION ?? 'us-central1';
// Deploy login/webhook storage before APNs is provisioned; never use a dummy key.
// Adding APNS_TOPIC requires the real Secret Manager key and a redeploy.
const pushSecrets=process.env.APNS_TOPIC ? ['APNS_PRIVATE_KEY'] : [];
let application:ReturnType<typeof createApplication>|undefined;
// Lazy initialization lets the CLI discover functions without production credentials.
function runtime() {return application ??= createApplication(readConfiguration({...process.env,NODE_ENV:'production'}));}
function services() {return firebaseServices({firebaseProjectId:process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID!,firebaseWebApiKey:process.env.IAP_FIREBASE_WEB_API_KEY!});}
function store() {const firebase=services();return new Store(firebase.db,firebase.identity);}

export const api=onRequest({region,memory:'512MiB',timeoutSeconds:60,maxInstances:10,secrets:pushSecrets,invoker:'public'},(req,res)=>runtime().app(req,res));
export const deliverPush=onTaskDispatched({region,memory:'256MiB',timeoutSeconds:60,maxInstances:5,secrets:pushSecrets,
  retryConfig:{maxAttempts:100,maxRetrySeconds:86400,minBackoffSeconds:10,maxBackoffSeconds:3600,maxDoublings:8},
  rateLimits:{maxConcurrentDispatches:10,maxDispatchesPerSecond:20},
},async req=>{
  if(typeof req.data?.jobId!=='string' || !/^[a-f0-9-]{36}$/.test(req.data.jobId)) throw new Error('Invalid job ID.');
  await runtime().worker.deliver(req.data.jobId);
});
async function enqueue(jobId:string,taskId=jobId) {
  const firebase=services();
  const queue=getFunctions(firebase.app).taskQueue(`locations/${region}/functions/deliverPush`);
  try {await queue.enqueue({jobId},{id:taskId,dispatchDeadlineSeconds:60});}
  catch(error) {if((error as {code?:string}).code!=='functions/task-already-exists') throw error;}
}
/** Firestore is the durable outbox: failed task creation retries independently of Apple delivery. */
export const queuePush=onDocumentCreated({document:'delivery_jobs/{jobId}',region,retry:true},async event=>{
  if(event.data?.data().state==='pending') await enqueue(event.params.jobId);
});
/** Recover exhausted/stranded tasks after infrastructure failures; leases still prevent concurrent sends. */
export const recoverPush=onSchedule({schedule:'every 5 minutes',region,timeoutSeconds:120,maxInstances:1},async()=>{
  const s=store();
  const jobs=await s.query<Job>(s.collection('delivery_jobs').where('state','in',['pending','processing']).where('next_attempt_at','<=',Date.now()-300000).orderBy('next_attempt_at').limit(100));
  await Promise.all(jobs.map(job=>enqueue(job.id,`${job.id}-${Math.floor(Date.now()/300000)}`)));
});
export async function purgeApp(s:Store,appId:string) {
  // Bounded batches make deletion resumable; the app tombstone prevents further writes/sends.
  for(const [collection,field] of [['events','appId'],['notifications','app_id'],['economic_events','app_id'],['delivery_jobs','app_id']]) {
    for(;;) {
      const page=await s.collection(collection).where(field,'==',appId).limit(400).get();
      if(page.empty) break;
      const batch=s.db.batch();for(const doc of page.docs) batch.delete(doc.ref);await batch.commit();
    }
  }
}
export const cleanupApp=onDocumentUpdated({document:'apps/{appId}',region,retry:true,timeoutSeconds:540},async event=>{
  if(event.data?.before.data().active && event.data.after.data().active===false) await purgeApp(store(),event.params.appId);
});
