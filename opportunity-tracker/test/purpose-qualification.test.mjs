import test from 'node:test';
import assert from 'node:assert/strict';
import {captureEvidence,pendingEvidence,qualificationInputHash,qualificationEvidence,saveConversationReview} from '../conversation-evidence.mjs';
import {conversationCurrentState} from '../conversation-feed.mjs';
import {conversationSignals,namedReference,commentThreadPriority} from '../conversation-purpose.mjs';
import {validateV2Qualification,qualificationInput} from '../listening-qualification.mjs';
import {searchPlanInput,validateSearchPlan,plannedQueries,compileRedditQuery} from '../search-plan.mjs';
import {applyBackfillPage} from '../backfill.mjs';
import {beginCollection,claimCollection,finishCollection,collectionSettings} from '../collection.mjs';
import {matchesConversation} from '../ui/src/feed.mjs';
import {hash} from '../pipeline-contract.mjs';
import {v2Business,plan} from './pipeline.fixture.mjs';

const now=Date.parse('2026-10-08T12:00:00Z'),at=new Date(now).toISOString();
function fixture(){
 const p={...v2Business(),id:'cafe',listeningVersion:'v2'};p.searchPlanV2=validateSearchPlan({...plan(),reviewed:true},p);
 return {p,data:{products:[p],items:[],searches:{}}};
}
const source=(text,extra={})=>({source:'Reddit comment',type:'comment',sourceId:'t1_reply1',postId:'t3_thread1',parentId:'t3_thread1',url:'https://www.reddit.com/r/vancouver/comments/thread1/_/reply1/',title:text.slice(0,180),snippet:text,author:'fixture_customer',publishedAt:at,commentCount:0,...extra});
function decision(e,overrides={}){return {evidenceId:e.id,relevant:true,directFit:false,category:'complaint',need:'',quote:e.text,offeringIds:[],reason:'Concrete experience relevant to a documented offering.',resolved:'unknown',purposes:[],...overrides};}
const signal=(purpose,quote,extra={})=>({purpose,quote,reason:'A concrete source passage connected to the cafe offering.',offeringIds:['o1'],reference:'',...extra});
function classify(p,e,q){return validateV2Qualification({results:[q]},p,{business:searchPlanInput(p).business,evidence:[e]}).results[0];}

test('a feedback reply keeps parent context and appears independently without losing shared review state',()=>{
 const {p,data}=fixture();const row=source('The lunch pickup took too long.',{context:'Fixture Cafe customer experiences'});
 captureEvidence(data,p,[row],at);const e=data.conversationEvidence[p.id][0];
 const q=classify(p,e,decision(e,{purposes:[signal('feedback',e.text)]}));
 data.items=[{id:'saved-reply',productId:p.id,url:row.url,status:'saved',note:'Keep this note',draft:'Preserve existing user content'}];
 saveConversationReview(data,p,e,q,at,'fixture');
 const item={...data.items[0],...conversationCurrentState(data,data.items[0])};
 assert.equal(item.context,row.context);assert.equal(item.type,'comment');assert.equal(item.id,'saved-reply');assert.equal(item.note,'Keep this note');
 assert.equal(matchesConversation(item,{relevance:'feedback'}),true);assert.equal(matchesConversation(item,{relevance:'direct'}),false);assert.equal(matchesConversation(item,{view:'saved'}),true);
 saveConversationReview(data,p,e,q,at,'fixture');assert.equal(data.items.length,1);
});

test('parent text identifies the subject but cannot supply a comment quote or customer need',()=>{
 const {p,data}=fixture();captureEvidence(data,p,[source('Thanks!',{context:'I need a sandwich for lunch in Vancouver.'})],at);
 const e=qualificationEvidence(data.conversationEvidence[p.id][0]);assert.equal(e.context,'I need a sandwich for lunch in Vancouver.');
 const q=decision(e,{directFit:true,need:'Find a sandwich',quote:e.context,offeringIds:['o1'],purposes:[signal('potential_customer',e.context)]});
 assert.throws(()=>classify(p,e,q),/exact quote/);
});

