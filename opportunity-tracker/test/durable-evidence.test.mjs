import test from 'node:test';
import assert from 'node:assert/strict';
import {captureEvidence,evidenceFor,pendingEvidence,pendingEvidenceCount,reviewQueueBlock,qualificationEvidence,saveConversationReview,validateEvidence,recordReviewFailure,failedEvidenceCount} from '../conversation-evidence.mjs';
import {freshRows} from '../incremental.mjs';
import {backfillPlan,backfillBlock,applyBackfillPage,finishBackfill,backfillPublic,BACKFILL_LIMITS} from '../backfill.mjs';
import {beginBackfill,beginCollection,claimCollection,finishCollection,collectionSettings,normalizeTweet} from '../collection.mjs';
import {validateSearchPlan} from '../search-plan.mjs';
import {v2Business,plan} from './pipeline.fixture.mjs';

const now=Date.parse('2026-10-09T12:00:00Z'),DAY=86400000,at=new Date(now).toISOString();
const settings=collectionSettings({TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'});
function fixture({durable=true,x=false}={}){
  const product={...v2Business(),id:'business',monitoring:true,x};
  const search=plan();
  if(x)search.themes[0].queries.push({id:'qx',platform:'x',community:null,query:'Vancouver lunch'});
  product.searchPlanV2=validateSearchPlan({...search,reviewed:true},product);product.listeningVersion='v2';
  return {product,data:{version:1,products:[product],items:[],searches:{},...(durable?{subscription:{planId:'starter'}}:{})}};
}
const row=(id,extra={})=>({source:'Reddit',provider:'scrapebadger',sourceId:`t3_r${id}`,postId:`t3_r${id}`,parentId:null,type:'post',url:`https://www.reddit.com/r/vancouver/comments/r${id}/`,title:'Looking for lunch',snippet:'I need a croissant sandwich for lunch in Vancouver.',author:`author${id}`,publishedAt:new Date(now-2*DAY).toISOString(),commentCount:0,...extra});
function decision(source,relevant=true){return {evidenceId:source.id,relevant,directFit:relevant,category:relevant?'question':'other',need:relevant?'Find lunch':'',quote:relevant?'croissant sandwich':'',offeringIds:relevant?['o1']:[],reason:relevant?'The business serves this sandwich.':'Unrelated.',resolved:'unknown',purposes:[]};}
function settleReviews(data,product){for(const source of [...evidenceFor(data,product)])saveConversationReview(data,product,source,decision(source,false),at,'fixture');}
function page(rows=[],extra={}){return {rows,cursor:null,rawCount:rows.length,oldest:rows.length?Math.min(...rows.map(r=>Date.parse(r.publishedAt))):null,...extra};}

test('provisioned accounts retain over 600 full source records and over 6 MiB independently of AI batch size',()=>{
  const {data,product}=fixture();
  const text='Full source text. '.repeat(450)+'END OF ORIGINAL SOURCE';
  const context='Actual parent discussion. '.repeat(100)+'END OF PARENT';
  captureEvidence(data,product,Array.from({length:725},(_,i)=>row(i,{snippet:text,context})),at);
  assert.equal(evidenceFor(data,product).length,725);
  assert(Buffer.byteLength(JSON.stringify(data))>6*1024*1024);
  assert.equal(evidenceFor(data,product)[0].text,text);
  assert.equal(evidenceFor(data,product)[0].context,context);
  assert.equal(pendingEvidenceCount(data,product),725);
  assert.equal(pendingEvidence(data,product).length,12);
  assert.equal(data.conversationReviewQueue[product.id].length,0);
  const input=qualificationEvidence(evidenceFor(data,product)[0]);
  assert.equal(input.text.length,2200);assert.equal(input.context.length,1500);
  assert.equal(input.sourceTextTruncated,true);assert.equal(input.sourceContentHash,evidenceFor(data,product)[0].contentHash);
  const restored=validateEvidence(data.conversationEvidence,[product],{durable:true});
  assert.equal(restored[product.id].length,725);assert.equal(restored[product.id][0].text,text);
});

test('a daily AI backlog cannot stop modern keyword collection and all returned text survives settlement',()=>{
  const {data,product}=fixture();
  captureEvidence(data,product,Array.from({length:650},(_,i)=>row(i,{snippet:'Evidence '.repeat(1200)})),at);
  assert.equal(reviewQueueBlock(data,product),null);
  beginCollection(data,product.id,'manual',now,settings);
  const request=claimCollection(data,settings,product.id,now);
  assert(request);assert.equal(request.preserveText,true);
  const longText='Full new evidence '.repeat(500)+'ORIGINAL END';
  finishCollection(data,request.token,{credits:5,result:page([row('new',{snippet:longText,publishedAt:new Date(now-60000).toISOString()})])},now+1);
  const saved=evidenceFor(data,product).find(source=>source.url.includes('/rnew/'));
  assert.equal(saved.text,longText);assert.equal(evidenceFor(data,product).length,651);
  assert.equal(pendingEvidence(data,product).length,12);
});

test('20,000 ingestion identities remain deduplicated and edits beyond old truncation limits are updates',()=>{
  const {data,product}=fixture();
  const rows=Array.from({length:20020},(_,i)=>row(i));
  assert.equal(freshRows(data,product,rows,{at}).length,20020);
  assert.equal(Object.keys(data.ingestion).length,20020);
  assert.equal(freshRows(data,product,[rows[0]],{at}).length,0);
  const first=row('long',{snippet:'x'.repeat(5000)+'before',context:'parent A'});
  assert.equal(freshRows(data,product,[first],{at}).length,1);
  assert.equal(freshRows(data,product,[{...first,snippet:'x'.repeat(5000)+'after'}],{at}).length,1);
  assert.equal(freshRows(data,product,[{...first,snippet:'x'.repeat(5000)+'after',context:'parent B'}],{at}).length,1);
});

test('recollection retains source identity, review metadata and qualification receipts without repaying unchanged content',()=>{
  const {data,product}=fixture();
  captureEvidence(data,product,[row(1,{queryId:'one',queryFamily:'keyword'})],at);
  const original=evidenceFor(data,product)[0];saveConversationReview(data,product,original,decision(original),at,'fixture');
  const item=data.items[0];Object.assign(item,{status:'saved',note:'Keep this note',draft:'Keep this draft'});
  data.workspace={reviews:{[item.id]:{version:3,assigneeSub:'member'}}};
  captureEvidence(data,product,[row(1,{queryId:'two',queryFamily:'long_tail'})],new Date(now+1000).toISOString());
  const again=evidenceFor(data,product)[0];
  assert.equal(again.id,original.id);assert.equal(pendingEvidenceCount(data,product),0);
  assert.deepEqual(again.queryIds,['one','two']);assert.deepEqual(again.queryFamilies,['keyword','long_tail']);
  assert.equal(data.items[0].id,item.id);assert.equal(data.items[0].note,'Keep this note');assert.equal(data.items[0].draft,'Keep this draft');
  assert.equal(data.workspace.reviews[item.id].version,3);
  captureEvidence(data,product,[row(1,{snippet:'Updated original text.'})],at);
  const updated=evidenceFor(data,product)[0];assert.equal(updated.id,item.id);assert.equal(pendingEvidenceCount(data,product),1);
  saveConversationReview(data,product,updated,decision(updated),at,'fixture');
  assert.equal(data.items[0].status,'saved');assert.equal(data.items[0].note,'Keep this note');assert.equal(data.items[0].snippet,'Updated original text.');
});

test('modern rejected and failed evidence remains durable beyond legacy receipt and failure limits',()=>{
  const {data,product}=fixture();
  captureEvidence(data,product,Array.from({length:1650},(_,i)=>row(i)),at);
  const sources=[...evidenceFor(data,product)];
  for(const source of sources)saveConversationReview(data,product,source,decision(source,false),at,'fixture');
  assert.equal(Object.keys(data.conversationReviewReceipts[product.id]).length,1650);
  assert.equal(evidenceFor(data,product).length,1650);
  captureEvidence(data,product,[row(0)],at);assert.equal(pendingEvidenceCount(data,product),0);
  captureEvidence(data,product,Array.from({length:175},(_,i)=>row('failure'+i)),at);
  for(const source of pendingEvidenceAll(data,product))recordReviewFailure(data,product,source,'Provider failed',at);
  assert.equal(failedEvidenceCount(data,product),175);
  assert.equal(evidenceFor(data,product).length,1825);
});
function pendingEvidenceAll(data,product){return evidenceFor(data,product).filter(source=>!source.qualification);}

test('modern v2 history covers twelve adjacent X windows and preserves query-family identity',()=>{
  const {product}=fixture({x:true});
  const tasks=backfillPlan(product,['Vancouver lunch since:2020-01-01'],now,{durable:true});
  const x=tasks.filter(task=>task.kind==='x');assert.equal(x.length,12);
  assert.equal(Math.min(...x.map(task=>task.cutoff)),now-365*DAY);assert.equal(Math.max(...x.map(task=>task.until)),now);
  assert(x.every(task=>task.queryId==='qx'&&task.themeId==='lunch'&&task.queryFamily==='keyword'&&!task.query.includes('since:')));
  for(let i=1;i<x.length;i++)assert.equal(x[i].until,x[i-1].cutoff);
});

test('modern history request and candidate limits preserve the complete queue and resume next budget day',()=>{
  const {data,product}=fixture({x:true});beginBackfill(data,product.id,now);
  const job=data.collection.backfills[product.id],queue=structuredClone(job.queue);
  job.requests=BACKFILL_LIMITS.requests;data.largeRetainedHistory='x'.repeat(7*1024*1024);
  assert.equal(backfillBlock(data,job,now),true);assert.equal(job.blocked,'daily_history_request_limit');
  assert.deepEqual(job.queue,queue);assert.equal(job.status,'running');assert.deepEqual(job.errors,[]);
  assert.equal(backfillBlock(data,job,now+DAY),false);assert.deepEqual(job.queue,queue);
  job.staged=BACKFILL_LIMITS.candidates;
  assert.equal(backfillBlock(data,job,now+DAY),true);assert.equal(job.blocked,'daily_history_candidate_limit');
  assert.deepEqual(job.queue,queue);assert.equal(backfillPublic(data,job).limits.resumable,true);
  assert.equal(backfillBlock(data,job,now+2*DAY),false);
});

test('modern history keeps page-nine cursor work and all candidates while deduplicating branch overlap',()=>{
  const {data,product}=fixture();beginBackfill(data,product.id,now);
  const job=data.collection.backfills[product.id],task={...job.queue[0],page:8};
  job.queue=[];job.branches=job.branches.filter(branch=>branch.id===task.branch);
  const text='Historical original '.repeat(400)+'END';
  applyBackfillPage(data,job,task,page([row('history',{snippet:text})],{cursor:'t3_next'}),now);
  assert.equal(job.queue[0].page,9);assert.equal(job.queue[0].cursor,'t3_next');
  assert.equal(evidenceFor(data,product)[0].text,text);assert.equal(evidenceFor(data,product)[0].backfillId,job.id);
  assert.equal(job.staged,1);
  const next=job.queue.shift();applyBackfillPage(data,job,next,page([row('history',{snippet:text})]),now+1);
  assert.equal(job.staged,1);assert.equal(job.duplicates,1);assert.equal(job.status,'reviewing');
  settleReviews(data,product);finishBackfill(data,job,now+2);assert.equal(job.status,'complete');
  assert.match(backfillPublic(data,job).coverage,/not an exhaustive archive/);
});

test('history provider failures and partial pages cannot become successful complete coverage',()=>{
  const failed=fixture();beginBackfill(failed.data,failed.product.id,now);
  assert.equal(claimCollection(failed.data,{...settings,scrapebadgerConfigured:false},failed.product.id,now),null);
  const failedJob=failed.data.collection.backfills[failed.product.id];
  assert.equal(failedJob.status,'failed');assert(failedJob.branches.every(branch=>branch.status==='failed'));
  const {data,product}=fixture();beginBackfill(data,product.id,now);
  const job=data.collection.backfills[product.id],task=job.queue[0];job.queue=[];job.branches=job.branches.filter(branch=>branch.id===task.branch);
  applyBackfillPage(data,job,task,page([row('partial')],{partial:true,omitted:1}),now);
  assert.equal(job.status,'reviewing');assert.equal(job.coverageStatus,'partial');
  settleReviews(data,product);finishBackfill(data,job,now+1);
  assert.equal(job.status,'partial');assert.equal(backfillPublic(data,job).coverageStatus,'partial');
});

test('modern lost-dispatch protection holds provider charges and never replays the removed task',()=>{
  const {data,product}=fixture();beginBackfill(data,product.id,now);
  const first=claimCollection(data,settings,product.id,now);assert(first);
  const next=claimCollection(data,settings,product.id,now+46000);
  assert.notEqual(next?.task.branch,first.task.branch);
  assert.equal(Object.values(data.collection.daily)[0].uncertainCredits,102);
  assert.equal(finishCollection(data,first.token,{credits:0,result:page([row('late')])},now+47000),null);
  assert.equal(evidenceFor(data,product).length,0);
});

test('modern X provider normalization preserves available long text; legacy behavior stays bounded',()=>{
  const text='x'.repeat(16000),tweet={id:'123',created_at:at,text};
  assert.equal(normalizeTweet(tweet,at,{preserveText:true}).snippet,text);
  assert.equal(normalizeTweet(tweet,at).snippet.length,10000);
  const {data,product}=fixture({durable:false});captureEvidence(data,product,[row(1,{snippet:'x'.repeat(5000),context:'y'.repeat(2000)})],at);
  assert.equal(evidenceFor(data,product)[0].text.length,2200);assert.equal(evidenceFor(data,product)[0].context.length,1500);
});
