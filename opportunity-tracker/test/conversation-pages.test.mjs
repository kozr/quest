import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapWorkspace,createClient,createInvite,acceptInvite,updateReview,removeMember} from '../workspace.mjs';
import {planFor} from '../plans.mjs';
import {captureEvidence,evidenceFor,saveConversationReview,recordReviewFailure} from '../conversation-evidence.mjs';
import {syncConversationItems,conversationCurrentState} from '../conversation-feed.mjs';
import {materializeCollectedConversations,pageConversations,pageConversationEvidence} from '../conversation-pages.mjs';
import {discover} from '../discovery.mjs';
import {productHash,matchHash} from '../analysis.mjs';
import {v2Business} from './pipeline.fixture.mjs';

const NOW=Date.now(),AT=new Date(NOW).toISOString(),owner={sub:'1001',email:'owner@gmail.com'},viewer={sub:'1002',email:'viewer@gmail.com'};
const text='I need a croissant sandwich for lunch in Vancouver.';
const source=(id,extra={})=>({source:'Reddit',sourceId:`t3_r${id}`,postId:`t3_r${id}`,provider:'scrapebadger',url:`https://www.reddit.com/r/vancouver/comments/r${id}/`,type:'post',title:'Looking for lunch',snippet:text,author:'author',publishedAt:new Date(NOW-1000).toISOString(),...extra});
function fixture(){
  const data={version:1,products:[],items:[],subscription:{planId:'team',status:'active'}};bootstrapWorkspace(data,{id:'workspace1',owner,now:NOW});
  const a=createClient(data,owner,{name:'A',now:NOW},planFor(data)),b=createClient(data,owner,{name:'B',now:NOW},planFor(data));
  const p={...v2Business(),id:'p',listeningVersion:'v2',clientId:a.id},other={...v2Business(),id:'other',listeningVersion:'v2',clientId:b.id};data.products.push(p,other);
  const invite=createInvite(data,owner,{email:viewer.email,role:'member',clientIds:[a.id],now:NOW},planFor(data));acceptInvite(data,viewer,{token:invite.token,now:NOW},planFor(data));
  return {data,p,other};
}
function collect(data,p,rows){captureEvidence(data,p,rows,AT);materializeCollectedConversations(data,p,rows,AT);}
function decision(row,extra={}){return {evidenceId:row.id,relevant:true,directFit:true,category:'question',need:'Find lunch',quote:'croissant sandwich',offeringIds:['o1'],reason:'Matches a served sandwich.',resolved:'unknown',purposes:[{purpose:'potential_customer',quote:'croissant sandwich',offeringIds:['o1'],reason:'Expressed lunch need.',reference:''}],...extra};}

test('collection immediately exposes editable full-source rows without inventing relevance or purposes',()=>{
  const {data,p}=fixture(),full=text.repeat(1000)+'ORIGINAL END';collect(data,p,[source(1,{snippet:full,context:'Parent '.repeat(1000)})]);
  assert.equal(data.items.length,1);assert.equal(data.items[0].kind,'conversation');assert.equal(data.items[0].analysisStatus,'awaiting_analysis');assert.equal(data.items[0].qualification,undefined);
  const page=pageConversations(data,viewer,{relevance:'collected'});assert.equal(page.total,1);assert.equal(page.items[0].snippet,full);assert.equal(page.items[0].reviewEditable,true);assert.deepEqual(page.items[0].conversationSignals,[]);assert.equal(page.items[0].currentOpportunityFit,false);
  assert.equal(pageConversations(data,viewer,{relevance:'direct'}).total,0);assert.equal(pageConversations(data,viewer,{relevance:'mentions'}).total,0);assert.equal(pageConversations(data,viewer,{}).total,0);
  assert.equal(pageConversations(data,viewer,{relevance:'collected',status:'awaiting_analysis'}).total,1);
});

