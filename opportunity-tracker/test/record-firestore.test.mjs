import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Firestore} from '@google-cloud/firestore';
import {FirestoreRecordBackend,RECORD_FORMAT,MAX_NODE_BYTES} from '../record-backend.mjs';
import {FirestoreBackend,FirestoreStore} from '../firestore-store.mjs';
import {analysisUsageState} from '../usage.mjs';

// This suite can only reach a loopback emulator. Never use a project or endpoint
// from ambient production configuration, and never initialize ADC credentials.
const emulator=process.env.FIRESTORE_EMULATOR_HOST;
if(emulator&&!/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(emulator))throw new Error('Record integration tests require a loopback Firestore emulator.');
const options={skip:emulator?false:'Needs local Firestore emulator',timeout:120000};
const owner={sub:'12345678901234567890',email:'fixture@example.com'};
const now=Date.parse('2026-10-09T12:00:00Z');
async function fixture(t){
  assert(emulator&&/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(emulator));
  const workspace=`record-fixture-${randomUUID()}`,clients=[0,1].map(()=>new Firestore({projectId:'demo-opportunity-tracker',host:emulator,ssl:false}));
  const reference=clients[0].collection('opportunityTrackers').doc(workspace);
  t.after(async()=>{try{await clients[0].recursiveDelete(reference);}finally{await Promise.all(clients.map(db=>db.terminate()));}});
  const backends=clients.map(db=>new FirestoreRecordBackend(db,workspace));
  return {workspace,clients,reference,backends,stores:backends.map(backend=>new FirestoreStore(backend))};
}
const product=name=>({name,url:'https://example.com/',description:'Example business',keywords:['example'],communities:['examples'],capabilities:['Useful service'],needs:['Find a useful service'],aliases:[],exclusions:[],monitoring:true,x:false});
const reservation=(executionKey,sourceIdentities)=>({productId:'p',executionKey,sourceIdentities,now,leaseMs:120000});

test('real Firestore migrates the legacy blob and preserves more than 8 MiB, human notes, plan and usage',options,async t=>{
  const {workspace,clients,reference}=await fixture(t);
  const legacy=new FirestoreBackend(clients[0],workspace);
  const original={version:1,products:[{id:'p',...product('Example')}],items:[{id:'old',productId:'p',text:'Original conversation',note:'Keep this private review note',draft:'My draft',status:'saved'}],searches:{},subscription:{planId:'growth',status:'manual'},usage:{version:1,periods:{'2026-10':{units:{old:{completed:true,claims:[]}},resetAt:'2026-11-01T00:00:00.000Z'}},historical:{},reservations:{},executions:{}},extra:{futureField:['retained']}};
  assert.equal(await legacy.compareAndSwap(0,original),true);
  const oldChunk=await reference.collection('stateChunks').doc('0').get();assert(oldChunk.exists);
  const migrating=new FirestoreRecordBackend(clients[0],workspace,{legacyBackend:legacy});
  const read=await migrating.read();assert.equal(read.revision,1);assert.deepEqual(read.data,original);
  // Individual source bodies exceed a Firestore document once encoded. The
  // record backend must chunk them losslessly and publish one small manifest.
  read.data.items.push(...Array.from({length:10},(_,i)=>({id:`large-${i}`,productId:'p',text:`Source ${i} \ud800 ${'界🙂\n'.repeat(125000)} \udfff`,note:`Review ${i}`,status:'new'})));
  assert(Buffer.byteLength(JSON.stringify(read.data))>8*1024*1024);
  assert.equal(await migrating.compareAndSwap(read.revision,read.data),true);
  const pointer=(await reference.get()).data();assert.equal(pointer.format,RECORD_FORMAT);assert.equal(pointer.revision,2);assert.equal(Object.keys(pointer).length,4);
  const restored=await new FirestoreRecordBackend(clients[1],workspace).read();assert.deepEqual(restored,{revision:2,data:read.data});assert.deepEqual(restored.data.items[0],original.items[0]);assert.deepEqual(restored.data.subscription,original.subscription);assert.deepEqual(restored.data.usage,original.usage);
  assert((await reference.collection('stateChunks').doc('0').get()).data().bytes.equals(oldChunk.data().bytes),'Migration leaves the old blob intact');
  const nodes=await reference.collection('recordNodes').get();assert(nodes.size>10);for(const node of nodes.docs)assert(node.data().bytes.length<=MAX_NODE_BYTES);
});

