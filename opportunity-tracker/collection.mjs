import {collectedQuotaBlock,reserveCollectedQuota,settleCollectedQuota,collectedUsageState} from './collected-usage.mjs';
import {materializeCollectedConversations} from './conversation-pages.mjs';
import {activeProduct,subscriptionState} from './plans.mjs';
import {scheduleState,claimScheduledLoop,finishScheduledLoop} from './schedules.mjs';
import {freshRows} from './incremental.mjs';
import {ApifyInstagramAdapter,INSTAGRAM_ACTOR,INSTAGRAM_MAX_ITEMS,INSTAGRAM_MAX_CHARGE_USD} from './instagram-apify.mjs';
import {ApifyRedditCommentsAdapter,redditCommentQueries,COMMENT_SEARCH_MAX_CHARGE_USD,REDDIT_COMMENTS_ACTOR} from './reddit/apify-comments.mjs';
import {commentThreadPriority} from './conversation-purpose.mjs';
import {SOCIAL_PLATFORMS,SOCIAL_LABELS,socialDue,socialTaskPlatform,socialTaskURL,parseSocialPage} from './social-search.mjs';
import {activeSearchPlan,plannedQueries,compileRedditQuery,listeningReady} from './search-plan.mjs';
import {captureEvidence,reviewQueueBlock} from './conversation-evidence.mjs';
import {createBackfill,backfillBlock,applyBackfillPage,backfillError,backfillPublic,finishBackfill} from './backfill.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {normalizeScrapeBadgerPost, normalizeScrapeBadgerComments} from './reddit/scrapebadger.mjs';
import {readText} from './reddit/http.mjs';
import {stageQualifications, budgetDay} from './qualification.mjs';
import {pilotBudgetBlock} from './pilot-budget.mjs';

