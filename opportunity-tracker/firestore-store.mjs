import {accountRestore} from './account.mjs';
import {activeProduct,assertSubscriptionActive} from './plans.mjs';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { getVercelOidcToken } from '@vercel/oidc';
import { ExternalAccountClient } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import {mergeQualificationHistory} from './qualification.mjs';

const empty = () => ({ version: 1, products: [], items: [], searches: {} });
const chunkSize = 700 * 1024;
const maximumBytes = 8 * 1024 * 1024;
function unavailable() {
  const error = new Error('Firebase storage is unavailable. Check the Firebase configuration and try again.');
  error.status = 503;
  return error;
}

const federatedClients = new Map();
export function createVercelAuthClient({projectId, provider, serviceAccountEmail, tokenSupplier = getVercelOidcToken}) {
  if (!/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(provider || '') || !serviceAccountEmail?.endsWith(`@${projectId}.iam.gserviceaccount.com`)) throw new Error('Configure GCP_WIF_PROVIDER and GCP_SERVICE_ACCOUNT_EMAIL for this Firebase project.');
  return ExternalAccountClient.fromJSON({
    type: 'external_account',
    audience: `//iam.googleapis.com/${provider}`,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
    scopes: ['https://www.googleapis.com/auth/datastore'],
    subject_token_supplier: {getSubjectToken: () => tokenSupplier()},
  });
}
export function configuredFirestore({projectId = process.env.FIREBASE_PROJECT_ID, databaseId = process.env.FIREBASE_DATABASE_ID || '(default)', serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON, provider = process.env.GCP_WIF_PROVIDER, serviceAccountEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL} = {}) {
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('FIREBASE_PROJECT_ID is required for hosted storage.');
  if (process.env.VERCEL && (projectId.startsWith('demo-') || process.env.FIRESTORE_EMULATOR_HOST)) throw new Error('Vercel requires a real Firebase project without emulator settings.');
  if (databaseId !== '(default)' && !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(databaseId)) throw new Error('Use a valid FIREBASE_DATABASE_ID.');
  if (provider || serviceAccountEmail) {
    const key = `${projectId}:${databaseId}:${provider}:${serviceAccountEmail}`;
    if (!federatedClients.has(key)) {
      const authClient = createVercelAuthClient({projectId, provider, serviceAccountEmail});
      federatedClients.set(key, new Firestore({projectId, databaseId, authClient}));
    }
    return federatedClients.get(key);
  }
  let credential;
  if (serviceAccountJson) {
    try {
      const account = JSON.parse(serviceAccountJson);
      if (account.project_id !== projectId || !account.client_email || !account.private_key) throw new Error();
      credential = cert(account);
    } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain valid server credentials for FIREBASE_PROJECT_ID.'); }
  } else {
    if (process.env.VERCEL) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required on Vercel.');
    credential = applicationDefault();
  }
  const name = `opportunity-tracker-${projectId}`;
  const app = getApps().find(value => value.name === name) || initializeApp({projectId, credential}, name);
  return getFirestore(app, databaseId);
}

export class FirestoreBackend {
  constructor(db, workspace = 'personal') {
    if (!db) throw new Error('Configure Firebase for hosted storage.');
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workspace)) throw new Error('Use a TRACKER_WORKSPACE with 1–100 letters, numbers, underscores, or hyphens.');
    this.db = db;
    this.document = db.collection('opportunityTrackers').doc(workspace);
  }
  // Read the manifest and chunks at one consistent Firestore snapshot. Binary
  // JSON chunks avoid Firestore's 1 MiB document and nested-array restrictions.
  async read() {
    try {
      return await this.db.runTransaction(async transaction => {
        const snapshot = await transaction.get(this.document);
        if (!snapshot.exists) return {revision: 0, data: empty()};
        const {revision, chunks, bytes} = snapshot.data();
        if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isInteger(chunks) || chunks < 1 || chunks > Math.ceil(maximumBytes / chunkSize) || !Number.isInteger(bytes) || bytes > maximumBytes) throw new Error();
        const refs = Array.from({length: chunks}, (_, index) => this.document.collection('stateChunks').doc(String(index)));
        const snapshots = await transaction.getAll(...refs);
        const contents = Buffer.concat(snapshots.map(value => {
          if (!value.exists || !Buffer.isBuffer(value.data().bytes)) throw new Error();
          return value.data().bytes;
        }));
        if (contents.length !== bytes) throw new Error();
        return {revision, data: JSON.parse(contents.toString('utf8'))};
      }, {readOnly: true});
    } catch { throw unavailable(); }
  }
  async compareAndSwap(revision, data) {
    const contents = Buffer.from(JSON.stringify(data), 'utf8');
    if (contents.length > maximumBytes) {
      const error = new Error('The personal tracker has reached its 8 MiB storage limit. Export a backup and remove older products before adding more.');
      error.status = 413;
      throw error;
    }
    const count = Math.ceil(contents.length / chunkSize);
    try {
      return await this.db.runTransaction(async transaction => {
        const snapshot = await transaction.get(this.document);
        if ((snapshot.exists ? snapshot.data().revision : 0) !== revision) return false;
        for (let index = 0; index < count; index++) {
          transaction.set(this.document.collection('stateChunks').doc(String(index)), {bytes: contents.subarray(index * chunkSize, (index + 1) * chunkSize)});
        }
        for (let index = count; index < (snapshot.data()?.chunks || 0); index++) transaction.delete(this.document.collection('stateChunks').doc(String(index)));
        transaction.set(this.document, {revision: revision + 1, chunks: count, bytes: contents.length});
        return true;
      });
    } catch { throw unavailable(); }
  }
}