test('parent-context edits invalidate a cached decision without duplicating the comment',()=>{
 const {p,data}=fixture();const row=source('The lunch pickup took too long.',{context:'Fixture Cafe'});
 captureEvidence(data,p,[row],at);const e=data.conversationEvidence[p.id][0];saveConversationReview(data,p,e,decision(e),at,'fixture');
 captureEvidence(data,p,[{...row,context:'A different cafe'}],at);assert.equal(data.conversationEvidence[p.id].length,1);
 assert.equal(data.conversationEvidence[p.id][0].qualification,undefined);assert.equal(data.conversationReviewQueue[p.id].length,1);
});

test('generic complaints do not become feedback and feedback must connect to an offering',()=>{
 const {p,data}=fixture();captureEvidence(data,p,[source('My display shelf broke.')],at);const e=data.conversationEvidence[p.id][0];
 const q=classify(p,e,decision(e));saveConversationReview(data,p,e,q,at,'fixture');
 const item={...data.items[0],...conversationCurrentState(data,data.items[0])};assert.equal(matchesConversation(item,{relevance:'feedback'}),false);
 assert.throws(()=>classify(p,e,decision(e,{purposes:[signal('feedback',e.text,{offeringIds:[]})]})),/documented offering/);
});

test('a named alternative in a reply reaches Competitors with its own quote',()=>{
 const {p,data}=fixture();captureEvidence(data,p,[source('Other Cafe has sandwiches but pickup is slow.')],at);const e=data.conversationEvidence[p.id][0];
 const q=classify(p,e,decision(e,{purposes:[signal('competitor',e.text,{reference:'Other Cafe'})]}));saveConversationReview(data,p,e,q,at,'fixture');
 const item={...data.items[0],...conversationCurrentState(data,data.items[0])};assert.equal(matchesConversation(item,{relevance:'competitors'}),true);assert.equal(matchesConversation(item,{relevance:'direct'}),false);
 assert.throws(()=>classify(p,e,decision(e,{purposes:[signal('competitor',e.text,{reference:'Invented Cafe'})]})),/named alternative/);
});

test('a recommendation may qualify as a mention without inventing an unmet need',()=>{
 const {p,data}=fixture();captureEvidence(data,p,[source('Fixture Cafe has excellent sandwiches in Vancouver.')],at);const e=data.conversationEvidence[p.id][0];
 const q=classify(p,e,decision(e,{category:'recommendation',need:'',entityMatch:{status:'confirmed',basis:'business_context',reference:p.name,quote:e.text,identityQuote:e.text,businessQuote:'sandwiches and cheesecake in Vancouver',contextSource:'own',reason:'The named cafe matches the reviewed Vancouver offering.'},purposes:[signal('mention',e.text,{reference:p.name,offeringIds:[]})]}));saveConversationReview(data,p,e,q,at,'fixture');
 const item={...data.items[0],...conversationCurrentState(data,data.items[0])};assert.equal(matchesConversation(item,{relevance:'mentions'}),true);assert.equal(matchesConversation(item,{relevance:'direct'}),false);
});

test('accent variants match while partial names, domains and namesake businesses do not qualify automatically',()=>{
 assert.equal(namedReference('Wren Cafe in Yaletown','Wren Café'),true);
 assert.equal(namedReference('Blind Box Trackerish','Blind Box Tracker'),false);
 assert.equal(namedReference('wrencafe.ca.evil.example','wrencafe.ca'),false);
 const p={name:'Wren Café',url:'https://wrencafe.ca/',aliases:['Wren Cafe']};
 const row={title:'Wren Cafe in London',text:'I recommend this London cafe.'};
 assert.deepEqual(conversationSignals(p,row,{relevant:false,purposes:[]},{current:true}),[]);
 assert.deepEqual(conversationSignals(p,row,{relevant:true,purposes:[]},{current:false}),[]);
});

test('an explicit uncertain identity stays outside Mentions while retaining its literal name',()=>{
 const {p,data}=fixture();captureEvidence(data,p,[source('Fixture Cafe is the name. No customer experience or useful comparison here.')],at);const e=data.conversationEvidence[p.id][0];
 const q=classify(p,e,decision(e,{category:'other',entityMatch:{status:'uncertain',basis:'none',reference:'',quote:'',identityQuote:'',businessQuote:'',contextSource:'none',reason:'Only an ambiguous name is supplied.'},purposes:[]}));saveConversationReview(data,p,e,q,at,'fixture');
 const item={...data.items[0],...conversationCurrentState(data,data.items[0])};
 assert.equal(item.qualification.relevant,true);assert.deepEqual(item.conversationSignals,[]);
 assert.equal(matchesConversation(item,{relevance:'mentions'}),false);assert.equal(item.keywordMention.reference,p.name);assert.equal(matchesConversation(item,{relevance:'direct'}),false);
});

