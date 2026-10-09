import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, open, rename, link, unlink, rmdir, lstat, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {hostname} from 'node:os';

// Immutable records are uploaded before publishing one small manifest. Readers
// retain that root for their entire read; failed CAS attempts leave harmless
// unreachable nodes. Garbage collection must preserve all active reader roots.
export const RECORD_FORMAT = 'hearwhispers-records';
export const RECORD_VERSION = 1;
export const MAX_NODE_BYTES = 512 * 1024;
const DEFAULT_LIMIT = 512 * 1024 * 1024;
const LEAF_BYTES = 16 * 1024;
const CHUNK_BYTES = 256 * 1024;
const FANOUT = 128;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const LOCAL_LOCK_HOST = hash(hostname()).slice(0,24);
const LOCK_OWNER = /^owner-(\d{1,10})-([a-f0-9]{24})-([a-f0-9-]{36})$/;
const jsonBytes = value => Buffer.from(JSON.stringify(value));
const emptyState = () => ({version:1, products:[], items:[], searches:{}});
const error = (message, status = 503) => Object.assign(new Error(message), {status, recordStorageError:true});
const unavailable = () => error('Database record storage is unavailable. Check the storage configuration and retry.');
async function databaseOperation(operation) {
  try { return await operation(); }
  catch (failure) { throw failure.recordStorageError ? failure : unavailable(); }
}
const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function reference(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw error('Invalid record reference.');
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw error('Invalid storage revision.');
  return value;
}
function manifest(value) {
  if (!object(value) || value.format !== RECORD_FORMAT || value.version !== RECORD_VERSION) throw error('Unsupported record storage schema.');
  revision(value.revision);
  if (value.revision < 1) throw error('Invalid storage revision.');
  reference(value.root);
  return value;
}
function currentRevision(value) {
  if (value == null) return 0;
  if (own(value, 'format')) return manifest(value).revision;
  // Legacy manifests share the same pointer document. The supplied legacy
  // backend, rather than this codec, validates and decodes legacy chunks.
  return revision(value.revision);
}
function json(value, ancestors = new Set(), depth = 0) {
  if (depth > 128) throw error('JSON nesting is too deep.', 400);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!object(value) && !Array.isArray(value)) throw error('State must contain JSON values only.', 400);
  if (object(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error('State must contain plain JSON objects.', 400);
  if (ancestors.has(value)) throw error('State must not contain circular references.', 400);
  ancestors.add(value);
  for (const key of Object.keys(value)) json(value[key], ancestors, depth + 1);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw error('State arrays must not contain holes or extra properties.', 400);
  ancestors.delete(value);
}
function gate(concurrency) {
  let running = 0;
  const waiting = [];
  return async operation => {
    if (running >= concurrency) await new Promise(resolve => waiting.push(resolve));
    else running++;
    try { return await operation(); }
    finally { const next = waiting.shift(); if(next)next(); else running--; }
  };
}

function encode(data, maximum) {
  json(data);
  const bytes = jsonBytes(data);
  if (bytes.length > maximum) throw error('State exceeds the configured defensive storage limit.', 413);
  const nodes = new Map();
  const put = payload => {
    const bytes = jsonBytes({v:RECORD_VERSION, ...payload});
    if (bytes.length > MAX_NODE_BYTES) throw error('Record node exceeds the storage envelope.', 413);
    const id = hash(bytes); nodes.set(id, bytes); return id;
  };
  const sequence = refs => {
    if (refs.length <= FANOUT) return put({t:'sequence', refs});
    const children = [];
    for (let i = 0; i < refs.length; i += FANOUT) children.push(sequence(refs.slice(i, i + FANOUT)));
    return put({t:'sequence-tree', children:sequence(children)});
  };
  const mapping = (entries, prefix = 0) => {
    if (entries.length <= FANOUT) return put({t:'map', entries:[...entries].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, ref]) => [encodeValue(key), ref])});
    if (prefix >= 64) throw error('Record key partition is too deep.');
    const buckets = new Map();
    for (const entry of entries) {
      const digit = hash(jsonBytes(entry[0]))[prefix];
      if (!buckets.has(digit)) buckets.set(digit, []);
      buckets.get(digit).push(entry);
    }
    return put({t:'map-tree', children:[...buckets].sort(([a],[b]) => a.localeCompare(b)).map(([, rows]) => mapping(rows, prefix + 1))});
  };
  const encodeValue = (value, forceContainer = false) => {
    const serialized = jsonBytes(value);
    if (!forceContainer && serialized.length <= LEAF_BYTES) return put({t:'value', value});
    if (typeof value === 'string') {
      // Chunk the JSON encoding, preserving control characters and lone UTF-16
      // surrogates as well as ordinary UTF-8 text without truncation.
      const raw = serialized, parts = [];
      for (let i = 0; i < raw.length; i += CHUNK_BYTES) parts.push(put({t:'chunk', data:raw.subarray(i, i + CHUNK_BYTES).toString('base64')}));
      return put({t:'text', bytes:raw.length, parts:sequence(parts)});
    }
    if (Array.isArray(value)) {
      const ids = value.map(row => object(row) && typeof row.id === 'string' ? row.id : null);
      if (ids.every(id => id !== null) && new Set(ids).size === ids.length) {
        return put({t:'records', order:sequence(ids.map(id => encodeValue(id))), records:mapping(value.map(row => [row.id, encodeValue(row)]))});
      }
      return put({t:'array', values:sequence(value.map(row => encodeValue(row)))});
    }
    if (object(value)) return put({t:'object', values:mapping(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]))});
    return put({t:'value', value});
  };
  return {root:encodeValue(data, true), nodes};
}

