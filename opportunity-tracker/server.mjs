import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Store } from './store.mjs';
import { importMetadata, publicUrl } from './metadata.mjs';
import { discover } from './discovery.mjs';
import { configuredFirestore, FirestoreBackend, FirestoreStore } from './firestore-store.mjs';
import { createAuth } from './auth.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const list = (value, max = 12) => {
  if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || x.length > 160)) throw new Error(`Use up to ${max} phrases, each under 160 characters.`);
  return [...new Set(value.map(x => x.trim()).filter(Boolean))];
};
export function validateProduct(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) throw new Error('Enter a product name under 120 characters.');
  if (typeof value.description !== 'string' || value.description.length > 5000) throw new Error('Describe the product in 5,000 characters or fewer.');
  if (typeof value.url !== 'string' || value.url.length > 2048) throw new Error('Enter a website or App Store URL.');
  const url = publicUrl(value.url).href;
  const keywords = list(value.keywords);
  if (!keywords.length) throw new Error('Add at least one phrase describing a problem your product solves.');
  return { name: value.name.trim(), description: value.description.trim(), url, type: new URL(url).hostname === 'apps.apple.com' ? 'app_store' : 'website', keywords, aliases: list(value.aliases || [value.name]), exclusions: list(value.exclusions || []) };
}

