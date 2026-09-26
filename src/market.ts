import {requireMarketingAccess} from './marketing-billing.js';
import {marketResearchSchema,citationKey} from './market-research.js';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import {Store,documentKey} from './database.js';
import {ServiceError} from './firebase.js';
import {rateLimit,type AuthenticatedRequest} from './auth.js';
import type {LeadProfile} from './leads-types.js';
import {marketFeatureEnabledFor,marketScanDTO,marketScanStatus,queueMarketScan} from './market-jobs.js';
import {aggregateMarketEvidence,marketAuthorIdentities} from './market-aggregation.js';
import {marketSourceContentHash} from './market-sources.js';
import type {MarketEvidenceDTO,MarketObservation,MarketPeoplePageDTO,MarketPersonDTO,MarketProblemRecord,MarketScanRow,MarketSnapshot,MarketSource} from './market-types.js';
import {marketPeopleInput,marketScanInput} from './market-types.js';

const MAX_SNAPSHOT_SOURCES=1_000;
const MAX_SNAPSHOT_OBSERVATIONS=500;
const MAX_SNAPSHOT_PROBLEMS=40;
const MAX_PERSON_EVIDENCE=10;
const emptyCoverage='partial' as const;
export interface MarketRouterOptions {env?:NodeJS.ProcessEnv;now?:()=>number;cursorSecret?:string}
type ProfileContext={userId:string;appId:string;profile:LeadProfile};
type CursorPayload={v:1;userId:string;appId:string;revision:number;snapshotId:string;problemId:string|null;after:string};
type LoadedSnapshot={snapshot:MarketSnapshot;aggregate:ReturnType<typeof aggregateMarketEvidence>};

const uid=(req:unknown)=>(req as AuthenticatedRequest).user.id;
const appParam=(value:unknown)=>z.string().uuid().parse(value);
const snapshotHeadID=(userId:string,appId:string,revision:number)=>documentKey(userId,appId,String(revision));
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;

