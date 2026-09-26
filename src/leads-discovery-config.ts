import type {LeadDiscoveryContext} from './leads-types.js';
import {MAX_SEARCH_CALLS} from './leads-types.js';

export const ONBOARDING_WAIT_MS=30_000;
export const QUALIFICATION_CONCURRENCY=3;

/** Discovery breadth changes by pass. Qualification never receives this setting. */
export function discoveryLimits(context?:LeadDiscoveryContext) {
  const quick=context?.phase==='quick';
  return {quick,maxCandidates:quick?5:20,maxToolCalls:quick?2:MAX_SEARCH_CALLS};
}
