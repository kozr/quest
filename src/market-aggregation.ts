import {randomUUID} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import {documentKey} from './database.js';
import {marketAnalysisSchema,type MarketAnalysisGroup,type MarketAnalysisObservation,type MarketAnalysisOutput,
  type MarketEvidenceDTO,type MarketObservation,type MarketProblemDTO,type MarketProblemRecord,type MarketSource} from './market-types.js';
import type {LeadProfile} from './leads-types.js';

export const MARKET_PROMPT_VERSION='questline-market-v1';

const evidenceText=(source:Pick<MarketSource,'title'|'text'>)=>`${source.title??''}\n${source.text}`;

/** Reject model output that cites a different source, changes a quote, or invents an app feature. */
export function validateMarketOutput(value:unknown,sources:MarketSource[],profile:LeadProfile,existing:MarketProblemRecord[]):MarketAnalysisOutput {
  const output=marketAnalysisSchema.parse(value);
  const bySource=new Map(sources.map(source=>[source.id,source]));
  const capabilityIDs=new Set(profile.capabilities.map(item=>item.id));
  const problemIDs=new Set(existing.map(problem=>problem.id));
  let total=0;
  for(const group of output.groups) {
    if(group.problemId) {
      const canonical=existing.find(problem=>problem.id===group.problemId);
      if(!canonical||!problemIDs.has(group.problemId)||canonicalSimilarity(group,canonical)<0.35)
        throw new Error('Market analysis referenced an unknown or unrelated canonical problem.');
    }
    for(const observation of group.observations) {
      const source=bySource.get(observation.sourceId);
      if(!source || !evidenceText(source).includes(observation.quote)) throw new Error('Market analysis quotation did not match its public source.');
      if(observation.matchedCapabilityIds.some(id=>!capabilityIDs.has(id))) throw new Error('Market analysis referenced an unsupported app capability.');
      total++;
      if(total>120) throw new Error('Market analysis exceeded its observation limit.');
    }
  }
  return output;
}

function words(value:string) {
  return new Set(value.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g,' ').split(/\s+/)
    .filter(word=>word.length>2&&!['with','from','that','this','their','they','have','would','could','about','into','when','what','where','your','there','using'].includes(word)));
}
function dice(left:Set<string>,right:Set<string>) {
  if(!left.size||!right.size) return 0;
  let common=0;for(const word of left) if(right.has(word)) common++;
  return 2*common/(left.size+right.size);
}
function canonicalSimilarity(group:MarketAnalysisGroup,problem:MarketProblemRecord) {
  if(group.signalKind!==problem.signalKind) return 0;
  const aTitle=words(group.title),bTitle=words(problem.title),aContext=words(`${group.title} ${group.summary}`),bContext=words(`${problem.title} ${problem.summary}`);
  const title=dice(aTitle,bTitle),context=dice(aContext,bContext);
  return Math.max(title,context*.88);
}

/** Keep problem IDs stable across wording edits; new records receive a persisted random ID. */
function groupAnchors(group:MarketAnalysisGroup) {
  return {sources:[...new Set(group.observations.map(row=>row.sourceId))],capabilities:[...new Set(group.observations.flatMap(row=>row.matchedCapabilityIds))]};
}
function intersectionCount(left:string[]|undefined,right:string[]) {
  const values=new Set(left??[]);return right.reduce((count,value)=>count+(values.has(value)?1:0),0);
}

