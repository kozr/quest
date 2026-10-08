import {createHash, randomUUID} from 'node:crypto';
import {publicSourceURL} from './discovery.mjs';
import {readText} from './reddit/http.mjs';
import {TAVERN_QUALIFICATION_PROMPT,TAVERN_COMMENT_INSTRUCTIONS} from './qualification-policy.mjs';
import {businessConstraints} from './business-profile.mjs';

export const QUALIFICATION_MODEL = 'gpt-6.1-sol';
export const QUALIFICATION_VERSION = 'tracker-tavern-evidence-v3';
const OUTPUT_TOKENS = 1600;
const LEASE_MS = 120000;
export const AI_BUDGET_TIME_ZONE = 'America/Los_Angeles';
const pacificDay = new Intl.DateTimeFormat('en-CA',{timeZone:AI_BUDGET_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
export const budgetDay = now => pacificDay.format(new Date(now));
// Standard Sol prices verified against OpenAI's model page on 2026-10-08.
// No tools, images, Fast/priority tier, retries, or other models are requested.
const INPUT_RATE = 2.50, OUTPUT_RATE = 10; // micro-USD per token
const digest = value => createHash('sha256').update(value).digest('hex');
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max) : '';
const iso = now => new Date(now).toISOString();

export function qualificationSettings(env = process.env, now = Date.now()) {
  const enabled = env.TRACKER_AI_ENABLED === 'true';
  const mode = env.TRACKER_AI_MODE === undefined ? 'ongoing' : ['test','ongoing'].includes(env.TRACKER_AI_MODE) ? env.TRACKER_AI_MODE : null;
  const dollars = Number(env.TRACKER_AI_DAILY_BUDGET_USD || 0), maxCalls = Number(env.TRACKER_AI_DAILY_MAX_CALLS || 2000);
  const until = Date.parse(env.TRACKER_AI_BUDGET_UNTIL || '');
  // The owner's approved tracker allowance is $2 per Pacific day. A larger
  // environment value cannot raise it. Homiegraph has no access to this ledger.
  const budgetReady = mode && Number.isFinite(dollars) && dollars > 0 && dollars <= 2 && Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 2000 && (!env.TRACKER_AI_BUDGET_UNTIL || Number.isFinite(until) && until > now);
  const configured = Boolean(env.TRACKER_OPENAI_API_KEY) && budgetReady;
  return {enabled, configured, active:enabled && configured, mode, model:QUALIFICATION_MODEL,
    budgetMicroUsd: Math.floor(dollars * 1e6), maxCalls, until: Number.isFinite(until) ? until : Infinity,
    dailyMaxCalls:maxCalls, reason:!enabled?'disabled':!env.TRACKER_OPENAI_API_KEY?'key_required':!budgetReady?'budget_required':null};
}

export function canonicalPost(row) {
  const url = publicSourceURL(row?.url);
  if (!url) return null;
  const parsed = new URL(url);
  if (row.source?.startsWith('Reddit') && ['reddit.com','www.reddit.com','old.reddit.com'].includes(parsed.hostname)) {
    const comment = parsed.pathname.match(/^\/r\/([\w]{2,21})\/comments\/([a-z0-9]+)\/[^/]+\/([a-z0-9]+)\/?$/i);
    if(comment) return {identity:`reddit:t1_${comment[3].toLowerCase()}`,platform:'reddit',subreddit:comment[1].toLowerCase(),url:`https://www.reddit.com/r/${comment[1].toLowerCase()}/comments/${comment[2].toLowerCase()}/_/${comment[3].toLowerCase()}/`};
    if(row.type && row.type!=='post')return null;
    const match = parsed.pathname.match(/^\/r\/([\w]{2,21})\/comments\/([a-z0-9]+)\/(?:[^/]+\/?)?$/i);
    if (!match) return null;
    return {identity:`reddit:${match[2].toLowerCase()}`, platform:'reddit', subreddit:match[1].toLowerCase(),
      url:`https://www.reddit.com/r/${match[1].toLowerCase()}/comments/${match[2].toLowerCase()}/`};
  }
  if(row.source==='X' && ['x.com','www.x.com','twitter.com','www.twitter.com'].includes(parsed.hostname)) {
    const match=parsed.pathname.match(/^\/(?:i|[a-z0-9_]{1,15})\/status\/(\d{1,30})\/?$/i);
    return match?{identity:`x:${match[1]}`,platform:'x',url:`https://x.com/i/status/${match[1]}`}:null;
  }
  if (row.source === 'LinkedIn' && ['linkedin.com','www.linkedin.com'].includes(parsed.hostname)) {
    const match = parsed.pathname.match(/^\/posts\/[a-z0-9%._-]+_[a-z0-9%._-]+-(\d{10,20})-[a-z0-9_-]+\/?$/i);
    if (!match) return null;
    return {identity:`linkedin:${match[1]}`, platform:'linkedin', url:url.split('?')[0]};
  }
  return null;
}
export function qualificationKey(productId, identity, contentHash) {return digest(`${productId}:${identity}${contentHash?`:${contentHash}`:''}`);}
export function profileSnapshot(product) {
  return {capabilities:(product.capabilities || []).filter(value => typeof value === 'string' && value.trim()).slice(0,8).map(value => {
    const content=text(value,320); return {id:`cap:${digest(content).slice(0,16)}`,text:content};
  }), needs:(product.needs || []).map(value => text(value,240)).filter(Boolean).slice(0,8),...(product.profileVersion==='v2'?{constraints:businessConstraints(product)}:{})};
}
export function profileHash(product) {return digest(JSON.stringify({profile:profileSnapshot(product),communities:product.communities,linkedin:product.linkedin,x:product.x,xQueries:product.xQueries,exclusions:product.exclusions}));}

export const QUALIFICATION_PROMPT = TAVERN_QUALIFICATION_PROMPT;

export function postEvidence(row) {
  const passages=[];
  for (const [field,content] of Object.entries({title:text(row.title,1000),body:text(row.snippet,3000)})) {
    let start=0;
    while(start<content.length) {
      let end=Math.min(start+500,content.length);
      if(end<content.length) {const boundary=content.slice(start,end).search(/\s+\S*$/u);if(boundary>0)end=start+boundary;if(/[\uD800-\uDBFF]/u.test(content[end-1]))end--;}
      const excerpt=content.slice(start,end); if(excerpt.trim())passages.push({id:`post:${field}:${start}`,text:excerpt});start=end;
    }
  }
  return passages;
}
export function qualificationRequest(job) {
  const evidence=postEvidence(job.row), ids=evidence.map(value=>value.id), caps=job.profile.capabilities.map(value=>value.id);
  const properties={decision:{type:'string',enum:['qualified','rejected']},explicitIntent:{type:'boolean'},intentEvidenceId:{type:['string','null'],enum:[...ids,null]},
    postEvidenceIds:{type:'array',maxItems:4,items:{type:'string',enum:ids}},capabilityIds:{type:'array',maxItems:8,items:{type:'string',enum:caps}},whyItFits:{type:'string',maxLength:80}};
  return {model:QUALIFICATION_MODEL,service_tier:'default',store:false,max_output_tokens:OUTPUT_TOKENS,reasoning:{effort:'medium'},
    input:[{role:'system',content:QUALIFICATION_PROMPT+(job.profile.constraints?'\nRespect the supplied business constraints, including location, platforms and coverage. Constraints limit fit; they are not selectable capabilities or evidence of customer demand.':'')+(job.row.type==='comment'?TAVERN_COMMENT_INSTRUCTIONS:'')},{role:'user',content:JSON.stringify({source:job.row.source,postURL:job.url,capabilities:job.profile.capabilities,problems:job.profile.needs,...(job.profile.constraints?{constraints:job.profile.constraints}:{}),postEvidence:evidence,...(job.row.type==='comment'?{sourceKind:'comment',threadContext:job.row.context || ''}:{})})}],
    text:{format:{type:'json_schema',name:'tracker_post_qualification',strict:true,schema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)}}}};
}
export function resolveQualification(value, job) {
  const keys=['decision','explicitIntent','intentEvidenceId','postEvidenceIds','capabilityIds','whyItFits'];
  if (!value || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some(key=>!Object.hasOwn(value,key)) || !['qualified','rejected'].includes(value.decision) || typeof value.explicitIntent !== 'boolean' || !Array.isArray(value.postEvidenceIds) || value.postEvidenceIds.length>4 || !Array.isArray(value.capabilityIds) || value.capabilityIds.length>8 || typeof value.whyItFits !== 'string' || value.whyItFits.length>80) throw Error('invalid_qualification');
  if (value.decision==='rejected') {
    if(value.explicitIntent || value.intentEvidenceId!==null || value.postEvidenceIds.length || value.capabilityIds.length || value.whyItFits) throw Error('invalid_rejection');
    return {decision:'rejected',intentQuote:'',evidenceQuotes:[],capabilityIds:[],whyItFits:''};
  }
  const passages=new Map(postEvidence(job.row).map(p=>[p.id,p.text])), caps=new Map(job.profile.capabilities.map(c=>[c.id,c.text]));
  if(!value.explicitIntent || !passages.has(value.intentEvidenceId) || !value.postEvidenceIds.length || !value.capabilityIds.length || value.postEvidenceIds.some(id=>!passages.has(id)) || value.capabilityIds.some(id=>!caps.has(id)) || value.whyItFits.trim().length<12) throw Error('invalid_evidence');
  if(/\bandroid\b/i.test(`${job.row.title}\n${job.row.snippet}`) && !value.capabilityIds.some(id=>/android/i.test(caps.get(id)))) return {decision:'rejected',intentQuote:'',evidenceQuotes:[],capabilityIds:[],whyItFits:''};
  return {decision:'qualified',intentQuote:passages.get(value.intentEvidenceId),evidenceQuotes:[...new Set(value.postEvidenceIds)].map(id=>passages.get(id)),capabilityIds:[...new Set(value.capabilityIds)],whyItFits:value.whyItFits.replace(/[<>`*_#]/g,'').replace(/\s+/g,' ').trim()};
}
export function reservationMicroUsd(job) {return Math.ceil((Buffer.byteLength(JSON.stringify(qualificationRequest(job)))+4096)*INPUT_RATE + OUTPUT_TOKENS*OUTPUT_RATE);}

export function solCost(usage) {
  const cached=usage?.input_tokens_details?.cached_tokens || 0,writes=usage?.input_tokens_details?.cache_write_tokens || 0;
  if(!usage || ![usage.input_tokens,usage.output_tokens,cached,writes].every(n=>Number.isSafeInteger(n)&&n>=0) || cached+writes>usage.input_tokens)throw Error('invalid_usage');
  return Math.ceil((usage.input_tokens-cached-writes)*2+cached*0.1+writes*2.5+usage.output_tokens*10);
}
export function batchRequest(jobs) {
  const candidates=jobs.map((job,index)=>({id:job.key,type:job.row.type || 'post',postEvidence:postEvidence(job.row).map(p=>({...p,id:`candidate:${index}:${p.id}`})),...(job.row.type==='comment'?{threadContext:job.row.context || ''}:{})}));
  const ids=candidates.flatMap(c=>c.postEvidence.map(p=>p.id)),caps=jobs[0].profile.capabilities.map(c=>c.id);
  const properties={id:{type:'string',enum:jobs.map(j=>j.key)},decision:{type:'string',enum:['qualified','rejected']},explicitIntent:{type:'boolean'},intentEvidenceId:{type:['string','null'],enum:[...ids,null]},postEvidenceIds:{type:'array',maxItems:4,items:{type:'string',enum:ids}},capabilityIds:{type:'array',maxItems:8,items:{type:'string',enum:caps}},whyItFits:{type:'string',maxLength:80}};
  const batchInstructions='\n\nApply this policy independently to each supplied candidate. Return exactly one result per candidate, using its id. Select evidence only from that candidate’s postEvidence; never borrow passages, circumstances or needs from another candidate. The word app refers to the supplied product or business and its documented capabilities. For candidates with type comment, apply the comment instructions only to that candidate. No images are supplied; do not infer image contents.';
  return {model:QUALIFICATION_MODEL,service_tier:'default',store:false,reasoning:{effort:'medium'},max_output_tokens:4096,
    input:[{role:'system',content:QUALIFICATION_PROMPT+(jobs[0].profile.constraints?'\nRespect the supplied business constraints, including location, platforms and coverage. Constraints limit fit; they are not selectable capabilities or evidence of customer demand.':'')+(jobs.some(j=>j.row.type==='comment')?TAVERN_COMMENT_INSTRUCTIONS:'')+batchInstructions},{role:'user',content:JSON.stringify({capabilities:jobs[0].profile.capabilities,problems:jobs[0].profile.needs,...(jobs[0].profile.constraints?{constraints:jobs[0].profile.constraints}:{}),candidates})}],
    text:{format:{type:'json_schema',name:'tracker_relevance_batch',strict:true,schema:{type:'object',additionalProperties:false,properties:{results:{type:'array',minItems:jobs.length,maxItems:jobs.length,items:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)}}},required:['results']}}}};
}
export function resolveBatch(value,jobs) {
  if(!Array.isArray(value?.results)||value.results.length!==jobs.length||new Set(value.results.map(r=>r.id)).size!==jobs.length)throw Error('invalid_results');
  return Object.fromEntries(value.results.map(result=>{
    const index=jobs.findIndex(j=>j.key===result.id),job=jobs[index];if(!job)throw Error('invalid_results');
    const prefix=`candidate:${index}:`,{id,...selection}=result;
    const localId=value=>{if(typeof value!=='string'||!value.startsWith(prefix))throw Error('invalid_evidence');return value.slice(prefix.length);};
    if(selection.intentEvidenceId!==null)selection.intentEvidenceId=localId(selection.intentEvidenceId);
    if(!Array.isArray(selection.postEvidenceIds))throw Error('invalid_evidence');
    selection.postEvidenceIds=selection.postEvidenceIds.map(localId);
    return [job.key,resolveQualification(selection,job)];
  }));
}
export function claimQualificationBatch(data,settings,now,productId) {
  if(!settings.active || settings.until<=now)return null;
  retireAnalysis(data,now);const budget=ledger(data);for(const job of Object.values(data.qualifications))retireRunning(data,job,now);
  if(budget.overrun || Object.values(data.qualifications).some(j=>j.status==='running'))return null;
  const eligible=Object.values(data.qualifications).filter(job=> {
    if(job.status!=='pending'||productId&&job.productId!==productId)return false;
    if(job.row?.pipeline && !job.backfillId && data.collection?.cycles?.[job.productId]?.status==='running')return false;
    const product=data.products.find(p=>p.id===job.productId);
    if(!product || job.profileHash!==profileHash(product)){job.status='profile_changed';job.processedAt=iso(now);delete job.row;delete job.profile;return false;}
    return !(job.trigger==='scheduled'&&!product.monitoring || settings.mode==='test'&&!productId);
  }).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  if(!eligible.length)return null;
  const same=eligible.filter(j=>j.productId===eligible[0].productId),reddit=same.filter(j=>j.platform==='reddit'),other=same.filter(j=>j.platform!=='reddit'),jobs=[];
  while(jobs.length<10 && (reddit.length||other.length)){if(reddit.length)jobs.push(reddit.shift());if(jobs.length<10&&other.length)jobs.push(other.shift());}
  const day=budgetDay(now),usage=budget.dailyUsage[day] ||= {spentMicroUsd:0,reservedMicroUsd:0,calls:0};
  let reserve;
  // Shrink a batch near the cap instead of exceeding or raising the allowance.
  while(jobs.length){reserve=Math.ceil((Buffer.byteLength(JSON.stringify(batchRequest(jobs)))+4096)*2.5+4096*10);if(usage.spentMicroUsd+usage.reservedMicroUsd+reserve<=settings.budgetMicroUsd)break;jobs.pop();}
  if(!jobs.length || usage.calls>=settings.dailyMaxCalls)return null;
  const token=randomUUID();budget.calls++;budget.daily[day]=(budget.daily[day]||0)+1;budget.reservedMicroUsd+=reserve;
  usage.calls++;usage.reservedMicroUsd+=reserve;
  jobs.forEach((job,index)=>Object.assign(job,{status:'running',token,leaseUntil:now+LEASE_MS,dispatchedAt:iso(now),budgetDay:day,reservationMicroUsd:index===0?reserve:0,model:QUALIFICATION_MODEL,promptVersion:QUALIFICATION_VERSION}));
  return {token,jobs:structuredClone(jobs),reservationMicroUsd:reserve};
}
export function finishQualificationBatch(data,batch,outcome,now) {
  if(batch.jobs.some(job=>data.qualifications[job.key]?.token!==batch.token || data.qualifications[job.key]?.status!=='running'))return null;
  const cost=Number.isSafeInteger(outcome.costMicroUsd)&&outcome.costMicroUsd>=0?outcome.costMicroUsd:batch.reservationMicroUsd;
  const statuses=batch.jobs.map((job,index)=>finishQualification(data,job.key,batch.token,{assessment:outcome.assessments?.[job.key],costMicroUsd:index===0?cost:0,...(index===0&&outcome.usage?{usage:outcome.usage}:{}),requestId:outcome.requestId},now));
  return {status:outcome.assessments?'processed':'uncertain',assessed:statuses.length};
}

function ledger(data) {data.qualifications ||= {};data.qualificationMigrations ||= {};data.aiBudget ||= {spentMicroUsd:0,reservedMicroUsd:0,calls:0,daily:{}};data.aiBudget.dailyUsage ||= {};return data.aiBudget;}
function charge(data,job,cost) {
  const budget=ledger(data), day=job.budgetDay || budgetDay(Date.parse(job.dispatchedAt));
  const usage=budget.dailyUsage[day] ||= {spentMicroUsd:0,reservedMicroUsd:0,calls:0};
  budget.reservedMicroUsd=Math.max(0,budget.reservedMicroUsd-job.reservationMicroUsd);budget.spentMicroUsd+=cost;
  usage.reservedMicroUsd=Math.max(0,usage.reservedMicroUsd-job.reservationMicroUsd);usage.spentMicroUsd+=cost;
  if(cost>job.reservationMicroUsd)budget.overrun=true;
}
// Manual research and reply analysis share the existing owner-approved ledger.
// Reserve the model's worst-case context across four passes, capped output,
// and web calls. Settle from usage; uncertain dispatches retain their hold.
export function reserveAnalysis(data, lease, settings, now) {
  const fail = (message, status) => {const error = new Error(message); error.status = status; throw error;};
  if (!settings.active || settings.until <= now) fail('AI analysis is paused. Check the server key and daily budget settings.', 503);
  const budget = ledger(data), day = budgetDay(now);
  const usage = budget.dailyUsage[day] ||= {spentMicroUsd:0,reservedMicroUsd:0,calls:0};
  const reservation = lease.kind==='pipeline-stage' ? lease.stageReservationMicroUsd : lease.kind==='business-profile' ? lease.profileReservationMicroUsd : lease.itemId ? 20000 : 1100000;
  if(!Number.isSafeInteger(reservation) || reservation<=0 || reservation>2000000)fail('Invalid analysis reservation.',400);
  if (budget.overrun || usage.calls >= settings.dailyMaxCalls || usage.spentMicroUsd + usage.reservedMicroUsd + reservation > settings.budgetMicroUsd) fail('There is not enough daily AI allowance for this analysis. Try again tomorrow (Pacific time).', 429);
  budget.calls++; budget.daily[day] = (budget.daily[day] || 0) + 1; budget.reservedMicroUsd += reservation;
  usage.calls++; usage.reservedMicroUsd += reservation;
  Object.assign(lease, {budgetDay:day,dispatchedAt:iso(now),reservationMicroUsd:reservation});
}
export function settleAnalysis(data, lease, cost = lease.reservationMicroUsd) {
  if (lease.reservationMicroUsd === undefined) return;
  if (!Number.isSafeInteger(cost) || cost < 0) cost = lease.reservationMicroUsd;
  charge(data, lease, cost);
}
export function retireAnalysis(data, now) {
  for (const [token, lease] of Object.entries(data.analysisLeases || {})) if (lease.expiresAt <= now) {
    settleAnalysis(data, lease); delete data.analysisLeases[token];
  }
}
function previousCheck(search, platform) {
  const names=platform==='reddit'?['Reddit','Reddit watchlist']:['LinkedIn'];
  return search?.lastChecks?.[platform] || search?.sources?.find(source=>names.includes(source.name))?.checkedAt || (search?.sources?.some(source=>names.includes(source.name))?search.searchedAt:null);
}
export function stageQualifications(data, product, rows, searchedAt, trigger) {
  ledger(data);
  if(!data.qualificationMigrations[product.id]) {
    for(const item of data.items.filter(item=>item.productId===product.id)) {
      const identity=canonicalPost(item); if(!identity)continue;
      const key=qualificationKey(product.id,identity.identity);
      data.qualifications[key] ||= {key,productId:product.id,...identity,status:'legacy_processed',processedAt:searchedAt};
    }
    const prior=data.searches[product.id];
    data.qualificationMigrations[product.id]={at:searchedAt,redditBefore:previousCheck(prior,'reddit'),linkedinBaseline:Boolean(previousCheck(prior,'linkedin'))};
  }
  const migration=data.qualificationMigrations[product.id], profile=profileSnapshot(product);
  let pending=0, skipped=0, duplicates=0, unassessed=0, historyFull=false;
  for(const value of rows.slice(0,300)) {
    const identity=canonicalPost(value); if(!identity || identity.platform==='reddit' && !value.backfillId && !product.communities?.includes(identity.subreddit) || identity.platform==='linkedin' && !product.linkedin || identity.platform==='x' && product.x===false)continue;
    const contentHash=value.pipeline?digest(JSON.stringify({title:value.title,text:value.snippet,parentId:value.parentId})):undefined;
    const key=qualificationKey(product.id,identity.identity,contentHash);
    const prior=data.qualifications[key];
    const historicalJob=value.backfillId && data.collection?.backfills?.[product.id];
    const isBackfill=Boolean(value.backfillId) && historicalJob?.id===value.backfillId && ['running','reviewing'].includes(historicalJob.status) && Date.parse(value.publishedAt)>=Date.parse(historicalJob.from) && Date.parse(value.publishedAt)<Date.parse(historicalJob.to);
    if(value.backfillId && !isBackfill) {skipped++;continue;}
    if(prior && !(isBackfill && prior.status==='historical_skipped')) {if(isBackfill)prior.backfillId=historicalJob.id;skipped++;duplicates++;continue;}
    const legacy=data.qualifications[qualificationKey(product.id,identity.identity)];
    if(isBackfill && legacy?.status==='legacy_processed') {legacy.backfillId=historicalJob.id;skipped++;duplicates++;continue;}
    if(Object.keys(data.qualifications).length>=10000) {historyFull=true;skipped++;unassessed++;continue;}
    const published=Date.parse(value.publishedAt||''), cutoff=Date.parse(migration.redditBefore||'');
    const hasPreviousVersion=contentHash && Object.values(data.qualifications).some(j=>j.productId===product.id&&j.identity===identity.identity&&j.contentHash);
    const pipelineHistorical=contentHash && !hasPreviousVersion && Date.parse(value.publishedAt)<Date.parse(value.pipelineCutoff || '');
    const historical=!isBackfill && (pipelineHistorical || Boolean(contentHash && data.qualifications[qualificationKey(product.id,identity.identity)]) || identity.platform==='reddit' && Number.isFinite(cutoff) && (!Number.isFinite(published)||published<=cutoff) || identity.platform==='linkedin' && migration.linkedinBaseline);
    const row={...value,url:identity.url,title:text(value.title,1000),snippet:text(value.snippet,3000)};
    const status=historical?'historical_skipped':!profile.capabilities.length?'profile_required':row.title.length+row.snippet.length<12?'insufficient_text':'pending';
    data.qualifications[key]={key,productId:product.id,...identity,...(contentHash?{contentHash}:{}),status,createdAt:searchedAt,trigger,...(isBackfill?{backfillId:historicalJob.id}:{}),
      ...(['pending','profile_required'].includes(status)?{row,profile,profileHash:profileHash(product)}:{processedAt:searchedAt})};
    if(status==='pending')pending++;else {skipped++;if(['profile_required','insufficient_text'].includes(status))unassessed++;}
  }
  if(rows.some(row=>canonicalPost(row)?.platform==='linkedin')) migration.linkedinBaseline=false;
  return {pending,skipped,duplicates,unassessed,...(historyFull?{historyFull}: {})};
}
function retireRunning(data, job, now) {
  if(job.status!=='running' || job.leaseUntil>now)return;
  charge(data,job,job.reservationMicroUsd);
  Object.assign(job,{status:'uncertain',reason:'expired_dispatch',processedAt:iso(now),chargedMicroUsd:job.reservationMicroUsd});delete job.token;delete job.row;delete job.profile;
}
export function claimQualification(data, settings, now, productId) {
  if(!settings.active || settings.until<=now)return null;
  retireAnalysis(data, now);
  const budget=ledger(data);for(const job of Object.values(data.qualifications))retireRunning(data,job,now);
  if(Object.values(data.qualifications).some(job=>job.status==='running') || budget.overrun)return null;
  const day=budgetDay(now), usage=budget.dailyUsage[day] ||= {spentMicroUsd:0,reservedMicroUsd:0,calls:0};
  if(usage.calls>=settings.dailyMaxCalls)return null;
  const jobs=Object.values(data.qualifications).filter(job=>job.status==='pending'&&(!productId||job.productId===productId)).sort((a,b)=>Number(a.platform!=='reddit')-Number(b.platform!=='reddit')||a.createdAt.localeCompare(b.createdAt));
  for(const job of jobs) {
    const product=data.products.find(p=>p.id===job.productId);
    if(!product || job.profileHash!==profileHash(product)) {Object.assign(job,{status:'profile_changed',processedAt:iso(now)});delete job.row;delete job.profile;continue;}
    if(job.trigger==='scheduled' && !product.monitoring || settings.mode==='test'&&!productId)continue;
    const reservation=reservationMicroUsd(job);
    if(usage.spentMicroUsd+usage.reservedMicroUsd+reservation>settings.budgetMicroUsd)return null;
    budget.calls++;budget.daily[day]=(budget.daily[day]||0)+1;budget.reservedMicroUsd+=reservation;
    usage.calls++;usage.reservedMicroUsd+=reservation;
    Object.assign(job,{status:'running',token:randomUUID(),leaseUntil:now+LEASE_MS,dispatchedAt:iso(now),budgetDay:day,reservationMicroUsd:reservation,model:QUALIFICATION_MODEL,promptVersion:QUALIFICATION_VERSION});
    return structuredClone(job);
  }
  return null;
}
export function finishQualification(data, key, token, outcome, now) {
  const job=data.qualifications?.[key];if(!job || job.status!=='running' || job.token!==token)return null;
  const cost=outcome.costMicroUsd ?? job.reservationMicroUsd;
  charge(data,job,cost);
  Object.assign(job,{status:outcome.assessment?.decision||'uncertain',processedAt:iso(now),chargedMicroUsd:cost,...(outcome.usage?{usage:outcome.usage}:{}),...(outcome.assessment?{assessment:outcome.assessment}:{reason:'provider_result_uncertain'}),...(outcome.requestId?{requestId:outcome.requestId}:{})});
  if(outcome.assessment?.decision==='qualified' && data.products.some(p=>p.id===job.productId&&profileHash(p)===job.profileHash)) {
    const prior=data.items.find(item=>item.productId===job.productId&&canonicalPost(item)?.identity===job.identity);
    const item={...job.row,id:prior?.id||digest(`${job.productId}:${job.url}`).slice(0,24),productId:job.productId,kind:prior?.kind==='mention'?'mention':'opportunity',
      status:prior?.status||'new',note:prior?.note||'',draft:prior?.draft||'',foundAt:prior?.foundAt||iso(now),lastSeenAt:iso(now),matchedTerms:outcome.assessment.capabilityIds.map(id=>job.profile.capabilities.find(c=>c.id===id).text),
      snippet:text(outcome.assessment.intentQuote,600),reason:`Review needed: ${outcome.assessment.whyItFits}${job.row.publishedAt?'':' Publication date is unavailable; verify whether the need is current.'}`,
      qualification:{model:job.model || QUALIFICATION_MODEL,promptVersion:job.promptVersion || QUALIFICATION_VERSION,...outcome.assessment}};
    data.items=[item,...data.items.filter(row=>row.id!==item.id)];
  }
  delete job.token;delete job.row;delete job.profile;return {status:job.status,key};
}
export function qualificationSummary(data, settings, productId) {
  const jobs=Object.values(data.qualifications||{}).filter(job=>!productId||job.productId===productId), counts={};
  for(const job of jobs)counts[job.status]=(counts[job.status]||0)+1;
  const day=budgetDay(Date.now()), usage=data.aiBudget?.dailyUsage?.[day]||{};
  return {enabled:settings.active,collecting:settings.enabled,mode:settings.mode,model:QUALIFICATION_MODEL,reason:settings.reason,counts,
    budget:{day,timeZone:AI_BUDGET_TIME_ZONE,spentMicroUsd:usage.spentMicroUsd||0,reservedMicroUsd:usage.reservedMicroUsd||0,calls:usage.calls||0,limitMicroUsd:settings.configured?settings.budgetMicroUsd:0,maxCalls:settings.maxCalls,overrun:Boolean(data.aiBudget?.overrun),paused:Boolean(data.aiBudget?.overrun)||(usage.calls||0)>=settings.dailyMaxCalls||(usage.spentMicroUsd||0)+(usage.reservedMicroUsd||0)>=settings.budgetMicroUsd}};
}
export function qualificationPublicState(data,settings) {
  return {version:data.version,products:data.products,items:data.items,searches:data.searches,
    qualification:{...qualificationSummary(data,settings),products:Object.fromEntries(data.products.map(product=>[product.id,qualificationSummary(data,settings,product.id).counts]))}};
}
export function createQualificationProvider({env=process.env,fetchImpl=fetch}={}) {
  if(!env.TRACKER_OPENAI_API_KEY)return null;
  return {async qualifyBatch(batch) {
    const response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:`Bearer ${env.TRACKER_OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(batchRequest(batch.jobs))});
    const data=JSON.parse(await readText(response,2_097_152));
    if(!response.ok || data.status!=='completed' || !(data.model===QUALIFICATION_MODEL || data.model?.startsWith(`${QUALIFICATION_MODEL}-`)) || data.service_tier && data.service_tier!=='default' || data.usage?.output_tokens>4096)throw Error('provider_result_uncertain');
    const costMicroUsd=solCost(data.usage);
    const output=data.output_text || data.output?.filter(row=>row.type==='message'&&row.role==='assistant').flatMap(row=>row.content||[]).filter(row=>row.type==='output_text').map(row=>row.text).join('');
    return {value:JSON.parse(output),costMicroUsd,usage:data.usage,requestId:data.id};
  },async qualify(job) {
    const response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:`Bearer ${env.TRACKER_OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(qualificationRequest(job))});
    const data=JSON.parse(await readText(response,1_048_576));
    if(!response.ok || data.status!=='completed' || !(data.model===QUALIFICATION_MODEL||data.model?.startsWith(`${QUALIFICATION_MODEL}-`)) || data.service_tier&&data.service_tier!=='default' || !Number.isSafeInteger(data.usage?.input_tokens) || data.usage.input_tokens<0 || !Number.isSafeInteger(data.usage?.output_tokens)||data.usage.output_tokens<0||data.usage.output_tokens>OUTPUT_TOKENS)throw Error('provider_result_uncertain');
    const output=data.output_text || data.output?.filter(row=>row.type==='message'&&row.role==='assistant').flatMap(row=>row.content||[]).filter(row=>row.type==='output_text').map(row=>row.text).join('');
    return {value:JSON.parse(output),costMicroUsd:solCost(data.usage),requestId:typeof data.id==='string'?data.id.slice(0,120):undefined};
  }};
}
export async function processQualification(store,settings,provider,{productId,now=Date.now()}={}) {
  if(!settings.active || !provider)return {status:'disabled'};
  if(provider.qualifyBatch && Object.values((await store.snapshot()).qualifications || {}).some(j=>j.status==='pending'&&j.row?.pipeline&&(!productId||j.productId===productId))) {
    const batch=await store.claimQualificationBatch(settings,now,productId);if(!batch)return {status:'idle'};
    let outcome;
    try {const result=await provider.qualifyBatch(batch);outcome={assessments:resolveBatch(result.value,batch.jobs),costMicroUsd:result.costMicroUsd,usage:result.usage,requestId:result.requestId};}
    catch {outcome={};}
    return await store.finishQualificationBatch(batch,outcome,Date.now()) || {status:'uncertain'};
  }
  const job=await store.claimQualification(settings,now,productId);if(!job)return {status:'idle'};
  let outcome,result;
  try {result=await provider.qualify(job);outcome={assessment:resolveQualification(result.value,job),costMicroUsd:result.costMicroUsd,requestId:result.requestId};if(!Number.isSafeInteger(outcome.costMicroUsd)||outcome.costMicroUsd<0)throw Error('invalid_usage');}
  catch {outcome={...(Number.isSafeInteger(result?.costMicroUsd)&&result.costMicroUsd>=0?{costMicroUsd:Math.max(job.reservationMicroUsd,result.costMicroUsd)}:{}),...(typeof result?.requestId==='string'?{requestId:text(result.requestId,120)}:{})};}
  return await store.finishQualification(job.key,job.token,outcome,Date.now()) || {status:'uncertain'};
}

const recordObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
const money=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e12;
const productID=value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{1,100}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const terminal=new Set(['qualified','rejected','legacy_processed','historical_skipped','uncertain','profile_changed','profile_required','insufficient_text']);
export function qualificationBackup(data) {
  if(!data.qualifications)return {};
  const qualifications={};
  for(const [key,job] of Object.entries(data.qualifications)) {
    qualifications[key]={key,productId:job.productId,identity:job.identity,...(job.contentHash?{contentHash:job.contentHash}:{}),url:job.url,platform:job.platform,status:terminal.has(job.status)?job.status:'uncertain',processedAt:job.processedAt||iso(Date.now()),
      ...(job.dispatchedAt?{dispatchedAt:job.dispatchedAt,budgetDay:job.budgetDay||budgetDay(Date.parse(job.dispatchedAt))}:{}),...(job.chargedMicroUsd!==undefined||job.status==='running'?{chargedMicroUsd:job.chargedMicroUsd??job.reservationMicroUsd}:{}),
      ...(job.model?{model:job.model,promptVersion:job.promptVersion}:{}),...(job.reason?{reason:job.reason}:{}),...(job.assessment?{assessment:job.assessment}:{}),...(job.requestId?{requestId:job.requestId}:{})};
  }
  const budget=data.aiBudget||{};
  const dailyUsage=Object.fromEntries(Object.entries(budget.dailyUsage||{}).map(([day,u])=>[day,{spentMicroUsd:u.spentMicroUsd+u.reservedMicroUsd,reservedMicroUsd:0,calls:u.calls}]));
  return {qualifications,qualificationMigrations:structuredClone(data.qualificationMigrations||{}),aiBudget:{spentMicroUsd:(budget.spentMicroUsd||0)+(budget.reservedMicroUsd||0),reservedMicroUsd:0,calls:budget.calls||0,daily:{...budget.daily},dailyUsage,overrun:Boolean(budget.overrun)}};
}
export function validateQualificationHistory(data) {
  if(data.qualifications===undefined&&data.aiBudget===undefined&&data.qualificationMigrations===undefined)return {};
  const fail=()=>{throw Error('The backup has invalid AI processing history.');};
  if(!recordObject(data.qualifications)||Object.keys(data.qualifications).length>10000||!recordObject(data.qualificationMigrations)||Object.keys(data.qualificationMigrations).length>10000||!recordObject(data.aiBudget))fail();
  const qualifications={};
  for(const [key,job] of Object.entries(data.qualifications)) {
    const source=job?.platform==='reddit'?'Reddit':job?.platform==='linkedin'?'LinkedIn':job?.platform==='x'?'X':null;
    const identity=source&&canonicalPost({url:job.url,source,type:'post'});
    if(!/^[a-f0-9]{64}$/.test(key)||!recordObject(job)||job.key!==key||!productID(job.productId)||!identity||identity.identity!==job.identity||qualificationKey(job.productId,job.identity,job.contentHash)!==key || job.contentHash!==undefined&&!/^[a-f0-9]{64}$/.test(job.contentHash)||!terminal.has(job.status)||!validDate(job.processedAt)||job.chargedMicroUsd!==undefined&&!money(job.chargedMicroUsd)||job.dispatchedAt!==undefined&&!validDate(job.dispatchedAt))fail();
    let assessment;
    if(job.assessment!==undefined) {
      const a=job.assessment;
      if(!recordObject(a)||!['qualified','rejected','uncertain'].includes(a.decision)||a.decision!==job.status||typeof a.intentQuote!=='string'||a.intentQuote.length>500||!Array.isArray(a.evidenceQuotes)||a.evidenceQuotes.length>4||a.evidenceQuotes.some(q=>typeof q!=='string'||q.length>500)||!Array.isArray(a.capabilityIds)||a.capabilityIds.length>8||a.capabilityIds.some(id=>!/^cap:[a-f0-9]{16}$/.test(id))||typeof a.whyItFits!=='string'||a.whyItFits.length>500)fail();
      assessment={decision:a.decision,intentQuote:a.intentQuote,evidenceQuotes:a.evidenceQuotes,capabilityIds:a.capabilityIds,whyItFits:a.whyItFits};
    }
    qualifications[key]={key,productId:job.productId,...identity,...(job.contentHash?{contentHash:job.contentHash}:{}),status:job.status,processedAt:job.processedAt,...(assessment?{assessment}:{}),
      ...(job.chargedMicroUsd!==undefined?{chargedMicroUsd:job.chargedMicroUsd}:{}),...(job.dispatchedAt?{dispatchedAt:job.dispatchedAt,budgetDay:budgetDay(Date.parse(job.dispatchedAt))}:{}),...([QUALIFICATION_MODEL,'gpt-6-luna'].includes(job.model)?{model:job.model,promptVersion:text(job.promptVersion,100)}:{}),...(job.reason?{reason:text(job.reason,100)}:{}),...(job.requestId?{requestId:text(job.requestId,120)}:{})};
  }
  const qualificationMigrations={};
  for(const [id,m] of Object.entries(data.qualificationMigrations)) {
    if(!productID(id)||!recordObject(m)||!validDate(m.at)||m.redditBefore!==null&&m.redditBefore!==undefined&&!validDate(m.redditBefore)||typeof m.linkedinBaseline!=='boolean')fail();
    qualificationMigrations[id]={at:m.at,redditBefore:m.redditBefore||null,linkedinBaseline:m.linkedinBaseline};
  }
  const b=data.aiBudget;
  if(!money(b.spentMicroUsd)||!money(b.reservedMicroUsd)||!money(b.calls)||!recordObject(b.daily)||Object.keys(b.daily).length>3660||Object.entries(b.daily).some(([day,calls])=>!/^\d{4}-\d{2}-\d{2}$/.test(day)||!money(calls)))fail();
  const dailyUsage={};
  if(b.dailyUsage!==undefined&&(!recordObject(b.dailyUsage)||Object.keys(b.dailyUsage).length>3660))fail();
  for(const [day,u] of Object.entries(b.dailyUsage||{})) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!recordObject(u)||!money(u.spentMicroUsd)||!money(u.reservedMicroUsd)||!money(u.calls))fail();
    dailyUsage[day]={spentMicroUsd:u.spentMicroUsd,reservedMicroUsd:u.reservedMicroUsd,calls:u.calls};
  }
  return {qualifications,qualificationMigrations,aiBudget:{spentMicroUsd:b.spentMicroUsd,reservedMicroUsd:b.reservedMicroUsd,calls:b.calls,daily:{...b.daily},dailyUsage,overrun:Boolean(b.overrun)}};
}
// Restore retains the union of charged receipts; old backups cannot refund a
// reservation, erase a rejection, or turn a dispatched request into a new job.
export function mergeQualificationHistory(current, incoming) {
  const old=qualificationBackup(current), restored=validateQualificationHistory(incoming);
  const qualifications={...restored.qualifications,...old.qualifications};
  if(Object.keys(qualifications).length>10000)throw Error('The combined AI processing history exceeds the 10,000-post limit.');
  const daily={...restored.aiBudget?.daily};
  for(const [day,calls] of Object.entries(old.aiBudget?.daily||{}))daily[day]=Math.max(daily[day]||0,calls);
  const dailyUsage={},receiptUsage={};let receiptCost=0,receiptCalls=0;
  for(const job of Object.values(qualifications))if(job.chargedMicroUsd!==undefined){receiptCost+=job.chargedMicroUsd;receiptCalls++;if(job.dispatchedAt){const day=budgetDay(Date.parse(job.dispatchedAt)),u=receiptUsage[day]||={spentMicroUsd:0,calls:0};u.spentMicroUsd+=job.chargedMicroUsd;u.calls++;}}
  for(const day of new Set([...Object.keys(old.aiBudget?.dailyUsage||{}),...Object.keys(restored.aiBudget?.dailyUsage||{}),...Object.keys(receiptUsage)])) {
    const a=old.aiBudget?.dailyUsage?.[day]||{},b=restored.aiBudget?.dailyUsage?.[day]||{},r=receiptUsage[day]||{};
    dailyUsage[day]={spentMicroUsd:Math.max((a.spentMicroUsd||0)+(a.reservedMicroUsd||0),(b.spentMicroUsd||0)+(b.reservedMicroUsd||0),r.spentMicroUsd||0),reservedMicroUsd:0,calls:Math.max(a.calls||0,b.calls||0,r.calls||0)};
    daily[day]=Math.max(daily[day]||0,dailyUsage[day].calls);
  }
  if(!money(receiptCost))throw Error('The backup has invalid AI usage totals.');
  return {...structuredClone(incoming),qualifications,qualificationMigrations:{...restored.qualificationMigrations,...old.qualificationMigrations},
    aiBudget:{spentMicroUsd:Math.max(old.aiBudget?.spentMicroUsd||0,(restored.aiBudget?.spentMicroUsd||0)+(restored.aiBudget?.reservedMicroUsd||0),receiptCost),reservedMicroUsd:0,calls:Math.max(old.aiBudget?.calls||0,restored.aiBudget?.calls||0,receiptCalls),daily,dailyUsage,overrun:Boolean(old.aiBudget?.overrun||restored.aiBudget?.overrun)}};
}
