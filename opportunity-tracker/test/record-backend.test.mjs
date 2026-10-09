import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordBackend, FirestoreRecordBackend, FirestoreRecordAdapter, LocalRecordBackend, LocalRecordAdapter, RECORD_FORMAT, MAX_NODE_BYTES} from '../record-backend.mjs';

const clone = value => structuredClone(value);
class FakeFirestore {
  constructor() { this.documents = new Map(); this.writes = []; this.transactions = []; this.tail = Promise.resolve(); this.failPublish = false; this.failNodeAt = null; }
  collection(path) { return {doc:id => this.doc(`${path}/${id}`)}; }
  doc(path) {
    return {
      path,
      collection:name => this.collection(`${path}/${name}`),
      get:async () => this.snapshot(path),
      create:async value => {
        if (this.documents.has(path)) throw Object.assign(new Error('Already exists'), {code:6});
        if (this.failNodeAt === this.writes.length) throw new Error('Fixture node upload failure');
        this.documents.set(path, clone(value)); this.writes.push({path, value:clone(value)});
      },
    };
  }
  snapshot(path) { return {exists:this.documents.has(path), data:() => clone(this.documents.get(path))}; }
  async runTransaction(operation) {
    let unlock; const before = this.tail; this.tail = new Promise(resolve => { unlock = resolve; }); await before;
    const changes = [];
    try {
      const result = await operation({get:async ref => this.snapshot(ref.path), set:(ref, value) => changes.push({path:ref.path, value:clone(value)})});
      if (this.failPublish && changes.length) throw new Error('Fixture manifest publish failure');
      assert(changes.length <= 1, 'Only the small manifest is changed transactionally');
      for (const change of changes) this.documents.set(change.path, change.value);
      this.transactions.push(changes); return result;
    } finally { unlock(); }
  }
}
const state = (count = 300) => ({version:1, products:[{id:'p', name:'Example'}], items:Array.from({length:count}, (_, i) => ({id:`item-${i}`, productId:'p', text:`Original ${i}: ${'x'.repeat(200)}`, note:''})), searches:{p:{lastRunAt:'2026-10-09T00:00:00Z'}}});
const local = async t => { const directory = await mkdtemp(join(tmpdir(), 'record-backend-')); t.after(() => rm(directory, {recursive:true, force:true})); return directory; };

test('deduplicated immutable leaves decode to independent mutable objects and arrays', async t => {
  const directory=await local(t),backend=new LocalRecordBackend(directory);
  const initial={a:{},b:{},x:[],y:[],nestedA:{tags:[],meta:{ok:true}},nestedB:{tags:[],meta:{ok:true}}};
  await backend.compareAndSwap(0,initial);
  const {data}=await backend.read();
  data.a.claim='one';data.x.push('error');data.nestedA.tags.push('one');data.nestedA.meta.ok=false;
  assert.deepEqual(data.b,{});assert.deepEqual(data.y,[]);assert.deepEqual(data.nestedB,{tags:[],meta:{ok:true}});
  await backend.compareAndSwap(1,data);
  const restored=(await new LocalRecordBackend(directory).read()).data;
  assert.deepEqual(restored,data);assert.deepEqual(restored.b,{});assert.deepEqual(restored.y,[]);
});

test('warm reads reuse verified nodes while observing a new manifest revision',async t=>{
 const directory=await local(t),adapter=new LocalRecordAdapter(directory);let reads=0;
 const original=adapter.getNode.bind(adapter);adapter.getNode=async id=>{reads++;return original(id);};
 const backend=new RecordBackend(adapter);
 await backend.compareAndSwap(0,{items:[{id:'a',text:'saved'}],a:{},b:{}});
 await backend.read();const cold=reads;assert(cold>0);
 await backend.read();assert.equal(reads,cold);
 await new LocalRecordBackend(directory).compareAndSwap(1,{items:[{id:'a',text:'changed'}],a:{},b:{}});
 const next=await backend.read();assert.equal(next.revision,2);assert.equal(next.data.items[0].text,'changed');assert(reads>cold);
 next.data.a.local=true;assert.deepEqual((await backend.read()).data.a,{});
});

