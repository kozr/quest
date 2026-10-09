import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapWorkspace,createClient,createInvite,acceptInvite} from '../workspace.mjs';
import {planFor} from '../plans.mjs';
import {captureEvidence,qualificationInputHash,saveConversationReview} from '../conversation-evidence.mjs';
import {materializeCollectedConversations,pageConversations,pagePrivateConversations} from '../conversation-pages.mjs';
import {conversationCurrentState,syncConversationItems} from '../conversation-feed.mjs';
import {keywordMentionEvidence} from '../keyword-mention.mjs';
import {ENTITY_MATCH_VERSION} from '../entity-mention.mjs';
import {projectPurposePatterns} from '../purpose-patterns.mjs';
import {matchesConversation,purposeEvidence} from '../ui/src/feed.mjs';
const now=Date.now(),at=new Date(now).toISOString(),owner={sub:'literal-owner',email:'owner@example.test'};
function fixture(name='Blind Box Tracker'){
 const product={id:'p1',name,aliases:name==='Wren Café'?['Wren Cafe']:['BlindBoxTracker'],url:name==='Wren Café'?'https://wrencafe.ca/':'https://blindboxtracker.com/',listeningVersion:'v2',businessProfileV2:{reviewed:true,offerings:[],constraints:[{text:'Location',quote:'Our cafe is in Vancouver.'}]},searchPlanV2:{themes:[]}};
 const data={products:[product],items:[],subscription:{planId:'growth',status:'active'}};bootstrapWorkspace(data,{id:'literal-workspace',owner,now});return {data,product};
}
function collect(data,product,snippet,extra={}){const source={title:'Original conversation',snippet,type:'post',source:'Reddit',url:'https://www.reddit.com/r/example/comments/literal123/',author:'source-author',publishedAt:at,queryFamily:'keyword',...extra};captureEvidence(data,product,[source],at);materializeCollectedConversations(data,product,[source],now);return data.conversationEvidence[product.id][0];}
function verdict(status='confirmed'){return status==='confirmed'?{version:ENTITY_MATCH_VERSION,status,basis:'business_context',reference:'Wren Cafe',quote:'Wren Cafe in Vancouver is lovely.',identityQuote:'Wren Cafe in Vancouver is lovely.',businessQuote:'Our cafe is in Vancouver.',contextSource:'own',reason:'The named cafe and its location match.'}:{version:ENTITY_MATCH_VERSION,status,basis:'none',reference:'',quote:'',identityQuote:'',businessQuote:'',contextSource:'none',reason:'A different business.'};}
function review(data,product,row,entityMatch,extra={}){saveConversationReview(data,product,row,{relevant:false,directFit:false,purposes:[],offeringIds:[],reason:'No customer intent.',entityMatch,...extra},at,'fixture');}
function compare(data,product,{mentions=0}={}){
 const collected=pageConversations(data,owner,{relevance:'collected',status:'all'}),item=collected.items[0],local=conversationCurrentState(data,data.items[0]);
 assert.deepEqual(item.entityMention,local.entityMention);assert.equal(pageConversations(data,owner,{relevance:'mentions',status:'all'}).total,mentions);assert.equal(matchesConversation({...item,status:'new'},{relevance:'mentions'}),Boolean(mentions));
 return item;
}
test('literal business reference remains Collected until exact entity identity is confirmed',()=>{
 const {data,product}=fixture();collect(data,product,'I use Blind Box Tracker to track my collection.');const item=pageConversations(data,owner,{relevance:'collected'}).items[0];
 assert.equal(item.analysisStatus,'awaiting_analysis');assert.equal(item.keywordMention.reference,'Blind Box Tracker');assert.equal(item.entityMention,null);assert.deepEqual(item.conversationSignals,[]);assert.equal(pageConversations(data,owner,{relevance:'mentions'}).total,0);
 for(const relevance of ['mentions','direct','feedback','competitors'])assert.equal(matchesConversation(item,{relevance}),false);
 const local={...data.items[0],...conversationCurrentState(data,data.items[0])};assert.equal(matchesConversation(local,{relevance:'mentions'}),false);
});
test('Wren namesake stays Collected even after a negative AI review and when dismissed',()=>{
 const {data,product}=fixture('Wren Café'),row=collect(data,product,'Wren Cafe in London has a lovely menu.');const before=pageConversations(data,owner,{relevance:'collected'}).items[0];
 row.qualification={profileHash:qualificationInputHash(product),contentHash:row.contentHash,relevant:false,directFit:false,purposes:[],reason:'A different business in London.'};
 const item=pageConversations(data,owner,{relevance:'collected'}).items[0];assert.equal(item.id,before.id);assert.equal(item.qualification.relevant,false);assert.equal(item.entityMention,null);assert.equal(pageConversations(data,owner,{relevance:'mentions'}).total,0);
 data.items[0].status='dismissed';assert.equal(pageConversations(data,owner,{relevance:'mentions',status:'dismissed'}).total,0);assert.equal(pageConversations(data,owner,{relevance:'collected',status:'dismissed'}).total,1);
});
test('official reference confirms identity independently of AI usefulness while preserving raw evidence',()=>{
 const {data,product}=fixture(),row=collect(data,product,'BlindBoxTracker is here: https://blindboxtracker.com');row.qualification={profileHash:qualificationInputHash(product),contentHash:row.contentHash,relevant:false,directFit:false,purposes:[]};
 const item=pageConversations(data,owner,{relevance:'mentions'}).items[0];assert.equal(item.keywordMention.matchType,'literal');assert.equal(item.entityMention.basis,'identifier');assert.equal(item.conversationSignals[0].purpose,'mention');assert.equal(item.currentOpportunityFit,false);
});
test('source ownership, exact domains and changed text prevent unsupported identity',()=>{
 const {data,product}=fixture('Wren Café');assert.equal(keywordMentionEvidence(product,{type:'comment',title:'Wren Cafe discussion',snippet:'Thank you',context:'I visited Wren Cafe.'}),null);
 assert.equal(keywordMentionEvidence(product,{snippet:'Wren Cafeteria'}),null);assert.equal(keywordMentionEvidence(product,{snippet:'wrencafe.ca.evil.example'}),null);
 collect(data,product,'Thank you',{type:'comment',title:'Wren Cafe https://wrencafe.ca/',context:'Parent says Wren Cafe https://wrencafe.ca/'});compare(data,product);
 collect(data,product,'Visit https://wrencafe.ca/',{type:'comment'});compare(data,product,{mentions:1});collect(data,product,'Visit https://wrencafe.ca.evil.example/');compare(data,product);
});
test('entity projections respect client isolation and never accept stored forged matches',()=>{
 const {data,product}=fixture();data.subscription.planId='team';const a=createClient(data,owner,{name:'A',now},planFor(data)),b=createClient(data,owner,{name:'B',now},planFor(data));product.clientId=a.id;const other={...product,id:'p2',clientId:b.id};data.products.push(other);collect(data,product,'No matching business name here.');data.items[0].entityMention={reference:'forged',quote:'forged'};collect(data,other,'My app https://blindboxtracker.com/');
 const viewer={sub:'scoped-reader',email:'scoped@gmail.com'},invite=createInvite(data,owner,{email:viewer.email,role:'viewer',clientIds:[a.id],now},planFor(data));acceptInvite(data,viewer,{token:invite.token,now},planFor(data));
 assert.equal(pageConversations(data,viewer,{relevance:'mentions'}).total,0);assert.equal(pageConversations(data,owner,{relevance:'mentions'}).total,1);assert.throws(()=>pageConversations(data,viewer,{relevance:'mentions',productId:'p2'}),error=>error.status===404);
});

