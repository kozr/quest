import type {ResearchProspect} from './market-prospects.js';
import type {MarketResearch,MarketResearchInput,MarketResearchResult} from './market-research.js';
import {Timestamp} from 'firebase-admin/firestore';
import {z} from 'zod';
import type {LeadProfile} from './leads-types.js';

export type MarketSignalKind='recurring_problem'|'competitor_complaint'|'workaround';
export type MarketProspectStatus='potential_fit'|'needs_review'|'not_a_prospect';
export type MarketSourceKind='post'|'comment';
export type MarketCoverage='partial'|'complete_for_configured_scan';
export type MarketScanState='queued'|'collecting'|'analyzing'|'complete'|'failed'|'cancelled';

export interface MarketSource {
  id:string;provider:'reddit';kind:MarketSourceKind;threadId:string;parentId:string|null;
  authorKey:string|null;authorDisplayName:string|null;title:string|null;text:string;community:string;url:string;
  createdAt:string;fetchedAt:string;contentHash:string;expiresAt:string;
  /** Firestore retention is also checked synchronously; TTL is only eventual cleanup. */
  expireAt:Timestamp;
}
export interface MarketObservation {
  id:string;user_id:string;app_id:string;profileRevision:number;sourceId:string;problemId:string;
  signalKind:MarketSignalKind;quote:string;explanation:string;prospectStatus:MarketProspectStatus;
  prospectReason:string;matchedCapabilityIds:string[];competitorName:string|null;sourceContentHash:string;
  model:string;promptVersion:string;observedAt:string;needStatus:'unresolved'|'resolved'|'unclear';
  isProductBuilder:boolean;isSatisfied:boolean;expireAt:Timestamp;
}
export interface MarketProblemRecord {
  id:string;user_id:string;app_id:string;title:string;summary:string;signalKind:MarketSignalKind;
  groupKey:string;sourceAnchors?:string[];capabilityAnchors?:string[];profileProblemAnchors?:string[];
  createdAt:string;updatedAt:string;expireAt:Timestamp;
}
export interface MarketScanRow {
  researchMode?: boolean;
  id:string;user_id:string;app_id:string;profileRevision:number;idempotencyKey:string;inputHash:string;
  state:MarketScanState;reasonCode?:string;requestedAt:string;startedAt?:string;finishedAt?:string;
  windowStart:string;windowEnd:string;nextAttemptAt:number;leaseToken?:string;leaseUntil?:number;
  fence?:number;collectionPhase?:'search'|'comments'|'analyzing';collectionClaim?:string;runId?:string|null;datasetId?:string|null;
  commentRunId?:string;commentDatasetId?:string;collectionMonth?:string;collectionReservationUsd?:number;
  collectionDispatched?:boolean;aiReservationMicroUsd?:number;aiBudgetMonth?:string;aiDispatched?:boolean;
  collectionTruncated?:boolean;
  sourceIds?:string[];observationIds?:string[];snapshotId?:string;coverage?:MarketCoverage;
  canRetry:boolean;expireAt:Timestamp;updatedAt:string;
}
export interface MarketSnapshot {
  research?: MarketResearch;
  id:string;user_id:string;app_id:string;profileRevision:number;generatedAt:string;windowStart:string;windowEnd:string;
  coverage:MarketCoverage;sourceIds:string[];sourceContentHashes:Record<string,string>;
  observationIds:string[];problems:MarketProblemDTO[];expireAt:Timestamp;
}
export interface MarketEvidenceDTO {
  id:string;problemId:string;signalKind:MarketSignalKind;quote:string;explanation:string;
  prospectStatus:MarketProspectStatus;prospectReason:string;matchedCapabilityIds:string[];
  competitorName:string|null;sourceContentHash:string;source:Omit<MarketSource,'expireAt'> & {isSample:false};isSample:false;
}
export interface MarketProblemDTO {
  id:string;title:string;summary:string;signalKind:MarketSignalKind;peopleCount:number;
  conversationCount:number;observationCount:number;representativeEvidenceId:string|null;lastObservedAt:string|null;
}
export interface MarketScanDTO {
  id:string;status:MarketScanState;profileRevision:number;requestedAt:string;startedAt:string|null;
  finishedAt:string|null;nextRunAt:string|null;retryAfter:string|null;reasonCode:string|null;canRetry:boolean;
}
export interface MarketOverviewDTO {
  research?:MarketResearch|null;
  appId:string;profileRevision:number;snapshotId:string|null;generatedAt:string|null;windowStart:string|null;windowEnd:string|null;
  coverage:MarketCoverage;sources:Array<{provider:'reddit'|'web';collectedCount:number}>;featuredProblemId:string|null;
  problems:MarketProblemDTO[];evidence:MarketEvidenceDTO[];scan:MarketScanDTO|null;isSample:false;
}
export interface MarketPersonDTO {
  researchProspect?:ResearchProspect;
  id:string;authorKey:string;authorDisplayName:string|null;prospectStatus:MarketProspectStatus;prospectReason:string;
  problemIds:string[];evidence:MarketEvidenceDTO[];isSample:false;
}
export interface MarketPeoplePageDTO {
  appId:string;profileRevision:number;snapshotId:string|null;problemId:string|null;people:MarketPersonDTO[];nextCursor:string|null;
  coverage:MarketCoverage;windowStart:string|null;windowEnd:string|null;
}