test('manual review and assignment survive qualification, synchronization and recollection under the same stable ID',()=>{
  const {data,p}=fixture();collect(data,p,[source(2)]);const item=data.items[0],id=item.id;
  updateReview(data,viewer,{itemId:id,expectedVersion:0,patch:{status:'saved',note:'Keep this note',draft:'My draft',assigneeSub:viewer.sub},now:NOW},planFor(data));
  const row=evidenceFor(data,p)[0];saveConversationReview(data,p,row,decision(row),AT,'fixture');syncConversationItems(data,p);
  let page=pageConversations(data,viewer,{relevance:'direct',status:'saved'});assert.equal(page.total,1);assert.equal(page.items[0].id,id);assert.equal(page.items[0].note,'Keep this note');assert.equal(page.items[0].draft,'My draft');assert.equal(page.items[0].review.assigneeSub,viewer.sub);assert.equal(page.items[0].review.version,1);
  collect(data,p,[source(2,{snippet:text+' The source changed after review.'})]);assert.equal(data.items.length,1);assert.equal(data.items[0].id,id);
  page=pageConversationEvidence(data,viewer,{status:'saved'});assert.equal(page.items[0].analysisStatus,'awaiting_analysis');assert.equal(page.items[0].note,'Keep this note');assert.equal(page.items[0].reason,undefined);assert.equal(page.items[0].qualification,undefined);assert.deepEqual(page.items[0].conversationSignals,[]);assert.equal(pageConversations(data,viewer,{relevance:'direct'}).total,0);
  const bounded={products:data.products,items:data.items};assert.equal(conversationCurrentState(bounded,data.items[0]).currentConversationRelevant,false);assert.equal(data.items[0].qualification,undefined);assert.equal(data.items[0].kind,'conversation');
});

test('pagination counts and source text never cross client scopes; revoked sessions lose access immediately',()=>{
  const {data,p,other}=fixture();collect(data,p,Array.from({length:725},(_,i)=>source(i)));collect(data,other,[source('secret',{snippet:'Confidential client evidence'})]);
  const first=pageConversationEvidence(data,viewer,{}),second=pageConversationEvidence(data,viewer,{offset:50});assert.equal(first.total,725);assert.equal(first.items.length,50);assert.equal(first.nextOffset,50);assert.equal(second.total,725);assert(!second.items.some(row=>first.items.some(previous=>previous.id===row.id)));
  assert.equal(pageConversationEvidence(data,viewer,{query:'Confidential'}).total,0);assert.throws(()=>pageConversationEvidence(data,viewer,{productId:other.id}),error=>error.status===404);assert.equal(pageConversationEvidence(data,owner,{limit:1}).total,726);
  const last=pageConversationEvidence(data,viewer,{offset:700,limit:100});assert.equal(last.items.length,25);assert.equal(last.hasMore,false);assert.equal(last.nextOffset,null);
  removeMember(data,owner,{sub:viewer.sub,now:NOW+1},planFor(data));assert.throws(()=>pageConversationEvidence(data,viewer,{}),error=>error.status===403);
});

test('paging rejects excessive/invalid inputs, has deterministic ordering and clones only public selected rows',()=>{
  const {data,p}=fixture();collect(data,p,[source(1),source(2)]);data.items[0].providerSecret='must not leave server';data.conversationEvidence.p[0].token='lease-secret';
  for(const options of [{limit:101},{limit:0},{offset:-1},{offset:'not-a-number'},{query:'x'.repeat(501)},{platform:'secret'},{purpose:'invented'},{purpose:'feedback',relevance:'direct'}])assert.throws(()=>pageConversations(data,viewer,options),error=>error.status===400);
  const page=pageConversationEvidence(data,viewer,{limit:'1',offset:'0'});assert.equal(page.items.length,1);assert(!JSON.stringify(page).includes('must not leave'));assert(!JSON.stringify(page).includes('lease-secret'));
  page.items[0].note='Client mutation';assert(data.items.every(item=>item.note===''));assert.deepEqual(pageConversationEvidence(data,viewer,{limit:1}).items.map(row=>row.id),page.items.map(row=>row.id));
});

test('failure and irrelevant analysis remain visible in collected results without creating purpose signals',()=>{
  const {data,p}=fixture();collect(data,p,[source(1),source(2)]);const [one,two]=evidenceFor(data,p);
  recordReviewFailure(data,p,one,'Provider temporarily unavailable',AT);saveConversationReview(data,p,two,decision(two,{relevant:false,directFit:false,purposes:[],offeringIds:[]}),AT,'fixture');
  assert.equal(pageConversationEvidence(data,viewer,{status:'analysis_failed'}).total,1);assert.equal(pageConversationEvidence(data,viewer,{status:'analyzed'}).total,1);assert.equal(pageConversations(data,viewer,{relevance:'feedback'}).total,0);assert.equal(pageConversations(data,viewer,{relevance:'direct'}).total,0);
  assert.equal(pageConversationEvidence(data,viewer,{status:'all'}).total,2);
});

