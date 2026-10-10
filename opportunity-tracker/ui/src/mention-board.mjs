import {platform} from './api.js';
export const MENTION_PAGE_SIZE=8;
export const MENTION_LANES=[
 {id:'reddit',label:'Reddit'},{id:'instagram',label:'Instagram'},
 {id:'reviews',label:'Reviews'},{id:'web',label:'Web'},
 {id:'x',label:'X'},{id:'linkedin',label:'LinkedIn'},
 {id:'tiktok',label:'TikTok'},{id:'other',label:'Other'}
];
export function localMentionLane(items,productId,source,page=0){
 const matching=items.filter(item=>item.productId===productId&&platform(item)===source);
 return {items:matching.slice(page*MENTION_PAGE_SIZE,(page+1)*MENTION_PAGE_SIZE),total:matching.length,loading:false,error:''};
}
// Return a position, rather than a cached row, so moving between pages always
// reads the existing conversation endpoint and retains the source's identity.
export function adjacentMention(lanes,current,offset){
 const laneIndex=lanes.findIndex(lane=>lane.id===current.lane),lane=lanes[laneIndex];
 if(!lane)return null;
 const index=lane.items.findIndex(item=>item.id===current.item.id);
 if(index<0)return null;
 const absolute=lane.page*MENTION_PAGE_SIZE+index+offset;
 if(absolute>=0&&absolute<lane.total)return {lane:lane.id,page:Math.floor(absolute/MENTION_PAGE_SIZE),index:absolute%MENTION_PAGE_SIZE};
 for(let next=laneIndex+offset;next>=0&&next<lanes.length;next+=offset){
  const target=lanes[next];if(!target.total||target.error)continue;
  const position=offset>0?0:target.total-1;
  return {lane:target.id,page:Math.floor(position/MENTION_PAGE_SIZE),index:position%MENTION_PAGE_SIZE};
 }
 return null;
}
