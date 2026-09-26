/** Bounded Reddit collection and source normalization for Market intelligence. */
import {createHash} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import type {MarketSource,MarketSourceKind} from './market-types.js';
import type {ApifyRun} from './reddit-apify.js';

const APIFY_BASE='https://api.apify.com/v2';
export const MARKET_SOURCE_RETENTION_DAYS=30;
export const MARKET_APIFY_MAX_CALL_USD=0.5;
export const MARKET_MAX_SEARCH_COMMUNITIES=10;
export const MARKET_MAX_SEARCH_POSTS=100;
export const MARKET_MAX_COMMENT_THREADS=20;
export const MARKET_MAX_COMMENTS_PER_THREAD=25;
export const MARKET_MAX_COMMENT_ROWS=MARKET_MAX_COMMENT_THREADS*MARKET_MAX_COMMENTS_PER_THREAD;
export const MARKET_MAX_DATASET_ROWS=1500;

export interface MarketRedditSearchInput {
  communities:string[];
  /** Profile keywords are applied locally to normalized post text. */
  keywords:string[];
  after:string;
  before:string;
  maxPosts?:number;
}
export interface MarketCommentRunOptions {maxCommentsPerThread:number}
export interface MarketThreadSelectionOptions {
  keywords:string[];
  maxThreads:number;
  maxCommentsPerThread:number;
  fetchedAt?:string;
}
export interface MarketSourceInvalidation {
  sourceId:string;
  kind:MarketSourceKind;
  threadId:string;
  reason:'removed'|'deleted';
}
export type MarketSourceRowResult=
  |{type:'source';source:MarketSource}
  |{type:'invalidate';invalidation:MarketSourceInvalidation};
export interface MarketNormalizedRows {sources:MarketSource[];invalidations:MarketSourceInvalidation[]}

const redditId=/^[a-z0-9]{1,20}$/i;
const subreddit=/^[a-z0-9_]{2,21}$/i;
const username=/^[a-z0-9_-]{1,32}$/i;
const fullname=/^t2_([a-z0-9]{1,20})$/i;
const timestampLimit=MARKET_SOURCE_RETENTION_DAYS*24*60*60*1000;

