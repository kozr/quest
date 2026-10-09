import {discoveryTasks,mentionQueries} from './mention-discovery.mjs';
import {materializeCollectedConversations} from './conversation-pages.mjs';
import {commentThreadPriority} from './conversation-purpose.mjs';
import {plannedQueries,compileRedditQuery} from './search-plan.mjs';
import {captureEvidence,evidenceFor,qualificationInputHash,currentReviewFailure,conversationSourceKey} from './conversation-evidence.mjs';
import {randomUUID} from 'node:crypto';
import {stageQualifications,budgetDay} from './qualification.mjs';

const DAY=86400000;
export const BACKFILL_LIMITS={requests:200,candidates:2000,pending:150,pages:8,threads:24};
const iso=n=>new Date(n).toISOString();
const words=s=>String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
const stop=new Set('a an the my your our their its and or of to for in on with from by is are be can has have it this that keep manage follow supported official including only not selected see create sharing begin optional app website source confirms available varies release currently lists'.split(' '));
const quote=s=>'"'+String(s).replace(/["\\\n\r]/g,' ').trim()+'"';

// Queries come from the confirmed product profile; no business-specific prompt or paid planner.
export function historicalQueries(product) {
  const phrases=[...new Set((product.keywords||[]).map(s=>words(s).filter(w=>!stop.has(w)).slice(0,5).join(' ')).filter(Boolean))].slice(0,6);
  const counts=new Map();
  for(const value of [...(product.needs||[]),...(product.capabilities||[])]) {
    for(const w of new Set(words(value).filter(w=>w.length>3&&!stop.has(w)&&!/^\d+$/.test(w))))counts.set(w,(counts.get(w)||0)+1);
  }
  const terms=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,16).map(([w])=>w);
  const families=[];
  for(let i=0;i<terms.length;i+=4)families.push('('+terms.slice(i,i+4).map(quote).join(' OR ')+')');
  return {phrases,families};
}
export function backfillPlan(product,queries,now,{durable=false,settings={}}={}) {
  const cutoff=now-365*DAY;
  if(product.listeningVersion==='v2'){
    const reddit=plannedQueries(product,'reddit').map(q=>({kind:'search',query:compileRedditQuery(q),queryId:q.id,themeId:q.themeId,queryFamily:q.loop||q.queryFamily||q.family||'keyword',purposes:q.purposes,name:q.community,sort:'relevance',page:1,cutoff,until:now}));
    const originals=plannedQueries(product,'x'),x=[];
    for(let i=0;i<(durable?12:1);i++)queries.forEach((query,index)=>{
      const source=originals[index],until=now-Math.floor(i*365/12)*DAY,from=durable?Math.max(cutoff,now-Math.floor((i+1)*365/12)*DAY):cutoff;
      x.push({kind:'x',query:query.replace(/\b(?:since|until):\S+/g,'').trim(),...(source?{queryId:source.id,themeId:source.themeId,purposes:source.purposes}:{}),queryFamily:source?.loop||source?.queryFamily||source?.family||'keyword',page:1,cutoff:from,until});
    });
    const queue=[...(settings.commentSearchEnabled?mentionQueries(product).map(q=>({kind:'reddit_comment_search',query:q.query,queryId:q.id,queryFamily:'keyword',purposes:q.purposes,name:q.community,page:1,cutoff,until:now})):[]),...discoveryTasks(product,{settings,historical:true,cutoff,until:now})];while(reddit.length||x.length){if(reddit.length)queue.push(reddit.shift());if(x.length)queue.push(x.shift());}
    return queue.map((task,index)=>({...task,historical:true,branch:String(index)}));
  }
  const {phrases,families}=historicalQueries(product);
  const reddit=[...families,...phrases.slice(0,2).map(quote)].flatMap(q=>(product.communities||[]).map(name=>({kind:'search',query:`subreddit:${name} AND ${q}`,name,page:1,cutoff,until:now,sort:'relevance'})));
  // Keywords retain topical context when searching outside the saved communities.
  if(product.communities?.length)reddit.push(...phrases.map(q=>({kind:'search',query:q,page:1,cutoff,until:now,sort:'relevance'})));
  const x=[];
  for(let i=0;i<12;i++)for(const query of queries) {
    const until=now-Math.floor(i*365/12)*DAY,from=Math.max(cutoff,now-Math.floor((i+1)*365/12)*DAY);
    x.push({kind:'x',query:query.replace(/\b(?:since|until):\S+/g,'').trim(),page:1,cutoff:from,until});
  }
  const queue=[];
  while(reddit.length||x.length){if(reddit.length)queue.push(reddit.shift());if(x.length)queue.push(x.shift());}
  return queue.map((task,index)=>({...task,historical:true,branch:String(index)}));
}
export function createBackfill(data,product,queries,profileKey,now,{settings={}}={}) {
  const s=data.collection;s.backfills ||= {};
  // Retain server-owned job identity when a later profile replaces the visible job.
  // Historical AI billing must still recognize conversations from the old run.
  if(data.subscription){s.backfillRuns||={};const prior=s.backfills[product.id];if(prior)s.backfillRuns[prior.id]={id:prior.id,productId:prior.productId,profileKey:prior.profileKey,startedAt:prior.startedAt,from:prior.from,to:prior.to};}
  // Starting twice (including a repeated onboarding request) never replays paid work.
  if(s.backfills[product.id] && (s.backfills[product.id].profileKey===profileKey || !data.subscription&&['running','reviewing'].includes(s.backfills[product.id].status)))return structuredClone(s.backfills[product.id]);
  const durable=Boolean(data.subscription),queue=backfillPlan(product,queries,now,{durable,settings});
  const job={id:randomUUID(),productId:product.id,profileKey,mode:'backfill',trigger:'onboarding',status:queue.length?'running':durable?'unavailable':'complete',...(durable?{retention:'durable',limitWindow:{day:budgetDay(now),requestStart:0,stagedStart:0}}:{}),startedAt:iso(now),from:iso(now-365*DAY),to:iso(now),queue,requests:0,rows:0,staged:0,duplicates:0,filtered:0,unassessed:0,errors:[],threads:{},branches:queue.map(t=>({id:t.branch,platform:t.kind==='x'?'x':t.kind==='reddit_comment_search'?'reddit_comment_search':t.kind.startsWith('maps_')?'maps':t.kind==='app_store_reviews'?'app_store_reviews':t.kind==='google_search'?'google':'reddit',query:t.query,...(t.queryId?{queryId:t.queryId}:{}),...(t.themeId?{themeId:t.themeId}:{}),queryFamily:t.queryFamily||'keyword',from:iso(t.cutoff),to:iso(t.until),pages:0,rows:0,status:'queued'}))};
  if(!queue.length)job.finishedAt=iso(now);
  s.backfills[product.id]=job;
  if(durable)s.backfillRuns[job.id]={id:job.id,productId:job.productId,profileKey:job.profileKey,startedAt:job.startedAt,from:job.from,to:job.to};
  return structuredClone(job);
}
export function backfillReviews(data,job) {
  const counts={pending:0,running:0,qualified:0,rejected:0,uncertain:0};
  const product=data.products.find(row=>row.id===job.productId);
  if(job.retention==='durable'&&product?.listeningVersion==='v2'){
    for(const row of evidenceFor(data,product))if(row.backfillId===job.id||row.backfillIds?.includes(job.id)){
      if(currentReviewFailure(data,product,row))counts.uncertain++;
      else if(row.qualification?.profileHash===qualificationInputHash(product))counts[row.qualification.relevant?'qualified':'rejected']++;
      else counts.pending++;
    }
    return counts;
  }
  for(const q of Object.values(data.qualifications||{}))if(q.backfillId===job.id)counts[q.status]=(counts[q.status]||0)+1;
  return counts;
}
export function finishBackfill(data,job,now) {
  if(job.queue.length)return;
  const q=backfillReviews(data,job);
  if(job.retention==='durable'){
    const failed=job.branches.filter(branch=>branch.status==='failed').length;
    const gaps=job.errors.length||job.unassessed||job.branches.some(branch=>['failed','partial','page_limit','repeated_cursor','limited'].includes(branch.status));
    const completion=!job.branches.length?'unavailable':failed===job.branches.length?'failed':gaps?'partial':'complete';
    job.coverageStatus=completion;
    job.status=q.pending+q.running?'reviewing':completion;
    if(job.status!=='reviewing')job.finishedAt ||= iso(now);
    return;
  }
  job.status=q.pending+q.running?'reviewing':'complete';
  if(job.status==='complete')job.finishedAt ||= iso(now);
}
export function backfillBlock(data,job,now) {
  if(job.retention==='durable'||data.subscription){
    job.retention='durable';
    if(!job.limitWindow||job.limitWindow.day!==budgetDay(now))job.limitWindow={day:budgetDay(now),requestStart:job.requests,stagedStart:job.staged};
    const requests=job.requests-job.limitWindow.requestStart,candidates=job.staged-job.limitWindow.stagedStart;
    if(requests>=BACKFILL_LIMITS.requests||candidates>=BACKFILL_LIMITS.candidates){
      job.blocked=requests>=BACKFILL_LIMITS.requests?'daily_history_request_limit':'daily_history_candidate_limit';
      // Keep every remaining branch and cursor for the next budget day.
      return true;
    }
    delete job.blocked;return false;
  }
  const q=backfillReviews(data,job);
  if(job.staged>=BACKFILL_LIMITS.candidates || job.requests>=BACKFILL_LIMITS.requests) {
    job.errors.push(job.staged>=BACKFILL_LIMITS.candidates?'candidate_limit':'request_limit');
    for(const b of job.branches)if(['queued','running'].includes(b.status))b.status='limited';
    job.unassessed+=job.queue.length;job.queue=[];finishBackfill(data,job,now);return true;
  }
  // Stop fetching before pending text can grow the 8 MiB transactional document.
  const size=Buffer.byteLength(JSON.stringify(data));
  if(q.pending+q.running>=BACKFILL_LIMITS.pending || size>6*1024*1024) {
    job.blocked=size>6*1024*1024?'storage_capacity':'awaiting_ai_review';return true;
  }
  if(Object.keys(data.qualifications||{}).length>=9900){job.blocked='qualification_history_full';return true;}
  delete job.blocked;return false;
}
export function backfillError(job,task,error) {
  job.errors.push(`${task.kind}:${error}`);
  const branch=job.branches.find(b=>b.id===task.branch);if(branch&&task.kind!=='comments')branch.status='failed';
}
export function applyBackfillPage(data,job,task,result,now) {
  const product=data.products.find(p=>p.id===job.productId);if(!product)return;
  const branch=job.branches.find(b=>b.id===task.branch);
  if(branch){branch.pages++;branch.rows+=result.rows.length;branch.status='running';}
  job.rows+=result.rows.length;
  const candidates=result.rows.filter(row=> {
    const at=Date.parse(row.publishedAt);
    return Number.isFinite(at)&&at>=Date.parse(job.from)&&at<Date.parse(job.to)&&!(product.exclusions||[]).some(t=>`${row.title} ${row.snippet}`.toLowerCase().includes(t.toLowerCase()));
  }).map(row=>({...row,...(task.queryId?{queryId:task.queryId}:{}),...(task.queryFamily?{queryFamily:task.queryFamily}:{}),snippet:data.subscription?String(row.snippet??row.text??''):row.snippet.slice(0,3000),pipeline:'experiment-v1',backfillId:job.id,historical:true,...(task.kind==='comments'?{context:data.subscription?`${task.post.title}\n${task.post.snippet}`:`${task.post.title}\n${task.post.snippet}`.slice(0,1500)}:{})}));
  job.filtered+=result.rows.length-candidates.length;
  const eligible=data.subscription?candidates:candidates.slice(0,Math.max(0,BACKFILL_LIMITS.candidates-job.staged));
  const before=data.subscription&&product.listeningVersion==='v2'?new Map(evidenceFor(data,product).map(row=>[conversationSourceKey(row.url),row.contentHash])):null;
  captureEvidence(data,product,eligible,iso(now));
  if(data.subscription)materializeCollectedConversations(data,product,eligible,iso(now));
  const changed=before?evidenceFor(data,product).filter(row=>row.backfillIds?.includes(job.id)&&before.get(conversationSourceKey(row.url))!==row.contentHash).length:eligible.length;
  const staged=product.listeningVersion==='v2'?{pending:changed,duplicates:eligible.length-changed}:stageQualifications(data,product,eligible,iso(now),'onboarding');
  job.staged+=staged.pending;job.duplicates+=staged.duplicates||0;
  job.unassessed+=candidates.length-eligible.length+(staged.unassessed||0);
  if(task.kind==='search' && Object.keys(job.threads).length<BACKFILL_LIMITS.threads) {
    const post=candidates.filter(row=>row.commentCount!==0&&!job.threads[row.sourceId]&&commentThreadPriority(product,row,task.purposes||[])>0).sort((a,b)=>commentThreadPriority(product,b,task.purposes||[])-commentThreadPriority(product,a,task.purposes||[]))[0];
    if(post){job.threads[post.sourceId]=true;job.queue.push({kind:'comments',post,historical:true,queryId:task.queryId,queryFamily:task.queryFamily,cutoff:Date.parse(job.from),until:Date.parse(job.to)});}
  }
  if(task.kind!=='comments') {
    const repeated=result.cursor&&(task.cursors||[]).includes(result.cursor);
    const pageLimit=(!data.subscription&&task.page>=BACKFILL_LIMITS.pages)||(task.kind==='reddit_comment_search'&&task.page>=20);
    // Relevance order is not chronological: an old result cannot end Reddit pagination.
    const boundary=['x','maps_reviews','app_store_reviews','reddit_comment_search'].includes(task.kind)&&Number.isFinite(result.oldest)&&result.oldest<=task.cutoff;
    if(result.cursor&&!repeated&&!pageLimit&&!boundary&&result.rawCount!==0) {
      job.queue.push({...task,page:task.page+1,cursor:result.cursor,cursors:[...(task.cursors||[]),result.cursor]});
      if(branch)branch.status='queued';
    } else if(branch) {
      branch.status=repeated?'repeated_cursor':pageLimit&&result.cursor?'page_limit':data.subscription&&(result.partial||result.omitted||task.incomplete)?'partial':'searched';
      if(['repeated_cursor','page_limit'].includes(branch.status))job.errors.push(`${task.kind}:${branch.status}`);
    }
  }
  if(data.subscription&&(result.partial||result.omitted)){
    job.errors.push(`${task.kind}:${result.partial?'partial_provider_response':'omitted_results'}`);
    if(branch&&branch.status==='searched')branch.status='partial';
  }
  finishBackfill(data,job,now);
}
export function backfillPublic(data,job) {
  const reviews=backfillReviews(data,job);
  return {id:job.id,status:job.status,from:job.from,to:job.to,startedAt:job.startedAt,finishedAt:job.finishedAt||null,remaining:job.queue.length,requests:job.requests,rows:job.rows,staged:job.staged,duplicates:job.duplicates,filtered:job.filtered,unassessed:job.unassessed,errors:job.errors,blocked:job.blocked||null,reviews,limits:job.retention==='durable'?{dailyRequests:BACKFILL_LIMITS.requests,dailyCandidates:BACKFILL_LIMITS.candidates,selectedThreads:BACKFILL_LIMITS.threads,resumable:true}:BACKFILL_LIMITS,branches:job.branches,...(job.retention==='durable'?{coverageStatus:job.coverageStatus||'in_progress',resumable:job.queue.length>0}:{}),coverage:'Search indexes, direct Reddit comment searches, verified business/app reviews and original pages discovered through Google where configured. Provider limits, failures and unfinished branches are reported; this is not an exhaustive archive.'};
}
