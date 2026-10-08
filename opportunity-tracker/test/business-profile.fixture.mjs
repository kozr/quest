import {BUSINESS_PROFILE_VERSION,BUSINESS_PROFILE_PROMPT_VERSION,businessProfileHash} from '../business-profile.mjs';

export const cafe={name:'Fixture Cafe',url:'https://fixture-cafe.dev/',description:'We serve croissant sandwiches and cheesecake in Vancouver. Pickup only.',keywords:['croissant sandwich'],aliases:['Fixture Cafe'],capabilities:['Serve sandwiches'],needs:['Find lunch'],communities:['vancouver'],monitoring:false,x:false};
export function prepared(input=cafe) {
  return {sources:[{id:'description',kind:'provided_description',url:null,text:input.description,observedAt:new Date().toISOString()}],limitations:['Fixture sources only.']};
}
export function breakdown(input=cafe) {
  return {version:BUSINESS_PROFILE_VERSION,promptVersion:BUSINESS_PROFILE_PROMPT_VERSION,inputHash:businessProfileHash(input),business:{name:input.name,url:input.url},model:'gpt-6.1-sol',generatedAt:new Date().toISOString(),reviewed:false,...prepared(input),
    offerings:[{id:'o1',label:'Croissant sandwiches and cheesecake',sourceId:'description',quote:'We serve croissant sandwiches and cheesecake in Vancouver.'}],
    audiences:[{text:'People looking for lunch in Vancouver',basis:'hypothesis',offeringIds:['o1'],sourceId:null,quote:null}],
    needs:[{text:'Find a croissant sandwich for lunch',basis:'hypothesis',offeringIds:['o1'],sourceId:null,quote:null}],
    constraints:[{text:'Pickup only',sourceId:'description',quote:'Pickup only.'}],unknowns:['Are reservations available?']};
}
export function fixtureProvider(options={}) {
  return {available:true,prepare:async input=>prepared(input),generate:async input=>({profile:breakdown(input),costMicroUsd:1234}),...options};
}
