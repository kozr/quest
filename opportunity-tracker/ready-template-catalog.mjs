import {normalizeCaptionStyle,isSocialCaptionStyle} from './caption-styles.mjs';

// Complete, caption-free scenes prepared by the library owner. Customers never
// choose a separate background or trim the reaction. Publish only owned/cleared
// masters; the reference footage below is restricted to disposable fixtures.
export const READY_TEMPLATES=[
 {id:'cafe-walk-v1',label:'The café walk-in',action:'A deliberate walk across the café.',description:'A woman in a robe and sunglasses walks left to right with deliberate strides across a café. The movement continues without a surprise or reversal. The café background is already assembled. Use for committing to a small plan or walking in confidently, not for a double take or an attack.',seconds:6,status:'preview',mediaUrl:'/content-templates/cafe-walk-v2.mp4',posterUrl:'/content-templates/cafe-walk-v2.jpg',provenance:'Reference robe-walk clip with an original generated café background. Local preview; original footage has not been generated or cleared for distribution.'},
 {id:'cafe-celebration-v1',label:'The tiny celebration',action:'A group bobs and raises their arms.',description:'A montage of podcast participants bobs, dances and raises arms against an already assembled café background. Use for a small shared victory or a celebratory payoff. It does not show receiving an item, pointing at an object, a surprised double take or walking into the café.',seconds:6,status:'preview',mediaUrl:'/content-templates/cafe-celebration-v2.mp4',posterUrl:'/content-templates/cafe-celebration-v2.jpg',provenance:'Reference podcast-dance montage with an original generated café background. Local preview; original footage has not been generated or cleared for distribution.'}
];
export const readyTemplates=({fixture=false}={})=>READY_TEMPLATES.filter(row=>row.status==='published'||fixture&&row.status==='preview');
export const templateAsset=row=>({id:row.id,kind:'clip',mode:'original',label:row.label,description:row.description,width:1080,height:1920,duration:row.seconds,clean:true,sourceUrl:''});

export function templateVideo(template,draft){
 return {id:template.id,title:template.label,format:'reaction',template:normalizeCaptionStyle(draft.captionStyle),reaction:{clipId:template.id,backgroundId:'',clipStart:0},scenes:[{role:'hook',headline:String(draft.headline||'').slice(0,240),body:'',seconds:String(template.seconds)}],caption:String(draft.caption||'').slice(0,2200),affiliation:'',reviewNotes:[],sources:[]};
}

export function switchVideoTemplate(video,template){
 return {...video,template:isSocialCaptionStyle(video.template)?video.template:'instagram',reaction:{...video.reaction,clipId:template.id,backgroundId:'',clipStart:0,action:template.action,clipCriteria:template.description,backgroundCriteria:'The reaction and café background are already assembled in this complete template.'},scenes:[{...video.scenes[0],seconds:String(template.seconds)}]};
}

// Keep referenced legacy files before optional assets, within existing request
// limits. This lets old drafts keep working when the owner adds ready templates.
export function mergeVideoCatalog(templates,local,saved=[],videos=[]){
 const referenced=new Set(videos.flatMap(row=>[row.reaction?.clipId,row.reaction?.backgroundId]).filter(Boolean));
 const available=[...templates.map(templateAsset),...local,...saved.filter(row=>referenced.has(row.id))],seen=new Set(),counts={clip:0,background:0};
 return [...available.filter(row=>referenced.has(row.id)),...available.filter(row=>!referenced.has(row.id))].filter(row=>{
  if(seen.has(row.id)||counts[row.kind]>=12)return false;
  seen.add(row.id);counts[row.kind]++;return true;
 });
}
