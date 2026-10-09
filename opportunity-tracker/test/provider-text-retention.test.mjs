import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ScrapeBadgerAdapter,normalizeScrapeBadgerPost,normalizeScrapeBadgerComments} from '../reddit/scrapebadger.mjs';
import {ApifyRedditCommentsAdapter,normalizeApifyRedditComment} from '../reddit/apify-comments.mjs';
import {ApifyInstagramAdapter,normalizeApifyInstagramPost} from '../instagram-apify.mjs';
import {ApifyLinkedInAdapter,normalizeApifyLinkedInPost} from '../linkedin/apify.mjs';
import {LinkedInCollector,normalizeLinkedInSearch} from '../linkedin/collector.mjs';
import {LinkedInBridgeAdapter} from '../linkedin/adapter.mjs';
import {createRedlibBridge} from '../reddit/bridge.mjs';
import {normalizeSocialPost,normalizeSocialComment,parseSocialPage,canonicalSocialSource} from '../social-search.mjs';

const NOW=Date.parse('2026-10-09T12:00:00Z'),AT=new Date(NOW).toISOString(),PUBLISHED=new Date(NOW-10000).toISOString();
const LONG='Available source body '.repeat(3000)+'THE ORIGINAL END';
const CONTEXT='Original parent title '.repeat(200)+'PARENT END';
const redditPost={id:'abc123',fullname:'t3_abc123',title:CONTEXT,selftext:LONG,subreddit:'journaling',author:'Journaler',created_utc:NOW/1000-10,archived:false,locked:false,num_comments:1,permalink:'/r/journaling/comments/abc123/journal/'};
const redditComment={id:'c123',fullname:'t1_c123',subreddit:'journaling',author:'Commenter',created_utc:NOW/1000-10,post_id:'t3_abc123',parent_id:'t3_abc123',body:LONG,permalink:'/r/journaling/comments/abc123/journal/c123/'};
const apifyComment={dataType:'comment',id:'c123',url:'https://www.reddit.com/r/journaling/comments/abc123/journal/c123/',postId:'t3_abc123',subredditName:'journaling',authorName:'Commenter',body:LONG,commentCreatedAt:PUBLISHED,postTitle:CONTEXT,parentId:'t3_abc123'};
const instagram={code:'C8xYzAbCdE1',caption:LONG,createdAt:PUBLISHED,owner:{username:'ig_collector'},commentCount:1};
const linkedin={type:'post',id:'7507254982996332545',linkedinUrl:'https://www.linkedin.com/posts/demo-person_product-activity-7507254982996332545-AbCd',content:LONG,author:{name:'Demo Person',linkedinUrl:'https://www.linkedin.com/in/demo-person'},postedAt:{date:PUBLISHED}};
const mcpData={sections:{search_results:`Feed post\nDemo Person\nFollow\n${LONG}\n6 reactions\nLike\nComment\n`},references:{search_results:[{kind:'feed_post',url:linkedin.linkedinUrl},{kind:'person',url:linkedin.author.linkedinUrl,text:'Demo Person'}]}};
const response=value=>Response.json(value,{headers:{'X-Credits-Used':'2'}});
function apifyClient(Adapter,items){
  const calls=[];
  const adapter=new Adapter({token:'fixture',now:()=>NOW,fetchImpl:async(url,init)=>{calls.push({url,init});return response(url.includes('/items?')?items:{data:{id:'Run123',defaultDatasetId:'Dataset123',status:'SUCCEEDED',usageTotalUsd:0.01}});}});
  return {adapter,calls};
}

