import {accessContext,authorizeProduct} from './workspace.mjs';
import {planFor} from './plans.mjs';
import {conversationSourceKey,qualificationInputHash,currentReviewFailure} from './conversation-evidence.mjs';
import {conversationSignals} from './conversation-purpose.mjs';
import {entityMentionEvidence} from './entity-mention.mjs';
import {qualificationCurrent} from './conversation-feed.mjs';
import {keywordMentionEvidence} from './keyword-mention.mjs';
import {freshAnalysis,productHash,matchHash} from './analysis.mjs';

export const CONVERSATION_PAGE_LIMIT=100;
const fail=(message,code='invalid_conversation_filter')=>{throw Object.assign(new Error(message),{status:400,code});};
const key=(productId,row)=>`${productId}\n${conversationSourceKey(row.url)}`;
const clone=value=>structuredClone(value);
const platform=row=>row.source?.startsWith('Reddit')?'reddit':row.source==='X'?'x':row.source==='LinkedIn'?'linkedin':row.source?.startsWith('TikTok')?'tiktok':row.source?.startsWith('Instagram')?'instagram':row.source==='Google Maps review'||row.source==='App Store review'?'reviews':row.source==='Web'?'web':'other';
const purposeMap={mentions:'mention',direct:'potential_customer',opportunities:'potential_customer',feedback:'feedback',competitors:'competitor',mention:'mention',potential_customer:'potential_customer',competitor:'competitor'};
const fields=['id','productId','url','source','provider','sourceId','postId','parentId','type','title','snippet','context','author','community','threadId','publishedAt','collectedAt','lastSeenAt','foundAt','historical','backfillId','backfillIds','discussionClosed','crosspost','kind','status','note','draft','reason','matchedTerms','queryIds','queryFamilies','discoverySource','discoveryURL','contentOrigin','sourceLinkKind','businessReview','rating'];
const pick=(value,names)=>Object.fromEntries(names.filter(name=>value?.[name]!==undefined).map(name=>[name,value[name]]));
function evidenceIndex(data,products){
  const rows=new Map();
  for(const product of products){
    for(const value of Object.values(data.conversationReviewFailures?.[product.id]||{}))if(value.row?.url)rows.set(key(product.id,value.row),{product,row:value.row});
    for(const row of [...(data.conversationEvidence?.[product.id]||[]),...(data.conversationReviewQueue?.[product.id]||[])])if(row?.url)rows.set(key(product.id,row),{product,row});
  }
  return rows;
}

// Collection materializes source records before AI runs. Their stable IDs and
// human review fields survive later qualification or changed source text.
// This is a trusted worker mutation; callers run it within the Store CAS.
export function materializeCollectedConversations(data,product,candidates,now=Date.now()){
  if(!data.subscription)return 0;
  const at=new Date(now).toISOString(),existing=new Map((data.items||[]).filter(item=>item.productId===product.id).map(item=>[key(product.id,item),item]));
  const wanted=candidates?new Set(candidates.filter(row=>row?.url).map(row=>key(product.id,row))):null;
  const additions=[],profileHash=qualificationInputHash(product);let count=0;
  for(const [identity,{row}] of evidenceIndex(data,[product])){
    if(wanted&&!wanted.has(identity))continue;
    const prior=existing.get(identity),current=qualificationCurrent(data,product,row,prior,profileHash);
    const source={...pick(row,fields),id:prior?.id||row.id,productId:product.id,snippet:row.text??row.snippet??'',context:row.context||'',
      kind:current&&row.qualification.relevant?prior?.kind||'conversation':'conversation',status:prior?.status||'new',note:prior?.note||'',draft:prior?.draft||'',foundAt:prior?.foundAt||row.collectedAt||at,
      lastSeenAt:row.lastSeenAt||row.collectedAt||at,analysisStatus:current?'analyzed':currentReviewFailure(data,product,row)?'analysis_failed':'awaiting_analysis'};
    if(current)source.qualification={...prior?.qualification,...row.qualification,contentHash:row.contentHash};
    if(prior){
      Object.assign(prior,source);
      // Bounded state snapshots may omit this source's evidence row. They must
      // not fall back to an old item decision after the source changed. The
      // server-owned receipt still retains the prior assessment for dedup.
      if(!current){delete prior.qualification;delete prior.reason;delete prior.matchedTerms;}
    }else{const item={...source};additions.push(item);existing.set(identity,item);}count++;
  }
  data.items=[...additions,...(data.items||[])];return count;
}