test('legacy name mentions preserve complete source URLs rather than sentence fragments',()=>{
 const p={name:'Blind Box Tracker',aliases:['BlindBoxTracker'],url:'https://play.google.com/store/apps/details?id=example.blindboxtracker'};
 const text='Android is available: [BlindBoxTracker](https://play.google.com/store/apps/details?id=example.blindboxtracker). Download here.';
 const signals=conversationSignals(p,{text},{relevant:true},{current:true});
 assert.equal(signals.length,1);assert.equal(signals[0].purpose,'mention');
 assert.equal(signals[0].quote,'https://play.google.com/store/apps/details?id=example.blindboxtracker');
});

test('resolved, closed and satisfied-user evidence cannot qualify as a potential customer',()=>{
 const {p,data}=fixture();captureEvidence(data,p,[source('Where can I pick up a sandwich in Vancouver?')],at);const e=data.conversationEvidence[p.id][0];
 const q=decision(e,{category:'question',directFit:true,need:'Find a sandwich in Vancouver',offeringIds:['o1'],purposes:[signal('potential_customer',e.text)]});
 for(const change of [{resolved:'yes'},{category:'recommendation'},{category:'promotion'}])assert.throws(()=>classify(p,e,{...q,...change}));
 assert.throws(()=>classify(p,{...e,discussionClosed:true},q),/open explicit need/);
 const valid=classify(p,e,q);assert.equal(conversationSignals(p,e,valid,{current:true})[0].purpose,'potential_customer');
});

test('search plans expose business references and retain separate purpose lanes',()=>{
 const {p}=fixture();const input=searchPlanInput(p);assert(input.business.references.includes('fixture-cafe.dev'));
 const next={...plan(),themes:[{...plan().themes[0],purposes:['mention'],queries:[{id:'brand',platform:'reddit',community:null,query:'Fixture Cafe'}]},{...plan().themes[0],id:'alternatives',purposes:['competitor','feedback'],queries:[{id:'alternatives',platform:'reddit',community:'vancouver',query:'sandwich cafe alternatives'}]}],reviewed:true};
 p.searchPlanV2=validateSearchPlan(next,p);const queries=plannedQueries(p,'reddit');
 assert.equal(queries[0].community,null);assert.deepEqual(queries[0].purposes,['mention']);assert.deepEqual(queries[1].purposes,['competitor','feedback']);
 assert.throws(()=>validateSearchPlan({...next,themes:[{...next.themes[0],purposes:['invented']}]},p),/unknown/);
});

test('historical reply collection prioritises a named product discussion over generic questions',()=>{
 const {p,data}=fixture();data.collection={};
 const generic=source('Where can I find lunch?',{type:'post',sourceId:'t3_generic',postId:'t3_generic',url:'https://www.reddit.com/r/vancouver/comments/generic/',commentCount:5});
 const named=source('Fixture Cafe customer experiences',{type:'post',sourceId:'t3_named',postId:'t3_named',url:'https://www.reddit.com/r/vancouver/comments/named/',commentCount:5});
 const job={productId:p.id,id:'history',queue:[],branches:[],threads:{},from:new Date(now-365*86400000).toISOString(),to:new Date(now+1).toISOString(),rows:0,filtered:0,staged:0,duplicates:0,unassessed:0,errors:[]};
 applyBackfillPage(data,job,{kind:'search',page:1,purposes:['feedback']},{rows:[generic,named],cursor:null},now);
 assert.equal(job.queue[0].kind,'comments');assert.equal(job.queue[0].post.sourceId,'t3_named');
 assert(commentThreadPriority(p,named)>commentThreadPriority(p,generic));
});