export function resolveCanonicalProblems(groups:MarketAnalysisGroup[],existing:MarketProblemRecord[],userId:string,appId:string,now:number,profile?:LeadProfile) {
  const byID=new Map(existing.map(problem=>[problem.id,problem]));
  const rows=new Map<string,MarketProblemRecord>();
  const groupProblemIDs=new Map<MarketAnalysisGroup,string>();
  for(const group of groups) {
    const anchors=groupAnchors(group);
    const profileProblemAnchors=(profile?.problems??[]).filter(problem=>dice(words(`${group.title} ${group.summary}`),words(problem.text))>=0.42).map(problem=>problem.id);
    const referenced=group.problemId?byID.get(group.problemId):undefined;
    let record=referenced&&canonicalSimilarity(group,referenced)>=0.35?referenced:undefined;
    if(!record) {
      // Also compare within this batch so two model groups cannot create duplicate
      // persisted IDs for the same problem in one scan. Exact keys are only a hint;
      // similar issue context is still required before reusing a record.
      const candidates=[...new Map([...existing,...rows.values()].map(problem=>[problem.id,problem])).values()].map(problem=>{
        const sourceOverlap=intersectionCount(problem.sourceAnchors,anchors.sources);
        const capabilityOverlap=intersectionCount(problem.capabilityAnchors,anchors.capabilities);
        const profileOverlap=intersectionCount(problem.profileProblemAnchors,profileProblemAnchors);
        const textScore=canonicalSimilarity(group,problem);
        // Shared evidence and a broad app capability are corroborating anchors,
        // not enough by themselves: one post can support several distinct issues.
        // Reuse still requires matching issue context and signal kind.
        const anchored=(sourceOverlap>0&&capabilityOverlap>0&&textScore>=0.52)||(sourceOverlap>=2&&textScore>=0.42)||
          (profileOverlap>0&&capabilityOverlap>0&&textScore>=0.4);
        const sameKey=group.groupKey===problem.groupKey;
        const score=anchored?Math.max(textScore,0.9+Math.min(sourceOverlap,capabilityOverlap)*0.02):textScore;
        return {problem,score,anchored,sameKey};
      }).filter(v=>v.anchored||v.score>=(v.sameKey?0.62:0.68))
        .sort((a,b)=>Number(b.anchored)-Number(a.anchored)||b.score-a.score||a.problem.id.localeCompare(b.problem.id))[0];
      record=candidates?.problem;
    }
    const id=record?.id??randomUUID();
    const stamp=new Date(now).toISOString();
    const next:MarketProblemRecord={id,user_id:userId,app_id:appId,title:group.title,summary:group.summary,signalKind:group.signalKind,
      groupKey:group.groupKey,sourceAnchors:[...new Set([...(record?.sourceAnchors??[]),...anchors.sources])].slice(-40),
      capabilityAnchors:[...new Set([...(record?.capabilityAnchors??[]),...anchors.capabilities])].slice(-16),
      profileProblemAnchors:[...new Set([...(record?.profileProblemAnchors??[]),...profileProblemAnchors])].slice(-8),
      createdAt:record?.createdAt??stamp,updatedAt:stamp,expireAt:Timestamp.fromMillis(now+30*86400000)};
    rows.set(id,next);groupProblemIDs.set(group,id);
  }
  return {rows:[...rows.values()],groupProblemIDs};
}

export function prospectStatusFor(observation:MarketAnalysisObservation):MarketObservation['prospectStatus'] {
  if(observation.isProductBuilder||observation.isSatisfied||observation.needStatus==='resolved'||!observation.matchedCapabilityIds.length) return 'not_a_prospect';
  return observation.needStatus==='unresolved'?'potential_fit':'needs_review';
}

export function makeMarketObservation(input:{userId:string;appId:string;revision:number;problemId:string;source:MarketSource;
  observation:MarketAnalysisObservation;signalKind:MarketObservation['signalKind'];model:string;now:number}) {
  const {source,observation}=input;
  const id=documentKey(input.userId,input.appId,String(input.revision),input.problemId,source.id,source.contentHash,MARKET_PROMPT_VERSION);
  const prospectStatus=prospectStatusFor(observation);
  return {id,user_id:input.userId,app_id:input.appId,profileRevision:input.revision,sourceId:source.id,problemId:input.problemId,
    signalKind:input.signalKind,quote:observation.quote,explanation:observation.explanation,prospectStatus,
    prospectReason:observation.prospectReason,matchedCapabilityIds:observation.matchedCapabilityIds,competitorName:observation.competitorName,
    sourceContentHash:source.contentHash,model:input.model,promptVersion:MARKET_PROMPT_VERSION,observedAt:new Date(input.now).toISOString(),
    needStatus:observation.needStatus,isProductBuilder:observation.isProductBuilder,isSatisfied:observation.isSatisfied,
    expireAt:source.expireAt} satisfies MarketObservation;
}

export interface MarketAggregateResult {problems:MarketProblemDTO[];evidence:MarketEvidenceDTO[];validSources:MarketSource[];validObservations:MarketObservation[]}

/** Stable fullname IDs are authoritative. Resolve username-only rows to one fullname only when unambiguous. */
export function marketAuthorIdentities(sources:MarketSource[]) {
  const stableByName=new Map<string,Set<string>>();
  const canonicalStable=(key:string)=>key.match(/^reddit:(t2_[a-z0-9]+)$/i)?.[1]?.toLowerCase();
  for(const source of sources) {
    const stable=source.authorKey?canonicalStable(source.authorKey):undefined;
    const name=source.authorDisplayName?.trim().toLocaleLowerCase();
    if(stable&&name) {const set=stableByName.get(name)??new Set<string>();set.add(`reddit:${stable}`);stableByName.set(name,set);}
  }
  return new Map(sources.map(source=>{
    if(!source.authorKey) return [source.id,null] as const;
    const stable=canonicalStable(source.authorKey);if(stable) return [source.id,`reddit:${stable}`] as const;
    const fallback=source.authorKey.match(/^reddit:name:(.+)$/i)?.[1]?.trim().toLocaleLowerCase();
    if(!fallback) return [source.id,null] as const;
    const matches=stableByName.get(fallback);
    return [source.id,matches?.size===1?[...matches][0]:`reddit:name:${fallback}`] as const;
  }));
}

