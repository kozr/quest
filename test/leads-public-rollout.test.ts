import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import {testStore} from './firebase-fixture.js';
import {documentKey,type AppRow} from '../src/database.js';
import {leadAccess,leadsEnabledFor} from '../src/lead-access.js';
import {collectReddit} from '../src/reddit-collector.js';
import {reconcileLeadCandidates} from '../src/leads-candidates.js';
import type {RedditApify} from '../src/reddit-apify.js';
import type {LeadProfile} from '../src/leads-types.js';
const env={LEADS_ENABLED:'true',REDDIT_MONITORING_ENABLED:'true',REDDIT_PUBLIC_ACCESS:'true',REDDIT_MONTHLY_BUDGET_USD:'15'};

test('public access admits non-invited accounts but still respects feature gates',async()=>{
 const store=testStore();assert.equal(leadsEnabledFor('unlisted',env),true);
 assert.deepEqual(await leadAccess(store,'unlisted',env),{enabled:true,aiAvailable:false,reasonCode:'AI_DISABLED'});
 assert.equal(leadsEnabledFor('unlisted',{...env,REDDIT_PUBLIC_ACCESS:'false'}),false);
 assert.equal(leadsEnabledFor('unlisted',{...env,LEADS_ENABLED:'false'}),false);
 assert.equal(leadsEnabledFor('unlisted',{...env,REDDIT_MONITORING_ENABLED:'false'}),false);
 assert.equal(leadsEnabledFor('',env),false);
});

test('public collector pages through opted-in accounts and still enforces its shared budget',async()=>{
 const store=testStore(),now=Date.now();
 for(let offset=0;offset<252;offset+=100){const b=store.db.batch();for(let i=offset;i<Math.min(offset+100,252);i++)b.set(store.collection('reddit_settings').doc(`user-${String(i).padStart(3,'0')}`),{user_id:`user-${i}`,enabled:true,communities:[i===251?'journaling':'swift'],keywords:[]});await b.commit();}
 await store.set('reddit_settings','disabled',{user_id:'disabled',enabled:false,communities:['excluded']});
 let calls=0;const provider={start:async(communities:string[])=>{calls++;assert.deepEqual(communities,['journaling','swift']);return {id:'fixture-run',status:'RUNNING',defaultDatasetId:'fixture-data'};}} as unknown as RedditApify;
 await collectReddit(store,provider,env,now);assert.equal(calls,1);
 const limited=testStore();await limited.set('reddit_settings','user',{user_id:'user',enabled:true,communities:['swift'],keywords:[]});
 await limited.set('reddit_budgets',new Date(now).toISOString().slice(0,7),{spent:15,reserved:0});
 await collectReddit(limited,provider,env,now);assert.equal(calls,1);
});

test('public candidate reconciliation includes non-invited owners and ignores removed apps',async()=>{
 const store=testStore(),now=Date.now(),userId='public-owner',appId=randomUUID();
 const app:AppRow={id:appId,user_id:userId,name:'Fixture',bundle_id:'test.public.fixture',apple_id:'123456789',source:'apple',icon_url:null,webhook_secret:randomUUID(),created_at:new Date(now).toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
 await store.set('apps',appId,app);
 const profile:LeadProfile={user_id:userId,app_id:appId,schemaVersion:1,revision:1,enabled:true,problems:[{id:randomUUID(),text:'Track owned figures and duplicates'}],capabilities:[{id:randomUUID(),text:'Track owned figures and duplicates',source:'user_confirmed'}],communities:['actionfigures'],keywords:['figures'],descriptionSource:null,confirmedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
 await store.set('lead_profiles',documentKey(userId,appId),profile);
 await store.set('reddit_posts','abc123',{id:'abc123',subreddit:'actionfigures',title:'Is there an app to track figures I already own and duplicates?',body:'I need an inventory for my figures.',url:'https://www.reddit.com/r/actionfigures/comments/abc123/',createdAt:new Date(now-60000).toISOString(),score:1,comments:0,expireAt:Timestamp.fromMillis(now+86400000)});
 const result=await reconcileLeadCandidates(store,null,now);assert.equal(result.queued,1);
 const jobs=await store.list<any>('lead_jobs');assert.equal(jobs[0].user_id,userId);assert.equal(jobs[0].app_id,appId);
 await store.set('apps',appId,{active:false},true);
 const repeated=await reconcileLeadCandidates(store,null,now+1000);assert.equal(repeated.queued,0);
});
