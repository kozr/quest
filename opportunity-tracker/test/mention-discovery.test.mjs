import test from 'node:test';
import assert from 'node:assert/strict';
import {cafe,breakdown} from './business-profile.fixture.mjs';
import {validateSearchPlan} from '../search-plan.mjs';
import {discoveryTaskURL,discoveryTasks,googleQueries,originalTask,parseDiscoveryPage,applyDiscoveryPage,verifiedPlace,reviewListingEvidence,canonicalReviewURL} from '../mention-discovery.mjs';
import {beginCollection,beginBackfill,claimCollection,finishCollection,collectionSettings,extendBackfillCoverage,createCollectionProvider} from '../collection.mjs';
import {activatePilotBudget,pilotBudgetState,ensurePilotCollectionAccounting,pilotBudgetBlock} from '../pilot-budget.mjs';
import {captureEvidence,evidenceFor,validateEvidence,canonicalSourceUrl} from '../conversation-evidence.mjs';
import {materializeCollectedConversations} from '../conversation-pages.mjs';
import {entityMentionEvidence} from '../entity-mention.mjs';
import {ApifyRedditCommentsAdapter} from '../reddit/apify-comments.mjs';
const now=Date.parse('2026-10-09T20:00:00Z'),day=86400000;
const settings=collectionSettings({TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture',APIFY_TOKEN:'fixture'});
function workspace(){
  const product={...cafe,id:'p',monitoring:true};product.profileVersion='v2';product.businessProfileV2={...breakdown(product),reviewed:true};
  product.searchPlanV2={...validateSearchPlan({themes:[{id:'brand',title:'Brand',need:'Find references to the cafe',purposes:['mention'],offeringIds:['o1'],keywords:[],longTail:[],queries:[{id:'brand',loop:'keyword',platform:'reddit',community:null,query:'"Fixture Cafe"'}]}],limitations:[]},product),reviewed:true};product.listeningVersion='v2';
  return {products:[product],items:[],searches:{},subscription:{planId:'growth',status:'manual'}};
}
const rawPlace={title:'Fixture Cafe',data_id:'0x5486730032605b3d:0xbda2f874fcb9d30',website:'https://fixture-cafe.dev/',address:'280 Nelson Street, Vancouver'};
const place=verifiedPlace(workspace().products[0],rawPlace,now);
const reviews=(text='Lovely desserts!',extra={})=>({location:{title:'Fixture Cafe',address:place.address},pagination:{next:null},reviews:[{text,iso_date:'2026-02-19T12:00:00Z',rating:5,user:{name:'Reviewer',contributor_id:'123456789'},...extra}]});
const reviewTask={kind:'maps_reviews',place,page:1,cutoff:now-365*day};

test('brand discovery includes broad and site searches without requiring city words',()=>{
  const queries=googleQueries(workspace().products[0]);assert(queries.some(q=>q.query==='"Fixture Cafe"'));assert(queries.some(q=>q.query.includes('site:reddit.com')));assert(queries.some(q=>q.query.includes('site:instagram.com')));assert(queries.every(q=>!q.query.includes('Vancouver')));
  assert.equal(discoveryTasks(workspace().products[0],{settings:{extendedDiscoveryEnabled:false}}).length,0);
});
test('Google snippets are stored as discoveries and never become conversation text',()=>{
  const data=workspace();beginCollection(data,'p','scheduled',now,settings);const cycle=data.collection.cycles.p;
  const task={kind:'google_search',query:'"Fixture Cafe"',queryId:'brand',page:1,maxPages:5,cutoff:now-365*day,until:now};
  const page=parseDiscoveryPage(task,{organic_results:[{link:'https://www.reddit.com/r/askvan/comments/1qccnl4/birthday_cake/',title:'Birthday cake',snippet:'Fixture Cafe recommendation'}]},new Date(now).toISOString());
  assert.deepEqual(page.rows,[]);applyDiscoveryPage(data,cycle,task,page,now);
  assert(cycle.queue.some(t=>t.kind==='reddit_post'&&t.postId==='1qccnl4'));assert.equal(data.items.length,0);
  assert.equal(Object.values(data.collection.discoveries.p)[0].status,'awaiting_original');
});
test('a Google-discovered Reddit thread always fetches its comments even without the brand in the post',()=>{
  const data=workspace();beginCollection(data,'p','scheduled',now,settings);const cycle=data.collection.cycles.p;
  const parent={source:'Reddit',postId:'t3_1qqxdio',sourceId:'t3_1qqxdio',title:'Pastry itinerary',snippet:'Where should I go?',url:'https://www.reddit.com/r/askvan/comments/1qqxdio/',type:'post'};
  applyDiscoveryPage(data,cycle,{kind:'reddit_post',postId:'1qqxdio',cutoff:now-365*day,until:now,historical:true,discoverySource:'google'}, {rows:[parent]},now);
  assert(cycle.queue.some(t=>t.kind==='comments'&&t.post.postId===parent.postId&&t.discoveredThread));
});
test('discovered URLs route to original platform adapters and reject unsafe hosts',()=>{
  assert.equal(originalTask({url:'https://www.instagram.com/reel/DTzgE8yjuBS/'}).kind,'instagram_post');
  assert.equal(originalTask({url:'https://www.smoochfood.com/2026/08/food.html'}).kind,'web_page');
  assert.equal(originalTask({url:'https://127.0.0.1/private'}),null);
  assert.equal(originalTask({url:'https://www.instagram.com/wren.cafe/'}),null);
});
test('Maps identity requires the exact official domain and the business name',()=>{
  const product=workspace().products[0];assert(place);assert.equal(verifiedPlace(product,{...rawPlace,website:'https://another-cafe.dev/'},now),null);assert.equal(verifiedPlace(product,{...rawPlace,title:'Another Cafe'},now),null);
});
test('a verified written review counts without repeating the business name; ratings and owner responses do not',()=>{
  const data=workspace(),page=parseDiscoveryPage(reviewTask,reviews(),new Date(now).toISOString());assert.equal(page.rows.length,1);
  assert(reviewListingEvidence(data.products[0],page.rows[0]));assert.equal(entityMentionEvidence(data.products[0],page.rows[0]).basis,'business_review');
  assert.equal(parseDiscoveryPage(reviewTask,reviews('',{response_from_owner:{text:'Fixture Cafe thanks you'}}),new Date(now).toISOString()).rows.length,0);
  assert.throws(()=>parseDiscoveryPage(reviewTask,{...reviews(),location:{title:'Another Cafe',address:place.address}},new Date(now).toISOString()),/mismatch/);
});
test('review identities survive edits, preserve human decisions and stay distinct between reviewers',()=>{
  const data=workspace(),product=data.products[0],first=parseDiscoveryPage(reviewTask,reviews(),new Date(now).toISOString()).rows;
  captureEvidence(data,product,first,new Date(now).toISOString());materializeCollectedConversations(data,product,first,now);Object.assign(data.items[0],{status:'saved',note:'Keep this',draft:'Thanks'});
  const changed=parseDiscoveryPage(reviewTask,reviews('Edited review'),new Date(now+1000).toISOString()).rows;
  assert.equal(first[0].sourceId,changed[0].sourceId);captureEvidence(data,product,changed,new Date(now+1000).toISOString());materializeCollectedConversations(data,product,changed,now+1000);
  assert.equal(data.items.length,1);assert.equal(data.items[0].note,'Keep this');assert.equal(data.items[0].draft,'Thanks');assert.equal(data.items[0].snippet,'Edited review');
  const second=parseDiscoveryPage(reviewTask,reviews('Another review',{user:{name:'Other',contributor_id:'987654321'}}),new Date(now).toISOString()).rows;
  captureEvidence(data,product,second,new Date(now).toISOString());assert.equal(evidenceFor(data,product).length,2);assert(canonicalReviewURL(second[0].url));
  const restored=validateEvidence(data.conversationEvidence,data.products,{durable:true});assert.equal(restored.p[0].businessReview,undefined);
});
test('web originals retain article text, author, publication date and content-identifying query parameters',()=>{
  const page=parseDiscoveryPage({kind:'web_page',originalURL:'https://blog.dev/post?id=2&utm_source=google'}, {success:true,status_code:200,url:'https://blog.dev/post?id=2&utm_source=google',content:'<html><head><title>Cafe review</title><meta name="author" content="Writer"><meta property="article:published_time" content="2026-08-27"></head><body><nav>Menu</nav><article>Fixture Cafe in Vancouver serves cheesecake.</article></body></html>'},new Date(now).toISOString());
  assert.equal(page.rows[0].snippet,'Fixture Cafe in Vancouver serves cheesecake.');assert.equal(page.rows[0].author,'Writer');assert.equal(page.rows[0].publishedAt,'2026-08-27T00:00:00.000Z');assert.equal(canonicalSourceUrl(page.rows[0].url),'https://blog.dev/post?id=2');
  const data=workspace();captureEvidence(data,data.products[0],page.rows,new Date(now).toISOString());assert.equal(evidenceFor(data,data.products[0]).length,1);
});
test('old historical jobs gain new branches once without resetting IDs, receipts, usage or the year window',()=>{
  const data=workspace();beginBackfill(data,'p',now);const job=data.collection.backfills.p;delete job.coverageVersion;job.requests=60;job.rows=933;job.status='complete';const original={id:job.id,from:job.from,to:job.to,queue:structuredClone(job.queue)};data.collectedUsage={sentinel:'unchanged'};
  const n=extendBackfillCoverage(data,data.products[0],settings);assert(n>=4);assert.equal(job.id,original.id);assert.equal(job.from,original.from);assert.equal(job.to,original.to);assert.equal(job.requests,60);assert.equal(job.rows,933);assert.deepEqual(data.collectedUsage,{sentinel:'unchanged'});assert.equal(job.status,'running');assert(job.queue.some(t=>t.kind==='reddit_comment_search'));assert(job.queue.some(t=>t.kind==='google_search'));assert.equal(extendBackfillCoverage(data,data.products[0],settings),0);
});
test('historical Apify requests retain historical quota attribution and their exact time window',()=>{
  const data=workspace();beginBackfill(data,'p',now);extendBackfillCoverage(data,data.products[0],settings);activatePilotBudget(data,{id:'pilot',now});const job=data.collection.backfills.p;job.queue=job.queue.filter(t=>t.kind==='reddit_comment_search');
  const claim=claimCollection(data,settings,'p',now);assert.equal(claim.mode,'backfill');assert.equal(claim.provider,'reddit-apify');assert.equal(data.collectedUsage.claims[claim.token].historical,true);assert.equal(claim.task.until,now);assert.equal(claim.task.cutoff,now-365*day);
});
test('a daily Apify pause preserves its task while another provider continues',()=>{
  const data=workspace();beginCollection(data,'p','scheduled',now,settings);activatePilotBudget(data,{id:'pilot',now});const cycle=data.collection.cycles.p;assert.equal(cycle.queue[0].kind,'reddit_comment_search');
  const remaining=cycle.queue.filter(t=>t.kind==='reddit_comment_search').length;
  const claim=claimCollection(data,{...settings,commentDailyLimitMicroUsd:0},'p',now);assert(claim?.token);assert.notEqual(claim.task.kind,'reddit_comment_search');assert.equal(cycle.queue.filter(t=>t.kind==='reddit_comment_search').length,remaining);
});
test('Apify consumes the existing total collection cap across midnight, including uncertain outcomes',()=>{
  const data=workspace();activatePilotBudget(data,{id:'pilot',now,scrapeCredits:667});beginCollection(data,'p','scheduled',now,settings);const claim=claimCollection(data,settings,'p',now);assert.equal(claim.reserve,100000);assert.equal(pilotBudgetState(data).scrapeCredits.used,667);finishCollection(data,claim.token,{error:'uncertain_dispatch'},now+1);
  assert.equal(pilotBudgetState(data).scrapeCredits.used,667);assert.equal(pilotBudgetBlock(data,'apifyMicroUsd',51).code,'pilot_scraper_budget');assert.equal(pilotBudgetBlock(data,'scrapeCredits',1).code,'pilot_scraper_budget');assert.equal(pilotBudgetState(data).scrapeCredits.limit,667);
});
test('upgrading old pilot accounting preserves its trusted baseline and includes only new Apify spend',()=>{
  const data=workspace();data.collection={daily:{old:{spentCredits:20,reservedCredits:0}},apifyDaily:{old:{spentMicroUsd:100,reservedMicroUsd:0}}};activatePilotBudget(data,{id:'pilot',now});delete data.pilotBudget.collectionAccounting;const baseline=structuredClone(data.pilotBudget.baseline);ensurePilotCollectionAccounting(data,now);data.collection.apifyDaily.new={spentMicroUsd:150,reservedMicroUsd:0};assert.deepEqual(data.pilotBudget.baseline,baseline);assert.equal(pilotBudgetState(data).scrapeCredits.used,1);ensurePilotCollectionAccounting(data,now+day);assert.equal(pilotBudgetState(data).scrapeCredits.used,1);
});
test('direct comment actor receives both historical boundaries and never retries a lost paid start',async()=>{
  const calls=[];const adapter=new ApifyRedditCommentsAdapter({token:'fixture',now:()=>now,fetchImpl:async(url,options)=>{calls.push({url,body:options.body&&JSON.parse(options.body)});return url.includes('/runs?')?Response.json({data:{id:'run',status:'SUCCEEDED',defaultDatasetId:'dataset'}}):Response.json([]);}});
  await adapter.search({query:'"Fixture Cafe"',cutoff:now-365*day,until:now});assert.equal(calls[0].body.commentedAfter,new Date(now-365*day).toISOString());assert.equal(calls[0].body.commentedBefore,new Date(now).toISOString());assert.equal(calls.filter(c=>c.url.includes('/runs?')).length,1);
});
test('App Store reviews bind to an exact app ID and keep individual review identity',()=>{
  const task={kind:'app_store_reviews',appId:'6742131820',country:'us',page:1,cutoff:now-365*day};
  const page=parseDiscoveryPage(task,{app_id:'6742131820',country:'us',reviews:[{review_id:'12345',user_name:'Collector',title:'Useful',content:'Please add this collection.',rating:4,updated_at:'2026-03-01'}]},new Date(now).toISOString());
  assert(reviewListingEvidence({url:'https://apps.apple.com/us/app/id6742131820'},page.rows[0]));assert.equal(reviewListingEvidence({url:'https://apps.apple.com/us/app/id6742131821'},page.rows[0]),null);assert(canonicalReviewURL(page.rows[0].url));
});

test('public pricing uses explicit endpoint overrides and the documented category default',async()=>{
 const {createCollectionProvider}=await import('../collection.mjs');
 const provider=createCollectionProvider({env:{},fetchImpl:async()=>Response.json({scraper_costs:[{scraper_name:'instagram',base_cost:5,per_item_cost:0,endpoints:[]},{scraper_name:'google',base_cost:1,per_item_cost:0,endpoints:[{endpoint_pattern:'search',base_cost:7,per_item_cost:0}]}]})});
 const costs=await provider.pricing();assert.equal(costs.instagram_post,5);assert.equal(costs.google_search,7);assert.equal(costs.maps_reviews,1);assert.equal(costs.reddit_post,undefined);
});

test('historical Google discovery retains older thread pages and undated listings while source dates remain bounded',()=>{
 const task={kind:'google_search',query:'"Fixture Cafe"',page:1,historical:true,cutoff:now-365*day,until:now};
 const {searchParams}=new URL(discoveryTaskURL(task));assert.equal(searchParams.has('tbs'),false);
 assert.equal(new URL(discoveryTaskURL({...task,historical:false})).searchParams.get('tbs'),'qdr:w');
});
test('the unrestricted upgrade reuses queued Google work and adds only an already-searched dated query once',()=>{
 const data=workspace();beginBackfill(data,'p',now);extendBackfillCoverage(data,data.products[0],settings);const job=data.collection.backfills.p;const google=job.queue.filter(t=>t.kind==='google_search');assert(google.length>1);
 for(const task of google){const branch=job.branches.find(b=>b.id===task.branch);branch.id='old_'+branch.id;task.branch=branch.id;}
 const completed=google[0];job.queue=job.queue.filter(t=>t!==completed);job.branches.find(b=>b.id===completed.branch).status='searched';job.coverageVersion=2;
 const id=job.id,requests=job.requests;assert.equal(extendBackfillCoverage(data,data.products[0],settings),1);assert.equal(job.id,id);assert.equal(job.requests,requests);assert.equal(job.queue.filter(t=>t.kind==='google_search'&&t.query===completed.query).length,1);assert.equal(extendBackfillCoverage(data,data.products[0],settings),0);
});
