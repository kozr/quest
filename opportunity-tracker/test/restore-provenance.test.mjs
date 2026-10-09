import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreSourceProvenance} from '../restore-provenance.mjs';
import {validateEvidence} from '../conversation-evidence.mjs';
import {analysisCandidate,claimAnalysisCycleBatch} from '../analysis-cycles.mjs';
import {analysisUsageState} from '../usage.mjs';
import {Store} from '../store.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const NOW=Date.parse('2026-10-09T12:00:00Z'),AT=new Date(NOW).toISOString();
const row={id:'a'.repeat(24),url:'https://www.reddit.com/r/example/comments/original/',title:'Original post',text:'Full original source text.',context:'Original parent',author:'Author',community:'example',threadId:'reddit:original',type:'post',source:'Reddit',publishedAt:AT,collectedAt:AT,historical:true,backfillId:'trusted-run',backfillIds:['trusted-run','older-run'],queryIds:[]};
const current=()=>({products:[{id:'p',name:'Example',monitoring:true,keywords:[]}],items:[],subscription:{planId:'starter',status:'manual'},conversationEvidence:{p:[structuredClone(row)]},collection:{backfillRuns:{'trusted-run':{id:'trusted-run',productId:'p'}}}});
const item=extra=>{const {text,...rest}=row;return {...rest,productId:'p',snippet:text,...extra};};

test('an exact source restore retains only server-stored historical attribution across item/evidence/queue formats',()=>{
  const state=current(),incoming={items:[item({backfillId:'attacker-run',backfillIds:['attacker-run']})],conversationEvidence:{p:[{...row,backfillId:'attacker-run'}]},conversationReviewQueue:{p:[{...row,backfillIds:['attacker-run']}]}};
  const restored=restoreSourceProvenance(state,incoming);
  for(const value of [restored.items[0],restored.conversationEvidence.p[0],restored.conversationReviewQueue.p[0]]){assert.equal(value.historical,true);assert.equal(value.backfillId,'trusted-run');assert.deepEqual(value.backfillIds,['trusted-run','older-run']);}
  assert.equal(incoming.items[0].backfillId,'attacker-run');assert.equal(state.conversationEvidence.p[0].backfillId,'trusted-run');
});

test('new sources, cross-product copies and altered original evidence cannot inherit a historical grant',()=>{
  for(const changes of [{url:'https://www.reddit.com/r/example/comments/newsource/'},{title:'Changed'},{snippet:'Changed'},{context:'Changed'},{author:'Other'},{publishedAt:'2026-10-08T12:00:00Z'},{productId:'other'}]){
    const restored=restoreSourceProvenance(current(),{items:[item(changes)]}).items[0];assert.equal(restored.historical,false);assert.equal(restored.backfillId,undefined);assert.equal(restored.backfillIds,undefined);
  }
  const imported={...row,id:'b'.repeat(24),text:'Changed',contentHash:'attacker copied hash',qualification:{contentHash:'attacker copied hash'}};
  for(const field of ['conversationEvidence','conversationReviewQueue']){const value=restoreSourceProvenance(current(),{[field]:{p:[imported]}})[field].p[0];assert.equal(value.historical,false);assert.equal(value.backfillId,undefined);}
});

test('existing live sources remain live even when a backup claims they were historical',()=>{
  const state=current();state.conversationEvidence.p[0].historical=false;delete state.conversationEvidence.p[0].backfillId;delete state.conversationEvidence.p[0].backfillIds;
  const restored=restoreSourceProvenance(state,{items:[item({})]}).items[0];assert.equal(restored.historical,false);assert.equal(restored.backfillId,undefined);
});

test('canonical source identity and equivalent publication dates can preserve an unchanged historical source',()=>{
  const alteredURL='https://reddit.com/r/example/comments/original/different_slug/?utm_source=backup';
  const restored=restoreSourceProvenance(current(),{items:[item({url:alteredURL,publishedAt:'2026-10-09T05:00:00-07:00'})]}).items[0];assert.equal(restored.historical,true);assert.equal(restored.backfillId,'trusted-run');
});

