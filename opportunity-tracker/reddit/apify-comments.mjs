import {CollectionError,readText} from './http.mjs';

const API='https://api.apify.com/v2/';
export const REDDIT_COMMENTS_ACTOR='harshmaur~reddit-scraper-pro';
export const COMMENT_SEARCH_MAX_CHARGE_USD=0.10;
const terminal=new Set(['SUCCEEDED','FAILED','TIMED-OUT','ABORTED']);
const runID=/^[a-zA-Z0-9]{1,64}$/;
const clean=value=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim():'';

// The comment's own author, body and date are evidence. Optional post text is
// context only; neither a URL slug nor the actor's authorId establishes it.
export function normalizeApifyRedditComment(value,collectedAt,{preserveText=false}={}){
  if(!value||value.dataType!=='comment'||typeof value.id!=='string'||! /^[a-z0-9]{1,20}$/.test(value.id))return null;
  let url;try{url=new URL(value.url);}catch{return null;}
  if(url.protocol!=='https:'||!['reddit.com','www.reddit.com'].includes(url.hostname)||url.username||url.password||url.port)return null;
  const match=url.pathname.match(/^\/r\/([a-z0-9_]{2,21})\/comments\/([a-z0-9]{1,20})\/[^/]+\/([a-z0-9]{1,20})\/?$/i);
  if(!match||match[3]!==value.id||value.postId!==`t3_${match[2]}`||value.parsedPostId!=null&&value.parsedPostId!==match[2]||
    typeof value.subredditName!=='string'||value.subredditName.toLowerCase()!==match[1].toLowerCase())return null;
  const author=clean(value.authorName),body=clean(value.body),when=Date.parse(value.commentCreatedAt);
  if(!/^[a-z0-9_-]{3,32}$/i.test(author)||!body||!preserveText&&body.length>50000||['[deleted]','[removed]'].includes(body)||
    !Number.isFinite(when)||when<=0||when>Date.parse(collectedAt)+300000)return null;
  const parent=value.parentId??null;
  if(parent!==null&&(!/^t[13]_[a-z0-9]{1,20}$/.test(parent)||parent===`t1_${value.id}`||parent.startsWith('t3_')&&parent!==value.postId))return null;
  const name=match[1].toLowerCase(),context=clean(value.postTitle);
  return {source:'Reddit comment',provider:'reddit-apify',sourceId:`t1_${value.id}`,postId:value.postId,parentId:parent,type:'comment',
    url:`https://www.reddit.com/r/${name}/comments/${match[2]}/_/${value.id}/`,subreddit:name,
    title:body.slice(0,180),snippet:preserveText?body:body.slice(0,10000),author,publishedAt:new Date(when).toISOString(),collectedAt,
    ...(context?{context:preserveText?context:context.slice(0,1500)}:{}),...(Number.isSafeInteger(value.score)?{score:value.score}:{})};
}

export function redditCommentQueries(product){
  if(product.listeningVersion!=='v2'&&!product.communities?.length)return [];
  return [...new Set([...(product.keywords||[]),...(product.aliases||[])].filter(q=>typeof q==='string'&&q.trim()).map(q=>q.trim()))].slice(0,6).map(query=>({query}));
}

