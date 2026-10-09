import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapWorkspace,createClient,createInvite,acceptInvite} from '../workspace.mjs';
import {planFor} from '../plans.mjs';
import {captureEvidence,qualificationInputHash} from '../conversation-evidence.mjs';
import {materializeCollectedConversations,pageConversations} from '../conversation-pages.mjs';
import {conversationCurrentState} from '../conversation-feed.mjs';
import {conversationSignals} from '../conversation-purpose.mjs';
import {keywordMentionEvidence} from '../keyword-mention.mjs';
import {matchesConversation,purposeEvidence} from '../ui/src/feed.mjs';
const now=Date.now(),at=new Date(now).toISOString(),owner={sub:'literal-owner',email:'owner@example.test'};
function fixture(name='Blind Box Tracker'){
 const product={id:'p1',name,aliases:name==='Wren Café'?['Wren Cafe']:['BlindBoxTracker'],url:name==='Wren Café'?'https://wrencafe.ca/':'https://blindboxtracker.com/',listeningVersion:'v2',businessProfileV2:{offerings:[]},searchPlanV2:{themes:[]}};
 const data={products:[product],items:[],subscription:{planId:'growth',status:'active'}};bootstrapWorkspace(data,{id:'literal-workspace',owner,now});return {data,product};
}
function collect(data,product,snippet,extra={}){const source={title:'Original conversation',snippet,type:'post',source:'Reddit',url:'https://www.reddit.com/r/example/comments/literal123/',author:'source-author',publishedAt:at,queryFamily:'keyword',...extra};captureEvidence(data,product,[source],at);materializeCollectedConversations(data,product,[source],now);return data.conversationEvidence[product.id][0];}

test('literal business reference appears in Mentions before AI while all confirmed purposes remain empty',()=>{
 const {data,product}=fixture();collect(data,product,'I use Blind Box Tracker to track my collection.');const item=pageConversations(data,owner,{relevance:'mentions'}).items[0];
 assert.equal(item.analysisStatus,'awaiting_analysis');assert.equal(item.keywordMention.reference,'Blind Box Tracker');assert.equal(item.keywordMention.quote,'I use Blind Box Tracker to track my collection.');assert.equal(item.qualification,undefined);assert.deepEqual(item.conversationSignals,[]);assert.equal(item.currentConversationRelevant,false);assert.equal(item.currentOpportunityFit,false);
 assert.equal(matchesConversation(item,{relevance:'mentions'}),true);assert.equal(purposeEvidence(item,'mentions').unverifiedMention,true);assert.deepEqual(purposeEvidence(item,'mentions').signals,[]);
 for(const relevance of ['direct','feedback','competitors']){assert.equal(pageConversations(data,owner,{relevance}).total,0);assert.equal(matchesConversation(item,{relevance}),false);}
 const local={...data.items[0],...conversationCurrentState(data,data.items[0])};assert.equal(matchesConversation(local,{relevance:'mentions'}),true);assert.deepEqual(local.conversationSignals,[]);
});
test('Wren namesake remains an unverified keyword match even after authoritative negative AI review',()=>{
 const {data,product}=fixture('Wren Café'),row=collect(data,product,'Wren Cafe in London has a lovely menu.');const before=pageConversations(data,owner,{relevance:'mentions'}).items[0];assert.equal(purposeEvidence(before,'mentions').unverifiedMention,true);
 row.qualification={profileHash:qualificationInputHash(product),contentHash:row.contentHash,relevant:false,directFit:false,purposes:[],reason:'A different business in London.'};
 const item=pageConversations(data,owner,{relevance:'mentions'}).items[0];assert.equal(item.id,before.id);assert.equal(item.analysisStatus,'analyzed');assert.equal(item.qualification.relevant,false);assert.deepEqual(item.conversationSignals,[]);assert.equal(purposeEvidence(item,'mentions').unverifiedMention,true);assert.equal(pageConversations(data,owner,{relevance:'direct'}).total,0);assert.deepEqual(conversationSignals(product,row,row.qualification,{current:true}),[]);
 data.items[0].status='dismissed';assert.equal(pageConversations(data,owner,{relevance:'mentions'}).total,0);assert.equal(pageConversations(data,owner,{relevance:'mentions',status:'dismissed'}).total,1);
});
test('positive AI mention confirms only the separate purpose signal, preserving the raw literal evidence',()=>{
 const {data,product}=fixture(),row=collect(data,product,'BlindBoxTracker is useful.');row.qualification={profileHash:qualificationInputHash(product),contentHash:row.contentHash,relevant:true,directFit:false,purposes:[{purpose:'mention',reference:'BlindBoxTracker',quote:'BlindBoxTracker is useful.',reason:'Names this app.',offeringIds:[]}]};
 const item=pageConversations(data,owner,{relevance:'mentions'}).items[0];assert.equal(item.keywordMention.matchType,'literal');assert.equal(item.conversationSignals[0].purpose,'mention');assert.equal(purposeEvidence(item,'mentions').unverifiedMention,false);assert.equal(item.currentOpportunityFit,false);
});
test('source ownership, name boundaries and changed text prevent unsupported raw mentions',()=>{
 const {data,product}=fixture('Wren Café');assert.equal(keywordMentionEvidence(product,{type:'comment',title:'Wren Cafe discussion',snippet:'Thank you',context:'I visited Wren Cafe.'}),null);
 assert.equal(keywordMentionEvidence(product,{snippet:'Wren Cafeteria'}),null);assert.equal(keywordMentionEvidence(product,{snippet:'wrencafe.ca.evil.example'}),null);assert.equal(keywordMentionEvidence(product,{snippet:'See wrencafe.ca for opening hours.'}).reference,'wrencafe.ca');
 collect(data,product,'I visited Wren Cafe.');assert.equal(pageConversations(data,owner,{relevance:'mentions'}).total,1);collect(data,product,'This source no longer names the cafe.');assert.equal(pageConversations(data,owner,{relevance:'mentions'}).total,0);
});
test('unverified mention projection still respects client access and never accepts a stored forged match',()=>{
 const {data,product}=fixture();data.subscription.planId='team';const a=createClient(data,owner,{name:'A',now},planFor(data)),b=createClient(data,owner,{name:'B',now},planFor(data));product.clientId=a.id;const other={...product,id:'p2',clientId:b.id};data.products.push(other);collect(data,product,'No matching business name here.');data.items[0].keywordMention={reference:'forged',quote:'forged'};collect(data,other,'Blind Box Tracker is named by another client.');
 const viewer={sub:'scoped-reader',email:'scoped@gmail.com'},invite=createInvite(data,owner,{email:viewer.email,role:'viewer',clientIds:[a.id],now},planFor(data));acceptInvite(data,viewer,{token:invite.token,now},planFor(data));
 assert.equal(pageConversations(data,viewer,{relevance:'mentions'}).total,0);assert.equal(pageConversations(data,owner,{relevance:'mentions'}).total,1);assert.throws(()=>pageConversations(data,viewer,{relevance:'mentions',productId:'p2'}),error=>error.status===404);
});
