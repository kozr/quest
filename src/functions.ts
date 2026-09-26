import {onRequest} from 'firebase-functions/v2/https';
import {onTaskDispatched} from 'firebase-functions/v2/tasks';
import {onDocumentCreated,onDocumentUpdated} from 'firebase-functions/v2/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {getFunctions} from 'firebase-admin/functions';
import {createApplication} from './app.js';
import {readConfiguration} from './config.js';
import {firebaseServices} from './firebase.js';
import {Store,type Job} from './database.js';
import type {ForwardingJob} from './forwarding.js';
import {purgeAccount,purgeAppData} from './account-deletion.js';
import {configuredLeadProvider,leadAISettings} from './leads-ai.js';
import {LeadWorkerBusy,processLeadReplyJob,processLeadDraftJob,processLeadQualificationJob,processLeadJobs} from './leads-jobs.js';
import {advanceInitialLeadScan} from './leads-initial-scan.js';
import {advanceMarketScan,recoverMarketScans,marketSourceAdapter} from './market-jobs.js';
import {configuredMarketAIProvider,marketAISettings} from './market-ai.js';

const region=process.env.IAP_FUNCTION_REGION ?? 'us-central1';
// Deploy login/webhook storage before APNs is provisioned; never use a dummy key.
// Adding APNS_TOPIC requires the real Secret Manager key and a redeploy.
const pushSecrets=process.env.APNS_TOPIC ? ['APNS_PRIVATE_KEY'] : [];
const marketAPISecrets=process.env.MARKET_ENABLED==='true'?['APIFY_TOKEN','MARKET_CURSOR_SECRET',...(process.env.MARKET_AI_ENABLED==='true'?['OPENAI_API_KEY']:[])]:[];
let application:ReturnType<typeof createApplication>|undefined;
// Lazy initialization lets the CLI discover functions without production credentials.
function runtime() {return application ??= createApplication(readConfiguration({...process.env,NODE_ENV:'production'}));}
function services() {return firebaseServices({firebaseProjectId:process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID!,firebaseWebApiKey:process.env.IAP_FIREBASE_WEB_API_KEY!});}
function store() {const firebase=services();return new Store(firebase.db,firebase.identity);}