function completeProfile(value:LeadProfile|undefined,userId:string,appId:string):value is LeadProfile {
  return !!value&&value.user_id===userId&&value.app_id===appId&&Number.isInteger(value.revision)&&value.revision>0&&
    value.schemaVersion===1&&typeof value.enabled==='boolean'&&Array.isArray(value.problems)&&value.problems.length>0&&value.problems.length<=8&&
    value.problems.every(problem=>record(problem)&&z.string().uuid().safeParse(problem.id).success&&typeof problem.text==='string'&&problem.text.trim().length>=3)&&
    Array.isArray(value.capabilities)&&value.capabilities.length>0&&value.capabilities.length<=8&&
    value.capabilities.every(capability=>record(capability)&&z.string().uuid().safeParse(capability.id).success&&typeof capability.text==='string'&&capability.text.trim().length>=3)&&
    Array.isArray(value.communities)&&value.communities.length>0&&value.communities.length<=10&&value.communities.every(community=>typeof community==='string'&&/^[a-z0-9_]{2,21}$/.test(community))&&
    Array.isArray(value.keywords)&&value.keywords.length<=20&&value.keywords.every(keyword=>typeof keyword==='string'&&keyword.trim().length>0)&&
    typeof value.confirmedAt==='string'&&Number.isFinite(Date.parse(value.confirmedAt));
}
function millis(value:unknown):number|null {
  try {
    const result=(value as {toMillis?:()=>number}|null)?.toMillis?.();
    return Number.isFinite(result)?result!:null;
  } catch {return null;}
}
function boundedIDs(value:unknown,max:number):string[]|null {
  if(!Array.isArray(value)||value.length>max||value.some(item=>typeof item!=='string'||!item||item.length>200)) return null;
  return [...new Set(value as string[])];
}
function record(value:unknown):value is Record<string,unknown> {return !!value&&typeof value==='object'&&!Array.isArray(value);}
function hasOwn(value:object,key:string) {return Object.prototype.hasOwnProperty.call(value,key);}
function verifiedSourceRow(source:MarketSource,now:number):boolean {
  const native=/^reddit:(post|comment):([a-z0-9]{1,20})$/i.exec(source.id);
  const created=Date.parse(source.createdAt),fetched=Date.parse(source.fetchedAt),expires=Date.parse(source.expiresAt),expiry=millis(source.expireAt);
  if(!native||native[1]!.toLowerCase()!==source.kind||!Number.isFinite(created)||new Date(created).toISOString()!==source.createdAt||
    !Number.isFinite(fetched)||!Number.isFinite(expires)||expiry===null||expiry!==expires||expiry<=now||
    expiry!==created+30*86400000||created>fetched+5*60_000||
    !/^[a-z0-9_]{2,21}$/.test(source.community)||! /^[a-z0-9]{1,20}$/i.test(source.threadId)||typeof source.text!=='string'||source.text.length>100_000||
    source.kind==='comment'&&!source.text.length||source.kind==='post'&&(typeof source.title!=='string'||source.title.length>1000)||
    source.kind==='comment'&&source.title!==null||source.kind==='post'&&source.parentId!==null||
    source.authorKey!==null&&!/^reddit:(?:t2_[a-z0-9]{1,20}|name:[a-z0-9_-]{1,32})$/i.test(source.authorKey)||
    source.authorDisplayName!==null&&(typeof source.authorDisplayName!=='string'||source.authorDisplayName.length>100)) return false;
  if(source.kind==='comment') {
    const parent=/^t([13])_([a-z0-9]{1,20})$/i.exec(source.parentId??'');
    if(!parent||parent[1]==='3'&&parent[2]!.toLowerCase()!==source.threadId.toLowerCase()) return false;
  }
  const expectedUrl=source.kind==='post'?`https://www.reddit.com/r/${source.community}/comments/${source.threadId}/`:
    `https://www.reddit.com/r/${source.community}/comments/${source.threadId}/_/${native[2]!.toLowerCase()}/`;
  return source.url===expectedUrl&&source.contentHash===marketSourceContentHash(source);
}
function validObservationRow(observation:MarketObservation,requestedID:string):boolean {
  return observation.id===requestedID&&typeof observation.user_id==='string'&&typeof observation.app_id==='string'&&
    Number.isInteger(observation.profileRevision)&&z.string().uuid().safeParse(observation.problemId).success&&typeof observation.sourceId==='string'&&
    typeof observation.sourceContentHash==='string'&&typeof observation.quote==='string'&&typeof observation.explanation==='string'&&
    typeof observation.prospectReason==='string'&&Array.isArray(observation.matchedCapabilityIds)&&
    observation.matchedCapabilityIds.every(id=>typeof id==='string')&&
    ['recurring_problem','competitor_complaint','workaround'].includes(observation.signalKind)&&
    ['potential_fit','needs_review','not_a_prospect'].includes(observation.prospectStatus)&&millis(observation.expireAt)!==null;
}

async function marketContext(store:Store,userId:string,appId:string,env:NodeJS.ProcessEnv):Promise<ProfileContext> {
  await requireMarketingAccess(store,userId,appId,env);
  if(!marketFeatureEnabledFor(userId,env)) throw new ServiceError(403,'Market insights are not enabled for this account yet.','FEATURE_UNAVAILABLE');
  const app=await store.getApp(appId,userId);
  if(!app) throw new ServiceError(404,'App not found.','APP_NOT_FOUND');
  const profile=await store.get<LeadProfile>('lead_profiles',documentKey(userId,appId));
  if(!completeProfile(profile,userId,appId)) throw new ServiceError(409,'Confirm this app’s problems, capabilities, and communities before using Market.','MISSING_PROFILE');
  return {userId,appId,profile};
}
async function assertProfileCurrent(store:Store,context:ProfileContext) {
  if(!await store.getApp(context.appId,context.userId)) throw new ServiceError(404,'App not found.','APP_NOT_FOUND');
  const latest=await store.get<LeadProfile>('lead_profiles',documentKey(context.userId,context.appId));
  if(!completeProfile(latest,context.userId,context.appId)) throw new ServiceError(409,'Confirm the app profile before using Market.','MISSING_PROFILE');
  if(latest.revision!==context.profile.revision) throw new ServiceError(409,'The app profile changed. Refresh Market and try again.','STALE_PROFILE');
}

