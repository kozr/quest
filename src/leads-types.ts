import {Timestamp} from 'firebase-admin/firestore';
import {z} from 'zod';
import type {LeadReplyPlan} from './lead-replies.js';

const community=z.string().trim().transform(v=>v.replace(/^r\//i,'').toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{2,21}$/));
const problemInput=z.object({id:z.string().uuid().optional(),text:z.string().trim().min(3).max(240)}).strict();
const capabilityInput=z.object({id:z.string().uuid().optional(),text:z.string().trim().min(3).max(240)}).strict();
export const leadProfileInput=z.object({
  expectedRevision:z.number().int().min(0).max(1_000_000),enabled:z.boolean(),
  problems:z.array(problemInput).min(1).max(8),capabilities:z.array(capabilityInput).min(1).max(8),
  communities:z.array(community).max(10).transform(v=>[...new Set(v)]),
  keywords:z.array(z.string().trim().min(1).max(80)).max(20).transform(v=>[...new Set(v.map(k=>k.toLowerCase()))]),
  draftId:z.string().min(20).max(128).optional(),
}).strict().refine(v=>!v.enabled || v.communities.length>0,{message:'Choose at least one community before enabling leads.'});
export type LeadProfileInput=z.infer<typeof leadProfileInput>;
export const leadDraftInput=z.object({requestId:z.string().uuid()}).strict();
export const leadDismissInput=z.object({mutationId:z.string().uuid()}).strict();
export const leadListInput=z.object({cursor:z.string().max(2048).optional(),limit:z.coerce.number().int().min(1).max(20).default(20)});

export interface LeadProblem {id:string;text:string}
export interface LeadCapability {id:string;text:string;evidenceQuote?:string;source:'app_store'|'user_confirmed'}
export interface DescriptionSource {appleId:string;country:string;fetchedAt:string;contentHash:string}
export interface LeadProfile {
  user_id:string;app_id:string;schemaVersion:1;revision:number;enabled:boolean;
  problems:LeadProblem[];capabilities:LeadCapability[];communities:string[];keywords:string[];
  descriptionSource:DescriptionSource|null;confirmedAt:string;updatedAt:string;
}
export interface LeadProfileDTO extends Omit<LeadProfile,'user_id'|'app_id'> {appId:string}
export interface LeadDraft {
  user_id:string;app_id:string;status:'succeeded';sourceDescription:string;sourceHash:string;
  source:{appleId:string;country:string;fetchedAt:string};problems:Array<{text:string;rationale:string}>;
  capabilities:Array<{text:string;evidenceQuote:string;rationale:string}>;suggestedCommunities:string[];
  createdAt:string;expireAt:Timestamp;promptVersion?:string;
}
export interface LeadAssessment {
  user_id:string;app_id:string;profileRevision:number;postId:string;postContentHash:string;
  postCreatedAt:string;decision:'qualified'|'rejected';explicitIntent:boolean;intentQuote:string;
  capabilityIds:string[];sourceEvidenceQuotes:string[];whyItFits:string;modelVersion:string;promptVersion:string;
  assessedAt:string;expireAt:Timestamp;
  imageEvidence?:LeadImageEvidence[];
}
export interface LeadDismissal {user_id:string;app_id:string;post_id:string;dismissedAt:string;mutationId:string;expireAt:Timestamp}
export type LeadJobState='pending'|'running'|'succeeded'|'failed'|'uncertain'|'cancelled';
export interface LeadJob {
  id:string;user_id:string;app_id:string;kind:'draft'|'qualify'|'discover'|'reply';inputHash:string;requestId?:string;
  replyPlan?:LeadReplyPlan;
  historical?:boolean;discoveryURLs?:string[];discoveryContext?:LeadDiscoveryContext;discoveryTrace?:LeadDiscoveryTrace;
  profileRevision?:number;postId?:string;postContentHash?:string;sourceDescription?:string;
  source?:{appleId:string;country:string;fetchedAt:string};state:LeadJobState;reasonCode?:string;nextAttemptAt:number;
  leaseToken?:string;leaseUntil?:number;createdAt:string;updatedAt:string;expireAt:Timestamp;
  budgetMonth?:string;reservationMicroUsd?:number;dispatchedAt?:string;providerRequestId?:string;
}

export interface LeadDraftProposal {
  problems:Array<{text:string;rationale:string}>;
  capabilities:Array<{text:string;evidenceQuote:string;rationale:string}>;
  suggestedCommunities:string[];
}
export interface LeadQualification {
  // Legacy wire name: explicitIntent records an evidenced goal/need/situation,
  // not a requirement that the author explicitly asks for software.
  decision:'qualified'|'rejected';explicitIntent:boolean;intentQuote:string;
  capabilityIds:string[];fitEvidenceQuotes:string[];whyItFits:string;
  imageEvidence?:LeadImageEvidence[];
}
export interface LeadImageEvidence {imageIndex:number;observation:string}
export interface LeadAIUsage {inputTokens:number;outputTokens:number;searchCalls?:number}
export interface LeadAIResult<T> {value:T;usage:LeadAIUsage;model:string;requestId?:string}
export interface LeadDiscoveryContext {round:number;totalRounds:number;excludeURLs:string[];previousQueries:string[];phase?:'quick'|'background'}
export interface LeadDiscoveryTrace {queries:string[];sourceCount:number;returnedCount:number;toolCalls:number}
export interface LeadDiscoveryResult {urls:string[];trace?:LeadDiscoveryTrace}
export interface LeadAIProvider {
  draftProfile(description:string,source:{appName:string;appleId:string;country:string}):Promise<LeadAIResult<LeadDraftProposal>>;
  qualifyPost(post:{id:string;subreddit:string;title:string;body:string;createdAt:string;images?:string[]},profile:LeadProfile):Promise<LeadAIResult<LeadQualification>>;
  discoverThreads?(profile:LeadProfile,appName:string,context?:LeadDiscoveryContext):Promise<LeadAIResult<LeadDiscoveryResult>>;
  draftReplies?(post:{title:string;body:string;subreddit:string},profile:LeadProfile,appName:string):Promise<LeadAIResult<LeadReplyPlan>>;
}
export interface LeadAISettings {
  enabled:boolean;configured:boolean;reasonCode:string|null;apiKey?:string;model?:string;
  inputPriceCeiling?:number;outputPriceCeiling?:number;globalCapMicroUsd:number;accountCapMicroUsd:number;
}

export const LEAD_PROMPT_VERSION='questline-leads-v1';
export const LEAD_PROFILE_PROMPT_VERSION='questline-profile-v3-direct-need';
export const MAX_FIT_SUMMARY=80;
export const MAX_SEARCH_CALLS=6;
export const MAX_DISCOVERY_OUTPUT=4800;
export const MAX_DISCOVERY_ROUNDS=3;
export const SEARCH_CALL_MICRO_USD=10000;
// Revisit previously prefiltered posts when matching criteria change. Existing
// job IDs stay stable so completed/uncertain provider calls are never replayed.
export const LEAD_QUALIFICATION_VERSION='questline-leads-v6-op-images';
export const MAX_POST_TEXT=4000;
export const MAX_DESCRIPTION=12000;
// Includes reasoning tokens for GPT-6 reasoning models. This deliberately
// generous but finite cap supports the bounded draft schema and is also used
// verbatim by reservation and post-call cost checks. Production token quality
// still needs calibration with real traffic before enabling the beta.
export const MAX_OUTPUT_TOKENS=1600;
export const AI_GLOBAL_CAP_DEFAULT_USD=5;
export const AI_ACCOUNT_CAP_DEFAULT_USD=1;

export const leadIntentSchema=z.object({
  decision:z.enum(['qualified','rejected']),explicitIntent:z.boolean(),intentQuote:z.string().max(500),
  capabilityIds:z.array(z.string().uuid()).max(8),fitEvidenceQuotes:z.array(z.string().max(500)).max(4),
  whyItFits:z.string().max(MAX_FIT_SUMMARY),
}).strict();
export const leadImageIntentSchema=leadIntentSchema.extend({imageEvidence:z.array(z.object({imageIndex:z.number().int().min(1).max(2),observation:z.string().trim().min(3).max(500)}).strict()).max(2)});
export const leadDraftProposalSchema=z.object({
  problems:z.array(z.object({text:z.string().trim().min(3).max(240),rationale:z.string().trim().min(3).max(240)}).strict()).min(1).max(4),
  capabilities:z.array(z.object({text:z.string().trim().min(3).max(240),evidenceQuote:z.string().trim().min(3).max(500),rationale:z.string().trim().min(3).max(240)}).strict()).min(1).max(4),
  suggestedCommunities:z.array(z.string().trim().min(2).max(21)).max(10),
}).strict();