export const api=onRequest({region,memory:'512MiB',timeoutSeconds:60,maxInstances:10,secrets:[...new Set([...pushSecrets,...marketAPISecrets])],invoker:'public'},(req,res)=>runtime().app(req,res));
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
export const deliverForward=onTaskDispatched({region,memory:'256MiB',timeoutSeconds:60,maxInstances:5,
  retryConfig:{maxAttempts:200,maxRetrySeconds:86400,minBackoffSeconds:10,maxBackoffSeconds:3600,maxDoublings:8},
  rateLimits:{maxConcurrentDispatches:10,maxDispatchesPerSecond:20},
},async req=>{
  if(typeof req.data?.jobId!=='string' || !/^[a-f0-9]{64}$/.test(req.data.jobId)) throw new Error('Invalid forwarding job ID.');
  // Forwarding remains usable without APNs secrets or an initialized push transport.
  const {ForwardingWorker,HttpsForwardTransport}=await import('./forwarding.js');
  await new ForwardingWorker(store(),new HttpsForwardTransport(process.env.PUBLIC_URL!)).deliver(req.data.jobId);
});
async function enqueueForward(jobId:string,taskId=jobId) {
  const queue=getFunctions(services().app).taskQueue(`locations/${region}/functions/deliverForward`);
  try {await queue.enqueue({jobId},{id:taskId,dispatchDeadlineSeconds:60});}
  catch(error) {if((error as {code?:string}).code!=='functions/task-already-exists') throw error;}
}
export const queueForward=onDocumentCreated({document:'forwarding_jobs/{jobId}',region,retry:true},async event=>{
  if(event.data?.data().state==='pending') await enqueueForward(event.params.jobId);
});
export const recoverForward=onSchedule({schedule:'every 5 minutes',region,timeoutSeconds:120,maxInstances:1},async()=>{
  const s=store();
  const jobs=await s.query<ForwardingJob>(s.collection('forwarding_jobs').where('state','in',['pending','processing']).where('next_attempt_at','<=',Date.now()-300000).orderBy('next_attempt_at').limit(100));
  await Promise.all(jobs.map(job=>enqueueForward(job.id,`${job.id}-${Math.floor(Date.now()/300000)}`)));
});
const leadWorkerSecrets=process.env.LEADS_AI_ENABLED==='true'?['OPENAI_API_KEY']:[];
export const processLeadDraft=onTaskDispatched({region,memory:'512MiB',timeoutSeconds:60,maxInstances:5,secrets:leadWorkerSecrets,
  retryConfig:{maxAttempts:8,maxRetrySeconds:3600,minBackoffSeconds:5,maxBackoffSeconds:300,maxDoublings:5},
  rateLimits:{maxConcurrentDispatches:4,maxDispatchesPerSecond:2},
},async req=>{
  if(typeof req.data?.jobId!=='string'||!/^[a-f0-9]{64}$/.test(req.data.jobId)) throw new Error('Invalid lead draft job ID.');
  const settings=leadAISettings(process.env),provider=configuredLeadProvider(settings);
  const result=await processLeadDraftJob(store(),req.data.jobId,provider,process.env);
  if(result.reasonCode==='WORKER_BUSY') throw new LeadWorkerBusy();
});
async function enqueueLeadDraft(jobId:string) {
  const queue=getFunctions(services().app).taskQueue(`locations/${region}/functions/processLeadDraft`);
  try {await queue.enqueue({jobId},{id:jobId,dispatchDeadlineSeconds:60});}
  catch(error) {if((error as {code?:string}).code!=='functions/task-already-exists') throw error;}
}
/** Firestore is the durable outbox; Cloud Tasks makes requested drafts prompt, and cron recovers them. */
export const queueLeadDraft=onDocumentCreated({document:'lead_jobs/{jobId}',region,retry:true},async event=>{
  const row=event.data?.data();if(row?.state!=='pending') return;
  if(row.kind==='draft') await enqueueLeadDraft(event.params.jobId);
  if(row.kind==='qualify'||row.kind==='reply') {
    const queue=getFunctions(services().app).taskQueue(`locations/${region}/functions/${row.kind==='reply'?'processLeadReply':'processLeadQualification'}`);
    try {await queue.enqueue({jobId:event.params.jobId},{id:event.params.jobId,dispatchDeadlineSeconds:60});}
    catch(error) {if((error as {code?:string}).code!=='functions/task-already-exists') throw error;}
  }
});
export const processLeadReply=onTaskDispatched({region,memory:'512MiB',timeoutSeconds:60,maxInstances:5,secrets:leadWorkerSecrets,
  retryConfig:{maxAttempts:12,maxRetrySeconds:1800,minBackoffSeconds:5,maxBackoffSeconds:60,maxDoublings:4},
  rateLimits:{maxConcurrentDispatches:4,maxDispatchesPerSecond:2},
},async req=>{
  if(typeof req.data?.jobId!=='string'||!/^[a-f0-9]{64}$/.test(req.data.jobId)) throw new Error('Invalid reply job ID.');
  const result=await processLeadReplyJob(store(),req.data.jobId,configuredLeadProvider(leadAISettings(process.env)),process.env);
  if(result.reasonCode==='WORKER_BUSY') throw new LeadWorkerBusy();
});
export const processLeadQualification=onTaskDispatched({region,memory:'512MiB',timeoutSeconds:60,maxInstances:5,secrets:leadWorkerSecrets,
  retryConfig:{maxAttempts:30,maxRetrySeconds:1800,minBackoffSeconds:5,maxBackoffSeconds:60,maxDoublings:4},
  rateLimits:{maxConcurrentDispatches:3,maxDispatchesPerSecond:3},
},async req=>{
  if(typeof req.data?.jobId!=='string'||!/^[a-f0-9]{64}$/.test(req.data.jobId)) throw new Error('Invalid qualification job ID.');
  const result=await processLeadQualificationJob(store(),req.data.jobId,configuredLeadProvider(leadAISettings(process.env)),process.env);
  if(result.reasonCode==='WORKER_BUSY') throw new LeadWorkerBusy();
});
export const processInitialLeadScan=onTaskDispatched({region,memory:'512MiB',timeoutSeconds:180,maxInstances:2,secrets:['APIFY_TOKEN',...leadWorkerSecrets],
  retryConfig:{maxAttempts:80,maxRetrySeconds:2100,minBackoffSeconds:15,maxBackoffSeconds:30,maxDoublings:1},
  rateLimits:{maxConcurrentDispatches:2,maxDispatchesPerSecond:1},
},async req=>{
  if(typeof req.data?.scanId!=='string'||!/^[a-f0-9]{64}$/.test(req.data.scanId)) throw new Error('Invalid first scan ID.');
  const {RedditApify}=await import('./reddit-apify.js');
  if(!process.env.APIFY_TOKEN) throw new Error('Collection is unavailable.');
  if(!await advanceInitialLeadScan(store(),req.data.scanId,new RedditApify(process.env.APIFY_TOKEN),process.env,Date.now(),configuredLeadProvider(leadAISettings(process.env)))) throw new Error('INITIAL_SCAN_PENDING');
});
async function enqueueInitialScan(scanId:string,taskId=scanId) {
  const queue=getFunctions(services().app).taskQueue(`locations/${region}/functions/processInitialLeadScan`);
  try {await queue.enqueue({scanId},{id:taskId,dispatchDeadlineSeconds:480});}
  catch(error) {if((error as {code?:string}).code!=='functions/task-already-exists') throw error;}
}
export const queueInitialLeadScan=onDocumentCreated({document:'lead_scans/{scanId}',region,retry:true},async event=>{
  if(event.data?.data().state==='queued') await enqueueInitialScan(event.params.scanId);
});
export const recoverLeadJobs=onSchedule({schedule:'every 5 minutes',region,timeoutSeconds:540,memory:'1GiB',maxInstances:1,secrets:leadWorkerSecrets},async()=>{
  const settings=leadAISettings(process.env),provider=configuredLeadProvider(settings);
  await processLeadJobs(store(),provider,process.env);
});