export const COLLECTION_VERSION = 'experiment-v1';
export const COLLECTION_INTERVAL_MS = 2 * 3600000;
const OVERLAP = 15 * 60000, DAY = 86400000, PACE = 15000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const profileKey = p => digest({discoveryVersion:'purpose-discovery-v1',communities:p.communities,keywords:p.keywords,aliases:p.aliases,competitorNames:p.competitorNames,x:p.x,xQueries:p.xQueries,...(p.tiktok?{tiktok:true}:{}),...(p.instagram?{instagram:true}:{}),capabilities:p.capabilities,exclusions:p.exclusions,...(p.listeningVersion?{listeningVersion:p.listeningVersion,searchPlan:p.searchPlanV2}:{})});
const iso = now => new Date(now).toISOString();
export function collectionSettings(env = process.env) {
  const apifyDailyLimitMicroUsd=Math.floor(Math.max(0,Math.min(0.50,Number(env.APIFY_COLLECTION_DAILY_BUDGET_USD??env.REDDIT_COMMENTS_DAILY_BUDGET_USD??0.50)||0))*1e6);
  const instagramSearchEnabled=Boolean(env.APIFY_TOKEN)&&env.INSTAGRAM_SEARCH_ENABLED!=='false';
  return {enabled:env.TRACKER_COLLECTION_PIPELINE === COLLECTION_VERSION,
    configured:Boolean(env.SCRAPEBADGER_API_KEY)||Boolean(env.APIFY_TOKEN), scrapebadgerConfigured:Boolean(env.SCRAPEBADGER_API_KEY), dailyCreditLimit:3333,
    instagramSearchEnabled,apifyDailyLimitMicroUsd,
    commentSearchEnabled:Boolean(env.APIFY_TOKEN)&&env.REDDIT_COMMENTS_ENABLED!=='false',
    commentDailyLimitMicroUsd:Math.min(apifyDailyLimitMicroUsd,Math.floor(Math.max(0,Math.min(0.50,Number(env.REDDIT_COMMENTS_DAILY_BUDGET_USD??0.50)||0))*1e6))}; // Shared Apify collection allowance stays <= $0.50/day.
}
export function xQueries(product,{loop}={}) {
  if(product.listeningVersion==='v2')return plannedQueries(product,'x',{loop}).map(q=>`${q.query} lang:en -filter:retweets`);
  if(product.x === false||loop==='long_tail') return [];
  const explicit=(product.xQueries || []).filter(q=>typeof q==='string' && q.trim()).slice(0,2);
  if(explicit.length)return explicit;
  // Product-specific phrases are editable. Never hard-code a test business.
  return [...new Set((product.keywords || []).slice(0,2).map(q=>`"${q.replace(/["\\\n\r]/g,' ').trim()}" lang:en -filter:retweets`))];
}
export function normalizeTweet(t, collectedAt,{preserveText=false}={}) {
  const when=Date.parse(t.created_at), text=t.full_text ?? t.text;
  if(!/^\d{1,30}$/.test(t.id ?? '') || typeof text!=='string' || !text.trim() || !Number.isFinite(when) || when>Date.parse(collectedAt)+300000 || t.is_retweet)return null;
  return {source:'X',provider:'scrapebadger',sourceId:`x_${t.id}`,postId:`x_${t.conversation_id ?? t.id}`,parentId:t.in_reply_to_status_id?`x_${t.in_reply_to_status_id}`:null,type:t.in_reply_to_status_id?'comment':'post',url:`https://x.com/i/status/${t.id}`,title:text.slice(0,180),snippet:preserveText?text:text.slice(0,10000),publishedAt:iso(when),collectedAt,author:typeof t.user?.screen_name==='string'?t.user.screen_name:null};
}
function state(data) {
  const s=data.collection ||= {version:COLLECTION_VERSION,cycles:{},watermarks:{},threads:{},cache:{},daily:{},receipts:[],nextRequestAt:0};
  s.backfills ||= {};s.apifyDaily ||= {};s.commentOffsets ||= {};s.lastModes ||= {};return s;
}
export function beginBackfill(data,productId,now=Date.now()) {
  const product=data.products.find(p=>p.id===productId);if(!product)return null;
  state(data);return createBackfill(data,product,xQueries(product),digest([profileKey(product),product.needs]),now);
}
const requestCycle=(s,r)=>r.mode==='backfill'?s.backfills[r.productId]:s.cycles[r.productId];
const sourceKey = (productId, task) => `${productId}:${task.kind}:${task.query ? digest([task.query,task.name||null]) : task.post?.sourceId||task.name}`;
const taskPlatform=task=>socialTaskPlatform(task)||(task.kind==='reddit_comment_search'?'reddit_comment_search':task.kind==='x'?'x':'reddit');
const sourcePlatform=name=>Object.entries(SOCIAL_LABELS).find(([,label])=>label===name)?.[0]||(name==='Reddit comments'?'reddit_comment_search':name==='X'?'x':'reddit');
const commentTask=task=>task.kind==='comments'||task.kind.endsWith('_comments');
export function socialQueries(product,platform,{loop}={}){
  if(product[platform]!==true||product.listeningVersion!=='v2'&&loop==='long_tail')return [];
  return product.listeningVersion==='v2'?plannedQueries(product,platform,{loop}):(product.keywords||[]).slice(0,2).map((query,index)=>({query,id:`${platform}_${index}`}));
}
const COLLECTION_LOOPS=['keyword','long_tail'];
const familyOf=task=>task.queryFamily||task.loop||'keyword';
const familyRun=(cycle,task)=>cycle.familyRuns?.[familyOf(task)];
function cycleError(cycle,task,code) {
  cycle.errors.push(`${task.kind}:${code}`);
  const run=familyRun(cycle,task);if(run)run.errors=(run.errors||0)+1;
}
function availableFamilySources(product,loop) {
  const reddit=product.listeningVersion==='v2'?plannedQueries(product,'reddit',{loop}).length:loop==='keyword'&&product.communities?.length;
  return [...(reddit?['reddit']:[]),...(xQueries(product,{loop}).length?['x']:[]),...SOCIAL_PLATFORMS.filter(platform=>socialQueries(product,platform,{loop}).length)];
}
function familySources(data,product,loop,now,settings={}) {
  const record=data.loopSchedules?.[product.id]?.[loop];
  return availableFamilySources(product,loop).filter(platform=>{
    const floor=Math.max(SOCIAL_PLATFORMS.includes(platform)?DAY:0,Number(settings.sourceFloors?.[platform])||0);
    const at=Date.parse(record?.sourceStartedAt?.[platform]);
    return !Number.isFinite(at)||now-at>=floor;
  });
}
// Each family owns its cadence. Source-specific floors are applied to that
// family's queries, so daily social sources cannot slow the Reddit/X loop.
export function collectionPlanState(data,productId,now=Date.now(),{manual=false,settings={}}={}) {
  const product=data.products.find(p=>p.id===productId);if(!product)return [];
  return COLLECTION_LOOPS.map(loop=>{
    const current=scheduleState(data,productId,loop,{now,manual}),sources=listeningReady(product)?familySources(data,product,loop,now,settings):[];
    return {...current,sources,due:current.due&&sources.length>0,...(current.due&&!sources.length?{status:'source_cadence'}:{})};
  });
}
function familyTasks(data,product,loop,sources,settings) {
  const s=state(data),plan=activeSearchPlan(product),has=platform=>sources.includes(platform);
  const reddit=has('reddit')?(plan?plannedQueries(product,'reddit',{loop}).map(q=>({kind:'search',query:compileRedditQuery(q),queryId:q.id,purposes:q.purposes,name:q.community,page:1,sort:'new',includeClosed:true})):(product.communities||[]).map(name=>({kind:'listing',name,page:1}))):[];
  const x=has('x')?xQueries(product,{loop}).map((query,index)=>({kind:'x',query,page:1,...(plan?{queryId:plannedQueries(product,'x',{loop})[index].id,purposes:plannedQueries(product,'x',{loop})[index].purposes}: {})})):[];
  const queue=[...reddit,...x,...SOCIAL_PLATFORMS.flatMap(platform=>has(platform)?socialQueries(product,platform,{loop}).map(q=>({kind:platform,query:q.query,queryId:q.id,purposes:q.purposes||[],page:1})):[])];
  if(settings.commentSearchEnabled&&has('reddit')){
    const queries=plan?plannedQueries(product,'reddit',{loop}):redditCommentQueries(product),key=`${product.id}:${loop}`,offset=s.commentOffsets[key]||0;
    const selected=Array.from({length:Math.min(2,queries.length)},(_,i)=>queries[(offset+i)%queries.length]);
    queue.unshift(...selected.map(q=>({kind:'reddit_comment_search',query:q.query,queryId:q.id,purposes:q.purposes||[],name:q.community,page:1})));
    if(queries.length)s.commentOffsets[key]=(offset+selected.length)%queries.length;
  }
  return queue.map(task=>({...task,queryFamily:loop}));
}
function markFamilyDispatch(data,cycle,task,now){
  if(!data.subscription||cycle.mode==='backfill')return;
  cycle.lastFamily=familyOf(task);
  if(!task.loopRunId||commentTask(task))return;
  const record=data.loopSchedules?.[cycle.productId]?.[familyOf(task)];
  if(record?.lease?.id===task.loopRunId){record.sourceStartedAt||={};record.sourceStartedAt[taskPlatform(task)]=iso(now);}
}
function heartbeatFamilies(data,cycle,now) {
  for(const [loop,run] of Object.entries(cycle.familyRuns||{}))if(run.status==='running'){
    const record=data.loopSchedules?.[cycle.productId]?.[loop];
    if(record?.lease?.id===run.id)record.lease.expiresAt=iso(now+300000);
  }
}
function settleFamilies(data,cycle,now) {
  if(!cycle.familyRuns)return;
  for(const [loop,run] of Object.entries(cycle.familyRuns))if(run.status==='running'){
    const pending=()=>(cycle.queue||[]).some(task=>task.loopRunId===run.id)||data.collection?.active?.task?.loopRunId===run.id;
    if(pending())continue;
    planThreads(data,cycle,now,loop);
    if(pending())continue;
    finishScheduledLoop(data,cycle.productId,loop,run.id,{now,outcome:run.errors?'failed':'success'});
    run.status='complete';run.finishedAt=iso(now);
    cycle.posts=cycle.posts.filter(row=>row.loopRunId!==run.id);
  }
  heartbeatFamilies(data,cycle,now);
}
function beginPlanCollection(data,product,trigger,now,settings) {
  if(!activeProduct(product)||product.planMonitoringBlocked||!subscriptionState(data,now).active||trigger==='scheduled'&&!product.monitoring)return null;
  const s=state(data),prior=s.cycles[product.id],manual=trigger!=='scheduled';
  if(prior?.status==='running'&&prior.profileKey!==profileKey(product))return structuredClone(prior);
  let cycle=prior?.status==='running'?prior:null;
  if(cycle?.familyRuns)settleFamilies(data,cycle,now);
  const existingQueue=cycle?.queue?.some(task=>!task.loopRunId)?cycle.queue.filter(task=>!task.loopRunId):null;
  if(cycle)cycle.familyRuns||={};
  for(const current of collectionPlanState(data,product.id,now,{manual,settings})) {
    if(cycle?.familyRuns?.[current.loop]?.status==='running'||!current.due)continue;
    const queue=existingQueue?existingQueue.filter(task=>familyOf(task)===current.loop):familyTasks(data,product,current.loop,current.sources,settings);
    if(!queue.length)continue;
    const claim=claimScheduledLoop(data,product.id,current.loop,{now,manual,leaseMs:300000});if(!claim.claimed)continue;
    if(!cycle)cycle={id:randomUUID(),productId:product.id,profileKey:profileKey(product),trigger,startedAt:iso(now),status:'running',queue:[],posts:[],familyRuns:{},rows:0,staged:0,unassessed:0,requests:0,errors:[],sourceStats:{},sources:[]};
    const run={id:claim.lease.id,startedAt:iso(now),status:'running',threadsPlanned:false,errors:0,sources:current.sources};cycle.familyRuns[current.loop]=run;
    for(const task of queue){
      task.queryFamily=current.loop;task.loopRunId=run.id;task.runStartedAt=run.startedAt;
      const mark=s.watermarks[sourceKey(product.id,task)],stamp=Date.parse(mark);task.cutoff=Number.isFinite(stamp)?stamp-OVERLAP:now-DAY;
    }
    if(existingQueue)cycle.queue=cycle.queue.filter(task=>familyOf(task)!==current.loop);
    if(current.loop==='keyword')cycle.queue.unshift(...queue);else cycle.queue.push(...queue);
    const record=data.loopSchedules[product.id][current.loop];record.sourceStartedAt={...record.sourceStartedAt,...Object.fromEntries(current.sources.map(platform=>[platform,iso(now)]))};
    cycle.sources=[...new Set([...cycle.sources,...queue.map(task=>SOCIAL_LABELS[taskPlatform(task)]||(task.kind==='reddit_comment_search'?'Reddit comments':task.kind==='x'?'X':'Reddit watchlist'))])];
  }
  if(!cycle)return null;
  if(manual)cycle.trigger='manual';
  heartbeatFamilies(data,cycle,now);s.cycles[product.id]=cycle;
  return structuredClone(cycle);
}
function finishCycle(data, cycle, now) {
  settleFamilies(data,cycle,now);
  cycle.status='complete'; cycle.finishedAt=iso(now); delete cycle.queue; delete cycle.posts;
  const search=data.searches[cycle.productId] ||= {sources:[],lastChecks:{},found:0};
  search.searchedAt=iso(now); search.pipeline=COLLECTION_VERSION;
  search.lastChecks ||= {};
  const sources=cycle.sources.map(name=>{
    const platform=sourcePlatform(name),stats=cycle.sourceStats?.[platform],errors=cycle.errors.filter(error=>platform==='reddit'?/^(listing|search|comments):/.test(error):error.startsWith(platform+':')||error.startsWith(platform+'_comments:'));
    const unconfigured=errors.some(error=>error.includes('provider_unconfigured'));
    const unavailable=unconfigured||errors.some(error=>error.includes('provider_temporarily_unavailable'));
    return {name,provider:platform==='instagram'?(stats?.searchProvider||'instagram-apify'):platform==='reddit_comment_search'?'reddit-apify':'scrapebadger',...(platform==='instagram'?{commentProvider:'scrapebadger'}:{}),status:unavailable&&!stats?.rows?'unavailable':errors.length?'partial':'ok',checkedAt:iso(now),
      message:unconfigured?(stats?.rows?`Some ${name} results were collected, but selected comment sections could not be read because comment collection is not configured.`:`${name} collection is unavailable because its server credentials are not configured.`):unavailable?`${name} collection requests are temporarily unavailable at the provider. They will be checked again on the next daily cycle.`:`${stats?.requests??cycle.requests} collection requests; ${stats?.rows??cycle.rows} returned objects. Bounded searches and selected comment sections; coverage is partial.${errors.length?' Some requests failed or reached their limit.':''}`,coverage:{complete:false,errors}};
  });
  for(const source of sources)search.lastChecks[sourcePlatform(source.name)]=iso(now);
  search.sources=[...sources,...(search.sources || []).filter(s=>!cycle.sources.includes(s.name))];
}
export function beginCollection(data, productId, trigger, now = Date.now(), settings=collectionSettings()) {
  const product=data.products.find(p=>p.id===productId); if(!product)return null;
  if(data.subscription)return beginPlanCollection(data,product,trigger,now,settings);
  const s=state(data), prior=s.cycles[productId];
  if(prior?.status==='running')return structuredClone(prior);
  if(trigger==='scheduled' && (!product.monitoring || prior && now-Date.parse(prior.startedAt)<COLLECTION_INTERVAL_MS))return null;
  const plan=activeSearchPlan(product);
  const queue=[...(plan?plannedQueries(product,'reddit').map(q=>({kind:'search',query:compileRedditQuery(q),queryId:q.id,purposes:q.purposes,name:q.community,page:1,sort:'new',includeClosed:true})):(product.communities || []).map(name=>({kind:'listing',name,page:1}))),...xQueries(product).map(query=>({kind:'x',query,page:1})),...SOCIAL_PLATFORMS.flatMap(platform=>trigger==='scheduled'&&!socialDue(product,data,platform,now)?[]:socialQueries(product,platform).map(q=>({kind:platform,query:q.query,queryId:q.id,purposes:q.purposes||[],page:1})))];
  if(settings.commentSearchEnabled){
    const queries=plan?plannedQueries(product,'reddit'):redditCommentQueries(product);
    const offset=s.commentOffsets[productId]||0,selected=Array.from({length:Math.min(2,queries.length)},(_,i)=>queries[(offset+i)%queries.length]);
    queue.unshift(...selected.map(q=>({kind:'reddit_comment_search',query:q.query,queryId:q.id,purposes:q.purposes||[],name:q.community,page:1})));
    if(queries.length)s.commentOffsets[productId]=(offset+selected.length)%queries.length;
  }
  for(const task of queue) {
    const mark=s.watermarks[sourceKey(productId,task)] || (task.kind==='listing'?data.searches[productId]?.lastChecks?.reddit:null);
    const stamp=Date.parse(mark);task.cutoff=Number.isFinite(stamp)?stamp-OVERLAP:now-DAY;
  }
  const cycle={id:randomUUID(),productId,profileKey:profileKey(product),trigger,startedAt:iso(now),status:'running',queue,posts:[],threadsPlanned:false,rows:0,staged:0,unassessed:0,requests:0,errors:[],sourceStats:{},sources:[...new Set(queue.map(task=>SOCIAL_LABELS[taskPlatform(task)]||(task.kind==='reddit_comment_search'?'Reddit comments':task.kind==='x'?'X':'Reddit watchlist')))]};
  s.cycles[productId]=cycle;
  product.monitorAttempts={...product.monitorAttempts,...Object.fromEntries(cycle.sources.map(name=>[sourcePlatform(name),iso(now)]))};
  if(!queue.length)finishCycle(data,cycle,now);
  return structuredClone(cycle);
}
function planThreads(data, cycle, now,loop) {
  if(cycle.familyRuns&&!loop){for(const family of Object.keys(cycle.familyRuns))planThreads(data,cycle,now,family);return;}
  const run=loop?cycle.familyRuns?.[loop]:null;
  if((run||cycle).threadsPlanned)return;
  (run||cycle).threadsPlanned=true;
  const s=state(data), product=data.products.find(p=>p.id===cycle.productId);
  const candidates=[...new Map(cycle.posts.filter(row=>!run||row.loopRunId===run.id).map(row=>[row.sourceId,row])).values()].filter(row=> {
    if(row.commentCount===0)return false;
    const priority=commentThreadPriority(product,row,row.discoveryPurposes||[]);
    return priority>0&&(['TikTok','Instagram'].includes(row.source)||Date.parse(row.publishedAt)>=now-7*DAY||priority>=3);
  }).filter(row=> {
    const prior=s.threads[`${cycle.productId}:${row.sourceId}`];
    // A daily refresh covers edits that do not change the count.
    return !prior || row.commentCount===null || prior.commentCount!==row.commentCount || now-Date.parse(prior.checkedAt)>=DAY;
  }).sort((a,b)=>commentThreadPriority(product,b,b.discoveryPurposes||[])-commentThreadPriority(product,a,a.discoveryPurposes||[])||(Date.parse(s.threads[`${cycle.productId}:${a.sourceId}`]?.checkedAt || '') || 0)-(Date.parse(s.threads[`${cycle.productId}:${b.sourceId}`]?.checkedAt || '') || 0) || Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
  const selected=candidates.slice(0,Math.max(0,4-(cycle.threadCount||0)));cycle.threadCount=(cycle.threadCount||0)+selected.length;
  cycle.queue.push(...selected.map(post=>({kind:post.source==='TikTok'?'tiktok_comments':post.source==='Instagram'?'instagram_comments':'comments',post,cutoff:s.threads[`${cycle.productId}:${post.sourceId}`]?.checkedAt?Date.parse(s.threads[`${cycle.productId}:${post.sourceId}`].checkedAt)-OVERLAP:now-DAY,includeClosed:product.listeningVersion==='v2',...(run?{loopRunId:run.id,runStartedAt:run.startedAt,queryFamily:loop,queryId:post.queryId}:{})})));
}
function taskURL(task) {
  if(task.kind==='instagram')return `https://api.apify.com/v2/actors/${INSTAGRAM_ACTOR}/runs?${new URLSearchParams({keyword:task.query,maxItems:String(INSTAGRAM_MAX_ITEMS)})}`;
  if(task.kind==='reddit_comment_search')return `https://api.apify.com/v2/actors/${REDDIT_COMMENTS_ACTOR}/runs?${new URLSearchParams({query:task.query,community:task.name||'',cutoff:iso(task.cutoff)})}`;
  const social=socialTaskURL(task);if(social)return social;
  const url=new URL(task.kind==='search'?'https://scrapebadger.com/v1/reddit/search/posts':task.kind==='listing'?`https://scrapebadger.com/v1/reddit/subreddits/${task.name}/posts`:task.kind==='comments'?`https://scrapebadger.com/v1/reddit/posts/${task.post.postId.slice(3)}/comments`:'https://scrapebadger.com/v1/twitter/tweets/advanced_search');
  const params=task.kind==='search'?{q:task.query,sort:task.sort,t:'year',limit:'50',...(task.cursor?{after:task.cursor}:{})}:task.kind==='listing'?{sort:'new',limit:'30',...(task.cursor?{after:task.cursor}:{})}:task.kind==='comments'?{sort:'new',limit:'100',depth:'10'}:{query:`${task.query} since:${iso(task.cutoff).slice(0,10)}${task.until?' until:'+iso(task.until+DAY).slice(0,10):''}`,query_type:'Latest',count:'20',...(task.cursor?{cursor:task.cursor}:{})};
  url.search=new URLSearchParams(params).toString();return url.href;
}
function settleHold(s, request, outcome, now) {
  if(['reddit-apify','instagram-apify'].includes(request.provider)){
    const day=s.apifyDaily[request.day],reported=outcome.coverage?.reportedCostUsd;
    const charged=Number.isFinite(reported)&&reported>=0?Math.max(request.reserve,Math.ceil(reported*1e6)):request.reserve;
    day.reservedMicroUsd-=request.reserve;day.spentMicroUsd+=charged;if(charged>request.reserve)s.overrun=true;
    // Apify reports preliminary cost. Keep the full run cap charged to this
    // local allowance instead of releasing funds before billing is final.
    const cycle=requestCycle(s,request);if(cycle){cycle.sourceStats ||= {};const stats=cycle.sourceStats[taskPlatform(request.task)] ||= {requests:0,rows:0};stats.requests++;if(request.task.kind==='instagram')stats.searchProvider=request.provider;}
    s.receipts.push({id:request.token,productId:request.productId,cycleId:request.cycleId,platform:taskPlatform(request.task),provider:request.provider,kind:request.task.kind,at:iso(now),reservedCostMicroUsd:request.reserve,reportedCostUsd:outcome.coverage?.reportedCostUsd??null,runId:outcome.coverage?.runId||outcome.runId||null,costFinal:false,status:outcome.error||outcome.coverage?.errors?.length?'failed':'settled',...(outcome.httpStatus?{httpStatus:outcome.httpStatus}:{})});
    s.receipts=s.receipts.slice(-2000);return;
  }
  const day=s.daily[request.day]; day.reservedCredits-=request.reserve;
  const known=Number.isSafeInteger(outcome.credits) && outcome.credits>=0;
  const amount=known?outcome.credits:request.reserve;
  day.spentCredits+=amount; if(!known)day.uncertainCredits+=amount;
  if(amount>request.reserve)s.overrun=true;
  const cycle=requestCycle(s,request);
  if(cycle){cycle.sourceStats ||= {};const stats=cycle.sourceStats[taskPlatform(request.task)] ||= {requests:0,rows:0};stats.requests++;if(request.task.kind==='instagram')stats.searchProvider='scrapebadger';}
  s.receipts.push({id:request.token,productId:request.productId,cycleId:request.cycleId,platform:taskPlatform(request.task),kind:request.task.kind,at:iso(now),credits:known?amount:null,unknownReservation:known?0:amount,status:outcome.error?'failed':'settled',...(outcome.httpStatus?{httpStatus:outcome.httpStatus}:{})});
  s.receipts=s.receipts.slice(-2000);
}
export function claimCollection(data, settings, productId, now = Date.now()) {
  const s=state(data); if(!settings.enabled || !settings.configured || s.overrun)return null;
  if(s.active && s.active.expiresAt<=now) {
    const expired=s.active; settleHold(s,expired,{error:'uncertain_dispatch'},now);settleCollectedQuota(data,expired,{error:'uncertain_dispatch'});
    const cycle=requestCycle(s,expired);if(cycle?.id===expired.cycleId){if(expired.mode==='backfill')backfillError(cycle,expired.task,'uncertain_dispatch');else cycleError(cycle,expired.task,'uncertain_dispatch');}
    delete s.active; // Task was removed before dispatch. Never replay it.
  }
  if(s.active || now<s.nextRequestAt)return null;
  const regular=s.cycles[productId],backfill=s.backfills[productId];
  if(backfill?.status==='reviewing')finishBackfill(data,backfill,now);
  const regularReady=regular?.status==='running';
  const backfillReady=backfill?.status==='running'&&!backfillBlock(data,backfill,now);
  // Alternate within each product; a workspace-global cursor can starve one product’s live loop.
  // Existing workspaces start each product with live search rather than inheriting another product’s mode.
  const cycle=backfillReady&&(!regularReady||s.lastModes[productId]==='regular')?backfill:regularReady?regular:null;
  const product=data.products.find(p=>p.id===productId);
  if(!cycle || cycle.status!=='running' || !product)return null;
  if(data.subscription&&(!activeProduct(product)||product.planMonitoringBlocked||!subscriptionState(data,now).active)){cycle.blocked=product.planMonitoringBlocked||'subscription_inactive';return null;}
  if(data.subscription&&cycle.mode!=='backfill'&&(!cycle.familyRuns||cycle.queue.some(task=>!task.loopRunId))){beginPlanCollection(data,product,cycle.trigger,now,settings);if(!cycle.familyRuns||cycle.queue.some(task=>!task.loopRunId)){cycle.blocked='schedule_not_due';return null;}}
  if(data.subscription)heartbeatFamilies(data,cycle,now);
  if(!listeningReady(product)){cycle.blocked='search_plan_needs_review';return null;}
  if(cycle.profileKey!==(cycle.mode==='backfill'?digest([profileKey(product),product.needs]):profileKey(product))){cycle.status='profile_changed';cycle.queue=[];delete cycle.posts;return null;}
  if(cycle.trigger==='scheduled' && !product.monitoring){if(data.subscription){cycle.blocked='monitoring_paused';return null;}cycle.status='paused';delete cycle.queue;delete cycle.posts;return null;}
  const reviewBlock=reviewQueueBlock(data,product);
  if(reviewBlock){cycle.blocked=reviewBlock;return null;}
  if(!data.subscription&&Buffer.byteLength(JSON.stringify(data))>4*1024*1024){cycle.blocked='storage_capacity';return null;}
  delete cycle.blocked;
  if(!cycle.queue.length && cycle.mode!=='backfill')planThreads(data,cycle,now);
  if(!cycle.queue.length){cycle.mode==='backfill'?finishBackfill(data,cycle,now):finishCycle(data,cycle,now);return null;}
  const quotaBlock=collectedQuotaBlock(data,productId,cycle.mode==='backfill',100,now);if(quotaBlock){cycle.blocked=quotaBlock.code;return null;}
  // Preserve FIFO within each family while preventing repeated keyword runs
  // from indefinitely postponing an already queued long-tail run.
  const alternate=cycle.lastFamily==='keyword'?'long_tail':'keyword';
  const preferred=data.subscription&&cycle.mode!=='backfill'?cycle.queue.findIndex(task=>familyOf(task)===alternate):-1;
  const taskIndex=preferred<0?0:preferred,task=cycle.queue[taskIndex],url=taskURL(task),cache=s.cache[digest([url,Boolean(task.historical||task.includeClosed),...(data.subscription?['durable',task.loopRunId||cycle.id]:[])])];
  if(cache && now-cache.at<OVERLAP) {
    const cachedRequest={token:randomUUID(),mode:cycle.mode||'regular',productId};reserveCollectedQuota(data,cachedRequest,now);
    markFamilyDispatch(data,cycle,task,now);cycle.queue.splice(taskIndex,1);applyPage(data,cycle,task,structuredClone(cache.result),now);settleCollectedQuota(data,cachedRequest,{result:cache.result});s.lastModes[productId]=cachedRequest.mode;return {cached:true};
  }
  if(data.pilotBudget?.active&&(socialTaskPlatform(task)||['instagram','reddit_comment_search'].includes(task.kind))){cycle.blocked='pilot_provider_not_allowed';return null;}
  if(task.kind==='instagram'){
    const dayKey=budgetDay(now),day=s.apifyDaily[dayKey] ||= {spentMicroUsd:0,reservedMicroUsd:0,calls:0};
    const reserve=Math.round(INSTAGRAM_MAX_CHARGE_USD*1e6);
    if(!settings.instagramSearchEnabled||day.spentMicroUsd+day.reservedMicroUsd+reserve>(settings.apifyDailyLimitMicroUsd??settings.commentDailyLimitMicroUsd??0)){
      if(data.subscription&&settings.instagramSearchEnabled){cycle.blocked='daily_apify_collection_budget';return null;}
      cycleError(cycle,task,settings.instagramSearchEnabled?'daily_apify_collection_budget':'provider_unconfigured');
      cycle.queue=cycle.queue.filter(task=>task.kind!=='instagram');return claimCollection(data,settings,productId,now);
    }
    const request={mode:'regular',provider:'instagram-apify',token:randomUUID(),productId,cycleId:cycle.id,task,url,day:dayKey,reserve,expiresAt:now+90000,...(data.subscription?{preserveText:true}:{})};
    reserveCollectedQuota(data,request,now);markFamilyDispatch(data,cycle,task,now);day.reservedMicroUsd+=reserve;day.calls++;cycle.requests++;cycle.queue.splice(taskIndex,1);s.lastModes[productId]=request.mode;s.nextRequestAt=now+PACE;s.active=request;return structuredClone(request);
  }
  if(task.kind==='reddit_comment_search'){
    const dayKey=budgetDay(now),day=s.apifyDaily[dayKey] ||= {spentMicroUsd:0,reservedMicroUsd:0,calls:0};
    const reserve=Math.round(COMMENT_SEARCH_MAX_CHARGE_USD*1e6);
    if(!settings.commentSearchEnabled||day.spentMicroUsd+day.reservedMicroUsd+reserve>(settings.commentDailyLimitMicroUsd||0)){
      if(data.subscription&&settings.commentSearchEnabled){cycle.blocked='daily_comment_search_budget';return null;}
      cycleError(cycle,task,settings.commentSearchEnabled?'daily_comment_search_budget':'provider_unconfigured');
      cycle.queue=cycle.queue.filter(task=>task.kind!=='reddit_comment_search');return claimCollection(data,settings,productId,now);
    }
    const request={mode:'regular',provider:'reddit-apify',token:randomUUID(),productId,cycleId:cycle.id,task,url,day:dayKey,reserve,expiresAt:now+90000,...(data.subscription?{preserveText:true}:{})};
    reserveCollectedQuota(data,request,now);markFamilyDispatch(data,cycle,task,now);day.reservedMicroUsd+=reserve;day.calls++;cycle.requests++;cycle.queue.splice(taskIndex,1);s.lastModes[productId]=request.mode;s.nextRequestAt=now+PACE;s.active=request;return structuredClone(request);
  }
  if(settings.scrapebadgerConfigured===false){
    if(cycle.mode==='backfill')backfillError(cycle,task,'provider_unconfigured');else cycleError(cycle,task,'provider_unconfigured');
    cycle.queue.splice(taskIndex,1);if(cycle.mode==='backfill'&&!cycle.queue.length)finishBackfill(data,cycle,now);return claimCollection(data,settings,productId,now);
  }
  const dayKey=budgetDay(now),day=s.daily[dayKey] ||= {spentCredits:0,reservedCredits:0,uncertainCredits:0,calls:0};
  const reserve=commentTask(task)?200:socialTaskPlatform(task)?105:task.kind==='x'?101:102;
  if(day.spentCredits+day.reservedCredits+reserve>settings.dailyCreditLimit){cycle.blocked='daily_scraper_budget';return null;}
  const pilotBlock=pilotBudgetBlock(data,'scrapeCredits',reserve);if(pilotBlock){cycle.blocked=pilotBlock.code;return null;}
  delete cycle.blocked;
  const request={mode:cycle.mode||'regular',token:randomUUID(),productId,cycleId:cycle.id,task,url,day:dayKey,reserve,expiresAt:now+45000,...(data.subscription?{preserveText:true}:{})};
  reserveCollectedQuota(data,request,now);markFamilyDispatch(data,cycle,task,now);day.reservedCredits+=reserve;day.calls++;cycle.requests++;cycle.queue.splice(taskIndex,1);
  s.lastModes[productId]=request.mode;s.nextRequestAt=now+PACE;s.active=request;return structuredClone(request);
}
function applyPage(data,cycle,task,result,now) {
  if(cycle.mode==='backfill')return applyBackfillPage(data,cycle,task,result,now);
  const s=state(data),product=data.products.find(p=>p.id===cycle.productId);if(!product)return;
  const rows=(result.rows || []).map(row=>({...row,snippet:data.subscription?String(row.snippet??row.text??''):row.snippet.slice(0,3000)}));cycle.rows+=rows.length;
  cycle.sourceStats ||= {};const stats=cycle.sourceStats[taskPlatform(task)] ||= {requests:0,rows:0};stats.rows+=rows.length;
  if(result.partial)cycleError(cycle,task,'page_limit');
  if(result.omitted)cycleError(cycle,task,'omitted_results');
  if(['listing','search','tiktok','instagram'].includes(task.kind))cycle.posts.push(...rows.map(row=>({...row,discoveryPurposes:task.purposes||[],queryId:task.queryId,queryFamily:task.queryFamily,loopRunId:task.loopRunId})));
  const candidates=rows.filter(row=>!(product.exclusions || []).some(term=>`${row.title} ${row.snippet}`.toLowerCase().includes(term.toLowerCase()))).map(row=>({...row,...(task.queryId?{queryId:task.queryId}:{}),...(task.queryFamily?{queryFamily:task.queryFamily}:{}),pipeline:COLLECTION_VERSION,...(task.kind==='reddit_comment_search'?{keywordCommentSearch:true}:{}),...(commentTask(task)?{context:data.subscription?`${task.post.title}\n${task.post.snippet}`:`${task.post.title}\n${task.post.snippet}`.slice(0,1500)}:{pipelineCutoff:iso(task.cutoff)})}));
  const fresh=freshRows(data,product,candidates,{cutoff:task.cutoff,at:iso(now),profileHash:cycle.profileKey});
  const eligible=data.subscription?fresh:fresh.slice(0,Math.max(0,60-cycle.staged));
  captureEvidence(data,product,data.subscription?candidates:fresh,iso(now));
  if(data.subscription)materializeCollectedConversations(data,product,candidates,iso(now));
  const staged=product.listeningVersion==='v2'?{pending:eligible.length}:stageQualifications(data,product,eligible,iso(now),cycle.trigger);
  cycle.staged+=staged.pending;cycle.unassessed+=Math.max(0,fresh.length-eligible.length);
  if(commentTask(task)){if(!result.partial&&!result.omitted)s.threads[`${cycle.productId}:${task.post.sourceId}`]={commentCount:task.post.commentCount,checkedAt:iso(now)};}
  else {
    const reachedBoundary=Number.isFinite(result.oldest) && result.oldest<=task.cutoff;
    if(result.cursor && !(socialTaskPlatform(task)?false:reachedBoundary) && task.page<2 && result.cursor!==task.cursor)cycle.queue.unshift({...task,page:task.page+1,cursor:result.cursor,incomplete:task.incomplete||result.partial||Boolean(result.omitted)});
    else {
      if(result.cursor && (socialTaskPlatform(task)||!reachedBoundary))cycleError(cycle,task,'page_limit');
      // A failure, omitted record or truncated cursor retains the old checkpoint.
      if(!task.incomplete&&!result.partial&&!result.omitted&&!(result.cursor&&(socialTaskPlatform(task)||!reachedBoundary)))s.watermarks[sourceKey(cycle.productId,task)]=task.runStartedAt||cycle.startedAt;
    }
  }
  settleFamilies(data,cycle,now);
  if(!cycle.queue.length)planThreads(data,cycle,now);
  if(!cycle.queue.length)finishCycle(data,cycle,now);
}
export function finishCollection(data, token, outcome, now = Date.now()) {
  const s=state(data),request=s.active;if(!request || request.token!==token)return null;
  settleHold(s,request,outcome,now);delete s.active;
  const cycle=requestCycle(s,request);if(cycle?.id!==request.cycleId){settleCollectedQuota(data,request,outcome);return null;}
  const product=data.products.find(p=>p.id===request.productId);
  if(!product||!listeningReady(product)||cycle.profileKey!==(cycle.mode==='backfill'?digest([profileKey(product),product.needs]):profileKey(product))){cycle.status='profile_changed';cycle.queue=[];delete cycle.posts;settleCollectedQuota(data,request,outcome);return {status:'profile_changed'};}
  if(outcome.error){if(request.mode==='backfill'){backfillError(cycle,request.task,outcome.error);finishBackfill(data,cycle,now);}else {cycleError(cycle,request.task,outcome.error);if(outcome.error==='provider_temporarily_unavailable')cycle.queue=cycle.queue.filter(task=>taskPlatform(task)!==taskPlatform(request.task));}}
  else {
    outcome.result.rows=outcome.result.rows.map(row=>({...row,snippet:data.subscription?String(row.snippet??row.text??''):row.snippet.slice(0,3000)}));
    s.cache[digest([request.url,Boolean(request.task.historical||request.task.includeClosed),...(data.subscription?['durable',request.task.loopRunId||cycle.id]:[])])]={at:now,result:outcome.result};
    s.cache=Object.fromEntries(Object.entries(s.cache).filter(([,v])=>now-v.at<OVERLAP).slice(-8));
    applyPage(data,cycle,request.task,outcome.result,now);
  }
  settleCollectedQuota(data,request,outcome);
  if(cycle.mode!=='backfill')settleFamilies(data,cycle,now);
  return {status:cycle.status};
}
export function collectionDueIds(data, now = Date.now()) {
  return data.products.filter(p=>listeningReady(p)&&(!data.subscription||activeProduct(p)&&!p.planMonitoringBlocked&&subscriptionState(data,now).active)).filter(p=>['running','reviewing'].includes(data.collection?.backfills?.[p.id]?.status) || data.collection?.cycles?.[p.id]?.status==='running' && (p.monitoring || data.collection.cycles[p.id].trigger==='manual')).map(p=>p.id);
}
export function collectionPublicState(data, now=Date.now(),settings=collectionSettings()) {
  const s=data.collection||{daily:{},cycles:{}};
  return {version:COLLECTION_VERSION,collectedUsage:collectedUsageState(data,now),day:budgetDay(now),budget:s.daily[budgetDay(now)] || {},limitCredits:3333,apify:{budget:s.apifyDaily?.[budgetDay(now)]||{},dailyLimitMicroUsd:settings.apifyDailyLimitMicroUsd??settings.commentDailyLimitMicroUsd},instagramSearch:{actor:INSTAGRAM_ACTOR.replace('~','/'),maxPosts:INSTAGRAM_MAX_ITEMS,maxRunChargeUsd:INSTAGRAM_MAX_CHARGE_USD},commentSearch:{actor:REDDIT_COMMENTS_ACTOR.replace('~','/'),budget:s.apifyDaily?.[budgetDay(now)]||{},dailyLimitMicroUsd:settings.commentDailyLimitMicroUsd,maxRunChargeUsd:COMMENT_SEARCH_MAX_CHARGE_USD},overrun:Boolean(s.overrun),
    backfills:Object.fromEntries(Object.entries(s.backfills||{}).map(([id,j])=>[id,backfillPublic(data,j)])),
    cycles:Object.fromEntries(Object.entries(s.cycles).map(([id,c])=>[id,{status:c.status,startedAt:c.startedAt,finishedAt:c.finishedAt || null,remaining:c.queue?.length || 0,requests:c.requests,staged:c.staged,unassessed:c.unassessed,errors:c.errors,blocked:c.blocked || null,...(data.subscription?{families:c.familyRuns||{},schedules:collectionPlanState(data,id,now)}:{})}]))};
}
export function createCollectionProvider({env=process.env,fetchImpl=fetch}={}) {
  const comments=env.APIFY_TOKEN?new ApifyRedditCommentsAdapter({token:env.APIFY_TOKEN,fetchImpl}):null;
  const instagram=env.APIFY_TOKEN&&env.INSTAGRAM_SEARCH_ENABLED!=='false'?new ApifyInstagramAdapter({token:env.APIFY_TOKEN,fetchImpl}):null;
  return {async fetchPage(request) {
    if(request.provider==='instagram-apify'){
      try{
        if(!instagram)return {error:'provider_unconfigured'};
        const {rows,coverage}=await instagram.search({query:request.task.query,preserveText:request.preserveText===true});
        return {credits:0,httpStatus:200,coverage,result:{rows,cursor:null,oldest:coverage.oldest,rawCount:coverage.observedPosts,partial:coverage.partial,omitted:coverage.skippedPosts}};
      }catch(error){return {error:error.httpStatus===503?'provider_temporarily_unavailable':error.code||'instagram_provider_failed',httpStatus:error.httpStatus||null,runId:error.runId||null};}
    }
    if(request.task.kind==='reddit_comment_search'){
      try{
        if(!comments)return {error:'provider_unconfigured'};
        const {rows,coverage}=await comments.search({query:request.task.query,subreddit:request.task.name,cutoff:request.task.cutoff,limit:30,preserveText:request.preserveText===true});
        return {credits:0,coverage,result:{rows,cursor:null,oldest:coverage.oldest,rawCount:coverage.observedComments,partial:coverage.errors.length>0||coverage.observedComments>=30&&!(coverage.oldest<=request.task.cutoff),omitted:coverage.skippedComments>0}};
      }catch(error){return {error:error.code||'reddit_comments_provider_failed',runId:error.runId||null};}
    }
    let credits=null,httpStatus;
    try {
      const response=await fetchImpl(request.url,{headers:{'X-API-Key':env.SCRAPEBADGER_API_KEY,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(25000)});
      httpStatus=response.status;const receipt=response.headers.get('X-Credits-Used');
      if(receipt!==null && receipt.trim() && Number.isSafeInteger(Number(receipt)) && Number(receipt)>=0)credits=Number(receipt);
      const raw=await readText(response.ok?response:{ok:true,headers:response.headers,body:response.body},response.ok?2_097_152:65_536);
      if(!response.ok){
        let error;try{error=JSON.parse(raw).error;}catch{}
        if(response.status===503&&error==='temporarily_unavailable'&&socialTaskPlatform(request.task))return {credits:credits??0,httpStatus,error:'provider_temporarily_unavailable'};
        throw Error('upstream_status');
      }
      const body=JSON.parse(raw),task=request.task,collectedAt=iso(Date.now());let rows,values,cursor=null,stamps=[];
      if(socialTaskPlatform(task))return {credits,httpStatus,result:parseSocialPage(task,body,collectedAt,{preserveText:request.preserveText===true})};
      if(task.kind==='listing'||task.kind==='search') {
        values=body.posts;if(!Array.isArray(values)||values.length>100)throw Error('invalid_response');
        rows=values.map(v=>normalizeScrapeBadgerPost(v,collectedAt,{includeClosed:task.historical||task.includeClosed,preserveText:request.preserveText===true})).filter(v=>v&&(!task.name||v.url.split('/')[4]===task.name));
        cursor=body.pagination?.after || null;if(cursor && !/^t3_[a-z0-9]{1,20}$/.test(cursor))throw Error('invalid_cursor');
        stamps=values.map(v=>typeof v.created_utc==='number'?v.created_utc*1000:Date.parse(v.created_utc ?? v.created_at));
      } else if(task.kind==='comments') {
        values=body.tree ?? body.comments;if(!Array.isArray(values)||values.length>1000)throw Error('invalid_response');
        rows=normalizeScrapeBadgerComments(values,task.post,collectedAt,100,{includeClosed:task.historical||task.includeClosed,preserveText:request.preserveText===true});
      } else {
        values=body.data;if(!Array.isArray(values)||values.length>100)throw Error('invalid_response');
        rows=values.map(v=>normalizeTweet(v,collectedAt,{preserveText:request.preserveText})).filter(Boolean);cursor=body.next_cursor || null;
        if(cursor && (typeof cursor!=='string'||cursor.length>2048))throw Error('invalid_cursor');
        stamps=values.map(v=>Date.parse(v.created_at));
      }
      return {credits,httpStatus,result:{rows,cursor,...(task.kind==='comments'?{partial:rows.length>=100}:{}),oldest:stamps.length&&stamps.every(Number.isFinite)?Math.min(...stamps):null,rawCount:values.length}};
    } catch {return {credits,httpStatus,error:'unavailable_or_invalid_response'};}
  }};
}
export async function processCollection(store, settings, provider, productId) {
  const request=await store.claimCollection(settings,productId,Date.now());if(!request)return {status:'idle'};
  if(request.cached)return {status:'cached'};
  let result;try{result=await provider.fetchPage(request);}catch{result={credits:null,error:'uncertain_dispatch'};}
  return await store.finishCollection(request.token,result,Date.now()) || {status:'uncertain'};
}
