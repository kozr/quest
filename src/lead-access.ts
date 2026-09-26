import {createHash} from 'node:crypto';
import {Store} from './database.js';
import {redditAccess} from './reddit.js';
import {leadAISettings} from './leads-ai.js';

export function leadsEnabledFor(userId:string,env:NodeJS.ProcessEnv=process.env) {
  const reddit=redditAccess(env);
  return env.LEADS_ENABLED==='true' && reddit.enabled && reddit.allows(userId);
}
export function leadsFeatureReason(userId:string,env:NodeJS.ProcessEnv=process.env) {
  const reddit=redditAccess(env);
  if(env.LEADS_ENABLED!=='true') return 'LEADS_DISABLED';
  if(!reddit.enabled || !reddit.allows(userId)) return 'BETA_ACCESS_REQUIRED';
  return null;
}
export function publicAIConfigFingerprint(env:NodeJS.ProcessEnv=process.env) {
  const cfg=leadAISettings(env,false);
  if(!cfg.configured || !cfg.model || !cfg.inputPriceCeiling || !cfg.outputPriceCeiling) return null;
  return createHash('sha256').update(JSON.stringify([cfg.model,cfg.inputPriceCeiling,cfg.outputPriceCeiling,cfg.globalCapMicroUsd,cfg.accountCapMicroUsd])).digest('hex');
}
export async function readLeadAIHealth(store:Store,env:NodeJS.ProcessEnv=process.env,now=Date.now()) {
  const publicConfig=publicAIConfigFingerprint(env);
  if(env.LEADS_AI_ENABLED!=='true') return {available:false,reasonCode:'AI_DISABLED'};
  if(!publicConfig) return {available:false,reasonCode:leadAISettings({...env,LEADS_AI_ENABLED:'true'},false).reasonCode ?? 'AI_CONFIGURATION_REQUIRED'};
  const status=await store.get<{ready:boolean;configFingerprint:string;checkedAt:number;reasonCode?:string}>('lead_control','provider');
  if(!status || now-status.checkedAt>15*60*1000 || status.configFingerprint!==publicConfig) return {available:false,reasonCode:'AI_UNAVAILABLE'};
  return status.ready?{available:true,reasonCode:null}:{available:false,reasonCode:status.reasonCode ?? 'AI_UNAVAILABLE'};
}
export async function leadAccess(store:Store,userId:string,env:NodeJS.ProcessEnv=process.env,now=Date.now()) {
  const reasonCode=leadsFeatureReason(userId,env);
  if(reasonCode) return {enabled:false,aiAvailable:false,reasonCode};
  const health=await readLeadAIHealth(store,env,now);
  return {enabled:true,aiAvailable:health.available,reasonCode:health.reasonCode};
}