function snapshotShape(value:MarketSnapshot|undefined,userId:string,appId:string,revision:number,now:number):value is MarketSnapshot {
  if(!value||value.user_id!==userId||value.app_id!==appId||value.profileRevision!==revision||typeof value.id!=='string'||
    !Number.isFinite(Date.parse(value.generatedAt))||!Number.isFinite(Date.parse(value.windowStart))||!Number.isFinite(Date.parse(value.windowEnd))||
    !['partial','complete_for_configured_scan'].includes(value.coverage)||millis(value.expireAt)===null||millis(value.expireAt)!<=now||
    !record(value.sourceContentHashes)||!Array.isArray(value.problems)||value.problems.length>12) return false;
  return boundedIDs(value.sourceIds,MAX_SNAPSHOT_SOURCES)!==null&&boundedIDs(value.observationIds,MAX_SNAPSHOT_OBSERVATIONS)!==null&&
    value.problems.every(problem=>record(problem)&&typeof problem.id==='string'&&typeof problem.title==='string'&&typeof problem.summary==='string');
}

async function loadSnapshot(store:Store,userId:string,appId:string,revision:number,snapshotId:string,now:number):Promise<LoadedSnapshot|null> {
  if(!z.string().uuid().safeParse(snapshotId).success) return null;
  const snapshot=await store.get<MarketSnapshot>('market_snapshots',snapshotId);
  if(!snapshotShape(snapshot,userId,appId,revision,now)) return null;
  const sourceIDs=boundedIDs(snapshot.sourceIds,MAX_SNAPSHOT_SOURCES)!,observationIDs=boundedIDs(snapshot.observationIds,MAX_SNAPSHOT_OBSERVATIONS)!;
  const [sourceRows,observationRows]=await Promise.all([
    Promise.all(sourceIDs.map(id=>store.get<MarketSource>('market_sources',id))),
    Promise.all(observationIDs.map(id=>store.get<MarketObservation>('market_observations',id))),
  ]);
  const sources=sourceRows.filter((source,index):source is MarketSource=>!!source&&source.id===sourceIDs[index]&&source.provider==='reddit'&&verifiedSourceRow(source,now));
  const observations=observationRows.filter((observation,index):observation is MarketObservation=>!!observation&&validObservationRow(observation,observationIDs[index]!));
  const sourceContentHashes:Record<string,string>={};
  for(const source of sources) if(hasOwn(snapshot.sourceContentHashes,source.id)&&snapshot.sourceContentHashes[source.id]===source.contentHash) {
    sourceContentHashes[source.id]=source.contentHash;
  }
  const problemIDs=[...new Set([...snapshot.problems.map(problem=>problem.id),...observations.map(observation=>observation.problemId)])].slice(0,MAX_SNAPSHOT_PROBLEMS);
  const problemRows=await Promise.all(problemIDs.map(id=>store.get<MarketProblemRecord>('market_problems',id)));
  const aggregate=aggregateMarketEvidence({sources,observations,problemRows:problemRows.filter((row):row is MarketProblemRecord=>!!row),
    userId,appId,revision,now,sourceContentHashes});
  const savedProblems=new Map(snapshot.problems.map(problem=>[problem.id,problem]));
  const stableProblems=aggregate.problems.map(problem=>{
    const saved=savedProblems.get(problem.id);
    return saved?{...problem,title:saved.title,summary:saved.summary}:problem;
  });
  return {snapshot,aggregate:{...aggregate,problems:stableProblems}};
}

function evidenceDTO(observation:MarketObservation,source:MarketSource):MarketEvidenceDTO {
  const {expireAt:_expireAt,...fields}=source;
  return {id:observation.id,problemId:observation.problemId,signalKind:observation.signalKind,quote:observation.quote,explanation:observation.explanation,
    prospectStatus:observation.prospectStatus,prospectReason:observation.prospectReason,matchedCapabilityIds:observation.matchedCapabilityIds,
    competitorName:observation.competitorName,sourceContentHash:observation.sourceContentHash,source:{...fields,isSample:false},isSample:false};
}