test('independent real Firestore stores atomically enforce product capacity and the final monthly unique unit',options,async t=>{
  const {workspace,stores:[left,right],clients}=await fixture(t);
  await left.initializeAccount({id:workspace,name:'Fixture',owner,planId:'starter',status:'manual',now});
  const products=await Promise.allSettled([left.saveProduct(product('Left')),right.saveProduct(product('Right'))]);
  assert.equal(products.filter(row=>row.status==='fulfilled').length,1);const failure=products.find(row=>row.status==='rejected').reason;assert.equal(failure.code,'plan_capacity_exceeded');assert.equal(failure.resource,'products');assert.equal((await right.snapshot()).products.length,1);
  await left.reserveAnalysisUnits(reservation('seed',Array.from({length:999},(_,i)=>`fixture:${i}`)));
  const attempts=await Promise.allSettled([left.reserveAnalysisUnits(reservation('last-left',['fixture:last-left'])),right.reserveAnalysisUnits(reservation('last-right',['fixture:last-right']))]);
  assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1);assert.equal(attempts.find(row=>row.status==='rejected').reason.code,'monthly_analysis_limit');
  let saved=await new FirestoreStore(new FirestoreRecordBackend(clients[1],workspace)).snapshot();assert.equal(analysisUsageState(saved,now).monthly.used,1000);assert.equal(Object.keys(saved.usage.reservations).length,2);
  const winner=attempts.find(row=>row.status==='fulfilled').value,side=attempts[0].status==='fulfilled'?'left':'right';
  const repeat=reservation(`last-${side}`,[`fixture:last-${side}`]);
  const reruns=await Promise.all([left.reserveAnalysisUnits(repeat),right.reserveAnalysisUnits(repeat)]);
  assert(reruns.every(row=>row.id===winner.id&&row.dispatch===false));
  await Promise.all([left.settleAnalysisUnits(winner.id,{outcome:'success',now:now+1}),right.settleAnalysisUnits(winner.id,{outcome:'success',now:now+1})]);
  saved=await left.snapshot();assert.equal(analysisUsageState(saved,now).monthly.used,1000);assert.equal(analysisUsageState(saved,now).monthly.completed,1);
});

test('failed real record publication and stale CAS preserve the old complete manifest and conservative holds',options,async t=>{
  const {workspace,clients,reference,backends:[writer,reader]}=await fixture(t);
  const original={version:1,products:[],items:[{id:'source',text:'Original text',note:'Human note'}],searches:{},subscription:{planId:'starter',status:'manual'},usage:{version:1,periods:{'2026-10':{units:{held:{completed:false,uncertain:true,claims:[]}},resetAt:'2026-11-01T00:00:00.000Z'}},historical:{},reservations:{held:{status:'uncertain',reason:'lease_expired'}},executions:{}}};
  assert.equal(await writer.compareAndSwap(0,original),true);const prior=(await reference.get()).data();
  const next=structuredClone(original);next.items[0].text='New source text';next.items[0].note='Updated note';next.usage.periods['2026-10'].units={};
  const rejected=new FirestoreRecordBackend(clients[0],workspace);rejected.adapter.compareManifest=async()=>{throw new Error('Injected publish interruption after immutable uploads');};
  await assert.rejects(rejected.compareAndSwap(1,next),/publish interruption/);
  assert.deepEqual((await reference.get()).data(),prior);assert.deepEqual(await reader.read(),{revision:1,data:original});
  assert.equal(await writer.compareAndSwap(1,next),true);
  assert.equal(await reader.compareAndSwap(1,original),false,'A stale independent writer cannot publish an old quota ledger');
  assert.deepEqual(await new FirestoreRecordBackend(clients[1],workspace).read(),{revision:2,data:next});
  assert((await reference.collection('recordNodes').doc(prior.root).get()).exists,'Old immutable roots remain readable');
});
