import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';

const empty = () => ({ version: 1, products: [], items: [], searches: {} });
function unavailable() {const error=new Error('Cloud storage is unavailable. Check the database connection and try again.');error.status=503;return error;}

export class PostgresBackend {
  constructor(connectionString, workspace = 'personal') {
    if (!connectionString) throw new Error('DATABASE_URL is required for hosted storage.');
    this.sql = neon(connectionString);
    this.workspace = workspace;
    this.ready = null;
  }
  async initialize() {
    if (!this.ready) this.ready = (async () => {
      await this.sql`CREATE TABLE IF NOT EXISTS product_tracker_state (workspace TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, data JSONB NOT NULL)`;
      await this.sql`INSERT INTO product_tracker_state (workspace, data) VALUES (${this.workspace}, ${JSON.stringify(empty())}::jsonb) ON CONFLICT (workspace) DO NOTHING`;
    })().catch(() => { this.ready = null; throw unavailable(); });
    await this.ready;
  }
  async read() {
    await this.initialize();
    let row;
    try {[row]=await this.sql`SELECT revision, data FROM product_tracker_state WHERE workspace = ${this.workspace}`;}catch {throw unavailable();}
    if (!row) throw new Error('Tracker storage is unavailable.');
    return row;
  }
  async compareAndSwap(revision, data) {
    let rows;
    try {rows=await this.sql`UPDATE product_tracker_state SET data = ${JSON.stringify(data)}::jsonb, revision = revision + 1 WHERE workspace = ${this.workspace} AND revision = ${revision} RETURNING revision`;}catch {throw unavailable();}
    return rows.length === 1;
  }
}

// The file and database adapters share the same record semantics. Each cloud
// mutation replays against fresh data and commits only its observed revision.
export class PostgresStore {
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