function researchFrom(snapshot:MarketSnapshot) {
 const parsed=marketResearchSchema.safeParse(snapshot.research);return parsed.success?parsed.data:null;
}
function researchProblems(snapshot:MarketSnapshot) {
 const research=researchFrom(snapshot);
 return (research?.findings??[]).map((finding,index)=>{
  const keys=new Set(finding.sources.map(source=>citationKey(source.url)));
  const people=(research?.prospects??[]).filter(p=>p.evidence.some(e=>keys.has(citationKey(e.url))));
  return {id:`${snapshot.id.slice(0,24)}${String(index).padStart(12,'0')}`,title:finding.title,summary:finding.summary,
   signalKind:'workaround' as const,peopleCount:new Set(people.map(p=>p.provider+'|'+p.profileUrl)).size,
   conversationCount:new Set(people.flatMap(p=>p.evidence.filter(e=>keys.has(citationKey(e.url))).map(e=>citationKey(e.url)))).size,
   observationCount:people.length,representativeEvidenceId:null,lastObservedAt:null};
 });
}
function researchPeople(snapshot:MarketSnapshot,userId:string,appId:string):MarketPersonDTO[] {
 const research=researchFrom(snapshot),problems=researchProblems(snapshot);
 return (research?.prospects??[]).map(p=>({id:documentKey(userId,appId,p.id),authorKey:'web:'+p.id,
  authorDisplayName:p.displayName,prospectStatus:'needs_review',prospectReason:p.fitReason,
  problemIds:(research?.findings??[]).flatMap((f,i)=>f.sources.some(s=>p.evidence.some(e=>citationKey(s.url)===citationKey(e.url)))?[problems[i]!.id]:[]),
  evidence:[],researchProspect:p,isSample:false}));
}

