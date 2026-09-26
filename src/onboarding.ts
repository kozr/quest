import {marketingBillingEnabled,requireMarketingAccess} from './marketing-billing.js';
import {Router} from 'express';
import {z} from 'zod';
import type {Store} from './database.js';
import type {AuthenticatedRequest} from './auth.js';
import {ServiceError} from './firebase.js';
import {leadAccess} from './lead-access.js';

export const QUEST_TRIAL_MS=14*86400000;
export interface QuestOnboarding {
  stage:'app'|'quest'|'first'|'trial'|'notifications'|'complete';
  legacy?:boolean;
  appId?:string;
  freeQuest?:{appId:string;postId:string;assessmentId:string};
  trialStartedAt?:number;
  trialEndsAt?:number;
}
export async function readOnboarding(store:Store,userId:string) {
  return (await store.get<{questOnboarding?:QuestOnboarding}>('users',userId))?.questOnboarding;
}
export function hasQuestAccess(state:QuestOnboarding|undefined,now=Date.now()) {
  // Existing beta accounts retain their access. New onboarding accounts receive one free quest.
  return !state||state.legacy===true||(state.trialEndsAt??0)>now;
}
export function onboardingDTO(state:QuestOnboarding,now=Date.now()) {
  return {...state,trialActive:!marketingBillingEnabled()&&hasQuestAccess(state,now)&&!state.legacy,
    trialAvailable:!marketingBillingEnabled()&&!state.legacy&&!state.trialStartedAt};
}
export async function requireQuestAccess(store:Store,userId:string,appId:string,postId:string) {
  if(marketingBillingEnabled()) {await requireMarketingAccess(store,userId,appId);return;}
  const state=await readOnboarding(store,userId);
  if(!hasQuestAccess(state)&&!(state?.freeQuest?.appId===appId&&state.freeQuest.postId===postId)) {
    throw new ServiceError(403,'Start your trial to unlock this quest. Your first quest stays free.','QUEST_LOCKED');
  }
}
export async function pinFreeQuest(store:Store,userId:string,appId:string,leads:Array<Record<string,unknown>>) {
  return store.atomic(async s=>{
    await s.assertAccountActive(userId);
    const state=await readOnboarding(s,userId);
    if(!state||state.legacy||state.freeQuest||!leads.length) return state;
    const first=leads[0];
    const next={...state,freeQuest:{appId,postId:String(first.postId),assessmentId:String(first.id)}};
    await s.set('users',userId,{questOnboarding:next},true);
    return next;
  });
}
export function onboardingRouter(store:Store) {
  const router=Router();
  const uid=(req:unknown)=>(req as AuthenticatedRequest).user.id;
  router.post('/onboarding/bootstrap',async(req,res)=>{
    const userId=uid(req);
    const state=await store.atomic(async s=>{
      await s.assertAccountActive(userId);
      const existing=await readOnboarding(s,userId);
      if(existing) return existing;
      const apps=await s.apps(userId);
      const value:QuestOnboarding=apps.length?{stage:'complete',legacy:true}:{stage:'app'};
      await s.set('users',userId,{questOnboarding:value},true);
      return value;
    });
    res.json(onboardingDTO(state));
  });
  router.put('/onboarding',async(req,res)=>{
    const input=z.object({stage:z.enum(['app','quest','first','trial','notifications','complete']),appId:z.string().uuid().optional()}).strict().parse(req.body);
    const userId=uid(req);
    const state=await store.atomic(async s=>{
      await s.assertAccountActive(userId);
      const current=await readOnboarding(s,userId);
      if(!current) throw new ServiceError(409,'Start onboarding first.','ONBOARDING_REQUIRED');
      if(input.appId&&!await s.getApp(input.appId,userId)) throw new ServiceError(404,'App not found.','APP_NOT_FOUND');
      const next={...current,...input};
      await s.set('users',userId,{questOnboarding:next},true);
      return next;
    });
    res.json(onboardingDTO(state));
  });
  router.post('/onboarding/trial',async(req,res)=>{
    z.object({}).strict().parse(req.body);
    if(marketingBillingEnabled()) throw new ServiceError(410,'Marketing uses monthly or annual subscriptions without a trial.','TRIAL_UNAVAILABLE');
    const userId=uid(req),access=await leadAccess(store,userId);
    if(!access.enabled||!access.aiAvailable) throw new ServiceError(503,'Discovery is temporarily unavailable. Your trial has not started.','TRIAL_UNAVAILABLE');
    const state=await store.atomic(async s=>{
      await s.assertAccountActive(userId);
      const current=await readOnboarding(s,userId);
      if(!current||current.legacy) throw new ServiceError(409,'This account already has access.','TRIAL_UNAVAILABLE');
      // Retries and concurrent devices cannot restart or extend a trial.
      if(current.trialStartedAt) return current;
      const now=Date.now(),next={...current,stage:current.stage==='complete'?'complete' as const:'notifications' as const,trialStartedAt:now,trialEndsAt:now+QUEST_TRIAL_MS};
      await s.set('users',userId,{questOnboarding:next},true);
      return next;
    });
    res.json(onboardingDTO(state));
  });
  return router;
}