function asObject(value:unknown):Record<string,unknown>|null {
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
function idPart(value:unknown,prefix?:'t1_'|'t3_'):string|null {
  if(typeof value!=='string') return null;
  const raw=value.trim();
  const id=prefix&&raw.toLowerCase().startsWith(prefix)?raw.slice(prefix.length):raw;
  return redditId.test(id)?id.toLowerCase():null;
}
function communityName(value:unknown):string|null {
  if(typeof value!=='string') return null;
  const raw=value.replace(/^r\//i,'').toLowerCase();
  return subreddit.test(raw)?raw:null;
}
function rowCommunity(row:Record<string,unknown>):string|null {
  const values=[row.subredditName,row.communityName,row.subreddit].filter(value=>value!==undefined&&value!==null);
  const normalized=values.map(communityName);
  if(!normalized.length||normalized.some(value=>value===null)||new Set(normalized).size!==1) return null;
  return normalized[0]??null;
}
function normalizedKind(row:Record<string,unknown>):MarketSourceKind|null {
  return row.dataType==='post'?'post':row.dataType==='comment'?'comment':null;
}
function nativeIdentity(row:Record<string,unknown>,kind:MarketSourceKind) {
  // In this scraper's comment output parsedId is often null; id is the comment ID.
  const prefix=kind==='post'?'t3_':'t1_';
  const rawId=typeof row.id==='string'&&row.id.length?row.id:row.parsedId;
  const ownId=idPart(rawId,prefix),parsedId=idPart(row.parsedId,prefix);
  if(row.parsedId!==undefined&&row.parsedId!==null&&!parsedId) return null;
  if(parsedId&&ownId&&parsedId!==ownId) return null;
  const parsedThread=idPart(row.parsedPostId,'t3_'),fullThread=idPart(row.postId,'t3_');
  if(row.parsedPostId!==undefined&&row.parsedPostId!==null&&!parsedThread) return null;
  if(row.postId!==undefined&&row.postId!==null&&!fullThread) return null;
  if(parsedThread&&fullThread&&parsedThread!==fullThread) return null;
  const postId=kind==='post'?ownId:(parsedThread??fullThread);
  return ownId&&postId?{ownId,threadId:postId}:null;
}
function isDeletedName(value:unknown):boolean {
  return typeof value!=='string'||!value.trim()||/^\[?(?:deleted|removed)\]?$/i.test(value.trim());
}
function rowText(row:Record<string,unknown>,kind:MarketSourceKind):string|null {
  const body=typeof row.body==='string'?row.body:typeof row.text==='string'?row.text:null;
  if(body===null||body.length>100_000) return null;
  if(kind==='comment'&&!body.length) return null;
  return body;
}
function parsedInstant(value:unknown):number|null {
  if(typeof value!=='string'&&typeof value!=='number') return null;
  const n=typeof value==='number'?value:Date.parse(value);
  return Number.isFinite(n)&&n>0?n:null;
}
function matchingRedditPermalink(value:unknown,community:string,threadId:string,commentId?:string):boolean {
  if(typeof value!=='string'||value.length>2048) return false;
  try {
    const url=new URL(value);
    if(!['reddit.com','www.reddit.com'].includes(url.hostname.toLowerCase())||url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash) return false;
    const parts=url.pathname.split('/').filter(Boolean);
    if(parts.length<4||parts[0].toLowerCase()!=='r'||parts[1].toLowerCase()!==community||parts[2].toLowerCase()!=='comments'||parts[3].toLowerCase()!==threadId) return false;
    if(!commentId) return parts.length<=5;
    return parts.length===6&&parts[5]?.toLowerCase()===commentId;
  } catch {return false;}
}
function canonicalUrl(kind:MarketSourceKind,community:string,threadId:string,id:string) {
  return kind==='post'
    ?`https://www.reddit.com/r/${community}/comments/${threadId}/`
    :`https://www.reddit.com/r/${community}/comments/${threadId}/_/${id}/`;
}
function parseAuthor(row:Record<string,unknown>,kind:MarketSourceKind):{key:string|null;display:string|null} {
  const displayCandidate=row.authorName??row.author;
  if(typeof displayCandidate==='string'&&isDeletedName(displayCandidate)) return {key:null,display:null};
  const display=typeof displayCandidate==='string'&&displayCandidate.length<=100&&!isDeletedName(displayCandidate)?displayCandidate:null;
  // `authorId` is a legacy comment ID in the actor's comment rows. Only the
  // documented authorFullname is trusted for comment identity.
  const fullnameValue=kind==='post'?(row.authorFullname??row.authorId):row.authorFullname;
  if(typeof fullnameValue==='string') {
    const match=fullname.exec(fullnameValue);
    if(match) return {key:`reddit:${fullnameValue.toLowerCase()}`,display};
  }
  if(display&&username.test(display)) return {key:`reddit:name:${display.toLowerCase()}`,display};
  return {key:null,display};
}
function sourceExpiry(createdAt:string) {
  const expireMs=Date.parse(createdAt)+timestampLimit;
  return {expiresAt:new Date(expireMs).toISOString(),expireAt:Timestamp.fromMillis(expireMs)};
}
function sourceId(kind:MarketSourceKind,id:string) {return `reddit:${kind}:${id}`;}
export function marketSourceContentHash(source:Pick<MarketSource,'id'|'provider'|'kind'|'threadId'|'parentId'|'authorKey'|'authorDisplayName'|'title'|'text'|'community'|'url'|'createdAt'>):string {
  // Snapshot identity also depends on authorship, thread grouping, attribution,
  // and source time. Exclude fetchedAt so an ordinary refresh does not rewrite
  // otherwise-identical source evidence.
  const identity={id:source.id,provider:source.provider,kind:source.kind,threadId:source.threadId,parentId:source.parentId,
    authorKey:source.authorKey,authorDisplayName:source.authorDisplayName,title:source.title,text:source.text,community:source.community,url:source.url,createdAt:source.createdAt};
  return createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
}

/** Normalize one untrusted Apify row. Unsafe links and malformed identities are rejected. */
export function normalizeMarketRedditRow(value:unknown,fetchedAt=new Date().toISOString()):MarketSourceRowResult|null {
  const row=asObject(value);if(!row) return null;
  const kind=normalizedKind(row);if(!kind) return null;
  const identity=nativeIdentity(row,kind);if(!identity) return null;
  const community=rowCommunity(row);
  if(!community) return null;
  const title=kind==='post'?row.title:null;
  if(kind==='post'&&(typeof title!=='string'||title.length>1000)) return null;
  const text=rowText(row,kind);
  const removedFlag=Boolean(row.removedByCategory)||row.isRemoved===true||row.removed===true;
  if(text===null&&!removedFlag) return null;
  const createdValue=kind==='comment'?(row.commentCreatedAt??row.createdAt):row.createdAt;
  const createdMs=parsedInstant(createdValue),fetchedMs=Date.parse(fetchedAt);
  if(createdMs===null||!Number.isFinite(fetchedMs)||fetchedMs<=0||createdMs>fetchedMs+5*60_000||fetchedMs-createdMs>timestampLimit) return null;
  const ownId=identity.ownId,threadId=identity.threadId;
  const parentId=kind==='comment'&&typeof row.parentId==='string'&&/^t[13]_[a-z0-9]{1,20}$/i.test(row.parentId)?row.parentId.toLowerCase():null;
  if(kind==='comment'&&!parentId) return null;
  if(kind==='comment'&&parentId?.startsWith('t3_')&&idPart(parentId,'t3_')!==threadId) return null;
  // The provider permalink fields are untrusted. Validate them when supplied;
  // if omitted, the canonical link below is derived from checked Reddit IDs.
  const permalinkAliases=kind==='comment'?[row.url,row.commentUrl,row.permalink]:[row.postUrl,row.permalink];
  for(const permalink of permalinkAliases) {
    if(permalink!==undefined&&permalink!==null&&!matchingRedditPermalink(permalink,community,threadId,kind==='comment'?ownId:undefined)) return null;
  }
  if(kind==='comment'&&row.postUrl!==undefined&&row.postUrl!==null&&!matchingRedditPermalink(row.postUrl,community,threadId)) return null;
  if(kind==='post'&&typeof row.url==='string') {
    // `url` can be the post's outbound link; only enforce identity for Reddit permalinks.
    try {if(['reddit.com','www.reddit.com'].includes(new URL(row.url).hostname.toLowerCase())&&
      !matchingRedditPermalink(row.url,community,threadId)) return null;} catch {/* outbound URL is not used or persisted */}
  }

  const removed=removedFlag||text==='[removed]';
  const deleted=text==='[deleted]';
  if(removed||deleted) return {type:'invalidate',invalidation:{sourceId:sourceId(kind,ownId),kind,threadId,reason:removed?'removed':'deleted'}};
  if(text===null) return null;

  const author=parseAuthor(row,kind),sourceTitle=typeof title==='string'?title:null;
  const url=canonicalUrl(kind,community,threadId,ownId);
  const core= {
    id:sourceId(kind,ownId),provider:'reddit',kind,threadId,parentId:kind==='post'?null:parentId,
    authorKey:author.key,authorDisplayName:author.display,title:sourceTitle,text,community,url,
    createdAt:new Date(createdMs).toISOString(),
  } as const;
  const source:MarketSource={
    ...core,fetchedAt:new Date(fetchedMs).toISOString(),contentHash:marketSourceContentHash(core),...sourceExpiry(new Date(createdMs).toISOString()),
  };
  return {type:'source',source};
}

/** Bounded row normalization; removed/deleted sources are returned for snapshot invalidation. */
export function normalizeMarketRedditRows(rows:unknown,fetchedAt=new Date().toISOString(),maxRows=MARKET_MAX_DATASET_ROWS):MarketNormalizedRows {
  if(!Array.isArray(rows)||!Number.isInteger(maxRows)||maxRows<1||maxRows>MARKET_MAX_DATASET_ROWS||rows.length>maxRows)
    throw new Error('Market Reddit collection exceeded its result limit.');
  const sources=new Map<string,MarketSource>(),invalidations=new Map<string,MarketSourceInvalidation>();
  for(const row of rows) {
    const result=normalizeMarketRedditRow(row,fetchedAt);if(!result) continue;
    if(result.type==='invalidate') {invalidations.set(result.invalidation.sourceId,result.invalidation);sources.delete(result.invalidation.sourceId);}
    else if(!invalidations.has(result.source.id)) sources.set(result.source.id,result.source);
  }
  return {sources:[...sources.values()],invalidations:[...invalidations.values()]};
}

export function normalizeMarketRedditSource(value:unknown,fetchedAt=new Date().toISOString()):MarketSource|null {
  const result=normalizeMarketRedditRow(value,fetchedAt);return result?.type==='source'?result.source:null;
}

function keywordMatch(source:MarketSource,keywords:string[]):boolean {
  if(!keywords.length) return true;
  const searchable=`${source.title??''}\n${source.text}`.toLowerCase();
  return keywords.some(keyword=>searchable.includes(keyword.toLowerCase()));
}
function validateKeywords(keywords:string[]):boolean {
  return Array.isArray(keywords)&&keywords.length<=20&&keywords.every(k=>typeof k==='string'&&k.trim().length>0&&k.length<=80);
}
/** Select newest unique matching thread posts with a hard cap. */
export function selectRelevantMarketThreads(posts:MarketSource[],keywords:string[],maxThreads:number):MarketSource[] {
  if(!Array.isArray(posts)||!validateKeywords(keywords)||!Number.isInteger(maxThreads)||maxThreads<1||maxThreads>MARKET_MAX_COMMENT_THREADS)
    throw new Error('Invalid Market thread selection bounds.');
  const unique=new Map<string,MarketSource>();
  for(const post of posts) {
    if(post.provider!=='reddit'||post.kind!=='post'||!post.threadId||post.id!==sourceId('post',post.threadId)||
      !matchingRedditPermalink(post.url,post.community,post.threadId)||!keywordMatch(post,keywords)) continue;
    if(!unique.has(post.threadId)) unique.set(post.threadId,post);
  }
  return [...unique.values()].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||a.threadId.localeCompare(b.threadId)).slice(0,maxThreads);
}

/**
 * Normalize the already-bounded results of a selected-thread comment run.
 * Candidate posts are included once so analysis receives complete conversation context.
 */
export function collectRelevantMarketSources(rows:unknown,posts:MarketSource[],options:MarketThreadSelectionOptions):MarketNormalizedRows {
  const {keywords,maxThreads,maxCommentsPerThread}=options;
  if(!Number.isInteger(maxCommentsPerThread)||maxCommentsPerThread<1||maxCommentsPerThread>MARKET_MAX_COMMENTS_PER_THREAD)
    throw new Error('Invalid Market comment collection bounds.');
  const selected=selectRelevantMarketThreads(posts,keywords,maxThreads);
  if(!selected.length) {
    if(!Array.isArray(rows)||rows.length) throw new Error('Market Reddit comment rows have no selected thread context.');
    return {sources:[],invalidations:[]};
  }
  const byThread=new Map(selected.map(post=>[post.threadId,post]));
  const fetchedAt=options.fetchedAt??new Date().toISOString();
  const normalized=normalizeMarketRedditRows(rows,fetchedAt,Math.min(MARKET_MAX_DATASET_ROWS,selected.length*(maxCommentsPerThread+1)));
  const invalidated=new Set(normalized.invalidations.map(item=>item.sourceId));
  const commentsByThread=new Map<string,MarketSource[]>();
  const collectedPosts=new Map<string,MarketSource>();
  for(const source of normalized.sources) {
    if(source.kind==='post'&&byThread.has(source.threadId)) collectedPosts.set(source.threadId,source);
    if(source.kind!=='comment'||!byThread.has(source.threadId)) continue;
    const group=commentsByThread.get(source.threadId)??[];group.push(source);commentsByThread.set(source.threadId,group);
  }
  const result:MarketSource[]=[];
  for(const post of selected) {
    const freshPost=collectedPosts.get(post.threadId);
    if(freshPost&&!invalidated.has(freshPost.id)) result.push(freshPost);
    else if(!invalidated.has(post.id)) result.push(post);
    const comments=(commentsByThread.get(post.threadId)??[])
      .sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id))
      .slice(0,maxCommentsPerThread).filter(source=>!invalidated.has(source.id));
    result.push(...comments);
  }
  return {sources:result,invalidations:normalized.invalidations};
}

