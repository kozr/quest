import {CollectionError,readText} from './reddit/http.mjs';
import {normalizeSocialPost} from './social-search.mjs';

const API='https://api.apify.com/v2/';
export const INSTAGRAM_ACTOR='apidojo~instagram-scraper';
export const INSTAGRAM_MAX_ITEMS=20;
export const INSTAGRAM_MAX_CHARGE_USD=0.02;
const terminal=new Set(['SUCCEEDED','FAILED','TIMED-OUT','ABORTED']);
const runID=/^[a-zA-Z0-9]{1,64}$/;

// Keep the same shortcode-based identity as existing Instagram evidence.
// A keyword, image, author bio or comment count cannot stand in for a caption.
export function normalizeApifyInstagramPost(value,collectedAt,{preserveText=false}={}){
  if(!value||typeof value.caption!=='string'||!value.caption.trim()||!preserveText&&value.caption.length>50000||
    typeof value.createdAt!=='string'||value.owner?.isPrivate===true||value.isPrivate===true)return null;
  const row=normalizeSocialPost('instagram',{
    code:value.code,url:value.url,caption_text:value.caption,taken_at:value.createdAt,
    user:{username:value.owner?.username,is_private:value.owner?.isPrivate},comment_count:value.commentCount,
    comments_disabled:value.commentsDisabled===true,
  },collectedAt,{preserveText});
  return row?{...row,provider:'instagram-apify'}:null;
}

export class ApifyInstagramAdapter{
  id='instagram-apify';
  constructor({token,fetchImpl=fetch,now=Date.now}={}){
    if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token))throw Error('Configure the server-only APIFY_TOKEN.');
    this.token=token;this.fetchImpl=fetchImpl;this.now=now;
  }
  async json(path,{method='GET',body,signal,timeout=15000}={}){
    const response=await this.fetchImpl(new URL(path,API).href,{method,redirect:'error',
      signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeout)]),
      headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok){await response.body?.cancel();const error=new CollectionError([401,403].includes(response.status)?'instagram_credentials_required':`upstream_http_${response.status}`);error.httpStatus=response.status;throw error;}
    try{return JSON.parse(await readText(response,2_097_152));}catch{throw new CollectionError('instagram_schema_changed');}
  }
  run(value,expected){
    const run=value?.data;
    if(!run||typeof run.id!=='string'||!runID.test(run.id)||expected&&run.id!==expected||
      !['READY','RUNNING','SUCCEEDED','FAILED','TIMING-OUT','TIMED-OUT','ABORTING','ABORTED'].includes(run.status)||
      run.defaultDatasetId!=null&&(typeof run.defaultDatasetId!=='string'||!runID.test(run.defaultDatasetId)))throw new CollectionError('instagram_schema_changed');
    return run;
  }
  async search({query,limit=INSTAGRAM_MAX_ITEMS,signal,preserveText=false}={}){
    if(typeof query!=='string'||!query.trim()||query.length>500||!Number.isInteger(limit)||limit<1||limit>INSTAGRAM_MAX_ITEMS)throw new CollectionError('invalid_instagram_search',400);
    const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(75000)]);let run;
    try{
      // Do not retry a start: a lost response may already have created a paid run.
      // Never use saved actor tasks, connector delivery, cookies or custom code.
      run=this.run(await this.json(`actors/${INSTAGRAM_ACTOR}/runs?timeout=60&memory=512&maxTotalChargeUsd=${INSTAGRAM_MAX_CHARGE_USD.toFixed(2)}&restartOnError=false`,{
        method:'POST',signal:deadline,timeout:8000,body:{keywords:[query.trim()],startUrls:[],maxItems:limit,getReels:false}}));
      for(let poll=0;!terminal.has(run.status)&&poll<8;poll++)run=this.run(await this.json(`actor-runs/${run.id}?waitForFinish=10`,{signal:deadline}),run.id);
      if(!terminal.has(run.status))throw new CollectionError('instagram_timeout');
      const failure=run.status==='SUCCEEDED'?null:run.status==='TIMED-OUT'?'instagram_timeout':'instagram_provider_failed';
      if(!run.defaultDatasetId)throw new CollectionError(failure||'instagram_schema_changed');
      const items=await this.json(`datasets/${run.defaultDatasetId}/items?format=json&clean=true&limit=${limit+1}`,{signal:deadline});
      if(!Array.isArray(items)||items.length>limit)throw new CollectionError('instagram_schema_changed');
      const collectedAt=new Date(this.now()).toISOString(),unique=new Map();let invalid=0;
      for(const item of items){const row=normalizeApifyInstagramPost(item,collectedAt,{preserveText});if(!row){invalid++;continue;}unique.set(row.sourceId,row);}
      if(items.length&&invalid===items.length)throw new CollectionError('instagram_unusable_records');
      if(failure&&!unique.size)throw new CollectionError(failure);
      const rows=[...unique.values()];
      return {rows,coverage:{provider:this.id,actor:INSTAGRAM_ACTOR.replace('~','/'),runId:run.id,runStatus:run.status,
        complete:false,partial:Boolean(failure)||invalid>0||items.length>=limit,oldest:rows.length?Math.min(...rows.map(row=>Date.parse(row.publishedAt))):null,
        maxPosts:limit,observedPosts:items.length,skippedPosts:invalid,maxChargeUsd:INSTAGRAM_MAX_CHARGE_USD,
        reportedCostUsd:Number.isFinite(run.usageTotalUsd)?run.usageTotalUsd:null,costFinal:false,
        errors:[...(failure?[failure]:[]),...(invalid?['invalid_or_missing_captions']:[])]}};
    }catch(error){
      if(run&&!terminal.has(run.status))try{await this.json(`actor-runs/${run.id}/abort`,{method:'POST',timeout:2000});}catch{}
      const safe=deadline.aborted||['AbortError','TimeoutError'].includes(error?.name)?new CollectionError('instagram_timeout'):error instanceof CollectionError?error:new CollectionError('instagram_provider_failed');
      safe.runId=run?.id;if(error.httpStatus)safe.httpStatus=error.httpStatus;throw safe;
    }
  }
}