test('regular collection refreshes older named product threads within the existing thread limit',()=>{
 const {p,data}=fixture();p.searchPlanV2=validateSearchPlan({...plan(),themes:[{...plan().themes[0],purposes:['mention'],queries:[{id:'brand',platform:'reddit',community:null,query:'Fixture Cafe'}]}],reviewed:true},p);
 beginCollection(data,p.id,'manual',now);const settings=collectionSettings({TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'});
 const request=claimCollection(data,settings,p.id,now);
 const post=source('Fixture Cafe customer experiences',{type:'post',sourceId:'t3_named',postId:'t3_named',url:'https://www.reddit.com/r/vancouver/comments/named/',commentCount:5,publishedAt:new Date(now-90*86400000).toISOString()});
 finishCollection(data,request.token,{credits:5,result:{rows:[post],cursor:null}},now+1);
 assert.equal(data.collection.cycles[p.id].queue[0].kind,'comments');assert.equal(data.collection.cycles[p.id].queue[0].post.sourceId,'t3_named');assert(data.collection.cycles[p.id].queue.length<=4);
});

test('previously reviewed plans remain usable without accepting a changed business profile',()=>{
 const {p}=fixture(),input=searchPlanInput(p);
 const business=Object.fromEntries(Object.entries(input.business).filter(([key])=>!['aliases','references','competitorNames'].includes(key)));
 const old={...plan(),profileHash:hash({...input,business}),reviewed:true};delete old.themes[0].purposes;
 assert.equal(validateSearchPlan(old,p).reviewed,true);
 const changed={...p,name:'Changed Cafe'};assert.throws(()=>validateSearchPlan(old,changed),/business breakdown|Business details|business profile/i);
});

test('limited review allowance prioritises named business replies without discarding older candidates',()=>{
 const {p,data}=fixture();captureEvidence(data,p,[source('Where can I find lunch?',{type:'post',url:'https://www.reddit.com/r/vancouver/comments/older/'})],at);
 captureEvidence(data,p,[source('The sandwich pickup was slow.',{context:'Fixture Cafe customer experiences'})],new Date(now+1000).toISOString());
 const pending=pendingEvidence(data,p);assert.equal(pending.length,2);assert.equal(pending[0].type,'comment');assert.equal(pending[1].url,'https://www.reddit.com/r/vancouver/comments/older/');
});


test('a named alternative announcement supports attributed competitor research without becoming a lead',()=>{
 const {p,data}=fixture();captureEvidence(data,p,[source('I run Other Cafe and we offer croissant sandwich pickup.')],at);const e=data.conversationEvidence[p.id][0];
 const q=classify(p,e,decision(e,{category:'promotion',purposes:[signal('competitor',e.text,{reference:'Other Cafe',reason:'The provider advertises a comparable pickup offering; this is a vendor claim, not an independent review.'})]}));
 assert.equal(q.directFit,false);assert.equal(q.purposes[0].purpose,'competitor');assert.throws(()=>classify(p,e,{...q,directFit:true,need:'Find lunch',offeringIds:['o1']}),/Promotional posts/);
});


test('Reddit collection keeps local context mandatory and preserves exact quoted business names',()=>{
 assert.equal(compileRedditQuery({query:'mousse desserts Vancouver',community:null}),'mousse AND desserts AND Vancouver');
 assert.equal(compileRedditQuery({query:'"Wren Café" Yaletown',community:null}),'"Wren Café" AND Yaletown');
 const {p,data}=fixture();p.searchPlanV2=validateSearchPlan({...plan(),themes:[{...plan().themes[0],queries:[{id:'local',platform:'reddit',community:'vancouver',query:'downtown brunch'}]}],reviewed:true},p);
 beginCollection(data,p.id,'manual',now);
 assert.equal(data.collection.cycles[p.id].queue[0].query,'subreddit:vancouver AND downtown AND brunch');
 const long='word '.repeat(30).trim();
 assert.throws(()=>validateSearchPlan({...plan(),themes:[{...plan().themes[0],queries:[{id:'long',platform:'reddit',community:'vancouver',query:long}]}]},p),/compiled query/);
});


test('qualification provides the review date separately from an old source date',()=>{
 const {p,data}=fixture();
 captureEvidence(data,p,[source('Where can I get lunch this Spring?',{publishedAt:'2026-02-01T12:00:00Z'})],at);
 const input=qualificationInput(data,p,now);
 assert.equal(input.asOf,at);
 assert.equal(input.evidence[0].publishedAt,'2026-02-01T12:00:00.000Z');
 assert.equal(input.evidence[0].text,'Where can I get lunch this Spring?');
});
