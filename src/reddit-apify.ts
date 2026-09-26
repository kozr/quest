/** Read-only Reddit collection. Tokens never leave this server-side client. */
import {extractPostImages} from './reddit-images.js';
export interface RedditPost {
  id:string; subreddit:string; title:string; body:string; url:string;
  createdAt:string; score:number; comments:number;
  images?:string[];
}
export function normalizeRedditPost(value:unknown):RedditPost|null {
  if(!value || typeof value!=='object') return null;
  const row=value as Record<string,unknown>;
  if(row.dataType!=='post') return null;
  const id=String(row.parsedId ?? row.id ?? '').replace(/^t3_/, '');
  const subreddit=String(row.subredditName ?? row.communityName ?? '').replace(/^r\//,'').toLowerCase();
  if(!/^[a-z0-9]{1,20}$/.test(id) || !/^[a-z0-9_]{2,21}$/.test(subreddit) || typeof row.title!=='string' || typeof row.createdAt!=='string') return null;
  const created=Date.parse(row.createdAt);
  if(!Number.isFinite(created)) return null;
  if(row.removedByCategory || row.body==='[removed]' || row.body==='[deleted]') return null;
  const images=extractPostImages(row);
  return {id,subreddit,title:row.title.slice(0,1000),body:typeof row.body==='string' ? row.body.slice(0,10000) : '',
    url:`https://www.reddit.com/r/${subreddit}/comments/${id}/`,createdAt:new Date(created).toISOString(),
    score:typeof row.score==='number' && Number.isFinite(row.score) ? row.score : 0,
    comments:typeof row.commentsCount==='number' && Number.isFinite(row.commentsCount) ? row.commentsCount : 0,
    ...(images.length?{images}:{})};
}
export function matchesRedditKeywords(post:RedditPost,keywords:string[]) {
  const text=`${post.title}\n${post.body}`.toLowerCase();
  return keywords.length===0 || keywords.some(keyword=>text.includes(keyword.toLowerCase()));
}
export interface ApifyRun {id:string;status:string;defaultDatasetId:string;finishedAt?:string|null;usageTotalUsd?:number|null}
export class RedditApify {
  constructor(private token:string,private request:typeof fetch=fetch) {}
  private async json(path:string,init:RequestInit={}) {
    const response=await this.request(`https://api.apify.com/v2/${path}`,{...init,
      headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000)});
    // Provider bodies can contain input or credentials; never forward them to customers or logs.
    if(!response.ok) throw new Error(`Reddit collection provider returned HTTP ${response.status}.`);
    return response.json();
  }
  async start(communities:string[],after:string,before:string,maxChargeUsd:number):Promise<ApifyRun> {
    const query=new URLSearchParams({memory:'1024',timeout:'600',maxTotalChargeUsd:String(maxChargeUsd)});
    const result=await this.json(`acts/harshmaur~reddit-scraper/runs?${query}`,{method:'POST',body:JSON.stringify({
      startUrls:communities.map(name=>({url:`https://www.reddit.com/r/${name}/new/`})),
      postedAfter:after,postedBefore:before,searchSort:'new',maxPostsCount:100,
      maxCommentsCount:0,maxCommentsPerPost:0,maxCommunitiesCount:0,crawlCommentsPerPost:false,
      searchComments:false,searchCommunities:false,searchUsers:false,aiAnalysis:false,
    })});
    return this.runShape(result);
  }
  async status(id:string):Promise<ApifyRun> {return this.runShape(await this.json(`actor-runs/${encodeURIComponent(id)}`));}
  async startThreads(urls:string[],maxChargeUsd:number):Promise<ApifyRun> {
    if(!urls.length||urls.length>20||urls.some(url=>!/^https:\/\/www\.reddit\.com\/r\/[a-z0-9_]{2,21}\/comments\/[a-z0-9]{1,20}\/$/.test(url))) throw new Error('Invalid historical thread URLs.');
    const query=new URLSearchParams({memory:'1024',timeout:'600',maxTotalChargeUsd:String(maxChargeUsd)});
    return this.runShape(await this.json(`acts/harshmaur~reddit-scraper/runs?${query}`,{method:'POST',body:JSON.stringify({
      startUrls:urls.map(url=>({url})),maxPostsCount:20,maxCommentsCount:0,maxCommentsPerPost:0,maxCommunitiesCount:0,
      crawlCommentsPerPost:false,searchComments:false,searchCommunities:false,searchUsers:false,aiAnalysis:false,
    })}));
  }
  private runShape(result:any):ApifyRun {
    const run=result?.data;
    if(!run || typeof run.id!=='string' || typeof run.status!=='string' || typeof run.defaultDatasetId!=='string') throw new Error('Invalid Reddit collection response.');
    return run;
  }
  async posts(dataset:string):Promise<RedditPost[]> {
    const rows=await this.json(`datasets/${encodeURIComponent(dataset)}/items?clean=true&format=json&limit=1001`);
    if(!Array.isArray(rows) || rows.length>1000) throw new Error('Reddit collection exceeded its result limit.');
    return rows.map(normalizeRedditPost).filter((post):post is RedditPost=>post!==null);
  }
}
