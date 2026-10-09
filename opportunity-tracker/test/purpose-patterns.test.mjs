import test from 'node:test';
import assert from 'node:assert/strict';
import {ENTITY_MATCH_VERSION} from '../entity-mention.mjs';
import {projectPurposePatterns} from '../purpose-patterns.mjs';
import {captureEvidence,saveConversationReview,evidenceFor} from '../conversation-evidence.mjs';
import {v2Business} from './pipeline.fixture.mjs';
import {createTrackerApp} from '../server.mjs';

const at='2026-10-09T12:00:00Z';
function fixture(){
  const p={...v2Business(),id:'p',listeningVersion:'v2'},q={...v2Business(),id:'q',name:'Another Cafe',listeningVersion:'v2'};
  const data={version:1,products:[p,q],items:[],searches:{},subscription:{planId:'growth',status:'manual'}};
  for(const product of [p,q]){
    const rows=Array.from({length:120},(_,i)=>({url:`https://www.reddit.com/r/vancouver/comments/${product.id}${i}/`,source:'Reddit',type:'post',title:`Discussion ${i}`,snippet:i>=114?`${product.name} in Vancouver has good sandwiches.`:'Unreviewed source body '.repeat(500),author:`author${i}`,publishedAt:at}));
    captureEvidence(data,product,rows,at);
    for(const row of evidenceFor(data,product).slice(product===p?114:119))saveConversationReview(data,product,row,{entityMatch:{version:ENTITY_MATCH_VERSION,status:'confirmed',basis:'business_context',reference:product.name,quote:row.text,identityQuote:row.text,businessQuote:'We serve croissant sandwiches and cheesecake in Vancouver.',contextSource:'own',reason:'Name and Vancouver match.'},relevant:true,directFit:false,category:'recommendation',need:'',quote:row.text,offeringIds:[],reason:'Names the business.',resolved:'unknown',purposes:[{purpose:'mention',quote:row.text,reference:product.name,reason:'Names the business.',offeringIds:[]}]},at,'fixture');
    data.conversationEvidence[product.id]=[...evidenceFor(data,product).filter(row=>!row.qualification),...evidenceFor(data,product).filter(row=>row.qualification)];
  }
  const rows=evidenceFor(data,p).slice(114),insight={id:'saved',kind:'repeated_question',title:'Original saved title',outcome:'Original saved claim',explanation:'Original saved explanation',community:'vancouver',evidenceIds:rows.slice(0,3).map(row=>row.id),offeringIds:[],unknowns:['Original limitation'],independentThreadCount:3,firstSeen:at,lastSeen:at,sources:rows.slice(0,3).map(row=>({id:row.id,url:row.url,title:row.title,author:row.author,publishedAt:row.publishedAt,quote:row.qualification.quote,threadId:row.threadId,discussionClosed:false,resolved:'unknown'}))};
  data.pipelineStages={p:{insights:{stage:'insights',generatedAt:at,inputHash:'previous-context',data:{insights:[insight],limitations:[]}}}};
  return {data,p,q,rows,insight};
}

test('purpose patterns use complete product evidence beyond the first 50 rows and retain saved claims and attribution',()=>{
  const {data,p,q,insight}=fixture();assert(evidenceFor(data,p).slice(0,50).every(row=>!row.qualification));
  const result=projectPurposePatterns(data,p);assert.equal(result.version,1);assert.equal(result.purposes.mentions.evidenceCount,6);assert.equal(result.purposes.all.evidenceCount,6);
  assert.deepEqual(result.purposes.mentions.patterns,[insight]);assert.equal(projectPurposePatterns(data,q).purposes.mentions.evidenceCount,1);assert.deepEqual(projectPurposePatterns(data,q).purposes.mentions.patterns,[]);
  assert(JSON.stringify(result).length<12000);assert(!JSON.stringify(result).includes('Unreviewed source body'));
  result.purposes.mentions.patterns[0].sources[0].quote='edited view';assert.equal(insight.sources[0].quote,data.pipelineStages.p.insights.data.insights[0].sources[0].quote);
  assert.notEqual(insight.sources[0].quote,'edited view');
});

test('all supporting sources must have a current confirmed purpose; stale, raw, mixed and foreign sources cannot qualify a pattern',()=>{
  const {data,p,q,rows,insight}=fixture();
  const mixed=structuredClone(insight);mixed.id='mixed';mixed.evidenceIds=[rows[0].id,evidenceFor(data,q).at(-1).id];data.pipelineStages.p.insights.data.insights.push(mixed);
  assert.equal(projectPurposePatterns(data,p).purposes.mentions.patterns.length,1);
  rows[0].contentHash='changed-content';let projected=projectPurposePatterns(data,p);assert.equal(projected.purposes.mentions.evidenceCount,5);assert.deepEqual(projected.purposes.mentions.patterns,[]);
  rows[1].qualification.profileHash='old-profile';delete rows[2].qualification.entityMatch;rows[2].qualification.purposes=[];delete rows[3].qualification;
  projected=projectPurposePatterns(data,p);assert.equal(projected.purposes.mentions.evidenceCount,2);assert.equal(projected.purposes.all.evidenceCount,3);
  assert.equal(projected.purposes.feedback.evidenceCount,0);assert.deepEqual(projected.purposes.feedback.patterns,[]);
});

test('private state exposes authoritative pattern counts while retaining its 50-row evidence bound',async t=>{
  const {data}=fixture(),store={snapshot:async()=>structuredClone(data)},tracker=createTrackerApp({store,qualificationEnv:{}});
  const server=tracker.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/state`);assert.equal(response.status,200);const state=await response.json();
  assert.equal(state.pipeline.products.p.conversations.length,50);assert.equal(state.pipeline.products.p.purposePatterns.purposes.mentions.evidenceCount,6);assert.equal(state.pipeline.products.q.purposePatterns.purposes.mentions.evidenceCount,1);assert.equal(state.pipeline.products.p.purposePatterns.purposes.mentions.patterns.length,1);
});