test('durable Reddit normalizers preserve full title, body and context while identities and legacy bounds remain stable',()=>{
  const legacy=normalizeScrapeBadgerPost(redditPost,AT),durable=normalizeScrapeBadgerPost(redditPost,AT,{preserveText:true});
  assert.equal(legacy.snippet.length,10000);assert.equal(legacy.title.length,1000);assert.equal(durable.snippet,LONG);assert.equal(durable.title,CONTEXT);assert.equal(durable.sourceId,legacy.sourceId);
  const oldComment=normalizeScrapeBadgerComments([redditComment],durable,AT)[0],newComment=normalizeScrapeBadgerComments([redditComment],durable,AT,100,{preserveText:true})[0];
  assert.equal(oldComment.snippet.length,10000);assert.equal(newComment.snippet,LONG);assert.equal(newComment.url,oldComment.url);assert.equal(newComment.parentId,'t3_abc123');
  assert.equal(normalizeApifyRedditComment(apifyComment,AT),null,'Legacy oversize schema guard stays in place');
  const row=normalizeApifyRedditComment(apifyComment,AT,{preserveText:true});assert.equal(row.snippet,LONG);assert.equal(row.context,CONTEXT);assert.equal(row.sourceId,newComment.sourceId);
  assert.equal(normalizeApifyRedditComment({...apifyComment,postId:'t3_wrong'},AT,{preserveText:true}),null);
});

test('ScrapeBadger search and thread propagate preservation through cached raw responses without another paid call',async()=>{
  const calls=[],adapter=new ScrapeBadgerAdapter({apiKey:'fixture',now:()=>NOW,fetchImpl:async url=>{calls.push(url);return response(url.endsWith('/posts/abc123')?{post:redditPost}:url.includes('/comments?')?{comments:[redditComment]}:{posts:[redditPost],pagination:{after:null}});}});
  const legacy=await adapter.search({query:'journal'});assert.equal(legacy.rows[0].snippet.length,10000);
  const before=calls.length,durable=await adapter.search({query:'journal',preserveText:true});assert.equal(calls.length,before);assert.equal(durable.rows.length,2);assert(durable.rows.every(row=>row.snippet===LONG));assert.equal(durable.coverage.creditsUsed,0);
});

test('social posts and comments retain full own text and separate full parent context',()=>{
  for(const platform of ['tiktok','instagram']){
    const raw=platform==='tiktok'?{id:'1234567890',description:LONG,create_time_at:PUBLISHED,author:{unique_id:'collector'},stats:{comment_count:1}}:{code:instagram.code,caption_text:LONG,taken_at:PUBLISHED,user:{username:'ig_collector'},comment_count:1};
    const old=normalizeSocialPost(platform,raw,AT),post=normalizeSocialPost(platform,raw,AT,{preserveText:true});assert.equal(old.snippet.length,10000);assert.equal(post.snippet,LONG);assert.equal(post.sourceId,old.sourceId);
    const rawComment=platform==='tiktok'?{id:'1234',text:LONG,aweme_id:'1234567890',author:{unique_id:'reader'},create_time_at:PUBLISHED}:{id:'1234',text:LONG,user:{username:'reader'},created_at:PUBLISHED};
    const comment=normalizeSocialComment(platform,rawComment,post,AT,{preserveText:true});assert.equal(comment.snippet,LONG);assert.equal(comment.context,`${post.title}\n${LONG}`);assert.notEqual(canonicalSocialSource(comment).identity,canonicalSocialSource(post).identity);
    const parsed=parseSocialPage({kind:`${platform}_comments`,post},platform==='tiktok'?{comments:[rawComment]}:{items:[rawComment]},AT,{preserveText:true});assert.equal(parsed.rows[0].snippet,LONG);assert.equal(parsed.rows[0].context,comment.context);
  }
  assert.equal(normalizeApifyInstagramPost(instagram,AT),null);assert.equal(normalizeApifyInstagramPost(instagram,AT,{preserveText:true}).snippet,LONG);
  assert.equal(normalizeApifyInstagramPost({...instagram,caption:undefined},AT,{preserveText:true}),null);
});

test('Apify Reddit and Instagram adapter requests retain full returned evidence and existing actor charge caps',async()=>{
  for(const [Adapter,item,charge] of [[ApifyRedditCommentsAdapter,apifyComment,'0.10'],[ApifyInstagramAdapter,instagram,'0.02']]){
    const {adapter,calls}=apifyClient(Adapter,[item]);const result=await adapter.search({query:'journal',preserveText:true});assert.equal(result.rows[0].snippet,LONG);assert.equal(calls.length,2);
    const url=new URL(calls[0].url);assert.equal(url.searchParams.get('maxTotalChargeUsd'),charge);assert.equal(url.searchParams.get('restartOnError'),'false');assert.equal(result.coverage.complete,false);assert.equal(result.coverage.costFinal,false);
  }
});