test('local adapter preserves arbitrary JSON fields, array ordering and dangerous property names across restart', async t => {
  const directory = await local(t), backend = new LocalRecordBackend(directory);
  assert.deepEqual(await backend.read(), {revision:0, data:{version:1, products:[], items:[], searches:{}}});
  const data = state();
  data.items.reverse(); data.extra = JSON.parse('{"__proto__":{"polluted":true},"constructor":"retained","prototype":[null,false,0,""]}');
  data.receipts = {p:{accepted:['c','a','b'], nested:[['nested',1],[]]}};
  assert.equal(await backend.compareAndSwap(0, data), true);
  assert.deepEqual(await new LocalRecordBackend(directory).read(), {revision:1, data});
  assert.equal({}.polluted, undefined);
  assert.equal(await backend.compareAndSwap(0, {version:1}), false);
  const pointer = JSON.parse(await readFile(join(directory,'record-manifest.json'),'utf8'));
  assert.equal(pointer.format, RECORD_FORMAT); assert(Object.keys(pointer).length <= 4);
});

test('20,000 records and more than 8 MiB survive independently addressed Firestore records', async () => {
  const db = new FakeFirestore(), backend = new FirestoreRecordBackend(db, 'large');
  const data = state(20_000);
  for (const row of data.items) row.text += 'Evidence preserved. '.repeat(22);
  data.conversationEvidence = {p:data.items.slice(0,300).map(row => ({...row, evidenceOnly:true}))};
  data.conversationReviewReceipts = {p:Object.fromEntries(data.items.map(row => [row.id, {hash:row.id, reviewedAt:'2026-10-09'}]))};
  assert(Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024);
  assert.equal(await backend.compareAndSwap(0, data), true);
  assert(db.writes.length > 500, 'Initial upload exceeds Firestore transaction write limits');
  assert(db.writes.every(row => row.value.bytes.length <= MAX_NODE_BYTES));
  assert.equal(db.transactions.at(-1).length, 1);
  assert.deepEqual(await new FirestoreRecordBackend(db, 'large').read(), {revision:1, data});
});

test('oversized text is lossless across multibyte boundaries, control characters and lone surrogates', async t => {
  const directory = await local(t), data = state(1);
  data.items[0].text = `prefix\ud800${'界🙂\n\u0000'.repeat(150_000)}\udfffend`;
  assert(Buffer.byteLength(JSON.stringify(data.items[0])) > 1024 * 1024);
  const backend = new LocalRecordBackend(directory);
  assert.equal(await backend.compareAndSwap(0, data), true);
  assert.deepEqual((await new LocalRecordBackend(directory).read()).data, data);
  for (const name of await readdir(join(directory,'record-nodes'))) assert((await readFile(join(directory,'record-nodes',name))).length <= MAX_NODE_BYTES);
});

test('a changed stable record uploads only its changed node and small index ancestors', async () => {
  const db = new FakeFirestore(), initial = state(2000), backend = new FirestoreRecordBackend(db);
  await backend.compareAndSwap(0, initial);
  const nextBackend = new FirestoreRecordBackend(db), {revision, data} = await nextBackend.read(), start = db.writes.length;
  data.items[877].note = 'Reviewed by a teammate';
  assert.equal(await nextBackend.compareAndSwap(revision, data), true);
  const changes = db.writes.slice(start);
  assert(changes.length <= 9, `Changed record uploaded ${changes.length} nodes`);
  const changedValues = changes.map(row => JSON.parse(Buffer.from(row.value.bytes).toString())).filter(node => node.t === 'value' && node.value?.id);
  assert.deepEqual(changedValues.map(node => node.value.id), ['item-877']);
  const unchangedStart = db.writes.length;
  assert.equal(await nextBackend.compareAndSwap(revision + 1, data), true);
  assert.equal(db.writes.length, unchangedStart);
});

test('reordering record arrays preserves all record bodies and changes only ordering metadata', async () => {
  const db = new FakeFirestore(), backend = new FirestoreRecordBackend(db), data = state(2000);
  await backend.compareAndSwap(0, data); const start = db.writes.length;
  data.items.reverse(); await backend.compareAndSwap(1, data);
  assert(db.writes.slice(start).every(row => { const node = JSON.parse(Buffer.from(row.value.bytes)); return !(node.t === 'value' && node.value?.id); }));
  assert.deepEqual((await backend.read()).data.items.map(row => row.id), data.items.map(row => row.id));
});

