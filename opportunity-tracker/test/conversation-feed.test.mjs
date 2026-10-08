import test from 'node:test';
import assert from 'node:assert/strict';
import {captureEvidence,qualificationInputHash} from '../conversation-evidence.mjs';
import {syncConversationItems,conversationCurrentState} from '../conversation-feed.mjs';
import {matchesConversation} from '../ui/src/feed.mjs';
import {v2Business,conversations} from './pipeline.fixture.mjs';

function reviewed(){
  const product={...v2Business(),id:'cafe',listeningVersion:'v2'};
  const data={products:[product],items:[],pipelineStages:{cafe:{qualify:{model:'fixture'}}}};
  captureEvidence(data,product,conversations(),'2026-10-08T10:00:00Z');
  for(const row of data.conversationEvidence.cafe)row.qualification={relevant:true,directFit:!row.text.includes('deliver'),reason:'Relevant to café customers',quote:row.text,offeringIds:row.text.includes('deliver')?[]:['o1'],profileHash:qualificationInputHash(product),qualifiedAt:'2026-10-08T10:01:00Z'};
  // This fixture represents completed review, so no source remains queued.
  data.conversationReviewQueue.cafe=[];
  return {data,product};
}

test('all relevant conversations become reviewable without duplicating or losing older review records',()=>{
  const {data,product}=reviewed(),complaint=data.conversationEvidence.cafe.find(row=>!row.qualification.directFit);
  data.items=[{id:'old-review',productId:product.id,url:complaint.url+'?source=old',kind:'opportunity',status:'saved',note:'Keep my note',draft:'Keep my draft',foundAt:'2025-12-01T00:00:00Z'}];
  syncConversationItems(data,product);
  assert.equal(data.items.length,4);
  const saved=data.items.find(item=>item.id==='old-review');
  assert.equal(saved.kind,'conversation');assert.equal(saved.status,'saved');assert.equal(saved.note,'Keep my note');assert.equal(saved.draft,'Keep my draft');assert.equal(saved.foundAt,'2025-12-01T00:00:00Z');
  const visible=data.items.map(item=>({...item,...conversationCurrentState(data,item)}));
  assert.equal(visible.filter(item=>matchesConversation(item)).length,4);
  assert.equal(visible.filter(item=>matchesConversation(item,{relevance:'direct'})).length,3);
  syncConversationItems(data,product);assert.equal(data.items.length,4);
});

test('stale and rejected classifications leave Saved intact while leaving the active feed',()=>{
  const {data,product}=reviewed();syncConversationItems(data,product);
  const item=data.items[0];item.status='saved';item.note='Still useful to me';
  const row=data.conversationEvidence.cafe.find(row=>row.url===item.url);row.qualification.relevant=false;row.qualification.directFit=false;
  syncConversationItems(data,product);
  let visible={...item,...conversationCurrentState(data,item)};
  assert.equal(matchesConversation(visible),false);assert.equal(matchesConversation(visible,{view:'saved'}),true);
  assert.equal(data.items.find(record=>record.id===item.id).note,'Still useful to me');
  product.businessProfileV2.description+=' Updated profile';
  visible={...data.items[1],...conversationCurrentState(data,data.items[1])};
  assert.equal(matchesConversation(visible),false);
  assert.equal(matchesConversation({...visible,status:'dismissed'},{status:'dismissed'}),true);
});

test('qualified relevant records survive sample eviction; legacy mentions remain separate from direct fits',()=>{
  const {data,product}=reviewed();syncConversationItems(data,product);
  const item=data.items[0],row=data.conversationEvidence.cafe.find(r=>r.url===item.url);
  delete row.qualification;
  assert.equal(conversationCurrentState(data,item).currentConversationRelevant,false);
  data.conversationEvidence.cafe=[];
  assert.equal(conversationCurrentState(data,item).currentConversationRelevant,true);
  const mention={id:'mention',productId:product.id,kind:'mention',status:'new',url:'https://www.reddit.com/r/vancouver/comments/brand/'};
  const visible={...mention,...conversationCurrentState(data,mention)};
  assert.equal(matchesConversation(visible),true);assert.equal(matchesConversation(visible,{relevance:'direct'}),false);assert.equal(matchesConversation(visible,{relevance:'mentions'}),true);
  assert.equal(matchesConversation({...item,status:'dismissed'}),false);
});