test('LinkedIn normalizers preserve available body without changing author association or legacy bounds',()=>{
  assert.equal(normalizeApifyLinkedInPost(linkedin,AT),null);
  const full=normalizeApifyLinkedInPost(linkedin,AT,{preserveText:true});assert.equal(full.snippet,LONG);assert.equal(full.author,'Demo Person');
  assert.equal(normalizeApifyLinkedInPost({...linkedin,author:{name:'Other',linkedinUrl:'https://www.linkedin.com/in/other'}},AT,{preserveText:true}),null);
  assert.equal(normalizeLinkedInSearch(mcpData,{collectedAt:AT}).rows.length,0);
  const parsed=normalizeLinkedInSearch(mcpData,{collectedAt:AT,preserveText:true});assert.equal(parsed.rows[0].snippet,LONG);assert.equal(parsed.rows[0].sourceId,full.sourceId);
});

test('LinkedIn Apify full and legacy normalization caches cannot truncate each other',async()=>{
  const content=LONG.slice(0,18000),{adapter,calls}=apifyClient(ApifyLinkedInAdapter,[{...linkedin,content}]);
  const old=await adapter.search({query:'journal'});assert.equal(old.rows[0].snippet.length,8000);
  const full=await adapter.search({query:'journal',preserveText:true});assert.equal(full.rows[0].snippet,content);assert.equal(calls.length,4);
  const cached=await adapter.search({query:'journal',preserveText:true});assert.equal(calls.length,4);assert.equal(cached.rows[0].snippet,content);assert.equal(cached.coverage.cacheHit,true);
  assert.equal((await adapter.search({query:'journal'})).rows[0].snippet.length,8000);
  assert.equal(new URL(calls[0].url).searchParams.get('maxTotalChargeUsd'),'0.10');
});

test('LinkedIn MCP and authenticated bridge carry full-text mode without exposing it in legacy requests',async()=>{
  const fetchImpl=async(_url,init)=>{if(init.method==='DELETE')return new Response(null,{status:204});const req=JSON.parse(init.body);if(!req.id)return new Response(null,{status:202});return response({jsonrpc:'2.0',id:req.id,result:req.method==='initialize'?{protocolVersion:'2025-03-26'}:{structuredContent:mcpData}});};
  const collector=new LinkedInCollector({endpoint:'http://127.0.0.1:8000/mcp',fetchImpl,now:()=>NOW});
  assert.equal((await collector.search({query:'journal',preserveText:true})).rows[0].snippet,LONG);
  assert.equal((await collector.search({query:'journal'})).rows.length,0);
  const sent=[],adapter=new LinkedInBridgeAdapter({baseURL:'https://collector.example',token:'x'.repeat(32),fetchImpl:async(_url,init)=>{sent.push(JSON.parse(init.body));return response({rows:[],coverage:{provider:'linkedin-mcp'}});}});
  await adapter.search({query:'journal',preserveText:true});await adapter.search({query:'journal'});assert.equal(sent[0].preserveText,true);assert.equal(sent[1].preserveText,undefined);
});

test('the authenticated bridge route accepts only boolean full-text mode and forwards it unchanged',async()=>{
  const calls=[],app=createRedlibBridge({token:'x'.repeat(32),adapter:{},linkedinCollector:{search:async value=>{calls.push(value);return {rows:[],coverage:{provider:'linkedin-mcp'}};}}});
  // Exercise the registered route in process; no socket or upstream request.
  const route=app.router.stack.find(layer=>layer.route?.path==='/v1/linkedin/search').route.stack[0].handle;
  const invoke=async body=>{const res=new EventEmitter();res.statusCode=200;res.status=function(code){this.statusCode=code;return this;};res.json=function(value){this.value=value;this.writableEnded=true;return this;};await route({body},res);return res;};
  const good=await invoke({query:'journal',preserveText:true});assert.equal(good.statusCode,200);assert.equal(calls[0].preserveText,true);
  const bad=await invoke({query:'journal',preserveText:'true'});assert.equal(bad.statusCode,400);assert.equal(calls.length,1);
});