export function aggregateMarketEvidence(input:{sources:MarketSource[];observations:MarketObservation[];problemRows:MarketProblemRecord[];userId:string;appId:string;revision:number;now:number;
  sourceContentHashes?:Record<string,string>}):MarketAggregateResult {
  const sourceMap=new Map(input.sources.filter(source=>source.expireAt.toMillis()>input.now&&
    (!input.sourceContentHashes||input.sourceContentHashes[source.id]===source.contentHash)).map(source=>[source.id,source]));
  const problemMap=new Map(input.problemRows.filter(problem=>problem.user_id===input.userId&&problem.app_id===input.appId).map(problem=>[problem.id,problem]));
  const validObservations=input.observations.filter(observation=>{
    const source=sourceMap.get(observation.sourceId);
    return observation.user_id===input.userId&&observation.app_id===input.appId&&observation.profileRevision===input.revision&&
      observation.expireAt.toMillis()>input.now&&!!source&&source.contentHash===observation.sourceContentHash&&problemMap.has(observation.problemId);
  });
  const groups=new Map<string,MarketObservation[]>();
  for(const observation of validObservations) {
    const list=groups.get(observation.problemId)??[];list.push(observation);groups.set(observation.problemId,list);
  }
  const evidence:MarketEvidenceDTO[]=[];
  const problems:MarketProblemDTO[]=[];
  const authorIdentities=marketAuthorIdentities([...sourceMap.values()]);
  const representativeByProblem=new Map<string,string>();
  for(const [problemId,rows] of groups) {
    const record=problemMap.get(problemId)!;
    const ordered=[...rows].sort((a,b)=>{
      const aDate=sourceMap.get(a.sourceId)?.createdAt??'',bDate=sourceMap.get(b.sourceId)?.createdAt??'';
      return bDate.localeCompare(aDate)||a.id.localeCompare(b.id);
    });
    const authors=new Set<string>(),threads=new Set<string>();
    for(const row of ordered) {
      const source=sourceMap.get(row.sourceId)!;
      const identity=authorIdentities.get(source.id);if(identity) authors.add(identity);
      threads.add(source.threadId);
    }
    // A model may call one report recurring; only two known distinct authors earn that label.
    const signalKind=record.signalKind==='recurring_problem'&&authors.size<2?'workaround':record.signalKind;
    const groupEvidence=ordered.slice(0,12).flatMap(row=>{
      const source=sourceMap.get(row.sourceId);if(!source) return [];
      const {expireAt:_expireAt,...sourceFields}=source;
      evidence.push({id:row.id,problemId,signalKind:row.signalKind,quote:row.quote,explanation:row.explanation,
        prospectStatus:row.prospectStatus,prospectReason:row.prospectReason,matchedCapabilityIds:row.matchedCapabilityIds,
        competitorName:row.competitorName,sourceContentHash:row.sourceContentHash,source:{...sourceFields,isSample:false},isSample:false});
      return [row];
    });
    const newest=ordered[0]?sourceMap.get(ordered[0].sourceId)?.createdAt??null:null;
    const representative=groupEvidence.sort((a,b)=>Number(b.prospectStatus==='potential_fit')-Number(a.prospectStatus==='potential_fit')||
      (sourceMap.get(b.sourceId)?.createdAt??'').localeCompare(sourceMap.get(a.sourceId)?.createdAt??'')||a.id.localeCompare(b.id))[0];
    if(representative) representativeByProblem.set(problemId,representative.id);
    problems.push({id:problemId,title:record.title,summary:record.summary,signalKind,peopleCount:authors.size,
      conversationCount:threads.size,observationCount:rows.length,representativeEvidenceId:representative?.id??null,lastObservedAt:newest});
  }
  problems.sort((a,b)=>b.peopleCount-a.peopleCount||b.conversationCount-a.conversationCount||
    (b.lastObservedAt??'').localeCompare(a.lastObservedAt??'')||a.id.localeCompare(b.id));
  evidence.sort((a,b)=>b.source.createdAt.localeCompare(a.source.createdAt)||a.id.localeCompare(b.id));
  const selected=new Map(evidence.slice(0,100).map(row=>[row.id,row]));
  for(const id of representativeByProblem.values()) {const representative=evidence.find(row=>row.id===id);if(representative) selected.set(id,representative);}
  const finalEvidence=[...selected.values()].sort((a,b)=>b.source.createdAt.localeCompare(a.source.createdAt)||a.id.localeCompare(b.id));
  return {problems,evidence:finalEvidence,validSources:[...sourceMap.values()],validObservations};
}
