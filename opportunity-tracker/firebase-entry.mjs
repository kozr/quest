import {createTrackerApp,orderMonitorProducts} from './server.mjs';
import {dueProducts} from './monitor.mjs';
import {collectionDueIds} from './collection.mjs';
export {default} from './server.mjs';

export function firebaseRuntimeConfig(env=process.env) {
  let config;
  try {config=JSON.parse(env.HEARWHISPERS_RUNTIME_CONFIG);} catch {throw new Error('Firebase runtime configuration is unavailable.');}
  if (!config || Array.isArray(config) || config.FIREBASE_PROJECT_ID !== 'the-app-quest' || config.FIREBASE_DATABASE_ID !== 'opportunity-tracker' || config.TRACKER_WORKSPACE !== 'personal' || config.TRACKER_RECORD_STORAGE_ENABLED !== 'true') throw new Error('Firebase storage target differs from the current dashboard.');
  for (const [key,value] of Object.entries(config)) {
    if (!/^(TRACKER_[A-Z_]+|FIREBASE_(PROJECT_ID|DATABASE_ID)|APIFY_TOKEN|SCRAPEBADGER_API_KEY|REDDIT_PROVIDER|LINKEDIN_PROVIDER|REDDIT_COMMENTS_ENABLED|INSTAGRAM_SEARCH_ENABLED)$/.test(key) || typeof value !== 'string') throw new Error('Invalid Firebase runtime setting.');
  }
  if (config.TRACKER_AUTH_COOKIE_MODE !== 'firebase-hosting' || !config.TRACKER_PUBLIC_ORIGINS) throw new Error('Firebase Hosting authentication is not configured.');
  return config;
}

let tracker;
function runtime() {
  if (!tracker) {
    const config=firebaseRuntimeConfig();
    // Cloud Functions uses its existing Google runtime identity, not Vercel WIF
    // or a downloaded service-account key. Database selection stays explicit.
    Object.assign(process.env,config);
    tracker=createTrackerApp({hosted:true,qualificationEnv:config});
  }
  return tracker;
}

export function hearwhispersApi(req,res) {
  try {return runtime().app(req,res);} catch {res.status(503).json({error:'The dashboard runtime is unavailable. Try again shortly.'});}
}

export async function runFirebaseMonitorTick(current,{now=Date.now,maxDurationMs=420000}={}) {
  const started=now(),snapshot=await current.store.snapshot();
  const ids=orderMonitorProducts(snapshot,[...new Set([...dueProducts(snapshot,started).map(p=>p.id),...collectionDueIds(snapshot,started)])]);
  const result={checked:0,failed:0,qualification:'deferred'};
  for (const id of ids) {
    if (now()-started>=maxDurationMs) break;
    try {await current.runSearch(id,true);result.checked++;} catch {result.failed++;}
  }
  if (now()-started<maxDurationMs) {
    try {await current.runQualification();result.qualification='checked';} catch {result.qualification='failed';}
  }
  return result;
}

// This function is private at Cloud Run IAM. Only the dedicated Scheduler
// invocation can run collection. No public URL or browser timer dispatches it.
export async function hearwhispersWorker(req,res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const current=runtime();
    if (req.body?.mode === 'status') {
      const views=await current.store.backend.openReadViews();
      return res.json({ready:Boolean(views),revision:views?.revision||null,storage:'records'});
    }
    res.json(await runFirebaseMonitorTick(current));
  } catch {res.status(503).json({error:'The scheduled dashboard worker could not complete.'});}
}