const marketWorkerSecrets=process.env.MARKET_ENABLED==='true'?(process.env.MARKET_AI_ENABLED==='true'?['APIFY_TOKEN','OPENAI_API_KEY']:['APIFY_TOKEN']):[];
export const processMarketScan=onTaskDispatched({region,memory:'512MiB',timeoutSeconds:480,maxInstances:4,secrets:marketWorkerSecrets,
  retryConfig:{maxAttempts:80,maxRetrySeconds:2100,minBackoffSeconds:5,maxBackoffSeconds:60,maxDoublings:4},
  rateLimits:{maxConcurrentDispatches:4,maxDispatchesPerSecond:1},
},async req=>{
  if(typeof req.data?.scanId!=='string'||!/^[a-f0-9-]{36}$/.test(req.data.scanId)) throw new Error('Invalid Market scan ID.');
  if(!process.env.APIFY_TOKEN) throw new Error('Market collection is unavailable.');
  const ai=configuredMarketAIProvider(marketAISettings(process.env));
  const result=await advanceMarketScan(store(),req.data.scanId,marketSourceAdapter(process.env.APIFY_TOKEN),ai,process.env,Date.now());
  if(result&&typeof result==='object'&&(('pending' in result&&result.pending)||('continueAI' in result&&result.continueAI)))
    throw new Error('MARKET_SCAN_PENDING');
});
async function enqueueMarket(scanId:string,taskId=scanId) {
  const queue=getFunctions(services().app).taskQueue(`locations/${region}/functions/processMarketScan`);
  try {await queue.enqueue({scanId},{id:taskId,dispatchDeadlineSeconds:480});}
  catch(error) {if((error as {code?:string}).code!=='functions/task-already-exists') throw error;}
}
/** Firestore is the durable Market outbox; task retries poll paid runs and recover continues after infrastructure failures. */
export const queueMarketScan=onDocumentCreated({document:'market_scans/{scanId}',region,retry:true},async event=>{
  if(event.data?.data().state==='queued') await enqueueMarket(event.params.scanId);
});
export const recoverMarketScansTask=onSchedule({schedule:'every 5 minutes',region,timeoutSeconds:540,maxInstances:1},async()=>{
  const s=store(),now=Date.now(),ids=await recoverMarketScans(s,now,100),bucket=Math.floor(now/300_000);
  await Promise.all(ids.map(id=>enqueueMarket(id,`${id}-${bucket}`)));
});
export async function purgeApp(s:Store,appId:string) {
  await purgeAppData(s,appId);
}
export const cleanupApp=onDocumentUpdated({document:'apps/{appId}',region,retry:true,timeoutSeconds:540},async event=>{
  if(event.data?.before.data().active && event.data.after.data().active===false) await purgeApp(store(),event.params.appId);
});
export const cleanupAccount=onDocumentCreated({document:'account_deletions/{userId}',region,retry:true,timeoutSeconds:540,maxInstances:2},async event=>{
  if(event.data?.data().state==='pending') await purgeAccount(store(),event.params.userId);
});
export const recoverAccountDeletion=onSchedule({schedule:'every 30 minutes',region,timeoutSeconds:540,maxInstances:1},async()=>{
  const s=store();
  const pending=await s.collection('account_deletions').where('state','==','pending').limit(50).get();
  for(const job of pending.docs) await purgeAccount(s,job.id);
});

// No provider access or billable runs until the beta flag, invited IDs, and secret are configured.
export const monitorReddit=onSchedule({schedule:'every 5 minutes',region,timeoutSeconds:180,maxInstances:1,secrets:['APIFY_TOKEN']},async()=>{
  if(process.env.REDDIT_MONITORING_ENABLED!=='true') return;
  const [{collectReddit},{RedditApify}]=await Promise.all([import('./reddit-collector.js'),import('./reddit-apify.js')]);
  if(!process.env.APIFY_TOKEN) throw new Error('APIFY_TOKEN is not configured.');
  await collectReddit(store(),new RedditApify(process.env.APIFY_TOKEN));
});