test('concurrent manifest CAS publishes exactly one complete state', async () => {
  const db = new FakeFirestore(), initial = new FirestoreRecordBackend(db); await initial.compareAndSwap(0, state());
  const a = new FirestoreRecordBackend(db), b = new FirestoreRecordBackend(db);
  const left = await a.read(), right = await b.read(); left.data.items[0].note = 'Left'; right.data.items[0].note = 'Right';
  const outcomes = await Promise.all([a.compareAndSwap(left.revision,left.data),b.compareAndSwap(right.revision,right.data)]);
  assert.deepEqual([...outcomes].sort(), [false,true]);
  const saved = await new FirestoreRecordBackend(db).read();
  assert.equal(saved.revision, 2); assert.deepEqual(saved.data, outcomes[0] ? left.data : right.data);
});

test('independent local adapters CAS concurrently without a lost update', async t => {
  const directory = await local(t), a = new LocalRecordBackend(directory), b = new LocalRecordBackend(directory);
  await a.compareAndSwap(0, state(1));
  const outcomes = await Promise.all([a.compareAndSwap(1, {...state(1), writer:'a'}),b.compareAndSwap(1,{...state(1),writer:'b'})]);
  assert.deepEqual([...outcomes].sort(), [false,true]); assert.equal((await a.read()).revision,2);
});

test('a read remains on its captured immutable root during another publication', async () => {
  const db = new FakeFirestore(), initial = state(), writer = new FirestoreRecordBackend(db); await writer.compareAndSwap(0, initial);
  const adapter = new FirestoreRecordAdapter(db); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const get = adapter.getNode.bind(adapter); let first = true;
  adapter.getNode = async id => { if(first) { first = false; entered(); await barrier; } return get(id); };
  const pendingRead = new RecordBackend(adapter).read(); await started;
  const changed = clone(initial); changed.items[10].text = 'Changed after read started'; await writer.compareAndSwap(1,changed); release();
  assert.deepEqual(await pendingRead,{revision:1,data:initial}); assert.deepEqual(await writer.read(),{revision:2,data:changed});
});

test('legacy Firestore manifest migrates atomically and preserves all supplied fields', async () => {
  const db = new FakeFirestore(), legacyData = state(); legacyData.unrecognizedFutureData = {keep:['everything']};
  db.documents.set('opportunityTrackers/personal',{revision:7,chunks:2,bytes:900});
  db.documents.set('opportunityTrackers/personal/stateChunks/0',{bytes:Buffer.from('legacy chunk retained')});
  let reads = 0;
  const legacyBackend = {read:async () => { reads++; return {revision:7,data:clone(legacyData)}; }};
  const backend = new FirestoreRecordBackend(db,'personal',{legacyBackend});
  assert.deepEqual(await backend.read(),{revision:7,data:legacyData});
  assert.equal(await backend.compareAndSwap(7,legacyData),true);
  assert.deepEqual(await backend.read(),{revision:8,data:legacyData}); assert.equal(reads,1);
  assert(db.documents.has('opportunityTrackers/personal/stateChunks/0'));
  assert.equal(await backend.compareAndSwap(7,legacyData),false);
});

test('legacy local data migrates at its supplied revision without deleting the old file', async t => {
  const directory = await local(t), data = state(1), oldFile = join(directory,'tracker.json'); await writeFile(oldFile,JSON.stringify(data));
  const backend = new LocalRecordBackend(directory,{legacyBackend:{read:async () => ({revision:3,data:JSON.parse(await readFile(oldFile,'utf8'))})}});
  assert.deepEqual(await backend.read(),{revision:3,data}); assert.equal(await backend.compareAndSwap(3,data),true);
  assert.deepEqual(await new LocalRecordBackend(directory).read(),{revision:4,data}); assert.deepEqual(JSON.parse(await readFile(oldFile,'utf8')),data);
});

test('failed uploads and failed publication preserve the prior complete root and are retryable', async () => {
  const db = new FakeFirestore(), backend = new FirestoreRecordBackend(db), old = state(); await backend.compareAndSwap(0,old);
  const next = clone(old); next.items[1].note = 'One'; next.items[2].note = 'Two';
  db.failNodeAt = db.writes.length;
  await assert.rejects(backend.compareAndSwap(1,next),/storage is unavailable/);
  assert.deepEqual(await new FirestoreRecordBackend(db).read(),{revision:1,data:old}); db.failNodeAt = null;
  db.failPublish = true; await assert.rejects(backend.compareAndSwap(1,next),/storage is unavailable/);
  assert.deepEqual(await new FirestoreRecordBackend(db).read(),{revision:1,data:old}); db.failPublish = false;
  assert.equal(await backend.compareAndSwap(1,next),true); assert.deepEqual(await backend.read(),{revision:2,data:next});
});

