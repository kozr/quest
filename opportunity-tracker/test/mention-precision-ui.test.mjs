import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesConversation,purposeEvidence} from '../ui/src/feed.mjs';
import {canEditCollected,collectedReviewBody,modernReviewSummary} from '../ui/src/review-state.mjs';
const raw={id:'wren-source',status:'new',kind:'mention',keywordMention:{reference:'Wren Cafe',quote:'Wren Cafe in London'},currentConversationRelevant:false,conversationSignals:[],analysisStatus:'awaiting_analysis'};
const confirmed={...raw,id:'bbt-source',entityMention:{reference:'Blind Box Tracker',quote:'I built Blind Box Tracker: https://blindboxtracker.com',reason:'The source links to the official business website.',basis:'official_url'},keywordMention:{reference:'Blind Box Tracker',quote:'I built Blind Box Tracker: https://blindboxtracker.com'}};
test('Mentions excludes raw names, legacy kinds and AI-only namesake labels',()=>{
 for(const item of [raw,{...raw,currentConversationRelevant:true,conversationSignals:[{purpose:'mention',quote:raw.keywordMention.quote}]},{...raw,conversationSignals:undefined,qualification:{purposes:[{purpose:'mention'}]}}]){
  assert.equal(matchesConversation(item,{relevance:'mentions'}),false);
  assert.equal(matchesConversation({...item,status:'saved'},{view:'saved',relevance:'mentions'}),false);
  assert.equal(matchesConversation({...item,status:'dismissed'},{status:'dismissed',relevance:'mentions'}),false);
 }
});
test('identity-confirmed source is a mention before intent analysis without creating a lead',()=>{
 assert.equal(matchesConversation(confirmed,{relevance:'mentions'}),true);
 for(const relevance of ['direct','feedback','competitors'])assert.equal(matchesConversation(confirmed,{relevance}),false);
 const evidence=purposeEvidence(confirmed,'mentions');assert.equal(evidence.quote,confirmed.entityMention.quote);assert.deepEqual(evidence.signals,[]);assert.equal(evidence.entityMention,confirmed.entityMention);
 assert.equal(matchesConversation({...confirmed,entityMention:null},{relevance:'mentions'}),false);
});
test('Mentions retains shared saved/dismissed status rules',()=>{
 assert.equal(matchesConversation({...confirmed,status:'saved'},{relevance:'mentions'}),true);
 assert.equal(matchesConversation({...confirmed,status:'dismissed'},{relevance:'mentions'}),false);
 assert.equal(matchesConversation({...confirmed,status:'dismissed'},{relevance:'mentions',status:'dismissed'}),true);
});
test('other purpose views still require their own signal',()=>{
 const opportunity={...raw,currentConversationRelevant:true,conversationSignals:[{purpose:'potential_customer',quote:'I need help'}]};
 assert.equal(matchesConversation(opportunity,{relevance:'direct'}),true);
 assert.equal(matchesConversation(opportunity,{relevance:'mentions'}),false);
});
test('Collected review supports private editing and retains account ACL and version check',()=>{
 assert.equal(canEditCollected({conversationPaging:true},raw),true);
 assert.equal(canEditCollected({conversationPaging:true},{...raw,reviewEditable:false}),false);
 assert.equal(canEditCollected({account:{permissions:{write:false}}},raw),false);
 assert.equal(canEditCollected({account:{}},raw),false);
 assert.equal(canEditCollected({account:{permissions:{write:true}}},raw),true);
 const edit={version:7,note:'Keep source note',draft:'Saved response',status:'saved'};
 assert.deepEqual(collectedReviewBody(edit),{note:edit.note,draft:edit.draft,status:'saved'});
 assert.deepEqual(collectedReviewBody(edit,true),{expectedVersion:7,note:edit.note,draft:edit.draft,status:'saved'});
});
test('modern queue counters use complete pipeline totals rather than the legacy zero counters',()=>{
 const state={conversationPaging:true,qualification:{counts:{pending:0,qualified:900}},products:[{id:'bbt'},{id:'wren'},{id:'old',archived:true}],pipeline:{products:{bbt:{pending:13,failed:1},wren:{pending:14,failed:2},old:{pending:100}}}};
 assert.deepEqual(modernReviewSummary(state),{pending:27,failed:3});
 assert.deepEqual(modernReviewSummary({...state,conversationPaging:false,account:{id:'team'}}),{pending:27,failed:3});
 assert.equal(modernReviewSummary({...state,conversationPaging:false}),null);
});
