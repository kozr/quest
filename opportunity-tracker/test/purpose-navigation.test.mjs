import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveWorkspaceRoute,workspaceViews} from '../ui/src/navigation.mjs';
import {patternsForPurpose} from '../ui/src/purpose-analysis.mjs';
import {purposes} from '../ui/src/purposes.mjs';

test('legacy navigation reaches an enabled purpose or configuration instead of removed pages',()=>{
 const enabled=['opportunities','feedback'];
 assert.equal(resolveWorkspaceRoute('#conversations',enabled,'feedback'),'feedback');
 assert.equal(resolveWorkspaceRoute('#saved',enabled,'feedback'),'feedback');
 assert.equal(resolveWorkspaceRoute('#products',enabled,'feedback'),'settings');
 assert.equal(resolveWorkspaceRoute('#listening',enabled,'feedback'),'settings/monitoring');
 assert.equal(resolveWorkspaceRoute('#insights',enabled,'opportunities'),'feedback/patterns');
 assert.equal(resolveWorkspaceRoute('#research',enabled,'opportunities'),'opportunities/explore');
 assert.equal(resolveWorkspaceRoute('#competitors/explore',enabled,'feedback'),'feedback');
 assert.equal(resolveWorkspaceRoute('#feedback/patterns',enabled,'opportunities'),'feedback/patterns');
 for(const removed of ['products','listening','insights','research','saved','conversations'])assert.equal(Object.hasOwn(workspaceViews,removed),false);
});

test('mention monitoring never presents market research as brand-mention evidence',()=>{
 assert.equal(resolveWorkspaceRoute('#research',['mentions'],'mentions'),'mentions');
 assert.equal(resolveWorkspaceRoute('#mentions/explore',['mentions'],'mentions'),'mentions');
 assert.equal(resolveWorkspaceRoute('#research',['mentions','competitors'],'mentions'),'competitors/explore');
});

function fixture(){
 const conversations=[
  {id:'fit',url:'https://www.reddit.com/r/example/comments/fit/',classificationCurrent:true,qualification:{relevant:true,directFit:true,category:'question',resolved:'unknown'}},
  {id:'market',url:'https://www.reddit.com/r/example/comments/market/',classificationCurrent:true,qualification:{relevant:true,directFit:false,category:'complaint',resolved:'unknown'}}
 ];
 const insights=[{id:'fit-pattern',evidenceIds:['fit'],independentThreadCount:3},{id:'mixed-pattern',evidenceIds:['fit','market'],independentThreadCount:4},{id:'unsupported',evidenceIds:['missing'],independentThreadCount:99}];
 return {items:[],pipeline:{products:{p:{conversations}},stages:{p:{insights:{data:{insights}}}}}};
}

test('purpose summaries preserve their original counts and reject mixed or missing supporting evidence',()=>{
 const state=fixture(),before=structuredClone(state),purpose=purposes.find(p=>p.id==='opportunities');
 const result=patternsForPurpose(state,'p',purpose);
 assert.deepEqual(result.patterns.map(p=>p.id),['fit-pattern']);
 assert.strictEqual(result.patterns[0],state.pipeline.stages.p.insights.data.insights[0]);
 assert.equal(result.patterns[0].independentThreadCount,3);
 assert.deepEqual(patternsForPurpose(state,'p',purposes.find(p=>p.id==='feedback')).patterns.map(p=>p.id),['fit-pattern','mixed-pattern']);
 assert.deepEqual(state,before);
});

test('stale, resolved or closed need evidence cannot support a potential-customer summary',()=>{
 const purpose=purposes.find(p=>p.id==='opportunities');
 for(const update of [{classificationCurrent:false},{discussionClosed:true},{qualification:{relevant:true,directFit:true,category:'question',resolved:'yes'}}]){
  const state=fixture();Object.assign(state.pipeline.products.p.conversations[0],update);
  assert.equal(patternsForPurpose(state,'p',purpose).patterns.length,0);
 }
});

test('retained evidence and review records share canonical source identity for mention summaries',()=>{
 const state=fixture();
 state.items=[{productId:'p',url:'https://www.reddit.com/r/example/comments/fit/?ref=preview',kind:'mention',status:'saved',note:'Shared note',draft:'Shared draft'}];
 assert.deepEqual(patternsForPurpose(state,'p',purposes.find(p=>p.id==='mentions')).patterns.map(p=>p.id),['fit-pattern']);
});
