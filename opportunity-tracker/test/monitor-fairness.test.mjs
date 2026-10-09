import test from 'node:test';
import assert from 'node:assert/strict';
import {orderMonitorProducts,createTrackerApp} from '../server.mjs';
import {beginCollection,beginBackfill,claimCollection,finishCollection,collectionSettings} from '../collection.mjs';
import {v2Business,plan} from './pipeline.fixture.mjs';
import {validateSearchPlan} from '../search-plan.mjs';

const now=Date.parse('2026-10-09T12:00:00Z'),settings=collectionSettings({TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'});
function fixture(){
  const data={products:['a','b'].map(id=>({...v2Business(),id,monitoring:true,listeningVersion:'v2'})),items:[],searches:{},subscription:{planId:'growth',status:'manual'}};
  for(const product of data.products){product.searchPlanV2={...validateSearchPlan(plan(),product),reviewed:true};beginCollection(data,product.id,'scheduled',now,settings);beginBackfill(data,product.id,now);}
  return data;
}
test('least-recent-served monitor order lets both products claim despite fast requests and the shared 15-second gate',()=>{
  const data=fixture(),visits=[],claims=[];
  for(let tick=0;tick<4;tick++){
    const order=orderMonitorProducts(data,data.products.map(product=>product.id));visits.push(order);
    for(const [index,id] of order.entries()){
      const at=now+tick*60000+index*1000,request=claimCollection(data,settings,id,at);
      if(!request)continue;
      claims.push([id,request.mode]);finishCollection(data,request.token,{credits:1,result:{rows:[],cursor:null}},at+10);
    }
  }
  assert.deepEqual(visits,[['a','b'],['b','a'],['a','b'],['b','a']]);
  assert.deepEqual(claims,[['a','regular'],['b','regular'],['a','backfill'],['b','backfill']]);
  assert.equal(data.collection.daily[Object.keys(data.collection.daily)[0]].calls,4);
});
test('authenticated private monitor endpoint returns least-recent-served product first without changing its bearer contract',async t=>{
  const data=fixture(),request=claimCollection(data,settings,'a',now);finishCollection(data,request.token,{credits:1,result:{rows:[],cursor:null}},now+1);
  const tracker=createTrackerApp({store:{snapshot:async()=>structuredClone(data)},qualificationEnv:{TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'},monitorToken:'fixture-monitor-token-at-least-32-characters'});
  const server=tracker.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const url=`http://127.0.0.1:${server.address().port}/api/monitor`;
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:{Authorization:'Bearer fixture-monitor-token-at-least-32-characters'}});assert.equal(response.status,200);assert.deepEqual((await response.json()).ids,['b','a']);
});
