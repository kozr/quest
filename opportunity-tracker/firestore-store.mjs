import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';

const empty = () => ({ version: 1, products: [], items: [], searches: {} });
const chunkSize = 700 * 1024;
const maximumBytes = 8 * 1024 * 1024;
function unavailable() {
  const error = new Error('Firebase storage is unavailable. Check the Firebase configuration and try again.');
  error.status = 503;
  return error;
}

export function configuredFirestore({projectId = process.env.FIREBASE_PROJECT_ID, serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON} = {}) {
  if (!projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('FIREBASE_PROJECT_ID is required for hosted storage.');
  if (process.env.VERCEL && (projectId.startsWith('demo-') || process.env.FIRESTORE_EMULATOR_HOST)) throw new Error('Vercel requires a real Firebase project without emulator settings.');
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
  return getFirestore(app);
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
export class FirestoreStore {
  constructor(backend) { this.backend = backend; }
  async mutate(change) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { revision, data } = await this.backend.read();
      const next = structuredClone(data);
      const result = change(next);
      if (await this.backend.compareAndSwap(revision, next)) return result;
    }
    const error = new Error('Another request is updating the tracker. Try again.');
    error.status = 409;
    throw error;
  }
  async snapshot() {
    const {data} = await this.backend.read();
    return {version:1,products:structuredClone(data.products),items:structuredClone(data.items),searches:structuredClone(data.searches)};
  }
  async record(method, ...args) {
    return this.mutate(data => {
      const memory = Object.create(Store.prototype);
      memory.data = data;
      memory.commit = next => { Object.assign(data, next); memory.data = data; };
      return memory[method](...args);
    });
  }
  saveProduct(product,id) {
    return this.mutate(data=>{
      if(!id&&data.products.length>=100) throw new Error('The tracker supports up to 100 products.');
      const memory=Object.create(Store.prototype); memory.data=data;
      memory.commit=next=>Object.assign(data,next);
      return memory.saveProduct(product,id);
    });
  }
  deleteProduct(id) { return this.record('deleteProduct',id); }
  recordSearch(id,result) { return this.record('recordSearch',id,result); }
  updateItem(id,update) { return this.record('updateItem',id,update); }
  importData(value) {
    return this.mutate(data=>{
      if(Object.values(data.leases||{}).some(lease=>lease.expiresAt>Date.now())) throw new Error('Wait for the running searches to finish before restoring a backup.');
      const failures=data.loginFailures||[];
      for(const key of Object.keys(data)) delete data[key];
      Object.assign(data,structuredClone(value),{loginFailures:failures});
    });
  }
  activeSearches() {
    return this.backend.read().then(({data})=>Object.entries(data.leases||{}).filter(([,lease])=>lease.expiresAt>Date.now()).map(([id])=>id));
  }
  claimSearch(id) {
    const token=randomUUID();
    return this.mutate(data=>{
      data.leases ||= {};
      if(data.leases[id]?.expiresAt>Date.now()) return null;
      data.leases[id]={token,expiresAt:Date.now()+90000};
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
