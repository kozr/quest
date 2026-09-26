import {marketingBillingEnabled,marketingSubscription} from './marketing-billing.js';
import {Router} from 'express';
import {z} from 'zod';
import {Timestamp} from 'firebase-admin/firestore';
import {Store,documentKey} from './database.js';
import type {AuthenticatedRequest} from './auth.js';
import {ServiceError} from './firebase.js';
import {matchesRedditKeywords,type RedditPost} from './reddit-apify.js';
import type {LeadProfile} from './leads-types.js';

const community=z.string().trim().transform(v=>v.replace(/^r\//i,'').toLowerCase()).pipe(z.string().regex(/^[a-z0-9_]{2,21}$/));
export const redditSettingsInput=z.object({enabled:z.boolean(),communities:z.array(community).max(10).transform(v=>[...new Set(v)]),
  keywords:z.array(z.string().trim().min(1).max(80)).max(20).transform(v=>[...new Set(v.map(k=>k.toLowerCase()))])}).strict()
  .refine(v=>!v.enabled || v.communities.length>0,{message:'Choose at least one community to enable monitoring.'});
export type RedditSettings=z.infer<typeof redditSettingsInput> & {user_id:string;updatedAt:string};
export interface StoredRedditPost extends RedditPost {expireAt:Timestamp}
export interface RedditState {user_id:string;post_id:string;status:'saved'|'dismissed';updatedAt:string;expireAt:Timestamp}
export interface RedditCollectionStatus {message?:string;lastCompletedAt?:string;nextCheckAt?:number;active?:unknown}
export const emptyRedditSettings={enabled:false,communities:[] as string[],keywords:[] as string[]};
export function redditAccess(env=process.env) {
  const allowed=new Set((env.REDDIT_BETA_USER_IDS ?? '').split(',').map(v=>v.trim()).filter(Boolean));
  const allAccounts=env.REDDIT_PUBLIC_ACCESS==='true';
  return {enabled:env.REDDIT_MONITORING_ENABLED==='true',allowed,allAccounts,allows:(userId:string)=>!!userId&&(allAccounts||allowed.has(userId))};
}
/** The legacy account feed must not bypass paid per-app coverage. */
async function redditScope(store:Store,userId:string) {
  if(!marketingBillingEnabled()) return {settings:await store.get<RedditSettings>('reddit_settings',userId)??emptyRedditSettings,profiles:null};
  const access=await marketingSubscription(store,userId);
  const profiles=(await Promise.all(access.appIDs.map(id=>store.get<LeadProfile>('lead_profiles',documentKey(userId,id)))))
    .filter((profile):profile is LeadProfile=>!!profile?.enabled&&profile.user_id===userId&&access.appIDs.includes(profile.app_id));
  return {settings:{enabled:profiles.length>0,communities:[...new Set(profiles.flatMap(profile=>profile.communities))],
    keywords:[...new Set(profiles.flatMap(profile=>profile.keywords))]},profiles};
}
export function redditRouter(store:Store) {
  const router=Router();
  const uid=(req:unknown)=>(req as AuthenticatedRequest).user.id;
  router.get('/access',(req,res)=>{const access=redditAccess();res.json({enabled:access.enabled && access.allows(uid(req))});});
  router.use(async(req,_res,next)=>{
    if(marketingBillingEnabled()) {
      const subscription=await marketingSubscription(store,uid(req));
      if(!subscription.active||!subscription.appIDs.length) throw new ServiceError(403,'An active Marketing subscription is required.','MARKETING_SUBSCRIPTION_REQUIRED');
    }
    const access=redditAccess();
    if(!access.enabled || !access.allows(uid(req))) throw new ServiceError(403,'Reddit monitoring is not enabled for this account yet.');
    next();
  });
  router.get('/settings',async(req,res)=>{
    const {settings}=await redditScope(store,uid(req));
    const status=await store.get<RedditCollectionStatus>('reddit_control','collector');
    res.json({settings:{enabled:settings.enabled,communities:settings.communities,keywords:settings.keywords},
      status:{message:status?.message ?? 'Waiting for the first scheduled check.',lastCompletedAt:status?.lastCompletedAt ?? null,nextCheckAt:status?.nextCheckAt ?? null}});
  });
  router.put('/settings',async(req,res)=>{
    if(marketingBillingEnabled()) throw new ServiceError(409,'Manage communities and keywords in the profile of a covered app.','MARKETING_APP_PROFILE_REQUIRED');
    const input=redditSettingsInput.parse(req.body);const userId=uid(req);
    await store.atomic(async s=>{await s.assertAccountActive(userId);await s.set('reddit_settings',userId,{...input,user_id:userId,updatedAt:new Date().toISOString()});});
    res.json({settings:input});
  });
  router.get('/posts',async(req,res)=>{
    const {view}=z.object({view:z.enum(['inbox','saved','dismissed']).default('inbox')}).parse(req.query);
    const userId=uid(req);const {settings,profiles}=await redditScope(store,userId);
    if(!settings?.communities.length) {res.json({posts:[],limited:false});return;}
    const now=Date.now();
    // Per-community reads preserve visibility for quieter communities. Composite index is declared.
    const groups=await Promise.all(settings.communities.map(name=>store.query<StoredRedditPost>(store.collection('reddit_posts').where('subreddit','==',name).orderBy('createdAt','desc').limit(100))));
    const posts=groups.flat().filter(post=>post.expireAt.toMillis()>now && (profiles?profiles.some(profile=>profile.communities.includes(post.subreddit)&&matchesRedditKeywords(post,profile.keywords)):matchesRedditKeywords(post,settings.keywords))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    const states=await Promise.all(posts.map(post=>store.get<RedditState>('reddit_post_states',documentKey(userId,post.id))));
    res.json({posts:posts.flatMap((post,i)=>{
      const state=states[i]?.status ?? 'inbox';if(state!==view) return [];
      const {expireAt:_expiry,...fields}=post;return [{...fields,status:state}];
    }).slice(0,100),limited:groups.some(group=>group.length===100) || posts.length>100});
  });
  router.put('/posts/:id',async(req,res)=>{
    const id=z.string().regex(/^[a-z0-9]{1,20}$/).parse(req.params.id);
    const {status}=z.object({status:z.enum(['inbox','saved','dismissed'])}).strict().parse(req.body);const userId=uid(req);
    await store.atomic(async s=>{
      await s.assertAccountActive(userId);
      const [{settings,profiles},post]=await Promise.all([redditScope(s,userId),s.get<StoredRedditPost>('reddit_posts',id)]);
      if(!post || post.expireAt.toMillis()<=Date.now() || !settings.communities.includes(post.subreddit)||profiles&&!profiles.some(profile=>profile.communities.includes(post.subreddit)&&matchesRedditKeywords(post,profile.keywords))) throw new ServiceError(404,'Post not found.');
      const key=documentKey(userId,id);
      if(status==='inbox') await s.delete('reddit_post_states',key);
      else await s.set('reddit_post_states',key,{user_id:userId,post_id:id,status,updatedAt:new Date().toISOString(),expireAt:post.expireAt});
    });
    res.json({ok:true});
  });
  return router;
}