function filters(value={}){
  const productId=value.productId==null||value.productId==='all'?null:String(value.productId);
  const query=value.query==null?'':value.query;
  if(typeof query!=='string'||query.length>500)fail('Search text must be at most 500 characters.');
  const offset=value.offset==null?0:Number(value.offset),limit=value.limit==null?50:Number(value.limit);
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>CONVERSATION_PAGE_LIMIT)fail('Choose a valid page offset and a limit from 1 to 100.');
  const selectedPlatform=value.platform||'all',status=value.status||'active',relevance=value.relevance||'all',purpose=value.purpose||null;
  if(!['all','reddit','x','linkedin','tiktok','instagram','reviews','web','other'].includes(selectedPlatform)||!['all','active','new','saved','dismissed','awaiting_analysis','analysis_failed','analyzed'].includes(status)||!['all','collected',...Object.keys(purposeMap)].includes(relevance)||purpose!==null&&!Object.hasOwn(purposeMap,purpose))fail('Choose a supported conversation filter.');
  if(purpose&&relevance!=='all'&&relevance!=='collected'&&purposeMap[purpose]!==purposeMap[relevance])fail('Purpose and relevance filters must agree.');
  return {productId,query:query.toLowerCase(),offset,limit,platform:selectedPlatform,status,relevance,purpose:purposeMap[purpose]||purposeMap[relevance]||null};
}
function scope(data,principal,input){
  const entitlements=planFor(data),context=accessContext(data,principal,{},entitlements);
  if(input.productId)authorizeProduct(data,principal,input.productId,{},entitlements);
  const allowed=new Set(input.productId?[input.productId]:context.productIds);
  return (data.products||[]).filter(product=>allowed.has(product.id));
}
function state(data,product,item,row,profileHash){
  const source=row||item,keywordMention=keywordMentionEvidence(product,source),decision=row?row.qualification:item?.qualification;
  const current=qualificationCurrent(data,product,row,item,profileHash),entityMention=entityMentionEvidence(product,source,{decision,current});
  if(product.listeningVersion!=='v2')return {keywordMention,entityMention,analysisStatus:item?.analysisStatus||'analyzed',conversationSignals:undefined,currentConversationRelevant:undefined,currentOpportunityFit:undefined,current:false};
  const signals=conversationSignals(product,source,decision,{current});
  return {keywordMention,entityMention,analysisStatus:current?'analyzed':row&&currentReviewFailure(data,product,row)?'analysis_failed':'awaiting_analysis',conversationSignals:signals,currentConversationRelevant:current&&decision.relevant===true,currentOpportunityFit:signals.some(signal=>signal.purpose==='potential_customer'),current};
}
function matches(data,input,entry,collected){
  const {product,item,row}=entry,source=row||item,computed=state(data,product,item,row,input.profileHashes.get(product.id)),status=item?.status||'new';entry.computed=computed;
  if(input.platform!=='all'&&platform(source)!==input.platform)return false;
  if(['awaiting_analysis','analysis_failed','analyzed'].includes(input.status)){if(computed.analysisStatus!==input.status)return false;}
  else if(input.status==='active'?status==='dismissed':input.status!=='all'&&input.status!==status)return false;
  const entityMention=input.purpose==='mention'&&Boolean(computed.entityMention);
  if(input.purpose==='mention'&&!entityMention)return false;
  if(!collected&&!entityMention&&input.status!=='dismissed'&&computed.currentConversationRelevant===false)return false;
  if(input.purpose&&!entityMention){
    if(computed.conversationSignals){if(!computed.conversationSignals.some(signal=>signal.purpose===input.purpose))return false;}
    else if(input.purpose==='mention'?item?.kind!=='mention':input.purpose==='potential_customer'?!(item?.kind==='opportunity'&&item.qualification?.directFit!==false):!item?.qualification?.purposes?.some(signal=>signal.purpose===input.purpose))return false;
  }
  return !input.query||[source.title,source.text??source.snippet,source.context,source.author,source.source,source.community,item?.reason].some(value=>typeof value==='string'&&value.toLowerCase().includes(input.query));
}
function project(data,{product,item,row,computed},collected){
  const result={...pick(item,fields),...pick(row,fields),id:item?.id||row.id,productId:product.id,snippet:row?.text??row?.snippet??item?.snippet??'',context:row?.context??item?.context??'',status:item?.status||'new',note:item?.note||'',draft:item?.draft||'',kind:collected&&!computed.current?'conversation':item?.kind||'conversation',
    ...(row?{evidenceId:row.id}:{}),...pick(computed,['keywordMention','entityMention','analysisStatus','conversationSignals','currentConversationRelevant','currentOpportunityFit']),reviewEditable:Boolean(item)};
  if(!computed.current&&row){delete result.reason;delete result.matchedTerms;}
  const decision=row?row.qualification:item?.qualification;
  if(computed.current&&decision)result.qualification=pick(decision,['relevant','directFit','category','need','quote','offeringIds','reason','resolved','purposes','qualifiedAt','model','sourceTextTruncated']);
  if(item?.analysis&&freshAnalysis(item.analysis)&&item.analysis.profileHash===productHash(product)&&item.analysis.sourceHash===matchHash(result))result.analysis=pick(item.analysis,['decision','summary','evidenceQuote','matchedCapabilityIds','limitations','replies','generatedAt','model']);
  const review=data.workspace?.reviews?.[result.id];
  if(review?.productId===product.id)result.review=pick(review,['itemId','productId','version','assigneeSub','updatedAt','updatedBy']);
  else result.review={itemId:result.id,productId:product.id,version:0,assigneeSub:null};
  return clone(result);
}
function page(data,principal,value,collected,privateMode=false){
  const input=filters(value),products=privateMode?(data.products||[]).filter(product=>!input.productId||product.id===input.productId):scope(data,principal,input),byProduct=new Map(products.map(product=>[product.id,product])),evidence=evidenceIndex(data,products),items=new Map();
  input.profileHashes=new Map(products.map(product=>[product.id,qualificationInputHash(product)]));
  for(const item of data.items||[])if(byProduct.has(item.productId)&&item.url)items.set(key(item.productId,item),item);
  const entries=[];
  for(const [identity,item] of items){const product=byProduct.get(item.productId);entries.push({product,item,row:evidence.get(identity)?.row});}
  if(collected)for(const [identity,entry] of evidence)if(!items.has(identity))entries.push(entry);
  const matching=entries.filter(entry=>matches(data,input,entry,collected)).sort((a,b)=>{
    const stamp=entry=>Date.parse(entry.row?.publishedAt||entry.item?.publishedAt||entry.row?.collectedAt||entry.item?.foundAt)||0;
    return stamp(b)-stamp(a)||String(a.item?.id||a.row.id).localeCompare(String(b.item?.id||b.row.id))||a.product.id.localeCompare(b.product.id);
  });
  const selected=matching.slice(input.offset,input.offset+input.limit),hasMore=input.offset+selected.length<matching.length;
  return {items:selected.map(entry=>project(data,entry,collected)),total:matching.length,offset:input.offset,limit:input.limit,hasMore,nextOffset:hasMore?input.offset+selected.length:null};
}
// The current store hydrates a workspace before calling these pure projections.
// They bound HTTP rows and clone only the selected page; they do not claim to
// perform indexed database reads. Source bodies remain complete for each row.
export function pageConversations(data,principal,options={}){return page(data,principal,options,options.relevance==='collected');}
export function pageConversationEvidence(data,principal,options={}){return page(data,principal,{...options,relevance:'collected'},true);}