function signingSecret(options:MarketRouterOptions):string|undefined {
  const secret=options.cursorSecret??options.env?.MARKET_CURSOR_SECRET??process.env.MARKET_CURSOR_SECRET;
  return secret&&secret.length>=32?secret:undefined;
}
function invalidCursor():never {throw new ServiceError(400,'This Market people cursor is invalid or no longer matches the selected snapshot.','INVALID_CURSOR');}
function decodeCursor(token:string,secret:string,expected:{userId:string;appId:string;revision:number;problemId:string|null;snapshotId?:string}):CursorPayload {
  try {
    const parts=token.split('.');if(parts.length!==2||parts[0].length>1400||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return invalidCursor();
    const signature=createHmac('sha256',secret).update(parts[0]).digest();const supplied=Buffer.from(parts[1],'base64url');
    if(supplied.length!==signature.length||!timingSafeEqual(signature,supplied)) return invalidCursor();
    const payload=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')) as Partial<CursorPayload>;
    if(payload.v!==1||payload.userId!==expected.userId||payload.appId!==expected.appId||payload.revision!==expected.revision||
      payload.problemId!==expected.problemId||typeof payload.snapshotId!=='string'||!z.string().uuid().safeParse(payload.snapshotId).success||
      expected.snapshotId&&payload.snapshotId!==expected.snapshotId||typeof payload.after!=='string'||payload.after.length<1||payload.after.length>120) return invalidCursor();
    return payload as CursorPayload;
  } catch {return invalidCursor();}
}
function encodeCursor(payload:CursorPayload,secret:string) {
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}

function scanHeadFor(context:ProfileContext) {return snapshotHeadID(context.userId,context.appId,context.profile.revision);}
async function currentScanDTO(store:Store,context:ProfileContext,now:number) {
  const head=await store.get<{user_id:string;app_id:string;activeScanId?:string|null;latestScanId?:string|null;expireAt?:unknown}>(
    'market_scan_heads',scanHeadFor(context));
  if(!head||head.user_id!==context.userId||head.app_id!==context.appId||millis(head.expireAt)!==null&&millis(head.expireAt)!<=now) return null;
  const id=head.activeScanId||head.latestScanId;
  return id?await marketScanStatus(store,context.userId,context.appId,id,now)??null:null;
}

export function marketRouter(store:Store,options:MarketRouterOptions={}) {
  const router=Router();
  const env=options.env??process.env;
  const now=()=>options.now?.()??Date.now();
  router.use('/apps/:appId/market',rateLimit(store,'market-read',120,60000,req=>uid(req)));

  router.get('/apps/:appId/market',async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),context=await marketContext(store,userId,appId,env),at=now();
    const headID=scanHeadFor(context);
    const [snapshotHead,scan]=await Promise.all([
      store.get<{user_id:string;app_id:string;profileRevision:number;snapshotId:string;expireAt:unknown}>('market_snapshot_heads',headID),
      currentScanDTO(store,context,at),
    ]);
    let loaded:LoadedSnapshot|null=null;
    if(snapshotHead&&snapshotHead.user_id===userId&&snapshotHead.app_id===appId&&snapshotHead.profileRevision===context.profile.revision&&
      millis(snapshotHead.expireAt)!==null&&millis(snapshotHead.expireAt)!>at) {
      loaded=await loadSnapshot(store,userId,appId,context.profile.revision,snapshotHead.snapshotId,at);
    }
    await assertProfileCurrent(store,context);
    const aggregate=loaded?.aggregate;
    const parsedResearch=marketResearchSchema.safeParse(loaded?.snapshot.research);
    const research=parsedResearch.success?parsedResearch.data:null;
    const problems=aggregate?.problems.length?aggregate.problems:loaded?researchProblems(loaded.snapshot):[];
    res.json({appId,profileRevision:context.profile.revision,snapshotId:loaded?.snapshot.id??null,
      generatedAt:loaded?.snapshot.generatedAt??null,windowStart:loaded?.snapshot.windowStart??null,windowEnd:loaded?.snapshot.windowEnd??null,
      coverage:loaded?.snapshot.coverage??emptyCoverage,research,sources:research?[{provider:'web',collectedCount:new Set([
        ...research.findings.flatMap(f=>f.sources.map(s=>s.url)),...(research.landscape??[]).flatMap(f=>f.sources.map(s=>s.url)),
        ...(research.prospects??[]).flatMap(p=>p.evidence.map(e=>e.url))]).size}]:[{provider:'reddit',collectedCount:aggregate?.validSources.length??0}],
      featuredProblemId:problems[0]?.id??null,problems,evidence:aggregate?.evidence??[],scan,isSample:false});
  });

  router.get('/apps/:appId/market/people',async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),context=await marketContext(store,userId,appId,env),query=marketPeopleInput.parse(req.query),at=now();
    const secret=signingSecret(options);
    let cursor:CursorPayload|undefined;
    if(query.cursor) {
      if(!secret) throw new ServiceError(503,'Market people pagination is not configured.','MARKET_CURSOR_UNAVAILABLE');
      cursor=decodeCursor(query.cursor,secret,{userId,appId,revision:context.profile.revision,problemId:query.problemId??null,snapshotId:query.snapshotId});
    }
    const requestedSnapshot=query.snapshotId??cursor?.snapshotId;
    let snapshotID=requestedSnapshot;
    if(!snapshotID) {
      const head=await store.get<{user_id:string;app_id:string;profileRevision:number;snapshotId:string;expireAt:unknown}>(
        'market_snapshot_heads',scanHeadFor(context));
      if(head&&head.user_id===userId&&head.app_id===appId&&head.profileRevision===context.profile.revision&&millis(head.expireAt)!==null&&millis(head.expireAt)!>at)
        snapshotID=head.snapshotId;
    }
    if(!snapshotID) {
      await assertProfileCurrent(store,context);
      const empty:MarketPeoplePageDTO={appId,profileRevision:context.profile.revision,snapshotId:null,problemId:query.problemId??null,
        people:[],nextCursor:null,coverage:emptyCoverage,windowStart:null,windowEnd:null};res.json(empty);return;
    }
    const loaded=await loadSnapshot(store,userId,appId,context.profile.revision,snapshotID,at);
    if(!loaded) throw new ServiceError(409,'This Market snapshot expired or changed. Refresh Market to continue.','STALE_SNAPSHOT');
    if(query.problemId&&![...loaded.snapshot.problems,...researchProblems(loaded.snapshot)].some(problem=>problem.id===query.problemId))
      throw new ServiceError(404,'This problem is not in the selected Market snapshot.','MARKET_PROBLEM_NOT_FOUND');

    const sourceMap=new Map(loaded.aggregate.validSources.map(source=>[source.id,source]));
    const authorIdentities=marketAuthorIdentities(loaded.aggregate.validSources);
    const rowsByAuthor=new Map<string,MarketObservation[]>();
    for(const observation of loaded.aggregate.validObservations) {
      if(query.problemId&&observation.problemId!==query.problemId) continue;
      const identity=authorIdentities.get(observation.sourceId);if(!identity) continue;
      const list=rowsByAuthor.get(identity)??[];list.push(observation);rowsByAuthor.set(identity,list);
    }
    const rankedProblems=new Map(loaded.aggregate.problems.map((problem,index)=>[problem.id,index]));
    const people:MarketPersonDTO[]=researchPeople(loaded.snapshot,userId,appId).filter(p=>!query.problemId||p.problemIds.includes(query.problemId));
    for(const [authorKey,observations] of rowsByAuthor) {
      const ordered=[...new Map(observations.map(observation=>[observation.id,observation])).values()].sort((left,right)=>{
        const leftSource=sourceMap.get(left.sourceId),rightSource=sourceMap.get(right.sourceId);
        return (rightSource?.createdAt??'').localeCompare(leftSource?.createdAt??'')||left.id.localeCompare(right.id);
      });
      const bestRank=(status:string)=>status==='potential_fit'?0:status==='needs_review'?1:2;
      const best=ordered.reduce((chosen,row)=>bestRank(row.prospectStatus)<bestRank(chosen.prospectStatus)?row:chosen,ordered[0]!);
      const named=ordered.map(row=>sourceMap.get(row.sourceId)).find(source=>!!source?.authorDisplayName?.trim())?.authorDisplayName?.trim()??null;
      const problemIds=[...new Set(ordered.map(row=>row.problemId))].sort((a,b)=>(rankedProblems.get(a)??Number.MAX_SAFE_INTEGER)-(rankedProblems.get(b)??Number.MAX_SAFE_INTEGER)||lexical(a,b));
      const selectedEvidence=ordered.slice(0,MAX_PERSON_EVIDENCE);
      if(!selectedEvidence.some(row=>row.id===best.id)) selectedEvidence[selectedEvidence.length-1]=best;
      const evidence=selectedEvidence.flatMap(row=>{const source=sourceMap.get(row.sourceId);return source?[evidenceDTO(row,source)]:[];});
      people.push({id:documentKey(userId,appId,loaded.snapshot.id,authorKey),authorKey,authorDisplayName:named,
        prospectStatus:best.prospectStatus,prospectReason:best.prospectReason,problemIds,evidence,isSample:false});
    }
    people.sort((left,right)=>lexical(left.authorKey,right.authorKey));
    const after=cursor?.after;
    const eligible=after?people.filter(person=>lexical(person.authorKey,after)>0):people;
    const page=eligible.slice(0,query.limit);
    const hasMore=eligible.length>page.length;
    let nextCursor:string|null=null;
    if(hasMore) {
      if(!secret) throw new ServiceError(503,'Market people pagination is not configured.','MARKET_CURSOR_UNAVAILABLE');
      const last=page.at(-1)!;
      nextCursor=encodeCursor({v:1,userId,appId,revision:context.profile.revision,snapshotId:loaded.snapshot.id,
        problemId:query.problemId??null,after:last.authorKey},secret);
    }
    await assertProfileCurrent(store,context);
    res.json({appId,profileRevision:context.profile.revision,snapshotId:loaded.snapshot.id,problemId:query.problemId??null,
      people:page,nextCursor,coverage:loaded.snapshot.coverage,windowStart:loaded.snapshot.windowStart,windowEnd:loaded.snapshot.windowEnd} satisfies MarketPeoplePageDTO);
  });

  router.post('/apps/:appId/market/scan',async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),input=marketScanInput.parse(req.body),context=await marketContext(store,userId,appId,env),at=now();
    if(input.expectedRevision!==context.profile.revision) throw new ServiceError(409,'The app profile changed. Refresh Market and try again.','STALE_PROFILE');
    const row=await queueMarketScan(store,userId,appId,input,env,at);
    await assertProfileCurrent(store,context);
    res.status(202).json({scan:marketScanDTO(row,at)});
  });

  router.get('/apps/:appId/market/scans/:scanId',async(req,res)=>{
    const userId=uid(req),appId=appParam(req.params.appId),scanId=z.string().uuid().parse(req.params.scanId),context=await marketContext(store,userId,appId,env),at=now();
    const status=await marketScanStatus(store,userId,appId,scanId,at);
    if(!status) throw new ServiceError(404,'Market scan not found.','MARKET_SCAN_NOT_FOUND');
    if(status.profileRevision!==context.profile.revision) throw new ServiceError(409,'The app profile changed. Refresh Market and start a new scan.','STALE_PROFILE');
    await assertProfileCurrent(store,context);
    res.json(status);
  });

  return router;
}
