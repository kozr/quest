import {createHash} from 'node:crypto';
import {publicUrl} from './metadata.mjs';

export const BUSINESS_PROFILE_VERSION = 'business-profile-v2';
export const BUSINESS_PROFILE_PROMPT_VERSION = 'business-breakdown-v1';
export const BUSINESS_PROFILE_TTL_MS = 30 * 86400000;
const fail = message => {throw new Error(message);};
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail('The business breakdown contains invalid text.');
const list = (value, max) => Array.isArray(value) && value.length <= max ? value : fail('The business breakdown contains too many or invalid entries.');

export function businessProfileInput(value) {
  return {name:text(value?.name,120),url:publicUrl(text(value?.url,2048)).href,description:text(value?.description,5000)};
}
export function businessProfileHash(value) {
  return createHash('sha256').update(JSON.stringify([BUSINESS_PROFILE_VERSION,BUSINESS_PROFILE_PROMPT_VERSION,businessProfileInput(value)])).digest('hex');
}
export function freshBusinessProfile(profile, value, now=Date.now()) {
  const at=Date.parse(profile?.generatedAt);
  return profile?.inputHash===businessProfileHash(value) && Number.isFinite(at) && at<=now && at>now-BUSINESS_PROFILE_TTL_MS;
}

// Source passages are retained separately from interpretations. A valid quote
// establishes provenance, not semantic correctness; the owner reviews the draft.
export function validateBusinessProfile(value, input, {requireCurrent=false}={}) {
  if(value?.version!==BUSINESS_PROFILE_VERSION || value.promptVersion!==BUSINESS_PROFILE_PROMPT_VERSION)fail('Unsupported business profile version.');
  if(!/^[a-f0-9]{64}$/.test(value.inputHash || ''))fail('The business breakdown has no valid input reference.');
  if(requireCurrent && value.inputHash!==businessProfileHash(input))fail('Business details changed. Generate and review a new v2 breakdown before saving.');
  const sources=list(value.sources,2).map(source=>{
    if(!['description','website'].includes(source.id) || !['provided_description','official_page'].includes(source.kind) || (source.id==='description')!==(source.kind==='provided_description'))fail('Invalid business source.');
    const observedAt=Date.parse(source.observedAt);
    if(!Number.isFinite(observedAt) || observedAt>Date.now()+300000)fail('Invalid business source date.');
    return {id:source.id,kind:source.kind,url:source.kind==='official_page'?publicUrl(text(source.url,2048)).href:null,text:text(source.text,source.id==='description'?5000:9000),observedAt:new Date(observedAt).toISOString()};
  });
  if(!sources.some(s=>s.id==='description') || new Set(sources.map(s=>s.id)).size!==sources.length)fail('The business breakdown needs distinct source records.');
  const business={name:text(value.business?.name,120),url:publicUrl(text(value.business?.url,2048)).href};
  if(value.inputHash!==businessProfileHash({...business,description:sources.find(s=>s.id==='description').text}))fail('The business breakdown input reference does not match its sources.');
  if(requireCurrent && sources.find(s=>s.id==='description').text!==businessProfileInput(input).description)fail('The business description no longer matches the breakdown.');
  const evidence=row=>{
    const source=sources.find(s=>s.id===row.sourceId),quote=text(row.quote,320);
    if(!source?.text.includes(quote))fail('A business claim has no matching source passage.');
    return {sourceId:source.id,quote};
  };
  const offerings=list(value.offerings,8).map(row=>({id:text(row.id,20),label:text(row.label,160),...evidence(row)}));
  if(offerings.some(row=>!/^o[1-8]$/.test(row.id)) || new Set(offerings.map(row=>row.id)).size!==offerings.length)fail('Invalid or duplicate offering references.');
  const interpretations=(rows,max)=>list(rows,max).map(row=>{
    if(!['source','hypothesis'].includes(row.basis))fail('Mark each audience and need as sourced or inferred.');
    const offeringIds=list(row.offeringIds,8);
    if(!offeringIds.length || offeringIds.some(id=>!offerings.some(o=>o.id===id)) || new Set(offeringIds).size!==offeringIds.length)fail('A business need or audience refers to an unknown offering.');
    const provenance=row.basis==='source'?evidence(row):{sourceId:null,quote:null};
    if(row.basis==='hypothesis' && (row.sourceId!==null || row.quote!==null))fail('Inferences must not be presented as sourced facts.');
    return {text:text(row.text,240),basis:row.basis,offeringIds,...provenance};
  });
  const generatedAt=Date.parse(value.generatedAt);
  if(!Number.isFinite(generatedAt) || generatedAt>Date.now()+300000)fail('Invalid breakdown date.');
  if(value.reviewed!==undefined && typeof value.reviewed!=='boolean')fail('Confirm whether the breakdown has been reviewed.');
  return {version:BUSINESS_PROFILE_VERSION,promptVersion:BUSINESS_PROFILE_PROMPT_VERSION,inputHash:value.inputHash,
    generatedAt:new Date(generatedAt).toISOString(),model:text(value.model,80),reviewed:value.reviewed===true,business,sources,offerings,
    audiences:interpretations(value.audiences,6),needs:interpretations(value.needs,8),
    constraints:list(value.constraints,8).map(row=>({text:text(row.text,240),...evidence(row)})),
    unknowns:list(value.unknowns,8).map(v=>text(v,240)),limitations:list(value.limitations,4).map(v=>text(v,300))};
}

export function businessProfileSelection(value, input) {
  if(value.profileVersion===undefined && value.businessProfileV2===undefined && value.profileV1===undefined)return {};
  const profileVersion=value.profileVersion || 'v1';
  if(!['v1','v2'].includes(profileVersion))fail('Choose the standard or v2 business profile.');
  const profileV1=value.profileV1 || {capabilities:value.capabilities || [],needs:value.needs || []};
  const legacy={capabilities:list(profileV1.capabilities,8).map(v=>text(v,320)),needs:list(profileV1.needs,8).map(v=>text(v,240))};
  const businessProfileV2=value.businessProfileV2?validateBusinessProfile(value.businessProfileV2,input,{requireCurrent:profileVersion==='v2'}):null;
  if(profileVersion==='v2' && (!businessProfileV2?.reviewed || !businessProfileV2.offerings.length))fail('Generate and review at least one supported offering before using v2.');
  return {profileVersion,profileV1:legacy,...(businessProfileV2?{businessProfileV2}:{}),
    ...(profileVersion==='v2'?{capabilities:[...new Set(businessProfileV2.offerings.map(o=>o.quote))],needs:businessProfileV2.needs.map(n=>n.text)}:legacy)};
}

export function businessConstraints(product) {
  return product.profileVersion==='v2' && product.businessProfileV2?.reviewed
    ? product.businessProfileV2.constraints.map(row=>row.quote) : [];
}