test('existing legacy source IDs, notes and drafts are reused by materialization',()=>{
  const {data,p}=fixture(),raw=source(1);data.items=[{...raw,id:'legacy32characteridentity',productId:p.id,status:'dismissed',note:'Historical note',draft:'Historical draft',kind:'mention'}];
  collect(data,p,[raw]);assert.equal(data.items.length,1);assert.equal(data.items[0].id,'legacy32characteridentity');assert.equal(data.items[0].note,'Historical note');assert.equal(pageConversationEvidence(data,viewer,{status:'dismissed'}).items[0].id,'legacy32characteridentity');
  const legacy={products:[p],items:[]};assert.equal(materializeCollectedConversations(legacy,p,[raw],NOW),0);assert.deepEqual(legacy.items,[]);
});

test('manual analysis is returned only for current source/profile and unexpired results; stale qualification hashes never create purposes',()=>{
  const {data,p}=fixture();collect(data,p,[source(1,{historical:true,backfillId:'historical-run',backfillIds:['historical-run']})]);const item=data.items[0];
  assert.equal(item.backfillId,'historical-run');
  item.analysis={decision:'possible_fit',summary:'Review this fit',replies:[{approach:'helpful',body:'Useful response'}],generatedAt:AT,profileHash:productHash(p),sourceHash:matchHash(item),model:'fixture',privateToken:'never expose'};
  let result=pageConversationEvidence(data,viewer,{}).items[0];assert.equal(result.analysis.summary,'Review this fit');assert.equal(result.analysis.privateToken,undefined);
  item.analysis.sourceHash='stale';assert.equal(pageConversationEvidence(data,viewer,{}).items[0].analysis,undefined);item.analysis.sourceHash=matchHash(item);item.analysis.profileHash='stale';assert.equal(pageConversationEvidence(data,viewer,{}).items[0].analysis,undefined);
  item.analysis.profileHash=productHash(p);item.analysis.generatedAt='2000-01-01T00:00:00Z';assert.equal(pageConversationEvidence(data,viewer,{}).items[0].analysis,undefined);
  const row=evidenceFor(data,p)[0];saveConversationReview(data,p,row,decision(row),AT,'fixture');assert.equal(pageConversations(data,viewer,{relevance:'direct'}).total,1);
  data.conversationEvidence.p[0].contentHash='changed-source';assert.equal(pageConversations(data,viewer,{relevance:'direct'}).total,0);assert.equal(pageConversationEvidence(data,viewer,{}).items[0].analysisStatus,'awaiting_analysis');
});

test('discovery forwards durable source mode and retains every available full candidate while legacy sampling remains',async()=>{
  const {p}=fixture();p.linkedin=true;p.communities=[];p.listeningVersion=undefined;
  const full=text.repeat(1000)+'ORIGINAL END',calls=[];
  const linkedinAdapter={id:'linkedin-apify',search:async options=>{calls.push(options);return {rows:Array.from({length:350},(_,i)=>({source:'LinkedIn',type:'post',sourceId:`li_${i}`,url:`https://www.linkedin.com/posts/author_${i}-activity-${7000000000000000+i}-AbCd`,title:'Question',snippet:full,author:'Author',publishedAt:'2025-12-01T00:00:00Z'})),coverage:{partial:true,errors:[]}};}};
  const modern=await discover(p,{watchOnly:true,scheduledSources:['linkedin'],linkedinAdapter,now:new Date(NOW),semantic:true,preserveText:true});assert.equal(modern.candidates.length,350);assert.equal(modern.candidates[0].snippet,full);assert(calls.every(call=>call.preserveText===true));
  calls.length=0;const legacy=await discover(p,{watchOnly:true,scheduledSources:['linkedin'],linkedinAdapter,now:new Date(NOW),semantic:true});assert.equal(legacy.candidates.length,0,'Legacy past-month semantic filter stays in place');assert(calls.every(call=>call.preserveText===false));
});