// Adapter contract: getManifest(), getNode(hash), putNode(hash, Buffer), and
// compareManifest(expectedRevision, nextManifest). putNode never overwrites.
export class RecordBackend {
  constructor(adapter, {legacyBackend, empty = emptyState, maxReadBytes = DEFAULT_LIMIT, maxWriteBytes = maxReadBytes, maxNodes = 1_000_000, concurrency = 16, readViews} = {}) {
    if (!adapter || !['getManifest','getNode','putNode','compareManifest'].every(name => typeof adapter[name] === 'function')) throw new TypeError('A record storage adapter is required.');
    for (const [name, value] of Object.entries({maxReadBytes,maxWriteBytes,maxNodes,concurrency})) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${name}.`);
    this.adapter = adapter; this.legacyBackend = legacyBackend; this.empty = empty;
    this.maxReadBytes = maxReadBytes; this.maxWriteBytes = maxWriteBytes; this.maxNodes = maxNodes; this.io = gate(concurrency);
    this.readViews = readViews; this.inflight = new Map();
    this.known = new Set();
    // A warm worker rechecks the manifest but reuses verified immutable nodes.
    // Bound this cache so long-lived processes do not retain every old revision.
    this.nodeCache = new Map(); this.nodeCacheBytes = 0;
  }
  async read() {
    const pointer = await this.adapter.getManifest();
    if (!pointer || !own(pointer, 'format')) {
      if (!this.legacyBackend) {
        if (pointer) throw error('Legacy storage requires a legacy reader.');
        return {revision:0, data:structuredClone(this.empty())};
      }
      const legacy = await this.legacyBackend.read();
      revision(legacy.revision); json(legacy.data);
      if (jsonBytes(legacy.data).length > this.maxReadBytes) throw error('Legacy state exceeds the configured defensive read limit.', 413);
      const after = await this.adapter.getManifest();
      if (after && own(after, 'format')) return this.read();
      return legacy;
    }
    const root = manifest(pointer);
    return {revision:root.revision, data:await this.reader().decode(root.root)};
  }
  reader() {
    const cache = new Map();
    let outputBytes = 0, storedBytes = 0, operations = 0;
    const account = bytes => { outputBytes += bytes; if (outputBytes > this.maxReadBytes) throw error('State exceeds the configured defensive read limit.', 413); };
    const node = id => {
      if (++operations > this.maxNodes * 4) throw error('Record expansion exceeds the configured defensive node limit.', 413);
      reference(id);
      if (!cache.has(id)) {
        if (cache.size >= this.maxNodes) throw error('State exceeds the configured defensive node limit.', 413);
        cache.set(id, this.io(async () => {
          let bytes=this.nodeCache.get(id);
          if(bytes){this.nodeCache.delete(id);this.nodeCache.set(id,bytes);}
          else {
            if(!this.inflight.has(id))this.inflight.set(id,this.adapter.getNode(id).finally(()=>this.inflight.delete(id)));
            bytes=await this.inflight.get(id);
          }
          if (!Buffer.isBuffer(bytes) || bytes.length > MAX_NODE_BYTES || hash(bytes) !== id) throw error('Stored record failed integrity verification.');
          if(!this.nodeCache.has(id)){
            this.nodeCache.set(id,bytes);this.nodeCacheBytes+=bytes.length;
            while(this.nodeCacheBytes>32*1024*1024){const first=this.nodeCache.keys().next().value;this.nodeCacheBytes-=this.nodeCache.get(first).length;this.nodeCache.delete(first);}
          }
          storedBytes += bytes.length;
          if (storedBytes > this.maxReadBytes * 4) throw error('Stored records exceed the configured defensive read limit.', 413);
          let payload;
          try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw error('Stored record is not valid JSON.'); }
          if (!object(payload) || payload.v !== RECORD_VERSION || typeof payload.t !== 'string') throw error('Unsupported record node schema.');
          this.known.add(id); return payload;
        }));
      }
      return cache.get(id);
    };
    const depthCheck = depth => { if (depth > 256) throw error('Stored record tree is too deep.'); };
    const sequence = async (id, depth = 0) => {
      depthCheck(depth); const n = await node(id);
      if (n.t === 'sequence' && Array.isArray(n.refs) && n.refs.length <= FANOUT) return n.refs.map(reference);
      if (n.t === 'sequence-tree') return (await Promise.all((await sequence(n.children, depth + 1)).map(ref => sequence(ref, depth + 1)))).flat();
      throw error('Invalid record sequence.');
    };
    const mapping = async (id, depth = 0) => {
      depthCheck(depth); const n = await node(id);
      if (n.t === 'map' && Array.isArray(n.entries) && n.entries.length <= FANOUT && n.entries.every(row => Array.isArray(row) && row.length === 2)) {
        return Promise.all(n.entries.map(async ([key, ref]) => {
          const name = await decode(key, depth + 1, false);
          if (typeof name !== 'string') throw error('Invalid record field name.');
          return [name, reference(ref)];
        }));
      }
      if (n.t === 'map-tree' && Array.isArray(n.children) && n.children.length <= 16) return (await Promise.all(n.children.map(ref => mapping(ref, depth + 1)))).flat();
      throw error('Invalid record map.');
    };
    const decode = async (id, depth = 0, count = true) => {
      depthCheck(depth); const n = await node(id);
      // Immutable nodes can be shared on disk; mutable decoded values cannot.
      if (n.t === 'value' && own(n, 'value')) { if(count)account(jsonBytes(n.value).length); return structuredClone(n.value); }
      if (n.t === 'text') {
        if (!Number.isSafeInteger(n.bytes) || n.bytes < 0 || n.bytes > this.maxReadBytes) throw error('Invalid stored text length.');
        if(count)account(n.bytes);
        const parts = await Promise.all((await sequence(n.parts, depth + 1)).map(async ref => {
          const part = await node(ref);
          if (part.t !== 'chunk' || typeof part.data !== 'string') throw error('Invalid text chunk.');
          const bytes = Buffer.from(part.data, 'base64');
          if (bytes.length > CHUNK_BYTES || bytes.toString('base64') !== part.data) throw error('Invalid text chunk encoding.');
          return bytes;
        }));
        const bytes = Buffer.concat(parts);
        if (bytes.length !== n.bytes) throw error('Stored text length mismatch.');
        const encoded = bytes.toString('utf8');
        if (!Buffer.from(encoded).equals(bytes)) throw error('Stored text is not valid UTF-8.');
        let value; try { value = JSON.parse(encoded); } catch { throw error('Stored text is not valid JSON.'); }
        if (typeof value !== 'string') throw error('Stored text is not a string.');
        return value;
      }
      if (n.t === 'array') { const refs = await sequence(n.values, depth + 1); if(count)account(Math.max(0,refs.length - 1) + 2); return Promise.all(refs.map(ref => decode(ref, depth + 1, count))); }
      if (n.t === 'object') {
        const entries = await mapping(n.values, depth + 1);
        if (new Set(entries.map(([key]) => key)).size !== entries.length) throw error('Duplicate stored object fields.');
        if(count)account(entries.reduce((total,[key]) => total + jsonBytes(key).length + 1, 0) + Math.max(0,entries.length - 1) + 2);
        return Object.fromEntries(await Promise.all(entries.map(async ([key, ref]) => [key, await decode(ref, depth + 1, count)])));
      }
      if (n.t === 'records') {
        const [ordered, entries] = await Promise.all([sequence(n.order, depth + 1), mapping(n.records, depth + 1)]);
        const ids = await Promise.all(ordered.map(ref => decode(ref, depth + 1, false))), byId = new Map(entries);
        if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length || byId.size !== entries.length || byId.size !== ids.length || ids.some(id => !byId.has(id))) throw error('Invalid record array identity.');
        if(count)account(Math.max(0,ids.length - 1) + 2);
        const rows = await Promise.all(ids.map(id => decode(byId.get(id), depth + 1, count)));
        if (rows.some((row, i) => !object(row) || row.id !== ids[i])) throw error('Stored record identity mismatch.');
        return rows;
      }
      throw error('Invalid record value node.');
    };
    return {decode,node};
  }
  // Every request pins one current manifest. A derived view is accepted only
  // when its immutable descriptor binds it to that exact primary root.
  async openReadViews() {
    const pointer=await this.adapter.getManifest();
    if(!pointer?.readViews)return null;
    const current=manifest(pointer),reader=this.reader(),descriptor=await reader.node(reference(current.readViews));
    if(descriptor.t!=='view-root'||descriptor.schema!==1||descriptor.primaryRoot!==current.root||!object(descriptor.buckets))throw error('Read view does not match the current storage root.');
    return {revision:current.revision,get:async name=>{
      if(typeof name!=='string')throw error('Invalid read view name.');
      const bucketRef=descriptor.buckets[hash(jsonBytes(name)).slice(0,2)];
      if(!bucketRef)return null;
      const bucket=await reader.node(reference(bucketRef));
      if(bucket.t!=='view-map'||!object(bucket.entries))throw error('Invalid read view index.');
      return own(bucket.entries,name)?reader.decode(reference(bucket.entries[name])):null;
    }};
  }
  async refreshReadViews() {
    if(!this.readViews)return false;
    const current=await this.read();
    return this.compareAndSwap(current.revision,current.data);
  }
  async compareAndSwap(expectedRevision, data) {
    revision(expectedRevision);
    const {root, nodes} = encode(data, this.maxWriteBytes);
    let viewsRoot;this.readViewsFailed=false;
    // Optional projections must never prevent a durable provider receipt or
    // human edit from being saved. A failed build drops the views, causing the
    // authoritative reader to be used until a normal write rebuilds them.
    if(this.readViews)try {
      const views=await this.readViews(data),viewNodes=new Map();
      if(views){
        const buckets=new Map();
        for(const [name,value] of Object.entries(views)){
          // Pack small public projections in one envelope. The primary codec
          // remains byte-for-byte unchanged; large views still use its chunks.
          json(value);
          const packed=jsonBytes({v:RECORD_VERSION,t:'value',value});
          if(jsonBytes(value).length>this.maxWriteBytes)throw error('Read view exceeds the configured byte limit.',413);
          const encoded=packed.length<=MAX_NODE_BYTES?{root:hash(packed),nodes:new Map([[hash(packed),packed]])}:encode(value,this.maxWriteBytes);
          for(const [id,bytes] of encoded.nodes)viewNodes.set(id,bytes);
          const prefix=hash(jsonBytes(name)).slice(0,2);
          if(!buckets.has(prefix))buckets.set(prefix,{});
          buckets.get(prefix)[name]=encoded.root;
        }
        const put=value=>{const bytes=jsonBytes({v:RECORD_VERSION,...value});if(bytes.length>MAX_NODE_BYTES)throw error('Read view exceeds the storage envelope.',413);const id=hash(bytes);viewNodes.set(id,bytes);return id;};
        const refs=Object.fromEntries([...buckets].map(([prefix,entries])=>[prefix,put({t:'view-map',entries})]));
        const proposed=put({t:'view-root',schema:1,primaryRoot:root,buckets:refs});
        if(new Set([...nodes.keys(),...viewNodes.keys()]).size>this.maxNodes)throw error('Read view exceeds the configured node limit.',413);
        for(const [id,bytes] of viewNodes)nodes.set(id,bytes);
        viewsRoot=proposed;
      }
    } catch {this.readViewsFailed=true;}
    if (nodes.size > this.maxNodes) throw error('State exceeds the configured defensive node limit.', 413);
    await Promise.all([...nodes].filter(([id]) => !this.known.has(id)).map(([id, bytes]) => this.io(async () => { await this.adapter.putNode(id, bytes); this.known.add(id); })));
    return this.adapter.compareManifest(expectedRevision, {format:RECORD_FORMAT, version:RECORD_VERSION, revision:expectedRevision + 1, root,...(viewsRoot?{readViews:viewsRoot}:{})});
  }
}

export class FirestoreRecordAdapter {
  constructor(db, workspace = 'personal') {
    if (!db || !/^[a-zA-Z0-9_-]{1,100}$/.test(workspace)) throw new TypeError('A database and safe workspace identifier are required.');
    this.db = db; this.document = db.collection('opportunityTrackers').doc(workspace);
    this.nodeReads = []; this.nodeReadScheduled = false;
  }
  async getManifest() { const snapshot = await databaseOperation(() => this.document.get()); return snapshot.exists ? snapshot.data() : null; }
  async getNode(id) {
    const ref = this.document.collection('recordNodes').doc(reference(id));
    const snapshot = typeof this.db.getAll === 'function' ? await new Promise((resolve, reject) => {
      this.nodeReads.push({ref,resolve,reject}); this.scheduleNodeReads();
    }) : await databaseOperation(() => ref.get());
    if (!snapshot.exists || snapshot.data().version !== RECORD_VERSION) throw error('Stored record is missing or unsupported.');
    const bytes = snapshot.data().bytes;
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw error('Stored record bytes are invalid.');
    return Buffer.from(bytes);
  }
  scheduleNodeReads() {
    if (this.nodeReadScheduled) return;
    this.nodeReadScheduled = true;
    queueMicrotask(async () => {
      this.nodeReadScheduled = false;
      const pending = this.nodeReads.splice(0,128);
      if (this.nodeReads.length) this.scheduleNodeReads();
      try {
        const snapshots = await databaseOperation(() => this.db.getAll(...pending.map(row=>row.ref)));
        if (!Array.isArray(snapshots) || snapshots.length !== pending.length) throw error('Stored record batch is incomplete.');
        pending.forEach((row,index)=>row.resolve(snapshots[index]));
      } catch (failure) { pending.forEach(row=>row.reject(failure)); }
    });
  }
  async putNode(id, bytes) {
    reference(id);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_NODE_BYTES || hash(bytes) !== id) throw error('Invalid immutable record bytes.');
    const document = this.document.collection('recordNodes').doc(id);
    try { await document.create({version:RECORD_VERSION, bytes}); return true; }
    catch (failure) {
      if (![6,'6',409,'409','already-exists','ALREADY_EXISTS'].includes(failure.code)) throw unavailable();
      if (!(await this.getNode(id)).equals(bytes)) throw error('Immutable record collision or corruption.');
      return false;
    }
  }
  async compareManifest(expectedRevision, next) {
    revision(expectedRevision); manifest(next);
    if (next.revision !== expectedRevision + 1) throw error('Invalid next storage revision.');
    return databaseOperation(() => this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(this.document);
      if (currentRevision(snapshot.exists ? snapshot.data() : null) !== expectedRevision) return false;
      transaction.set(this.document, next); return true;
    }));
  }
}

export class LocalRecordAdapter {
  constructor(directory, {legacyRevision, lockTimeoutMs = 5000} = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('A storage directory is required.');
    this.directory = resolve(directory); this.legacyRevision = legacyRevision; this.lockTimeoutMs = lockTimeoutMs;
    this.pointer = join(this.directory, 'record-manifest.json'); this.lock = join(this.directory, '.record-publish-lock');
  }
  async init() { await mkdir(this.directory, {recursive:true, mode:0o700}); await mkdir(join(this.directory, 'record-nodes'), {recursive:true, mode:0o700}); }
  path(id) { return join(this.directory, 'record-nodes', reference(id)); }
  async getManifest() {
    try { const info = await lstat(this.pointer); if(!info.isFile() || info.size > 16 * 1024)throw error('Invalid local storage manifest.'); return JSON.parse(await readFile(this.pointer, 'utf8')); }
    catch (failure) { if (failure.code === 'ENOENT') return null; throw failure; }
  }
  async getNode(id) {
    const path = this.path(id), info = await lstat(path);
    if (!info.isFile() || info.size > MAX_NODE_BYTES) throw error('Invalid local record file.');
    return readFile(path);
  }
  async putNode(id, bytes) {
    reference(id);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_NODE_BYTES || hash(bytes) !== id) throw error('Invalid immutable record bytes.');
    await this.init();
    const path = this.path(id), temporary = join(this.directory, 'record-nodes', `.tmp-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, path); return true; }
    catch (failure) { if (failure.code !== 'EEXIST') throw failure; if (!(await this.getNode(id)).equals(bytes)) throw error('Immutable record collision or corruption.'); return false; }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async recoverDeadPublishLock() {
    // This adapter is for a local filesystem and shared process namespace.
    // Never use lock age as evidence of death: a paused writer still owns it.
    let entries;
    try { if (!(await lstat(this.lock)).isDirectory()) return false; entries = await readdir(this.lock, {withFileTypes:true}); }
    catch (failure) { if (failure.code === 'ENOENT') return false; throw failure; }
    if (entries.length !== 1 || !entries[0].isDirectory()) return false;
    const name = entries[0].name, owner = name.match(LOCK_OWNER);
    if (!owner || owner[2] !== LOCAL_LOCK_HOST || !Number.isSafeInteger(Number(owner[1])) || Number(owner[1]) < 1) return false;
    try { process.kill(Number(owner[1]), 0); return false; }
    catch (failure) { if (failure.code !== 'ESRCH') return false; }
    // The unique child is the ownership compare-and-delete. A competing
    // recovery that already removed it (or a new owner) makes this fail; only
    // the contender that removed that exact dead owner may remove the parent.
    try { await rmdir(join(this.lock, name)); }
    catch (failure) { if (['ENOENT','ENOTEMPTY','EEXIST'].includes(failure.code)) return false; throw failure; }
    try { await rmdir(this.lock); return true; }
    catch (failure) { if (['ENOENT','ENOTEMPTY','EEXIST'].includes(failure.code)) return false; throw failure; }
  }
  async acquirePublishLock() {
    await this.init(); const started = Date.now(), owner = `owner-${process.pid}-${LOCAL_LOCK_HOST}-${randomUUID()}`;
    while (true) {
      try {
        await mkdir(this.lock, {mode:0o700});
        try { await mkdir(join(this.lock, owner), {mode:0o700}); }
        catch (failure) { await rmdir(this.lock).catch(() => {}); throw failure; }
        return owner;
      } catch (failure) {
        if (failure.code !== 'EEXIST') throw failure;
        if (await this.recoverDeadPublishLock()) continue;
        if (Date.now() - started >= this.lockTimeoutMs) throw error('Local storage is busy or its lock has no verifiable owner. Retry after the writer finishes; an ownerless lock requires inspection with all writers stopped.', 409);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
  async releasePublishLock(owner) {
    if (typeof owner !== 'string' || !LOCK_OWNER.test(owner)) throw error('Invalid local storage lock owner.');
    // Do not remove someone else's lock if the ownership marker changed.
    await rmdir(join(this.lock, owner)); await rmdir(this.lock);
  }
  async compareManifest(expectedRevision, next) {
    revision(expectedRevision); manifest(next);
    if (next.revision !== expectedRevision + 1) throw error('Invalid next storage revision.');
    const owner = await this.acquirePublishLock();
    const temporary = join(this.directory, `.manifest-${randomUUID()}.tmp`);
    try {
      const prior = await this.getManifest();
      const actual = prior ? currentRevision(prior) : this.legacyRevision ? revision(await this.legacyRevision()) : 0;
      if (actual !== expectedRevision) return false;
      const records = await open(join(this.directory, 'record-nodes'), 'r'); try { await records.sync(); } finally { await records.close(); }
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(jsonBytes(next)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.pointer);
      const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      return true;
    } finally { await unlink(temporary).catch(() => {}); await this.releasePublishLock(owner); }
  }
}

export class FirestoreRecordBackend extends RecordBackend {
  constructor(db, workspace = 'personal', options = {}) { super(new FirestoreRecordAdapter(db, workspace), {concurrency:128,...options}); }
}
export class LocalRecordBackend extends RecordBackend {
  constructor(directory, options = {}) {
    super(new LocalRecordAdapter(directory, {...options, legacyRevision:options.legacyBackend ? async () => (await options.legacyBackend.read()).revision : undefined}), options);
  }
}