test('current structured identity evidence confirms Mentions without manufacturing another purpose',()=>{
 const {data,product}=fixture('Wren Café'),row=collect(data,product,'Wren Cafe in Vancouver is lovely.');review(data,product,row,verdict());const item=compare(data,product,{mentions:1});assert.equal(item.entityMention.basis,'business_context');assert.equal(item.currentOpportunityFit,false);assert.equal(projectPurposePatterns(data,product).purposes.mentions.evidenceCount,1);assert.equal(projectPurposePatterns(data,product).purposes.all.evidenceCount,0);
 const current=data.conversationEvidence[product.id][0];delete current.qualification.entityMatch;current.qualification.relevant=true;current.qualification.purposes=[{purpose:'mention',reference:'Wren Cafe',quote:row.text,reason:'Names the cafe.',offeringIds:[]}];compare(data,product);
});
test('profile edits, mutated body and stale hashes invalidate AI identity equally in state, pages and Patterns',()=>{
 for(const change of ['profile','body','hash']){
  const {data,product}=fixture('Wren Café'),row=collect(data,product,'Wren Cafe in Vancouver is lovely.');review(data,product,row,verdict(),{relevant:true});syncConversationItems(data,product);compare(data,product,{mentions:1});
  if(change==='profile')product.businessProfileV2.constraints.push({quote:'New branch in Victoria.'});if(change==='body')data.conversationEvidence[product.id][0].text='Wren Cafe in London has a lovely menu.';if(change==='hash')data.conversationEvidence[product.id][0].contentHash='changed';
  compare(data,product);assert.equal(projectPurposePatterns(data,product).purposes.mentions.evidenceCount,0);assert.equal(projectPurposePatterns(data,product).purposes.all.evidenceCount,0);
 }
});
test('item-only and private legacy projections retain source proof but reject imported kind shortcuts',()=>{
 const {data,product}=fixture('Wren Café'),row=collect(data,product,'Wren Cafe in Vancouver is lovely.');review(data,product,row,verdict(),{relevant:true});syncConversationItems(data,product);data.conversationEvidence={};compare(data,product,{mentions:1});data.items[0].snippet='Wren Cafe in London.';compare(data,product);
 delete data.workspace;delete product.listeningVersion;data.items[0].kind='mention';assert.equal(pagePrivateConversations(data,{relevance:'mentions'}).total,0);assert.equal(conversationCurrentState(data,data.items[0]).entityMention,null);
 data.items[0].snippet='My app https://wrencafe.ca/';assert.equal(pagePrivateConversations(data,{relevance:'mentions'}).total,1);
});
