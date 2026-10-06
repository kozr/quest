import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store.mjs';
import {analysisConfiguration} from '../analysis.mjs';
import {qualificationSettings,budgetDay,stageQualifications,claimQualification,qualificationBackup} from '../qualification.mjs';
const env={TRACKER_OPENAI_API_KEY:'fixture-only',TRACKER_AI_ENABLED:'true',TRACKER_AI_MODE:'test',TRACKER_AI_DAILY_BUDGET_USD:'2'};
const settings=qualificationSettings(env);
const product={name:'Calendar',url:'https://calendar.dev/',description:'Renewal reminders',capabilities:['Send renewal reminders'],keywords:['renewals'],needs:['Remember renewals'],communities:['productivity'],monitoring:false};
async function store(t){const path=await mkdtemp(join(tmpdir(),'analysis-budget-'));t.after(()=>rm(path,{recursive:true,force:true}));const store=new Store(path);return {store,product:store.saveProduct(product)};}
test('analysis uses the existing Luna credential and fails closed on disabled or invalid budget settings',()=>{
 assert.deepEqual(analysisConfiguration(env),{model:'gpt-6-luna',apiKey:'fixture-only',available:true});
 for(const override of [{TRACKER_AI_ENABLED:'false'},{TRACKER_AI_DAILY_BUDGET_USD:'3'},{TRACKER_AI_MODE:'bad'},{TRACKER_OPENAI_API_KEY:''}])assert.equal(analysisConfiguration({...env,...override}).available,false);
 assert.equal(analysisConfiguration({OPENAI_API_KEY:'unbudgeted',OPPORTUNITY_ANALYSIS_MODEL:'gpt-6-luna'}).available,false);
});
test('analysis shares qualification spending, Pacific dispatch days, call counts and conservative reservations',async t=>{
 const {store:s,product:p}=await store(t),now=Date.parse('2026-10-06T01:00:00Z'),day=budgetDay(now);
 const lease=s.claimAnalysis(p.id,null,now,settings);assert.equal(day,'2026-10-05');assert.equal(lease.budgetDay,day);
 let budget=s.snapshot().aiBudget;assert.equal(budget.dailyUsage[day].reservedMicroUsd,1100000);assert.equal(budget.dailyUsage[day].calls,1);
 const result=s.finishAnalysis(lease,{findings:[],landscape:[],people:[],coverage:'Fixture',costMicroUsd:30000},now+1000);
 assert.ok(result.generatedAt);budget=s.snapshot().aiBudget;assert.equal(budget.dailyUsage[day].reservedMicroUsd,0);assert.equal(budget.dailyUsage[day].spentMicroUsd,30000);
 const next=s.snapshot();next.aiBudget.dailyUsage[day].spentMicroUsd=1999900;s.commit(next);
 assert.throws(()=>s.claimAnalysis(p.id,null,now+2000,settings),e=>e.status===429);
 const snapshot=s.snapshot();stageQualifications(snapshot,p,[{url:'https://www.reddit.com/r/productivity/comments/abc123/',source:'Reddit',type:'post',title:'Can I set renewal reminders?',snippet:'I need a reminder before renewal.',publishedAt:new Date(now).toISOString()}],new Date(now).toISOString(),'manual');
 assert.equal(claimQualification(snapshot,settings,now,p.id),null,'Qualification cannot spend the allowance already consumed by analysis');
});
test('failed, expired and deleted analysis cannot refund reservations, and backups cannot reset shared spending',async t=>{
 const {store:s,product:p}=await store(t),now=Date.now(),day=budgetDay(now);
 let lease=s.claimAnalysis(p.id,null,now,settings);s.releaseAnalysis(lease.token);assert.equal(s.snapshot().aiBudget.dailyUsage[day].spentMicroUsd,1100000);
 assert.throws(()=>s.claimAnalysis(p.id,null,now+1000,settings),e=>e.status===429);
 const tomorrow=now+86400000,day2=budgetDay(tomorrow);lease=s.claimAnalysis(p.id,null,tomorrow,settings);
 s.deleteProduct(p.id);let b=s.snapshot().aiBudget.dailyUsage[day2];assert.equal(b.spentMicroUsd,1100000);assert.equal(b.reservedMicroUsd,0);
 const backup={version:1,products:[],items:[],searches:{},...qualificationBackup(s.snapshot())};s.importData({...backup,aiBudget:{spentMicroUsd:0,reservedMicroUsd:0,calls:0,daily:{},dailyUsage:{}}});assert.equal(s.snapshot().aiBudget.dailyUsage[day2].spentMicroUsd,1100000);
 const q=s.saveProduct(product),day3=budgetDay(now+2*86400000);s.claimAnalysis(q.id,null,now+2*86400000,settings);
 // Qualification settlement also retires expired manual analysis, so a lost
 // HTTP connection cannot leave the shared reservation refundable or stuck.
 s.claimQualification(settings,now+2*86400000+181000,q.id);b=s.snapshot().aiBudget.dailyUsage[day3];assert.equal(b.spentMicroUsd,1100000);assert.equal(b.reservedMicroUsd,0);
});