export const marketScanInput=z.object({expectedRevision:z.number().int().positive().max(1_000_000),idempotencyKey:z.string().uuid()}).strict();
export const marketPeopleInput=z.object({problemId:z.string().uuid().optional(),snapshotId:z.string().uuid().optional(),cursor:z.string().max(2048).optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
export type MarketScanInput=z.infer<typeof marketScanInput>;
export type MarketPeopleInput=z.infer<typeof marketPeopleInput>;

export interface MarketAnalysisObservation {
  sourceId:string;quote:string;explanation:string;prospectReason:string;
  needStatus:'unresolved'|'resolved'|'unclear';isProductBuilder:boolean;isSatisfied:boolean;
  matchedCapabilityIds:string[];competitorName:string|null;
}
export interface MarketAnalysisGroup {
  problemId:string|null;groupKey:string;title:string;summary:string;signalKind:MarketSignalKind;
  observations:MarketAnalysisObservation[];
}
export interface MarketAnalysisOutput {groups:MarketAnalysisGroup[]}
export interface MarketAIResult {value:MarketAnalysisOutput;inputTokens:number;outputTokens:number;inputBytes:number;model:string;requestId?:string}
export interface MarketAIProvider {
  research?(input:MarketResearchInput):Promise<MarketResearchResult>;
  analyze(input:{appName:string;profile:LeadProfile;existingProblems:Array<Pick<MarketProblemRecord,'id'|'title'|'summary'|'signalKind'>>;sources:Array<Pick<MarketSource,'id'|'kind'|'threadId'|'authorDisplayName'|'title'|'text'|'community'|'createdAt'>>}):Promise<MarketAIResult>;
}

export const marketAnalysisSchema=z.object({groups:z.array(z.object({
  problemId:z.string().uuid().nullable(),groupKey:z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),title:z.string().trim().min(3).max(120),
  summary:z.string().trim().min(3).max(320),signalKind:z.enum(['recurring_problem','competitor_complaint','workaround']),
  observations:z.array(z.object({sourceId:z.string().min(3).max(100),quote:z.string().min(3).max(500),
    explanation:z.string().trim().min(3).max(320),needStatus:z.enum(['unresolved','resolved','unclear']),
    isProductBuilder:z.boolean(),isSatisfied:z.boolean(),
    prospectReason:z.string().trim().min(3).max(220),matchedCapabilityIds:z.array(z.string().uuid()).max(8),
    competitorName:z.string().trim().min(1).max(80).nullable()}).strict()).min(1).max(40)
}).strict()).max(12)}).strict();
