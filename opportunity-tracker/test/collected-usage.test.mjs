import test from 'node:test';
import assert from 'node:assert/strict';
import {collectedQuotaBlock,reserveCollectedQuota,settleCollectedQuota,collectedUsageState} from '../collected-usage.mjs';
const now=Date.parse('2026-10-31T23:59:00Z');
const data=()=>({subscription:{planId:'growth',status:'manual'},products:[{id:'a'},{id:'b'}],items:[]});
const row=(id,productId='a')=>({productId,url:`https://www.reddit.com/r/test/comments/${id}/`,source:'Reddit post',type:'post',foundAt:new Date(now).toISOString()});
const request=(token,productId='a',mode='regular')=>({token,productId,mode});
test('new source is counted once across products and repeated queries',()=>{
 const d=data(),r=row('abc'),a=request('one');reserveCollectedQuota(d,a,now);d.items.push(r);settleCollectedQuota(d,a,{result:{rows:[r,r]}});
 const b=request('two','b');reserveCollectedQuota(d,b,now);d.items.push({...r,productId:'b'});settleCollectedQuota(d,b,{result:{rows:[r]}});
 assert.equal(collectedUsageState(d,now).monthly.used,1);assert.equal(collectedUsageState(d,now).monthly.reserved,0);
});
test('full-page holds enforce capacity before dispatch and retain unknown outcomes',()=>{
 const d=data();for(let i=0;i<100;i++)reserveCollectedQuota(d,request(String(i)),now);
 assert.equal(collectedQuotaBlock(d,'b',false,100,now).code,'monthly_collection_quota');
 assert.throws(()=>reserveCollectedQuota(d,request('extra'),now),e=>e.status===429);
 settleCollectedQuota(d,request('0'),{error:'uncertain_dispatch'});
 assert.equal(collectedUsageState(d,now).monthly.reserved,10000);
 settleCollectedQuota(d,request('1'),{error:'unavailable',credits:0});
 assert.equal(collectedUsageState(d,now).monthly.reserved,9900);
});
test('late settlement charges its originating month and recurring discovery is distinct from history',()=>{
 const d=data(),r=row('abc'),a=request('one');reserveCollectedQuota(d,a,now);d.items.push(r);settleCollectedQuota(d,a,{result:{rows:[r]}});
 const later=now+120000;assert.equal(collectedUsageState(d,later).monthly.used,0);
 const b=request('history','b','backfill');reserveCollectedQuota(d,b,later);d.items.push({...r,productId:'b',historical:true});settleCollectedQuota(d,b,{result:{rows:[r]}});
 assert.equal(collectedUsageState(d,later).historical.b.used,1);assert.equal(collectedUsageState(d,later).monthly.used,0);
});
test('existing archive buckets seed quota even without a row productId',()=>{
 const d=data();d.conversationEvidence={a:[{...row('aaa'),productId:undefined,historical:true},{...row('bbb'),productId:undefined}]};
 const state=collectedUsageState(d,now);assert.equal(state.monthly.used,1);assert.equal(state.historical.a.used,1);assert.equal(state.monthly.limit,10000);
 assert.equal(d.collectedUsage,undefined,'public projection does not mutate storage');
});
test('filtered and unretained results do not consume conversation allowance',()=>{
 const d=data(),a=request('one');reserveCollectedQuota(d,a,now);settleCollectedQuota(d,a,{result:{rows:[row('filtered')]}});
 assert.equal(collectedUsageState(d,now).monthly.used,0);assert.equal(collectedUsageState(d,now).monthly.reserved,0);
});