/** Convenience view for analysis callers that do not own source invalidation. */
export function collectRelevantComments(rows:unknown,posts:MarketSource[],options:MarketThreadSelectionOptions):MarketSource[] {
  return collectRelevantMarketSources(rows,posts,options).sources;
}

/** Server-side Apify adapter. It returns run IDs so durable jobs can checkpoint before polling. */
export class MarketRedditSource {
  constructor(private token:string,private request:typeof fetch=fetch) {
    if(typeof token!=='string'||!token.length) throw new Error('Market Reddit collection is not configured.');
  }
  private async json(path:string,init:RequestInit={}):Promise<unknown> {
    const response=await this.request(`${APIFY_BASE}/${path}`,{...init,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20_000)});
    if(!response.ok) throw new Error(`Market Reddit provider returned HTTP ${response.status}.`);
    return response.json();
  }
  private maxCharge(value:number):string {
    if(!Number.isFinite(value)||value<=0||value>MARKET_APIFY_MAX_CALL_USD) throw new Error('Market Reddit call exceeds its configured charge ceiling.');
    return String(value);
  }
  private actorPath(maxChargeUsd:number) {
    return `acts/harshmaur~reddit-scraper/runs?${new URLSearchParams({memory:'1024',timeout:'600',maxTotalChargeUsd:this.maxCharge(maxChargeUsd)})}`;
  }
  private runShape(result:unknown):ApifyRun {
    const run=asObject(asObject(result)?.data);
    if(!run||typeof run.id!=='string'||typeof run.status!=='string'||typeof run.defaultDatasetId!=='string') throw new Error('Invalid Market Reddit collection response.');
    return run as unknown as ApifyRun;
  }
  async startSearch(input:MarketRedditSearchInput,maxChargeUsd:number):Promise<ApifyRun> {
    const maxPosts=input.maxPosts??MARKET_MAX_SEARCH_POSTS;
    const after=Date.parse(input.after),before=Date.parse(input.before);
    if(!Array.isArray(input.communities)||input.communities.length<1||input.communities.length>MARKET_MAX_SEARCH_COMMUNITIES||
      input.communities.some(c=>typeof c!=='string'||!subreddit.test(c.replace(/^r\//i,'')))||!validateKeywords(input.keywords)||
      !Number.isInteger(maxPosts)||maxPosts<1||maxPosts>MARKET_MAX_SEARCH_POSTS||!Number.isFinite(after)||!Number.isFinite(before)||
      before<=after||before-after>timestampLimit||before>Date.now()+5*60_000)
      throw new Error('Invalid bounded Market Reddit search input.');
    const communities=[...new Set(input.communities.map(c=>c.replace(/^r\//i,'').toLowerCase()))];
    if(communities.length!==input.communities.length) throw new Error('Market Reddit communities must be unique.');
    // The actor schema accepts calendar dates, not timestamps. Jobs apply exact timestamp filters after retrieval.
    const body={startUrls:communities.map(name=>({url:`https://www.reddit.com/r/${name}/new/`})),postedAfter:new Date(after).toISOString().slice(0,10),postedBefore:new Date(before).toISOString().slice(0,10),
      searchSort:'new',maxPostsCount:maxPosts,maxCommentsCount:0,maxCommentsPerPost:0,maxCommunitiesCount:0,
      crawlCommentsPerPost:false,searchComments:false,searchCommunities:false,searchUsers:false,aiAnalysis:false};
    return this.runShape(await this.json(this.actorPath(maxChargeUsd),{method:'POST',body:JSON.stringify(body)}));
  }
  async startThreadComments(posts:MarketSource[],options:MarketCommentRunOptions,maxChargeUsd:number):Promise<ApifyRun> {
    if(!Array.isArray(posts)||posts.length<1||posts.length>MARKET_MAX_COMMENT_THREADS||!Number.isInteger(options.maxCommentsPerThread)||
      options.maxCommentsPerThread<1||options.maxCommentsPerThread>MARKET_MAX_COMMENTS_PER_THREAD||
      posts.length*options.maxCommentsPerThread>MARKET_MAX_COMMENT_ROWS||
      posts.some(p=>p.provider!=='reddit'||p.kind!=='post'||p.id!==sourceId('post',p.threadId)||!matchingRedditPermalink(p.url,p.community,p.threadId))||
      new Set(posts.map(p=>p.threadId)).size!==posts.length) throw new Error('Invalid bounded Market Reddit comment threads.');
    const body={startUrls:posts.map(post=>({url:post.url})),maxPostsCount:posts.length,maxCommentsCount:0,
      maxCommentsPerPost:options.maxCommentsPerThread,maxCommunitiesCount:0,crawlCommentsPerPost:true,
      searchComments:false,searchCommunities:false,searchUsers:false,aiAnalysis:false};
    return this.runShape(await this.json(this.actorPath(maxChargeUsd),{method:'POST',body:JSON.stringify(body)}));
  }
  async status(runId:string):Promise<ApifyRun> {
    if(typeof runId!=='string'||!/^[-_a-zA-Z0-9]{1,80}$/.test(runId)) throw new Error('Invalid Market Reddit run ID.');
    return this.runShape(await this.json(`actor-runs/${encodeURIComponent(runId)}`));
  }
  async datasetRows(datasetId:string,maxRows=MARKET_MAX_DATASET_ROWS):Promise<unknown[]> {
    if(typeof datasetId!=='string'||!/^[-_a-zA-Z0-9]{1,80}$/.test(datasetId)||!Number.isInteger(maxRows)||maxRows<1||maxRows>MARKET_MAX_DATASET_ROWS)
      throw new Error('Invalid Market Reddit dataset request.');
    const query=new URLSearchParams({clean:'true',format:'json',limit:String(maxRows+1)});
    const rows=await this.json(`datasets/${encodeURIComponent(datasetId)}/items?${query}`);
    if(!Array.isArray(rows)||rows.length>maxRows) throw new Error('Market Reddit collection exceeded its result limit.');
    return rows;
  }
}
