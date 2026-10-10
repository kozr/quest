import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapWorkspace,createClient,createInvite,acceptInvite} from '../workspace.mjs';
import {planFor} from '../plans.mjs';
import {captureEvidence,evidenceFor,saveConversationReview,recordReviewFailure,pendingEvidenceAll,failedEvidenceCount} from '../conversation-evidence.mjs';
import {materializeCollectedConversations,pageConversations,pagePrivateConversations,privateConversationReadViews,pagePrivateConversationViews} from '../conversation-pages.mjs';
import {conversationCurrentState} from '../conversation-feed.mjs';
import {keywordMentionEvidence,isKeywordResult} from '../keyword-mention.mjs';
import {projectPurposePatterns} from '../purpose-patterns.mjs';
import {workspaceReadViews,readWorkspaceSummary} from '../workspace-read-views.mjs';
import {matchesConversation,purposeEvidence} from '../ui/src/feed.mjs';
const now=Date.now(),at=new Date(now).toISOString(),owner={sub:'keyword-owner',email:'owner@example.test'};
function fixture(){
 const product={id:'p1',name:'Wren Café',aliases:['Wren Cafe'],url:'https://wrencafe.ca/',listeningVersion:'v2',businessProfileV2:{reviewed:true,offerings:[],constraints:[{text:'Location',quote:'Our cafe is in Vancouver.'}]},searchPlanV2:{themes:[
  {purposes:['mention'],queries:[{id:'name',loop:'keyword',query:'Wren Cafe'}]},
  {purposes:['potential_customer'],queries:[{id:'lunch',loop:'keyword',query:'Vancouver lunch'},{id:'need',loop:'long_tail',query:'Need somewhere for lunch'}]}
 ]}};
 const data={products:[product],items:[],subscription:{planId:'growth',status:'active'}};bootstrapWorkspace(data,{id:'keyword-workspace',owner,now});return {data,product};
}
function collect(data,product,snippet,extra={}){const source={title:'Original conversation',snippet,type:'post',source:'Reddit',url:'https://www.reddit.com/r/example/comments/keyword123/',author:'source-author',publishedAt:at,queryFamily:'keyword',queryId:'name',...extra};captureEvidence(data,product,[source],at);materializeCollectedConversations(data,product,[source],now);return evidenceFor(data,product).find(row=>row.url===source.url);}
function assertMention(data,product,count=1){
 const item=pageConversations(data,owner,{relevance:'collected',status:'all'}).items[0];
 assert.equal(pageConversations(data,owner,{relevance:'mentions',status:'all'}).total,count);assert.equal(matchesConversation({...item,status:'new'},{relevance:'mentions'}),Boolean(count));
 assert.deepEqual(item.keywordMention,conversationCurrentState(data,data.items[0]).keywordMention);
 if(count)assert.equal(purposeEvidence(item,'mentions').quote,item.keywordMention.quote);
 assert.equal(projectPurposePatterns(data,product).purposes.mentions.evidenceCount,count);return item;
}
test('keyword matches appear immediately despite negative or failed AI reviews, without another review unit',()=>{
 const {data,product}=fixture(),row=collect(data,product,'Wren Cafe in London has a lovely menu.');
 assert.equal(assertMention(data,product).analysisStatus,'not_required');assert.equal(pendingEvidenceAll(data,product).length,0);
 saveConversationReview(data,product,row,{relevant:false,directFit:false,purposes:[],reason:'A different business.'},at,'fixture');assert.equal(assertMention(data,product).entityMention,null);
 recordReviewFailure(data,product,row,'Prior provider failure',at);assertMention(data,product);assert.equal(failedEvidenceCount(data,product),0);assert(data.conversationReviewFailures.p1[row.id]);assert.equal(pendingEvidenceAll(data,product).length,0);
});
test('every result from a saved purpose keyword query bypasses AI intent filtering',()=>{
 const {data,product}=fixture();collect(data,product,'Here are some lunch places.',{queryId:'lunch'});
 const page=pageConversations(data,owner,{relevance:'direct'});assert.equal(page.total,1);assert.equal(page.items[0].keywordResult,true);assert.equal(page.items[0].conversationSignals[0].basis,'keyword');assert.equal(pendingEvidenceAll(data,product).length,0);assert.equal(pageConversations(data,owner,{relevance:'mentions'}).total,0);
});
test('long-tail remains review-gated; a later keyword hit promotes the same source and preserves its edits',()=>{
 const {data,product}=fixture();collect(data,product,'Need somewhere for lunch.',{queryFamily:'long_tail',queryId:'need'});assert.equal(pendingEvidenceAll(data,product).length,1);assert.equal(pageConversations(data,owner,{relevance:'direct'}).total,0);
 const original=data.items[0].id;data.items[0].note='Saved note';data.items[0].draft='Saved draft';collect(data,product,'Need somewhere for lunch.',{queryId:'lunch'});
 assert.equal(data.items.length,1);assert.equal(data.items[0].id,original);assert.equal(data.items[0].note,'Saved note');assert.equal(data.items[0].draft,'Saved draft');assert.equal(pageConversations(data,owner,{relevance:'direct'}).total,1);assert.equal(pendingEvidenceAll(data,product).length,0);assert.deepEqual(evidenceFor(data,product)[0].queryFamilies,['long_tail','keyword']);
});
test('full source text and profile edits cannot hide a keyword beyond the AI excerpt',()=>{
 const {data,product}=fixture(),text='Intro '.repeat(700)+'Wren Cafe in Vancouver has croissants.';collect(data,product,text,{queryId:'old-query'});assert(text.indexOf('Wren Cafe')>2200);assertMention(data,product);assert.equal(pendingEvidenceAll(data,product).length,0);
 product.businessProfileV2.constraints.push({quote:'A new branch.'});assertMention(data,product);assert.equal(pageConversations(data,owner,{relevance:'collected'}).items[0].snippet,text);
});
test('comments use their own keyword text; boundaries and parent context do not fabricate a match',()=>{
 const {data,product}=fixture();assert.equal(keywordMentionEvidence(product,{type:'comment',title:'Wren Cafe',context:'Visit Wren Cafe',text:'Thank you'}),null);assert.equal(keywordMentionEvidence(product,{text:'Wren Cafeteria'}),null);assert.equal(keywordMentionEvidence(product,{text:'wrencafe.ca.evil.example'}),null);
 collect(data,product,'Thank you',{type:'comment',title:'Wren Cafe',context:'Visit Wren Cafe'});assertMention(data,product,0);collect(data,product,'Wren Cafe is lovely.',{type:'comment'});assertMention(data,product);collect(data,product,'Thank you',{type:'comment',title:'Wren Cafe'});assertMention(data,product,0);
});
test('keyword projections preserve client isolation and dismissed filtering; imported labels alone do not create matches',()=>{
 const {data,product}=fixture();data.subscription.planId='team';const a=createClient(data,owner,{name:'A',now},planFor(data)),b=createClient(data,owner,{name:'B',now},planFor(data));product.clientId=a.id;const other={...product,id:'p2',clientId:b.id};data.products.push(other);collect(data,product,'Wren Cafe is lovely.');collect(data,other,'Wren Cafe is lovely.');
 const viewer={sub:'scoped-reader',email:'scoped@gmail.com'},invite=createInvite(data,owner,{email:viewer.email,role:'viewer',clientIds:[a.id],now},planFor(data));acceptInvite(data,viewer,{token:invite.token,now},planFor(data));assert.equal(pageConversations(data,viewer,{relevance:'mentions'}).total,1);assert.equal(pageConversations(data,owner,{relevance:'mentions'}).total,2);assert.throws(()=>pageConversations(data,viewer,{relevance:'mentions',productId:'p2'}),e=>e.status===404);
 data.items.find(item=>item.productId===product.id).status='dismissed';assert.equal(pageConversations(data,viewer,{relevance:'mentions'}).total,0);assert.equal(pageConversations(data,viewer,{relevance:'mentions',status:'dismissed'}).total,1);
 delete data.workspace;assert.equal(pagePrivateConversations(data,{relevance:'mentions',status:'all'}).total,2);
 data.products=[product];data.conversationEvidence={};data.items=[{id:'forged',productId:'p1',kind:'mention',entityMention:{quote:'forged'},title:'No business',snippet:'No business',url:'https://www.reddit.com/r/example/comments/forged/'}];assert.equal(pagePrivateConversations(data,{relevance:'mentions'}).total,0);
});
test('fresh indexed pages match authoritative rules; old AI-gated indexes and summaries fall back safely',async()=>{
 const {data,product}=fixture();collect(data,product,'Wren Cafe is lovely.');delete data.workspace;const views=privateConversationReadViews(data),reader={get:async key=>views[key]??null};
 for(const status of ['active','all','not_required'])assert.deepEqual(await pagePrivateConversationViews(reader,{relevance:'mentions',status}),pagePrivateConversations(data,{relevance:'mentions',status}));
 views['conversation-index']=JSON.stringify(JSON.parse(views['conversation-index']).entries);assert.equal(await pagePrivateConversationViews(reader,{relevance:'mentions'}),null);
 const summary=workspaceReadViews(data).summary;assert(readWorkspaceSummary(summary));const old=JSON.parse(summary);delete old.matchRules;assert.equal(readWorkspaceSummary(JSON.stringify(old)),null);
});