export class ApifyRedditCommentsAdapter{
  id='reddit-apify';
  constructor({token,fetchImpl=fetch,now=Date.now}={}){
    if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token))throw Error('Configure the server-only APIFY_TOKEN.');
    this.token=token;this.fetchImpl=fetchImpl;this.now=now;
  }
  async json(path,{method='GET',body,signal,timeout=15000}={}){
    const response=await this.fetchImpl(new URL(path,API).href,{method,redirect:'error',
      signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeout)]),
      headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok){await response.body?.cancel();throw new CollectionError([401,403].includes(response.status)?'reddit_comments_credentials_required':`upstream_http_${response.status}`);}
    try{return JSON.parse(await readText(response,2_097_152));}catch{throw new CollectionError('reddit_comments_schema_changed');}
  }
  run(value,expected){
    const run=value?.data;
    if(!run||typeof run.id!=='string'||!runID.test(run.id)||expected&&run.id!==expected||!['READY','RUNNING','SUCCEEDED','FAILED','TIMING-OUT','TIMED-OUT','ABORTING','ABORTED'].includes(run.status)||
      run.defaultDatasetId!=null&&(typeof run.defaultDatasetId!=='string'||!runID.test(run.defaultDatasetId)))throw new CollectionError('reddit_comments_schema_changed');
    return run;
  }
  async search({query,subreddit,cutoff,until,limit=30,signal,preserveText=false}={}){
    if(typeof query!=='string'||!query.trim()||query.length>500||!Number.isInteger(limit)||limit<1||limit>30||
      subreddit!=null&&!/^[a-z0-9_]{2,21}$/i.test(subreddit)||cutoff!=null&&!Number.isFinite(cutoff)||until!=null&&!Number.isFinite(until))throw new CollectionError('invalid_comment_search',400);
    const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(75000)]);let run;
    try{
      // A lost start response may still have started a paid run. Never retry it.
      run=this.run(await this.json(`actors/${REDDIT_COMMENTS_ACTOR}/runs?timeout=60&memory=512&maxTotalChargeUsd=${COMMENT_SEARCH_MAX_CHARGE_USD.toFixed(2)}&restartOnError=false`,{
        method:'POST',signal:deadline,timeout:8000,body:{searchTerms:[query.trim()],searchComments:true,searchPosts:false,searchCommunities:false,
          searchSort:'new',searchTime:'all',...(cutoff!=null?{commentedAfter:new Date(cutoff).toISOString()}:{}),...(until!=null?{commentedBefore:new Date(until).toISOString()}:{}),...(subreddit?{withinCommunity:subreddit.toLowerCase()}:{}),maxCommentsCount:limit,maxPostsCount:0,
          maxCommentsPerPost:0,maxCommunitiesCount:0,crawlCommentsPerPost:false,aiAnalysis:false,startUrls:[],subredditUrls:[]}}));
      for(let poll=0;!terminal.has(run.status)&&poll<8;poll++)run=this.run(await this.json(`actor-runs/${run.id}?waitForFinish=10`,{signal:deadline}),run.id);
      if(!terminal.has(run.status))throw new CollectionError('reddit_comments_timeout');
      const failure=run.status==='SUCCEEDED'?null:run.status==='TIMED-OUT'?'reddit_comments_timeout':'reddit_comments_provider_failed';
      if(!run.defaultDatasetId)throw new CollectionError(failure||'reddit_comments_schema_changed');
      const items=await this.json(`datasets/${run.defaultDatasetId}/items?format=json&clean=true&limit=${limit+1}`,{signal:deadline});
      if(!Array.isArray(items)||items.length>limit)throw new CollectionError('reddit_comments_schema_changed');
      const collectedAt=new Date(this.now()).toISOString(),unique=new Map(),stamps=[];let invalid=0,older=0;
      for(const item of items){const row=normalizeApifyRedditComment(item,collectedAt,{preserveText});if(!row){invalid++;continue;}stamps.push(Date.parse(row.publishedAt));if(cutoff!=null&&Date.parse(row.publishedAt)<cutoff||until!=null&&Date.parse(row.publishedAt)>until){older++;continue;}unique.set(row.sourceId,row);}
      if(items.length&&invalid===items.length)throw new CollectionError('reddit_comments_schema_changed');
      if(failure&&!unique.size)throw new CollectionError(failure);
      return {rows:[...unique.values()],coverage:{provider:this.id,actor:REDDIT_COMMENTS_ACTOR.replace('~','/'),runId:run.id,runStatus:run.status,
        complete:false,partial:true,oldest:stamps.length?Math.min(...stamps):null,comments:'keyword_search',maxComments:limit,observedComments:items.length,skippedComments:invalid,olderComments:older,
        maxChargeUsd:COMMENT_SEARCH_MAX_CHARGE_USD,reportedCostUsd:Number.isFinite(run.usageTotalUsd)?run.usageTotalUsd:null,costFinal:false,
        errors:[...(failure?[failure]:[]),...(invalid?['invalid_comment_records']:[])]}};
    }catch(error){
      if(run&&!terminal.has(run.status))try{await this.json(`actor-runs/${run.id}/abort`,{method:'POST',timeout:2000});}catch{}
      const safe=deadline.aborted||['AbortError','TimeoutError'].includes(error?.name)?new CollectionError('reddit_comments_timeout'):error instanceof CollectionError?error:new CollectionError('reddit_comments_provider_failed');
      safe.runId=run?.id;throw safe;
    }
  }
}