test('safe references, JSON validation, schema and integrity limits reject malformed storage', async t => {
  const directory = await local(t), adapter = new LocalRecordAdapter(directory), backend = new RecordBackend(adapter);
  await assert.rejects(adapter.getNode('../tracker.json'),/Invalid record reference/);
  await assert.rejects(adapter.putNode('../escape',Buffer.from('x')),/Invalid record reference/);
  assert.throws(() => new FirestoreRecordAdapter(new FakeFirestore(),'../other'),/safe workspace/);
  for (const value of [{number:Infinity},{bad:undefined},{date:new Date()},{sparse:new Array(3)}]) await assert.rejects(backend.compareAndSwap(0,value),/JSON|holes/);
  const cyclic = {}; cyclic.self = cyclic; await assert.rejects(backend.compareAndSwap(0,cyclic),/circular/);
  await backend.compareAndSwap(0,state(1));
  const pointer = JSON.parse(await readFile(join(directory,'record-manifest.json'),'utf8'));
  await writeFile(join(directory,'record-nodes',pointer.root),'{}');
  await assert.rejects(new LocalRecordBackend(directory).read(),/integrity/);
  await writeFile(join(directory,'record-manifest.json'),JSON.stringify({...pointer,version:99}));
  await assert.rejects(backend.read(),/schema/);
});

test('defensive size limits are configurable independently of commercial plans', async () => {
  const db = new FakeFirestore(), backend = new FirestoreRecordBackend(db), data = state(); await backend.compareAndSwap(0,data);
  await assert.rejects(new FirestoreRecordBackend(db,'personal',{maxReadBytes:1000}).read(),/defensive.*limit/);
  await assert.rejects(new FirestoreRecordBackend(db,'other',{maxWriteBytes:1000}).compareAndSwap(0,data),/defensive.*limit/);
  assert.deepEqual((await new FirestoreRecordBackend(db,'personal',{maxReadBytes:32*1024*1024}).read()).data,data);
});

test('database failures do not expose credentials or provider internals', async () => {
  const db = new FakeFirestore(), adapter = new FirestoreRecordAdapter(db);
  adapter.document.get = async () => { throw new Error('private_key=DO_NOT_EXPOSE'); };
  await assert.rejects(adapter.getManifest(), failure => failure.status === 503 && !failure.message.includes('DO_NOT_EXPOSE'));
});

test('batched Firestore reads preserve the full state and current manifest with fewer round trips',async()=>{
 const db=new FakeFirestore(),batches=[];db.getAll=async(...refs)=>{batches.push(refs.length);return refs.map(ref=>db.snapshot(ref.path));};
 const backend=new FirestoreRecordBackend(db),original=state(400);assert.equal(await backend.compareAndSwap(0,original),true);
 assert.deepEqual((await backend.read()).data,original);assert(batches.some(n=>n>1));assert(batches.every(n=>n<=128));
 const next=clone(original);next.items[17].note='Keep review';assert.equal(await backend.compareAndSwap(1,next),true);assert.deepEqual((await new FirestoreRecordBackend(db).read()).data,next);
});
test('an incomplete or missing batched record fails instead of returning partial state',async()=>{
 const db=new FakeFirestore();db.getAll=async()=>[];const backend=new FirestoreRecordBackend(db);await backend.compareAndSwap(0,state());await assert.rejects(backend.read(),/batch is incomplete/);
 db.getAll=async(...refs)=>refs.map(()=>({exists:false}));await assert.rejects(backend.read(),/missing or unsupported/);
});
test('REST create conflicts retain immutable byte verification',async()=>{
 const db=new FakeFirestore(),doc=db.doc.bind(db);db.doc=path=>{const ref=doc(path),create=ref.create;ref.create=async value=>{try{return await create(value);}catch(error){if(error.code===6)error.code=409;throw error;}};return ref;};
 const first=new FirestoreRecordBackend(db);await first.compareAndSwap(0,state(1));const second=new FirestoreRecordBackend(db);assert.equal(await second.compareAndSwap(1,state(1)),true);
 const node=[...db.documents.keys()].find(path=>path.includes('/recordNodes/'));const bytes=Buffer.from(db.documents.get(node).bytes);db.documents.get(node).bytes=Buffer.from('corrupt');const adapter=new FirestoreRecordAdapter(db);const id=node.split('/').at(-1);await assert.rejects(adapter.putNode(id,bytes),/collision or corruption/);
});
