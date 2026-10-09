import test from 'node:test';
import assert from 'node:assert/strict';
import {RecordBackend} from '../record-backend.mjs';
import {workspaceReadViews,readWorkspaceSummary,summaryUsage,summaryCollection} from '../workspace-read-views.mjs';
import {pagePrivateConversations,pagePrivateConversationViews,materializeCollectedConversations} from '../conversation-pages.mjs';
import {captureEvidence,evidenceFor,saveConversationReview} from '../conversation-evidence.mjs';
import {discoveryProgress,discoveryProgressFromSummary} from '../discovery-progress.mjs';
import {analysisUsageState} from '../usage.mjs';
import {v2Business} from './pipeline.fixture.mjs';
const NOW=Date.now(),AT=new Date(NOW).toISOString();
function memory(){let pointer=null,reads=[],nodes=new Map();return {adapter:{getManifest:async()=>pointer,getNode:async id=>{reads.push(id);return nodes.get(id);},putNode:async(id,b)=>nodes.set(id,b),compareManifest:async(expected,next)=>{if((pointer?.revision||0)!==expected)return false;pointer=next;return true;}},nodes,get pointer(){return pointer},set pointer(p){pointer=p},get reads(){return reads},clear(){reads=[]}};}
function fixture(count=40){const p={...v2Business(),id:'p',listeningVersion:'v2'},data={version:1,products:[p],items:[],subscription:{planId:'growth',status:'active'}};
 const rows=Array.from({length:count},(_,i)=>({source:'Reddit',url:`https://www.reddit.com/r/vancouver/comments/a${i}/`,type:'post',title:`Wren Cafe ${i}`,snippet:`I need lunch ${i} `+'full original text '.repeat(1200),publishedAt:new Date(NOW-i*1000).toISOString(),author:'author',providerSecret:'hidden'}));captureEvidence(data,p,rows,AT);materializeCollectedConversations(data,p,rows,NOW);
 const row=evidenceFor(data,p)[0];saveConversationReview(data,p,row,{evidenceId:row.id,relevant:true,directFit:true,category:'question',need:'Find lunch',quote:'I need lunch',offeringIds:['o1'],reason:'Matches lunch.',resolved:'unknown',purposes:[{purpose:'potential_customer',quote:'I need lunch',offeringIds:['o1'],reason:'Lunch need.',reference:''}]},AT,'fixture');
 data.items[0].note='kept note';data.items[0].draft='kept draft';data.items[1].status='dismissed';return data;}