export function createTrackerApp({ dataDirectory = process.env.TRACKER_DATA_DIR || join(directory, '.local'), discoverFn = discover, metadataFn = importMetadata, store: providedStore, hosted = false, password = process.env.TRACKER_PASSWORD, sessionSecret = process.env.TRACKER_SESSION_SECRET, firebaseProjectId = process.env.FIREBASE_PROJECT_ID, firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON, workspace = process.env.TRACKER_WORKSPACE || (process.env.VERCEL_ENV === 'preview' ? 'preview' : 'personal') } = {}) {
  const auth = hosted ? createAuth({password,secret:sessionSecret}) : null;
  const store = providedStore || (hosted ? new FirestoreStore(new FirestoreBackend(configuredFirestore({projectId:firebaseProjectId,serviceAccountJson:firebaseServiceAccountJson}),workspace)) : new Store(dataDirectory));
  const app = express();
  const token = randomBytes(24).toString('hex');
  const busy = new Set();
  const loginAttempts = [];
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const busyIds = async () => store.activeSearches ? await store.activeSearches() : [...busy];
  app.disable('x-powered-by');
  if(hosted) app.set('trust proxy',1);
  app.use((req,res,next) => {
    if (!hosted && !allowedHosts.has(req.hostname)) return res.status(403).json({error:'Open this tracker using localhost.'});
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if(req.path.startsWith('/api/')) {
      res.set('Cache-Control','no-store');
      if(req.method!=='GET' && req.get('origin') && req.get('origin')!==`${req.protocol}://${req.get('host')}`) return res.status(403).json({error:'This request came from another website.'});
      if(req.path==='/api/auth' || req.path==='/api/login') return next();
      if(auth&&!auth.authenticated(req)) return res.status(401).json({error:'Sign in to open your tracker.'});
      if(req.method!=='GET' && req.get('X-Tracker-Token')!==(auth ? auth.csrf(req) : token)) return res.status(403).json({error:'Refresh the page and try again.'});
    }
    next();
  });
  app.use(express.json({limit:'2mb'}));
  app.get('/api/auth',(_req,res)=>res.json({hosted,authenticated:!auth||auth.authenticated(_req),storage:hosted?'cloud':'local'}));
  app.post('/api/login',async(req,res)=>{
    if(!auth) return res.status(400).json({error:'Local mode does not require sign-in.'});
    const allowed=store.allowLoginAttempt ? await store.allowLoginAttempt() : (()=>{while(loginAttempts[0]<Date.now()-300000) loginAttempts.shift(); if(loginAttempts.length>=15)return false; loginAttempts.push(Date.now());return true;})();
    if(!allowed) return res.status(429).json({error:'Too many sign-in attempts. Wait five minutes and try again.'});
    if(!auth.validPassword(req.body.password)) return res.status(401).json({error:'Incorrect password. Try again.'});
    auth.login(res); res.json({ok:true});
  });
  app.post('/api/logout',(_req,res)=>{auth?.logout(res);res.json({ok:true});});
  app.get('/api/state',async(req,res)=>res.json({...await store.snapshot(),token:auth?auth.csrf(req):token,busy:await busyIds(),storage:hosted?'cloud':'local'}));
  app.post('/api/metadata',async(req,res)=>{if(typeof req.body.url!=='string') throw new Error('Enter a URL.');res.json(await metadataFn(req.body.url));});
  app.post('/api/products',async(req,res)=>{
    if((await store.snapshot()).products.length>=100) throw new Error('The tracker supports up to 100 products.');
    res.status(201).json({product:await store.saveProduct(validateProduct(req.body))});
  });
  app.put('/api/products/:id',async(req,res)=>{
    const product=await store.saveProduct(validateProduct(req.body),req.params.id);
    if(!product) return res.status(404).json({error:'Product not found.'}); res.json({product});
  });
  app.delete('/api/products/:id',async(req,res)=>{await store.deleteProduct(req.params.id);res.json({ok:true});});
  app.post('/api/products/:id/search',async(req,res)=>{
    const product=(await store.snapshot()).products.find(p=>p.id===req.params.id);
    if(!product) return res.status(404).json({error:'Product not found.'});
    let lease;
    if(store.claimSearch) lease=await store.claimSearch(product.id);
    else if(!busy.has(product.id)) {busy.add(product.id);lease=true;}
    if(!lease) return res.status(409).json({error:'A search is already running for this product.'});
    try {
      const result=await discoverFn(structuredClone(product));
      await store.recordSearch(product.id,result);
      const data=await store.snapshot();
      res.json({search:data.searches[product.id],items:data.items.filter(i=>i.productId===product.id)});
    } finally {
      if(store.releaseSearch) await store.releaseSearch(product.id,lease);
      else busy.delete(product.id);
    }
  });
  app.patch('/api/items/:id',async(req,res)=>{
    const update={};
    if(req.body.status!==undefined) {if(!['new','saved','dismissed'].includes(req.body.status)) throw new Error('Choose New, Saved, or Dismissed.');update.status=req.body.status;}
    if(req.body.note!==undefined) {if(typeof req.body.note!=='string'||req.body.note.length>3000) throw new Error('Notes must be under 3,000 characters.');update.note=req.body.note;}
    const item=await store.updateItem(req.params.id,update);
    if(!item) return res.status(404).json({error:'Match not found.'});res.json({item});
  });
  app.get('/api/export',async(_req,res)=>res.set('Content-Disposition','attachment; filename="product-tracker.json"').json(await store.snapshot()));
  app.post('/api/import',async(req,res)=>{
    if((await busyIds()).length) throw new Error('Wait for the running searches to finish before restoring a backup.');
    const data=req.body;
    if(data?.version!==1||!Array.isArray(data.products)||data.products.length>100||!Array.isArray(data.items)||data.items.length>10000) throw new Error('Choose a tracker JSON backup.');
    const products=data.products.map(p=>{
      if(typeof p.id!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(p.id)||['__proto__','constructor','prototype'].includes(p.id)) throw new Error('The backup has invalid product IDs.');
      return {...validateProduct(p),id:p.id,createdAt:typeof p.createdAt==='string'?p.createdAt:new Date().toISOString(),updatedAt:typeof p.updatedAt==='string'?p.updatedAt:new Date().toISOString()};
    });
    if(products.some(p=>!p.id)||new Set(products.map(p=>p.id)).size!==products.length) throw new Error('The backup has invalid product IDs.');
    const ids=new Set(products.map(p=>p.id));
    const items=data.items.map(i=>{
      if(!ids.has(i.productId)||!['opportunity','mention'].includes(i.kind)||!['new','saved','dismissed'].includes(i.status)||typeof i.id!=='string'||!i.id||typeof i.title!=='string'||typeof i.note!=='string'||i.note.length>3000) throw new Error('The backup has invalid matches.');
      const provenance = {};
      for (const key of ['sourceId', 'postId', 'parentId']) if (i[key] != null) {
        if (typeof i[key] !== 'string' || !/^(?:t[13]_)?[a-z0-9]{1,20}$/i.test(i[key])) throw new Error('The backup has invalid Reddit IDs.');
        provenance[key] = i[key];
      }
      if (i.parentId === null) provenance.parentId = null;
      if (['redlib', 'public-json'].includes(i.provider)) provenance.provider = i.provider;
      if (['post', 'comment'].includes(i.type)) provenance.type = i.type;
      if (typeof i.collectedAt === 'string' && Number.isFinite(Date.parse(i.collectedAt))) provenance.collectedAt = new Date(i.collectedAt).toISOString();
      return {...provenance,id:i.id,productId:i.productId,kind:i.kind,status:i.status,note:i.note,url:publicUrl(i.url).href,title:i.title.slice(0,500),snippet:String(i.snippet||'').slice(0,10000),reason:String(i.reason||'').slice(0,3000),source:typeof i.source==='string'?i.source.slice(0,100):'Imported',author:typeof i.author==='string'?i.author.slice(0,120):null,publishedAt:typeof i.publishedAt==='string'?i.publishedAt:null,foundAt:typeof i.foundAt==='string'?i.foundAt:new Date().toISOString(),lastSeenAt:typeof i.lastSeenAt==='string'?i.lastSeenAt:new Date().toISOString(),matchedTerms:Array.isArray(i.matchedTerms)?i.matchedTerms.filter(t=>typeof t==='string').slice(0,20):[]};
    });
    if(new Set(items.map(i=>i.id)).size!==items.length) throw new Error('The backup has duplicate matches.');
    await store.importData({version:1,products,items,searches:{}});res.json({ok:true});
  });
  app.use(express.static(join(directory,'public')));
  app.use((err,_req,res,_next)=>res.status(err.status||400).json({error:err.type==='entity.too.large'?'The backup is too large.':err.message||'The request failed. Try again.'}));
  return {app,store};
}

// Vercel imports the default Express export. Configuration is evaluated on the
// first request, so builds do not need secrets or create an ephemeral store.
const vercelApp=express();
let hostedApp;
vercelApp.use((req,res,next)=>{
  try {hostedApp ||= createTrackerApp({hosted:true}).app;return hostedApp(req,res,next);}
  catch {res.status(503).json({error:'Configure the Firebase connection, TRACKER_PASSWORD (16+ characters), and TRACKER_SESSION_SECRET (32+ characters) for this Vercel project.'});}
});
export default vercelApp;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port=Number(process.env.TRACKER_PORT||4322);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Use a TRACKER_PORT between 1024 and 65535.');
  createTrackerApp().app.listen(port,'127.0.0.1',()=>console.log(`Product tracker: http://127.0.0.1:${port}`));
}