// The file and database adapters share the same record semantics. Each cloud
// mutation replays against fresh data and commits only its observed revision.
// Legacy modules omit optional object values with JSON.stringify. Preserve
// that storage behavior while keeping malformed arrays/numbers detectable.
function omitUndefinedProperties(value) {
  if(Array.isArray(value)){for(const row of value)omitUndefinedProperties(row);}
  else if(value&&typeof value==='object')for(const key of Object.keys(value)){if(value[key]===undefined)delete value[key];else omitUndefinedProperties(value[key]);}
  return value;
}
export class FirestoreStore {
  constructor(backend) { this.backend = backend; }
  async mutate(change) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { revision, data } = await this.backend.read();
      const next = structuredClone(data);
      const result = change(next);
      if(result&&typeof result.then==='function')throw new TypeError('Store mutation callbacks must be synchronous.');
      if (await this.backend.compareAndSwap(revision, omitUndefinedProperties(next))) return result;
    }
    const error = new Error('Another request is updating the tracker. Try again.');
    error.status = 409;
    throw error;
  }
  async snapshot() {
    const {data} = await this.backend.read();
    return structuredClone(data);
  }
  initializeAccount(options) {return this.record('initializeAccount',options);}
  accountAction(principal,action,input,now) {return this.record('accountAction',principal,action,input,now);}
  accountSnapshot(principal,now) {return this.backend.read().then(({data})=>{const memory=Object.create(Store.prototype);memory.data=data;return memory.accountSnapshot(principal,now);});}
  reserveAnalysisUnits(options) {return this.record('reserveAnalysisUnits',options);}
  settleAnalysisUnits(id,options) {return this.record('settleAnalysisUnits',id,options);}
  claimScheduledLoop(...args) {return this.record('claimScheduledLoop',...args);}
  finishScheduledLoop(...args) {return this.record('finishScheduledLoop',...args);}

  async record(method, ...args) {
    return this.mutate(data => {
      const memory = Object.create(Store.prototype);
      memory.data = data;
      memory.commit = next => { for(const key of Object.keys(data))delete data[key];Object.assign(data,next);memory.data=data; };
      return memory[method](...args);
    });
  }
  saveProduct(product,id,options) {
    return this.mutate(data=>{
      if(!data.subscription&&!id&&data.products.length>=100) throw new Error('The tracker supports up to 100 products.');
      const memory=Object.create(Store.prototype); memory.data=data;
      memory.commit=next=>Object.assign(data,next);
      return memory.saveProduct(product,id,options);
    });
  }
  deleteProduct(id) { return this.record('deleteProduct',id); }
  recordSearch(id,result) { return this.record('recordSearch',id,result); }
  markMonitorAttempt(id,now = Date.now()) { return this.record('markMonitorAttempt',id,now); }
  updateItem(id,update) { return this.record('updateItem',id,update); }
  claimAnalysis(productId,itemId,now,settings) { return this.record('claimAnalysis',productId,itemId,now,settings); }
  finishAnalysis(lease,result,now) { return this.record('finishAnalysis',lease,result,now); }
  releaseAnalysis(token) { return this.record('releaseAnalysis',token); }
  saveVideos(...args) {return this.record('saveVideos',...args);}
  saveDrafts(...args) {return this.record('saveDrafts',...args);}
  claimStage(...args) {return this.record('claimStage',...args);}
  finishStage(...args) {return this.record('finishStage',...args);}
  failStage(...args) {return this.record('failStage',...args);}
  saveSearchPlan(...args) {return this.record('saveSearchPlan',...args);}
  getBusinessProfile(inputHash) {return this.backend.read().then(({data})=>structuredClone(data.businessProfileDrafts?.[inputHash] || null));}
  claimBusinessProfile(inputHash,reservation,now,settings,refresh) {return this.record('claimBusinessProfile',inputHash,reservation,now,settings,refresh);}
  finishBusinessProfile(lease,result,now) {return this.record('finishBusinessProfile',lease,result,now);}
  beginBackfill(productId,now) {return this.record('beginBackfill',productId,now);}
  beginCollection(id,trigger,now,settings) { return this.record('beginCollection',id,trigger,now,settings); }
  claimCollection(settings,productId,now) {return this.record('claimCollection',settings,productId,now);}
  finishCollection(token,outcome,now) {return this.record('finishCollection',token,outcome,now);}
  claimQualificationBatch(settings,now,productId) {return this.record('claimQualificationBatch',settings,now,productId);}
  finishQualificationBatch(batch,outcome,now) {return this.record('finishQualificationBatch',batch,outcome,now);}
  claimQualification(settings,now,productId) { return this.record('claimQualification',settings,now,productId); }
  finishQualification(key,token,outcome,now) { return this.record('finishQualification',key,token,outcome,now); }
  importData(value) {
    return this.mutate(data=>{
      if(Object.values(data.leases||{}).some(lease=>lease.expiresAt>Date.now())) throw new Error('Wait for the running searches to finish before restoring a backup.');
      if(Object.values(data.qualifications||{}).some(job=>job.status==='running'&&job.leaseUntil>Date.now())) throw new Error('Wait for the running AI check to finish before restoring a backup.');
      if(Object.values(data.analysisLeases||{}).some(lease=>lease.expiresAt>Date.now())) throw new Error('Wait for the running analysis to finish before restoring a backup.');
      if(data.collection?.active)throw new Error('Wait for the collection request to finish before restoring a backup.');
      const collection=data.collection,ingestion=data.ingestion,conversationReviewFailures=data.conversationReviewFailures||{};
      const analysisUsage=data.analysisUsage||{};
      const failures=data.loginFailures||[];
      const merged=data.qualifications||value.qualifications?mergeQualificationHistory(data,value):structuredClone(value);
      const restored=data.workspace||data.subscription?accountRestore(data,merged):merged;
      delete restored.pilotBudget;if(Object.hasOwn(data,'pilotBudget'))restored.pilotBudget=structuredClone(data.pilotBudget);
      for(const key of Object.keys(data)) delete data[key];
      Object.assign(data,restored,{loginFailures:failures,analysisUsage,conversationReviewReceipts:{},conversationReviewFailures,...(collection?{collection}:{}),...(ingestion?{ingestion}:{})});
    });
  }
  activeSearches() {
    return this.backend.read().then(({data})=>Object.entries(data.leases||{}).filter(([,lease])=>lease.expiresAt>Date.now()).map(([id])=>id));
  }
  claimSearch(id) {
    const token=randomUUID();
    return this.mutate(data=>{
      const now=Date.now();
      if(data.subscription){
        assertSubscriptionActive(data,now);
        const product=data.products.find(row=>row.id===id);
        if(!product)throw Object.assign(new Error('Product not found.'),{status:404,code:'product_not_found'});
        if(!activeProduct(product)||product.planMonitoringBlocked)throw Object.assign(new Error('This product is paused under the current plan.'),{status:409,code:product.planMonitoringBlocked||'product_archived'});
      }
      data.leases ||= {};
      if(data.leases[id]?.expiresAt>now) return null;
      data.leases[id]={token,expiresAt:now+90000};
      return token;
    });
  }
  releaseSearch(id,token) {
    return this.mutate(data=>{if(data.leases?.[id]?.token===token) delete data.leases[id];});
  }
  allowLoginAttempt() {
    return this.mutate(data=>{
      data.loginFailures=(data.loginFailures||[]).filter(at=>at>Date.now()-300000);
      if(data.loginFailures.length>=15) return false;
      data.loginFailures.push(Date.now());
      return true;
    });
  }
}
