import {commentThreadPriority} from './conversation-purpose.mjs';
import {activeSearchPlan,plannedQueries,compileRedditQuery,listeningReady} from './search-plan.mjs';
import {captureEvidence,reviewQueueBlock} from './conversation-evidence.mjs';
import {createBackfill,backfillBlock,applyBackfillPage,backfillError,backfillPublic,finishBackfill} from './backfill.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {normalizeScrapeBadgerPost, normalizeScrapeBadgerComments} from './reddit/scrapebadger.mjs';
import {readText} from './reddit/http.mjs';
import {stageQualifications, budgetDay} from './qualification.mjs';

export const COLLECTION_VERSION = 'experiment-v1';
export const COLLECTION_INTERVAL_MS = 2 * 3600000;
const OVERLAP = 15 * 60000, DAY = 86400000, PACE = 15000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const profileKey = p => digest({discoveryVersion:'purpose-discovery-v1',communities:p.communities,keywords:p.keywords,aliases:p.aliases,competitorNames:p.competitorNames,x:p.x,xQueries:p.xQueries,capabilities:p.capabilities,exclusions:p.exclusions,...(p.listeningVersion?{listeningVersion:p.listeningVersion,searchPlan:p.searchPlanV2}:{})});
const iso = now => new Date(now).toISOString();
export function collectionSettings(env = process.env) {
  return {enabled:env.TRACKER_COLLECTION_PIPELINE === COLLECTION_VERSION,
    configured:Boolean(env.SCRAPEBADGER_API_KEY), dailyCreditLimit:3333}; // <= $0.50 PAYG/day
}
export function xQueries(product) {
  if(product.listeningVersion==='v2')return plannedQueries(product,'x').map(q=>`${q.query} lang:en -filter:retweets`);
  if(product.x === false) return [];
  const explicit=(product.xQueries || []).filter(q=>typeof q==='string' && q.trim()).slice(0,2);
  if(explicit.length)return explicit;
  // Product-specific phrases are editable. Never hard-code a test business.
  return [...new Set((product.keywords || []).slice(0,2).map(q=>`"${q.replace(/["\\\n\r]/g,' ').trim()}" lang:en -filter:retweets`))];
}
export function normalizeTweet(t, collectedAt) {
  const when=Date.parse(t.created_at), text=t.full_text ?? t.text;
  if(!/^\d{1,30}$/.test(t.id ?? '') || typeof text!=='string' || !text.trim() || !Number.isFinite(when) || when>Date.parse(collectedAt)+300000 || t.is_retweet)return null;
  return {source:'X',provider:'scrapebadger',sourceId:`x_${t.id}`,postId:`x_${t.conversation_id ?? t.id}`,parentId:t.in_reply_to_status_id?`x_${t.in_reply_to_status_id}`:null,type:t.in_reply_to_status_id?'comment':'post',url:`https://x.com/i/status/${t.id}`,title:text.slice(0,180),snippet:text.slice(0,10000),publishedAt:iso(when),collectedAt,author:typeof t.user?.screen_name==='string'?t.user.screen_name:null};
}
function state(data) {
  const s=data.collection ||= {version:COLLECTION_VERSION,cycles:{},watermarks:{},threads:{},cache:{},daily:{},receipts:[],nextRequestAt:0};
  s.backfills ||= {};return s;
}
export function beginBackfill(data,productId,now=Date.now()) {
  const product=data.products.find(p=>p.id===productId);if(!product)return null;
  state(data);return createBackfill(data,product,xQueries(product),digest([profileKey(product),product.needs]),now);
}
const requestCycle=(s,r)=>r.mode==='backfill'?s.backfills[r.productId]:s.cycles[r.productId];
const sourceKey = (productId, task) => `${productId}:${task.kind}:${task.query ? digest(task.query) : task.name}`;
function finishCycle(data, cycle, now) {
  cycle.status='complete'; cycle.finishedAt=iso(now); delete cycle.queue; delete cycle.posts;
  const search=data.searches[cycle.productId] ||= {sources:[],lastChecks:{},found:0};
  search.searchedAt=iso(now); search.pipeline=COLLECTION_VERSION;
  search.lastChecks ||= {};
  const sources=cycle.sources.map(name=>({name,provider:'scrapebadger',status:cycle.errors.length?'partial':'ok',checkedAt:iso(now),
    message:`${cycle.requests} collection requests; ${cycle.rows} returned objects; ${cycle.staged} candidates submitted for review. ${cycle.unassessed} candidates exceeded the cycle limit. Bounded feeds, two pages per search and four comment threads; coverage is partial.${cycle.errors.length?' Some requests failed or reached their page limit.':''}`,coverage:{complete:false,errors:cycle.errors}}));
  for(const source of sources)search.lastChecks[source.name==='X'?'x':'reddit']=iso(now);
  search.sources=[...sources,...(search.sources || []).filter(s=>!cycle.sources.includes(s.name))];
}
export function beginCollection(data, productId, trigger, now = Date.now()) {
  const product=data.products.find(p=>p.id===productId); if(!product)return null;
  const s=state(data), prior=s.cycles[productId];
  if(prior?.status==='running')return structuredClone(prior);
  if(trigger==='scheduled' && (!product.monitoring || prior && now-Date.parse(prior.startedAt)<COLLECTION_INTERVAL_MS))return null;
  const plan=activeSearchPlan(product);
  const queue=[...(plan?plannedQueries(product,'reddit').map(q=>({kind:'search',query:compileRedditQuery(q),queryId:q.id,purposes:q.purposes,name:q.community,page:1,sort:'new',includeClosed:true})):(product.communities || []).map(name=>({kind:'listing',name,page:1}))),...xQueries(product).map(query=>({kind:'x',query,page:1}))];
  for(const task of queue) {
    const mark=s.watermarks[sourceKey(productId,task)] || (task.kind==='listing'?data.searches[productId]?.lastChecks?.reddit:null);
    task.cutoff=mark?Date.parse(mark)-OVERLAP:now-DAY;
  }
  const cycle={id:randomUUID(),productId,profileKey:profileKey(product),trigger,startedAt:iso(now),status:'running',queue,posts:[],threadsPlanned:false,rows:0,staged:0,unassessed:0,requests:0,errors:[],sources:[...((plan?.themes.some(t=>t.queries.some(q=>q.platform==='reddit'))||product.communities?.length)?['Reddit watchlist']:[]),...(xQueries(product).length?['X']:[])]};
  s.cycles[productId]=cycle;
  product.monitorAttempts={...product.monitorAttempts,reddit:iso(now),x:iso(now)};
  if(!queue.length)finishCycle(data,cycle,now);
  return structuredClone(cycle);
}
function planThreads(data, cycle, now) {
  if(cycle.threadsPlanned)return;
  cycle.threadsPlanned=true;
  const s=state(data), product=data.products.find(p=>p.id===cycle.productId);
  const candidates=[...new Map(cycle.posts.map(row=>[row.sourceId,row])).values()].filter(row=> {
    if(row.commentCount===0)return false;
    const priority=commentThreadPriority(product,row,row.discoveryPurposes||[]);
    return priority>0&&(Date.parse(row.publishedAt)>=now-7*DAY||priority>=3);
  }).filter(row=> {
    const prior=s.threads[`${cycle.productId}:${row.sourceId}`];
    // A daily refresh covers edits that do not change the count.
    return !prior || row.commentCount===null || prior.commentCount!==row.commentCount || now-Date.parse(prior.checkedAt)>=DAY;
  }).sort((a,b)=>commentThreadPriority(product,b,b.discoveryPurposes||[])-commentThreadPriority(product,a,a.discoveryPurposes||[])||(Date.parse(s.threads[`${cycle.productId}:${a.sourceId}`]?.checkedAt || '') || 0)-(Date.parse(s.threads[`${cycle.productId}:${b.sourceId}`]?.checkedAt || '') || 0) || Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
  cycle.queue.push(...candidates.slice(0,4).map(post=>({kind:'comments',post,includeClosed:product.listeningVersion==='v2'})));
}
function taskURL(task) {
  const url=new URL(task.kind==='search'?'https://scrapebadger.com/v1/reddit/search/posts':task.kind==='listing'?`https://scrapebadger.com/v1/reddit/subreddits/${task.name}/posts`:task.kind==='comments'?`https://scrapebadger.com/v1/reddit/posts/${task.post.postId.slice(3)}/comments`:'https://scrapebadger.com/v1/twitter/tweets/advanced_search');
  const params=task.kind==='search'?{q:task.query,sort:task.sort,t:'year',limit:'50',...(task.cursor?{after:task.cursor}:{})}:task.kind==='listing'?{sort:'new',limit:'30',...(task.cursor?{after:task.cursor}:{})}:task.kind==='comments'?{sort:'new',limit:'100',depth:'10'}:{query:`${task.query} since:${iso(task.cutoff).slice(0,10)}${task.until?' until:'+iso(task.until+DAY).slice(0,10):''}`,query_type:'Latest',count:'20',...(task.cursor?{cursor:task.cursor}:{})};
  url.search=new URLSearchParams(params).toString();return url.href;
}
function settleHold(s, request, outcome, now) {
  const day=s.daily[request.day]; day.reservedCredits-=request.reserve;
  const known=Number.isSafeInteger(outcome.credits) && outcome.credits>=0;
  const amount=known?outcome.credits:request.reserve;
  day.spentCredits+=amount; if(!known)day.uncertainCredits+=amount;
  if(amount>request.reserve)s.overrun=true;
  s.receipts.push({id:request.token,productId:request.productId,cycleId:request.cycleId,platform:request.task.kind==='x'?'x':'reddit',kind:request.task.kind,at:iso(now),credits:known?amount:null,unknownReservation:known?0:amount,status:outcome.error?'failed':'settled',...(outcome.httpStatus?{httpStatus:outcome.httpStatus}:{})});
  s.receipts=s.receipts.slice(-2000);
}
export function claimCollection(data, settings, productId, now = Date.now()) {
  const s=state(data); if(!settings.enabled || !settings.configured || s.overrun)return null;
  if(s.active && s.active.expiresAt<=now) {
    const expired=s.active; settleHold(s,expired,{error:'uncertain_dispatch'},now);
    const cycle=requestCycle(s,expired);if(cycle?.id===expired.cycleId){if(expired.mode==='backfill')backfillError(cycle,expired.task,'uncertain_dispatch');else cycle.errors.push('uncertain_dispatch');}
    delete s.active; // Task was removed before dispatch. Never replay it.
  }
  if(s.active || now<s.nextRequestAt)return null;
  const regular=s.cycles[productId],backfill=s.backfills[productId];
  if(backfill?.status==='reviewing')finishBackfill(data,backfill,now);
  const regularReady=regular?.status==='running';
  const backfillReady=backfill?.status==='running'&&!backfillBlock(data,backfill,now);
  const cycle=backfillReady&&(!regularReady||s.lastMode==='regular')?backfill:regularReady?regular:null;
  const product=data.products.find(p=>p.id===productId);
  if(!cycle || cycle.status!=='running' || !product)return null;
  if(!listeningReady(product)){cycle.blocked='search_plan_needs_review';return null;}
  if(cycle.profileKey!==(cycle.mode==='backfill'?digest([profileKey(product),product.needs]):profileKey(product))){cycle.status='profile_changed';cycle.queue=[];delete cycle.posts;return null;}
  if(cycle.trigger==='scheduled' && !product.monitoring){cycle.status='paused';delete cycle.queue;delete cycle.posts;return null;}
  const reviewBlock=reviewQueueBlock(data,product);
  if(reviewBlock){cycle.blocked=reviewBlock;return null;}
  if(Buffer.byteLength(JSON.stringify(data))>4*1024*1024){cycle.blocked='storage_capacity';return null;}
  if(!cycle.queue.length && cycle.mode!=='backfill')planThreads(data,cycle,now);
  if(!cycle.queue.length){cycle.mode==='backfill'?finishBackfill(data,cycle,now):finishCycle(data,cycle,now);return null;}
  const task=cycle.queue[0],url=taskURL(task),cache=s.cache[digest([url,Boolean(task.historical||task.includeClosed)])];
  if(cache && now-cache.at<OVERLAP) {
    cycle.queue.shift();applyPage(data,cycle,task,structuredClone(cache.result),now);return {cached:true};
  }
  const dayKey=budgetDay(now),day=s.daily[dayKey] ||= {spentCredits:0,reservedCredits:0,uncertainCredits:0,calls:0};
  const reserve=task.kind==='comments'?200:task.kind==='x'?101:102;
  if(day.spentCredits+day.reservedCredits+reserve>settings.dailyCreditLimit){cycle.blocked='daily_scraper_budget';return null;}
  delete cycle.blocked;
  const request={mode:cycle.mode||'regular',token:randomUUID(),productId,cycleId:cycle.id,task,url,day:dayKey,reserve,expiresAt:now+45000};
  day.reservedCredits+=reserve;day.calls++;cycle.requests++;cycle.queue.shift();
  s.lastMode=request.mode;s.nextRequestAt=now+PACE;s.active=request;return structuredClone(request);
}
function applyPage(data,cycle,task,result,now) {
  if(cycle.mode==='backfill')return applyBackfillPage(data,cycle,task,result,now);
  const s=state(data),product=data.products.find(p=>p.id===cycle.productId);if(!product)return;
  const rows=(result.rows || []).map(row=>({...row,snippet:row.snippet.slice(0,3000)}));cycle.rows+=rows.length;
  if(['listing','search'].includes(task.kind))cycle.posts.push(...rows.map(row=>({...row,discoveryPurposes:task.purposes||[]})));
  const candidates=rows.filter(row=>!(product.exclusions || []).some(term=>`${row.title} ${row.snippet}`.toLowerCase().includes(term.toLowerCase()))).map(row=>({...row,...(task.queryId?{queryId:task.queryId}:{}),pipeline:COLLECTION_VERSION,...(task.kind==='comments'?{context:`${task.post.title}\n${task.post.snippet}`.slice(0,1500)}:{pipelineCutoff:iso(task.cutoff)})}));
  const eligible=candidates.slice(0,Math.max(0,60-cycle.staged));
  captureEvidence(data,product,candidates,iso(now));
  const staged=product.listeningVersion==='v2'?{pending:eligible.length}:stageQualifications(data,product,eligible,iso(now),cycle.trigger);
  cycle.staged+=staged.pending;cycle.unassessed+=Math.max(0,candidates.length-eligible.length);
  if(task.kind==='comments')s.threads[`${cycle.productId}:${task.post.sourceId}`]={commentCount:task.post.commentCount,checkedAt:iso(now)};
  else {
    const reachedBoundary=Number.isFinite(result.oldest) && result.oldest<=task.cutoff;
    if(result.cursor && !reachedBoundary && task.page<2 && result.cursor!==task.cursor)cycle.queue.unshift({...task,page:task.page+1,cursor:result.cursor});
    else {
      if(result.cursor && !reachedBoundary)cycle.errors.push(`${task.kind}:page_limit`);
      // Advance only after successful pages; a failed page keeps the prior watermark.
      s.watermarks[sourceKey(cycle.productId,task)]=cycle.startedAt;
    }
  }
  if(!cycle.queue.length)planThreads(data,cycle,now);
  if(!cycle.queue.length)finishCycle(data,cycle,now);
}
export function finishCollection(data, token, outcome, now = Date.now()) {
  const s=state(data),request=s.active;if(!request || request.token!==token)return null;
  settleHold(s,request,outcome,now);delete s.active;
  const cycle=requestCycle(s,request);if(cycle?.id!==request.cycleId)return null;
  const product=data.products.find(p=>p.id===request.productId);
  if(!product||!listeningReady(product)||cycle.profileKey!==(cycle.mode==='backfill'?digest([profileKey(product),product.needs]):profileKey(product))){cycle.status='profile_changed';cycle.queue=[];delete cycle.posts;return {status:'profile_changed'};}
  if(outcome.error){if(request.mode==='backfill'){backfillError(cycle,request.task,outcome.error);finishBackfill(data,cycle,now);}else cycle.errors.push(`${request.task.kind}:${outcome.error}`);}
  else {
    outcome.result.rows=outcome.result.rows.map(row=>({...row,snippet:row.snippet.slice(0,3000)}));
    s.cache[digest([request.url,Boolean(request.task.historical||request.task.includeClosed)])]={at:now,result:outcome.result};
    s.cache=Object.fromEntries(Object.entries(s.cache).filter(([,v])=>now-v.at<OVERLAP).slice(-8));
    applyPage(data,cycle,request.task,outcome.result,now);
  }
  return {status:cycle.status};
}
export function collectionDueIds(data, now = Date.now()) {
  return data.products.filter(p=>listeningReady(p)).filter(p=>['running','reviewing'].includes(data.collection?.backfills?.[p.id]?.status) || data.collection?.cycles?.[p.id]?.status==='running' && (p.monitoring || data.collection.cycles[p.id].trigger==='manual')).map(p=>p.id);
}
export function collectionPublicState(data, now=Date.now()) {
  const s=data.collection;if(!s)return {version:COLLECTION_VERSION,cycles:{}};
  return {version:COLLECTION_VERSION,day:budgetDay(now),budget:s.daily[budgetDay(now)] || {},limitCredits:3333,overrun:Boolean(s.overrun),
    backfills:Object.fromEntries(Object.entries(s.backfills||{}).map(([id,j])=>[id,backfillPublic(data,j)])),
    cycles:Object.fromEntries(Object.entries(s.cycles).map(([id,c])=>[id,{status:c.status,startedAt:c.startedAt,finishedAt:c.finishedAt || null,remaining:c.queue?.length || 0,requests:c.requests,staged:c.staged,unassessed:c.unassessed,errors:c.errors,blocked:c.blocked || null}]))};
}
export function createCollectionProvider({env=process.env,fetchImpl=fetch}={}) {
  return {async fetchPage(request) {
    let credits=null,httpStatus;
    try {
      const response=await fetchImpl(request.url,{headers:{'X-API-Key':env.SCRAPEBADGER_API_KEY,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(25000)});
      httpStatus=response.status;const receipt=response.headers.get('X-Credits-Used');
      if(receipt!==null && receipt.trim() && Number.isSafeInteger(Number(receipt)) && Number(receipt)>=0)credits=Number(receipt);
      const raw=await readText(response,2_097_152);if(!response.ok)throw Error('upstream_status');
      const body=JSON.parse(raw),task=request.task,collectedAt=iso(Date.now());let rows,values,cursor=null,stamps=[];
      if(task.kind==='listing'||task.kind==='search') {
        values=body.posts;if(!Array.isArray(values)||values.length>100)throw Error('invalid_response');
        rows=values.map(v=>normalizeScrapeBadgerPost(v,collectedAt,{includeClosed:task.historical||task.includeClosed})).filter(v=>v&&(!task.name||v.url.split('/')[4]===task.name));
        cursor=body.pagination?.after || null;if(cursor && !/^t3_[a-z0-9]{1,20}$/.test(cursor))throw Error('invalid_cursor');
        stamps=values.map(v=>typeof v.created_utc==='number'?v.created_utc*1000:Date.parse(v.created_utc ?? v.created_at));
      } else if(task.kind==='comments') {
        values=body.tree ?? body.comments;if(!Array.isArray(values)||values.length>1000)throw Error('invalid_response');
        rows=normalizeScrapeBadgerComments(values,task.post,collectedAt,100,{includeClosed:task.historical||task.includeClosed});
      } else {
        values=body.data;if(!Array.isArray(values)||values.length>100)throw Error('invalid_response');
        rows=values.map(v=>normalizeTweet(v,collectedAt)).filter(Boolean);cursor=body.next_cursor || null;
        if(cursor && (typeof cursor!=='string'||cursor.length>2048))throw Error('invalid_cursor');
        stamps=values.map(v=>Date.parse(v.created_at));
      }
      return {credits,httpStatus,result:{rows,cursor,oldest:stamps.length&&stamps.every(Number.isFinite)?Math.min(...stamps):null,rawCount:values.length}};
    } catch {return {credits,httpStatus,error:'unavailable_or_invalid_response'};}
  }};
}
export async function processCollection(store, settings, provider, productId) {
  const request=await store.claimCollection(settings,productId,Date.now());if(!request)return {status:'idle'};
  if(request.cached)return {status:'cached'};
  let result;try{result=await provider.fetchPage(request);}catch{result={credits:null,error:'uncertain_dispatch'};}
  return await store.finishCollection(request.token,result,Date.now()) || {status:'uncertain'};
}
