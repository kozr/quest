import {problem,string,array,oneOf} from './pipeline-contract.mjs';
import {publicUrl} from './metadata.mjs';

// Only descriptions and technical metadata go to the writing model. Media stays
// in this browser until a cloud media store is explicitly configured.
export function validateVideoLibrary(value=[]){
 const ids=new Set(),counts={clip:0,background:0};
 return array(value,24).map(row=>{
  const id=string(row?.id,64);if(!/^[a-z0-9_-]+$/i.test(id)||ids.has(id))problem('Use a unique media ID.');ids.add(id);
  const kind=oneOf(row.kind,['clip','background']);if(++counts[kind]>12)problem('Keep up to twelve clips and twelve backgrounds in this batch.');
  const mode=oneOf(row.mode,kind==='clip'?['original','green']:['image']);
  const width=Number(row.width),height=Number(row.height),duration=Number(row.duration);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>7680||height>7680||!Number.isFinite(duration)||duration<0||duration>60||kind==='clip'&&duration<4||kind==='background'&&duration!==0)problem('Invalid media dimensions or duration.');
  if(row.clean!==true)problem('Review the clip for existing captions before adding it to the library.');
  const sourceUrl=row.sourceUrl?publicUrl(string(row.sourceUrl,2048)).href:'';
  return {id,kind,mode,label:string(row.label,120),description:string(row.description,500,20),width,height,duration,clean:true,sourceUrl};
 });
}

export const emptyReaction=()=>({viewpoint:'',want:'',trigger:'',action:'',turn:'',clipCriteria:'',backgroundCriteria:'',clipId:'',backgroundId:'',clipStart:0});
export function normalizeLegacyVideos(output){
 if(!Array.isArray(output?.videos))return output;
 return {...output,videos:output.videos.map(video=>({...video,format:video.format||'text',reaction:video.reaction||emptyReaction()}))};
}