test('indexed pages equal authoritative projections across products, purposes, platforms, statuses and search; source bodies and review edits are intact',async()=>{
 const data=fixture(),m=memory(),writer=new RecordBackend(m.adapter,{readViews:workspaceReadViews});assert(await writer.compareAndSwap(0,data));const reader=await new RecordBackend(m.adapter).openReadViews();
 for(const relevance of ['all','collected','mentions','direct','feedback','competitors'])for(const status of ['all','active','dismissed','saved','awaiting_analysis','analyzed'])for(const platform of ['all','reddit','web']){const q={relevance,status,platform,limit:5,offset:1};assert.deepEqual(await pagePrivateConversationViews(reader,q),pagePrivateConversations(data,q));}
 for(const query of ['original text','kept note','Wren Cafe 3','author','absent','lunch 1']){const q={query,relevance:'collected',status:'all',limit:5};assert.deepEqual(await pagePrivateConversationViews(reader,q),pagePrivateConversations(data,q));}
 const q={relevance:'collected',status:'all',limit:1};const a=await pagePrivateConversationViews(reader,q);assert.equal(a.items[0].providerSecret,undefined);a.items[0].note='mutated';assert.notEqual((await pagePrivateConversationViews(reader,q)).items[0].note,'mutated');
 for(const q of [{limit:101},{offset:-1},{query:'x'.repeat(501)},{purpose:'invented'}])await assert.rejects(()=>pagePrivateConversationViews(reader,q),e=>e.status===400);
});
test('cold summary and five-row page read only their view nodes, never the primary workspace tree',async()=>{
 const data=fixture(600),m=memory(),writer=new RecordBackend(m.adapter,{readViews:workspaceReadViews});assert(await writer.compareAndSwap(0,data));m.clear();const reader=await new RecordBackend(m.adapter).openReadViews();const summary=readWorkspaceSummary(await reader.get('summary'));assert.equal(summary.total,600);assert.deepEqual(summary.seed.items,[]);assert(m.reads.length<15);const n=m.reads.length;const page=await pagePrivateConversationViews(reader,{relevance:'collected',limit:5});assert.equal(page.items.length,5);assert(m.reads.length-n<60);assert(!m.reads.includes(m.pointer.root));
});
test('read views pin a revision; edits publish new views atomically; old writers fall back; forged root bindings and corrupt nodes fail closed',async()=>{
 const data=fixture(2),m=memory(),writer=new RecordBackend(m.adapter,{readViews:workspaceReadViews});await writer.compareAndSwap(0,data);const old=await new RecordBackend(m.adapter).openReadViews();data.items[0].note='new note';assert(await writer.compareAndSwap(1,data));assert(!await writer.compareAndSwap(1,data));const current=await new RecordBackend(m.adapter).openReadViews();const q={relevance:'collected',status:'all',limit:1};assert.equal((await pagePrivateConversationViews(old,q)).items[0].note,'kept note');assert.equal((await pagePrivateConversationViews(current,q)).items[0].note,'new note');assert.deepEqual((await writer.read()).data,data);
 const good={...m.pointer};m.pointer={...good,root:'f'.repeat(64)};await assert.rejects(()=>new RecordBackend(m.adapter).openReadViews(),/does not match/);m.pointer=good;m.nodes.set(good.readViews,Buffer.from('corrupt'));await assert.rejects(()=>new RecordBackend(m.adapter).openReadViews(),/integrity/);
});
test('clock-sensitive budgets, month rollover and discovery leases are evaluated on reads; account workspaces cannot create private views',()=>{
 const data=fixture(2);data.analysisLeases={x:{productId:'p',stage:'qualify',expiresAt:NOW+1000}};const summary=readWorkspaceSummary(workspaceReadViews(data).summary),p=data.products[0];
 for(const now of [NOW,NOW+2000,Date.parse('2027-01-01T12:00:00Z')]){assert.deepEqual(summaryUsage(summary,now),analysisUsageState(data,now));assert.deepEqual(discoveryProgressFromSummary(summary.seed,p,summary.discovery.p,{now}),discoveryProgress(data,p,{now}));assert.equal(summaryCollection(summary,'2027-01-01',now).budget.spentCredits,undefined);}
 assert.equal(workspaceReadViews({...data,workspace:{id:'private'}}),null);
});

test('projection failures cannot block a durable receipt; authoritative fallback and an unchanged-root refresh recover without importing data',async()=>{
 const data=fixture(2),m=memory(),writer=new RecordBackend(m.adapter,{readViews:workspaceReadViews});await writer.compareAndSwap(0,data);const priorRoot=m.pointer.root;
 const broken=new RecordBackend(m.adapter,{readViews:()=>{throw Error('projection failure');}});data.receipt={chargedMicroUsd:123,identity:'kept'};assert(await broken.compareAndSwap(1,data));assert.equal(broken.readViewsFailed,true);assert.equal(await broken.openReadViews(),null);assert.deepEqual((await broken.read()).data.receipt,data.receipt);
 const rawRoot=m.pointer.root;assert.notEqual(rawRoot,priorRoot);assert(await writer.refreshReadViews());assert.equal(m.pointer.root,rawRoot);assert(await writer.openReadViews());assert.deepEqual((await writer.read()).data,data);
});