test('verified import exploit now reserves monthly units instead of minting historical allowance for a new source',()=>{
  const state=current(),newSource={...row,id:'b'.repeat(24),url:'https://www.reddit.com/r/example/comments/newsource/',text:'Fresh unrelated imported source.'};
  const incoming={products:state.products,items:[],conversationEvidence:validateEvidence({p:[newSource]},state.products,{durable:true})};
  const restored=restoreSourceProvenance(state,incoming);Object.assign(state,restored);
  const candidate=analysisCandidate(state.conversationEvidence.p[0],{profileHash:'profile',version:'fixture'});
  const claim=claimAnalysisCycleBatch(state,'p',{candidates:[candidate],profileHash:'profile',version:'fixture',now:NOW});assert(claim.batch);
  const usage=analysisUsageState(state,NOW);assert.equal(usage.monthly.used,1);assert.deepEqual(usage.historical,{});
});

for(const adapter of ['local','record'])test(`${adapter} Store.importData applies trusted provenance before restoring server policy`,async t=>{
  const initial={version:1,searches:{},...current()};let store;
  if(adapter==='local'){
    const directory=mkdtempSync(join(tmpdir(),'restore-provenance-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
    store=new Store(directory);store.commit(initial);
  }else{
    let state=structuredClone(initial),revision=0;
    store=new FirestoreStore({async read(){return {revision,data:structuredClone(state)};},async compareAndSwap(expected,next){if(expected!==revision)return false;state=structuredClone(next);revision++;return true;}});
  }
  const backup=structuredClone(initial);
  backup.conversationEvidence.p=[{...row,id:'b'.repeat(24),url:'https://www.reddit.com/r/example/comments/imported/',text:'Untrusted new imported source.'}];
  backup.collection={backfillRuns:{'attacker-run':{id:'attacker-run',productId:'p'}}};
  await store.importData(backup);
  await store.mutate(data=>{
    const candidate=analysisCandidate(data.conversationEvidence.p[0],{profileHash:'profile',version:'fixture'});
    assert(claimAnalysisCycleBatch(data,'p',{candidates:[candidate],profileHash:'profile',version:'fixture',now:NOW}).batch);
  });
  const saved=await store.snapshot();assert.equal(saved.conversationEvidence.p[0].historical,false);assert.equal(saved.conversationEvidence.p[0].backfillId,undefined);
  assert(saved.collection.backfillRuns['trusted-run']);assert.equal(saved.collection.backfillRuns['attacker-run'],undefined);
  const usage=analysisUsageState(saved,NOW);assert.equal(usage.monthly.used,1);assert.deepEqual(usage.historical,{});
});


test('historical allowance adoption is server-owned and retained only for unchanged trusted sources',()=>{
  const row={id:'saved',productId:'p',url:'https://www.reddit.com/r/test/comments/post/',title:'Original',snippet:'Exact original text',author:'writer',publishedAt:'2026-01-01T00:00:00Z',historical:true,historicalAllowanceBackfillId:'job',allowanceAttribution:{kind:'saved-archive-adoption',jobId:'job',at:'2026-10-09T12:00:00Z'}};
  const current={items:[row]},incoming={items:[{...structuredClone(row),historicalAllowanceBackfillId:'forged',allowanceAttribution:{kind:'saved-archive-adoption',jobId:'forged',at:row.allowanceAttribution.at}}]};
  const kept=restoreSourceProvenance(current,incoming).items[0];assert.equal(kept.historicalAllowanceBackfillId,'job');assert.deepEqual(kept.allowanceAttribution,row.allowanceAttribution);assert.equal(kept.backfillId,undefined);
  incoming.items[0].snippet='Changed source';const stripped=restoreSourceProvenance(current,incoming).items[0];assert.equal(stripped.historical,false);assert.equal(stripped.historicalAllowanceBackfillId,undefined);assert.equal(stripped.allowanceAttribution,undefined);
});
