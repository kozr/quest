import test from 'node:test';
import assert from 'node:assert/strict';
import {PLAN_CATALOG,planFor,subscriptionState,ensureSubscription,setSubscriptionPlan,capacityUsage,assertWorkspaceCapacity,assertFeature,preserveServerOwnedState,SERVER_OWNED_FIELDS} from '../plans.mjs';

const now=Date.parse('2026-10-09T12:00:00Z');
const product=(id,keywords=1,themes=0)=>({id,keywords:Array.from({length:keywords},(_,i)=>`term${i}`),...(themes?{searchPlanV2:{themes:Array.from({length:themes},(_,i)=>({id:`t${i}`,queries:[{query:`k${i}`}],longTail:['customer language']}))}}:{})});
test('catalog contains the exact reviewed prices, capacities and independent timings',()=>{
  assert.deepEqual(Object.values(PLAN_CATALOG).map(p=>[p.price.amount,p.limits.products,p.limits.keywordSearches,p.limits.longTailThemes,p.intervals.keyword/60000,p.intervals.long_tail/60000,p.intervals.analysis/60000,p.limits.monthlyAiAnalyses,p.limits.seats]),[
    [39,1,10,3,60,1440,1440,1000,1],[99,3,30,10,15,360,60,5000,3],[249,10,100,30,5,60,15,20000,10],
  ]);
  for(const p of Object.values(PLAN_CATALOG)){assert.equal(p.history.days,365);assert.equal(p.price.currency,'USD');for(const feature of ['historicalSearch','basicFilters','manualReview','allPurposes','digest'])assert.equal(p.features[feature],true);}
  assert.throws(()=>{PLAN_CATALOG.starter.limits.products=99;},TypeError);
});
test('unmigrated workspaces resolve to Starter and migration writes explicit manual status',()=>{
  const data={products:[product('p')]};assert.equal(planFor(data).id,'starter');assert.equal(subscriptionState(data,now).status,'manual');
  const first=ensureSubscription(data,{now});assert.equal(first.status,'manual');assert.equal(first.planId,'starter');
  assert.deepEqual(ensureSubscription(data,{now:now+100,planId:'team'}),first);
  assert.throws(()=>planFor({subscription:{planId:'__proto__'}}),error=>error.status===400&&error.code==='invalid_plan');
});
test('trials are explicit and stop at their exact expiry without changing saved data',()=>{
  const data={products:[]};ensureSubscription(data,{now,status:'trial',trialEndsAt:new Date(now+1000).toISOString()});
  assert.equal(subscriptionState(data,now+999).active,true);assert.equal(subscriptionState(data,now+1000).effectiveStatus,'expired');
  assert.throws(()=>assertFeature(data,'digest',{now:now+1000}),error=>error.status===402);
  assert.throws(()=>ensureSubscription({}, {now,status:'trial'}),error=>error.code==='invalid_subscription');
  assert.throws(()=>ensureSubscription({}, {now,status:'trial',trialEndsAt:'invalid'}),error=>error.code==='invalid_subscription'&&error.status===400);
});
test('Stripe active access requires a verified future paid-through time',()=>{
  const subscription={planId:'growth',status:'active',managedBy:'stripe',paidUntil:new Date(now+1000).toISOString(),cancelAtPeriodEnd:true};
  assert.equal(subscriptionState({subscription},now).active,true);assert.equal(subscriptionState({subscription},now+1000).effectiveStatus,'expired');
  assert.equal(subscriptionState({subscription:{...subscription,paidUntil:null}},now).active,false);
  assert.equal(subscriptionState({subscription:{...subscription,status:'past_due'}},now).active,false);
});
test('query capacities aggregate products and distinguish executable discovery from keywords',()=>{
  const data={products:[{id:'a',searchPlanV2:{themes:[{queries:[{query:'a',loop:'keyword'},{query:'b',loop:'long_tail'},{query:'c',loop:'long_tail'}],longTail:['description']},{queries:[{query:'d'}],longTail:['legacy theme']}]}},product('b',2)]};
  assert.deepEqual(capacityUsage(data),{products:2,keywordSearches:4,longTailThemes:2,seats:0,members:0,pendingInvites:0});
  assert.throws(()=>assertWorkspaceCapacity(data),error=>error.resource==='products'&&error.limit===1&&error.used===2&&error.requiredPlan==='growth');
});
test('archive policy frees monitoring capacity but preserves data; restoring must pass the cap',()=>{
  const archived={...product('b',99),archived:true,note:'Keep history'};const data={products:[product('a'),archived]};
  assert.equal(assertWorkspaceCapacity(data).products,1);assert.equal(data.products[1].note,'Keep history');
  assert.throws(()=>assertWorkspaceCapacity(data,{products:data.products.map(p=>({...p,archived:false}))}),error=>error.resource==='products');
});
test('keyword and legacy theme caps are enforced independently',()=>{
  assert.throws(()=>assertWorkspaceCapacity({products:[product('a',11)]}),error=>error.resource==='keywordSearches'&&error.used===11);
  assert.throws(()=>assertWorkspaceCapacity({products:[product('a',1,4)]}),error=>error.resource==='longTailThemes'&&error.used===4);
  const explicitKeyword={products:[{id:'a',searchPlanV2:{themes:[{queries:[{loop:'keyword'}],longTail:['illustration only']} ]}}]};
  assert.equal(capacityUsage(explicitKeyword).longTailThemes,0);
});
test('seats include active members and valid pending invitations only',()=>{
  const data={subscription:{planId:'growth',status:'manual'},products:[],workspace:{members:{one:{status:'active'},old:{status:'revoked'}},invites:{one:{status:'pending',expiresAt:new Date(now+1).toISOString()},expired:{status:'pending',expiresAt:new Date(now).toISOString()},done:{status:'accepted',expiresAt:new Date(now+10000).toISOString()}}}};
  assert.equal(capacityUsage(data,{now}).seats,2);assert.equal(capacityUsage(data,{now:now+1}).seats,1);
  assert.throws(()=>assertWorkspaceCapacity(data,{now,planId:'starter'}),error=>error.resource==='seats'&&error.limit===1&&error.used===2);
});
test('downgrade rejects excess capacity atomically and never deletes products',()=>{
  const data={subscription:{planId:'growth',status:'manual'},products:[product('a'),product('b')]},before=structuredClone(data);
  assert.throws(()=>setSubscriptionPlan(data,'starter',{now}),error=>error.code==='plan_capacity_exceeded');assert.deepEqual(data,before);
  data.products[1].archived=true;setSubscriptionPlan(data,'starter',{now});assert.equal(data.subscription.planId,'starter');assert.equal(data.products.length,2);
});
test('feature gates identify the first qualifying plan',()=>{
  assert.throws(()=>assertFeature({},'assignments',{now}),error=>error.requiredPlan==='growth'&&error.code==='feature_unavailable');
  assert.throws(()=>assertFeature({subscription:{planId:'growth'}},'clientSeparation',{now}),error=>error.requiredPlan==='team');
  assert.equal(assertFeature({subscription:{planId:'team'}},'integrations',{now}),true);
  assert.throws(()=>assertFeature({},'imaginary',{now}),error=>error.status===400);
});
test('restore cannot grant a plan, add seats, erase cost holds or reset schedules',()=>{
  const current={products:[product('a')],subscription:{planId:'starter',status:'manual'},workspace:{members:{one:{status:'active'}}},usage:{version:1,periods:{proof:1}},loopSchedules:{p:{keyword:{lastStartedAt:'saved'}}},aiBudget:{spentMicroUsd:20},collection:{active:{token:'hold'}}};
  const incoming={products:[product('a')],subscription:{planId:'team'},workspace:{members:{}},usage:{},loopSchedules:{},aiBudget:{},collection:{}};
  const restored=preserveServerOwnedState(current,incoming,{now});
  for(const field of SERVER_OWNED_FIELDS.filter(field=>field in current))assert.deepEqual(restored[field],current[field]);
  assert.throws(()=>preserveServerOwnedState(current,{...incoming,products:[product('a'),product('b')]},{now}),error=>error.resource==='products');
  assert.equal('usage' in preserveServerOwnedState({products:[]},{products:[],usage:{fake:true}}),false);
});
test('serial store mutations prevent two requests from exceeding capacity',()=>{
  let data={products:[]};
  function insert(id){const next=structuredClone(data);next.products.push(product(id));assertWorkspaceCapacity(next,{now});data=next;}
  insert('one');assert.throws(()=>insert('two'),error=>error.resource==='products');assert.deepEqual(data.products.map(p=>p.id),['one']);
});