test('optional Patterns can use unreviewed or failed keyword sources and retain their source versions',async()=>{
 const {v2Business,plan}=await import('./pipeline.fixture.mjs'),{insightsInput,validateInsights}=await import('../listening-insights.mjs');
 const product={...v2Business(),id:'p1',listeningVersion:'v2',searchPlanV2:{...plan(),reviewed:true}},data={products:[product],items:[],subscription:{planId:'growth',status:'active'}};
 const row=collect(data,product,`${product.name} has a sandwich complaint.`,{queryId:'q1'});recordReviewFailure(data,product,row,'Prior provider failure',at);row.qualification={profileHash:'old-profile',relevant:false,quote:'Old rejected source'};
 const input=insightsInput(data,product);assert.deepEqual(input.evidence[0].qualification,{});assert.equal(pendingEvidenceAll(data,product).length,0);
 const insights=validateInsights({insights:[{id:'complaint',kind:'complaint',title:'Sandwich complaint',outcome:'A sandwich complaint',community:'example',evidenceIds:[row.id],explanation:'An original complaint.',offeringIds:[],unknowns:[]}],limitations:[]},product,input);
 assert.equal(insights.insights[0].sources[0].quote,row.text);data.pipelineStages={p1:{insights:{data:insights}}};assert.equal(projectPurposePatterns(data,product).purposes.mentions.patterns.length,1);
 row.text='Different source body';assert.equal(projectPurposePatterns(data,product).purposes.feedback.patterns.length,0);
});