// Use only behind the existing private tracker authentication boundary.
export function pagePrivateConversations(data,options={}){if(data.workspace)throw Object.assign(new Error('Use the workspace-scoped conversation API.'),{status:403,code:'workspace_scope_required'});return page(data,null,options,options.relevance==='collected',true);}

// Public row payloads are stored separately from their compact filter index.
// The index contains no source bodies, drafts, notes or private provider data.
export function privateConversationReadViews(data){
  if(data.workspace)return null;
  const products=data.products||[],byProduct=new Map(products.map(p=>[p.id,p])),evidence=evidenceIndex(data,products),items=new Map(),views={},index=[],search={};
  for(const item of data.items||[])if(byProduct.has(item.productId)&&item.url)items.set(key(item.productId,item),item);
  const entries=[...items].map(([identity,item])=>({product:byProduct.get(item.productId),item,row:evidence.get(identity)?.row}));
  for(const [identity,entry] of evidence)if(!items.has(identity))entries.push(entry);
  entries.sort((a,b)=>{const stamp=e=>Date.parse(e.row?.publishedAt||e.item?.publishedAt||e.row?.collectedAt||e.item?.foundAt)||0;return stamp(b)-stamp(a)||String(a.item?.id||a.row.id).localeCompare(String(b.item?.id||b.row.id))||a.product.id.localeCompare(b.product.id);});
  for(const entry of entries){
    const {product,item,row}=entry,source=row||item,computed=state(data,product,item,row,qualificationInputHash(product));entry.computed=computed;
    const name=`conversation:${key(product.id,source)}`;
    const purposes=['mention','potential_customer','feedback','competitor'].filter(purpose=>purpose==='mention'?Boolean(computed.entityMention):computed.conversationSignals?computed.conversationSignals.some(s=>s.purpose===purpose):purpose==='potential_customer'?item?.kind==='opportunity'&&item.qualification?.directFit!==false:item?.qualification?.purposes?.some(s=>s.purpose===purpose));
    index.push({name,productId:product.id,platform:platform(source),status:item?.status||'new',analysisStatus:computed.analysisStatus,regular:Boolean(item),relevant:computed.currentConversationRelevant!==false,purposes,kind:item?.kind||'conversation',current:computed.current});
    search[name]=[source.title,source.text??source.snippet,source.context,source.author,source.source,source.community,item?.reason].filter(v=>typeof v==='string').map(v=>v.toLowerCase());
    views[name]=JSON.stringify(project(data,entry,false));
  }
  // Serializing the compact arrays avoids turning each scalar into a database
  // node. The immutable codec still checks their hashes and byte limits.
  views['conversation-index']=JSON.stringify(index);
  views['conversation-search']=JSON.stringify(search);
  return views;
}
export async function pagePrivateConversationViews(reader,options={}){
  const input=filters(options),collected=options.relevance==='collected';
  const raw=await reader.get('conversation-index');if(raw===null)return null;
  const entries=JSON.parse(raw),search=input.query?JSON.parse(await reader.get('conversation-search')):null;
  const matching=entries.filter(e=>{
    if(input.productId&&e.productId!==input.productId||!collected&&!e.regular||input.platform!=='all'&&e.platform!==input.platform)return false;
    if(['awaiting_analysis','analysis_failed','analyzed'].includes(input.status)){if(e.analysisStatus!==input.status)return false;}
    else if(input.status==='active'?e.status==='dismissed':input.status!=='all'&&e.status!==input.status)return false;
    const mention=input.purpose==='mention'&&e.purposes.includes('mention');
    if(input.purpose==='mention'&&!mention)return false;
    if(!collected&&!mention&&input.status!=='dismissed'&&!e.relevant)return false;
    if(input.purpose&&!e.purposes.includes(input.purpose))return false;
    return !input.query||search[e.name]?.some(v=>v.includes(input.query));
  });
  const selected=matching.slice(input.offset,input.offset+input.limit),items=await Promise.all(selected.map(async e=>{
    const raw=await reader.get(e.name),row=raw===null?null:JSON.parse(raw);if(!row)throw Object.assign(new Error('Conversation read view is incomplete.'),{status:503});
    row.kind=collected&&!e.current?'conversation':e.kind;
    if(row.analysis&&!freshAnalysis(row.analysis))delete row.analysis;
    return row;
  }));
  const hasMore=input.offset+items.length<matching.length;
  return {items,total:matching.length,offset:input.offset,limit:input.limit,hasMore,nextOffset:hasMore?input.offset+items.length:null};
}
