const DB_NAME='hearwhispers-video-media-v1';
let database;
async function db(){
 if(!globalThis.indexedDB)throw new Error('This browser cannot keep a media library. Enable browser storage and try again.');
 if(!database)database=new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>request.result.createObjectStore('assets',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('The media library could not be opened.'));});
 return database;
}
async function operation(mode,callback){
 const connection=await db();return new Promise((resolve,reject)=>{const transaction=connection.transaction('assets',mode),request=callback(transaction.objectStore('assets'));let result;request.onsuccess=()=>{result=request.result;};transaction.oncomplete=()=>resolve(result);transaction.onerror=transaction.onabort=()=>reject(new Error('The media file could not be saved. Check available browser storage.'));});
}
export async function listMedia(scope){return (await operation('readonly',store=>store.getAll())).filter(row=>row.scope===scope).map(({blob,key,scope,...metadata})=>metadata);}
export const mediaBlob=(scope,id)=>operation('readonly',store=>store.get(`${scope}:${id}`)).then(row=>row?.blob);
export const removeMedia=(scope,id)=>operation('readwrite',store=>store.delete(`${scope}:${id}`));
export async function addMedia(scope,file,details){
 const clip=details.kind==='clip',types=clip?['video/mp4','video/webm','video/quicktime']:['image/png','image/jpeg','image/webp'];
 if(!types.includes(file.type)||file.size>30*1024*1024)throw new Error(clip?'Choose an MP4, MOV or WebM under 30 MB.':'Choose a PNG, JPEG or WebP under 30 MB.');
 if(!details.label.trim()||details.description.trim().length<20)throw new Error('Name the asset and describe the specific action or setting in at least twenty characters.');
 if(!details.clean)throw new Error('Review the file for existing captions before adding it.');
 const url=URL.createObjectURL(file),element=clip?document.createElement('video'):new Image();
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('This file did not load. Try a different format.')),10000);element[clip?'onloadedmetadata':'onload']=()=>{clearTimeout(timer);resolve();};element.onerror=()=>{clearTimeout(timer);reject(new Error('This browser cannot decode that file. Try an H.264 MP4 or a PNG/JPEG image.'));};if(clip)element.preload='metadata';element.src=url;});
  const width=clip?element.videoWidth:element.naturalWidth,height=clip?element.videoHeight:element.naturalHeight,duration=clip?element.duration:0;
  if(width<1||height<1||width>7680||height>7680||!Number.isFinite(duration)||clip&&(duration<4||duration>60))throw new Error('Clips must be 4–60 seconds, with dimensions no larger than 7680 pixels.');
  const metadata={id:crypto.randomUUID(),kind:details.kind,mode:clip?details.mode:'image',label:details.label.trim().slice(0,120),description:details.description.trim().slice(0,500),width,height,duration,clean:true,sourceUrl:details.sourceUrl.trim()};
  if(metadata.sourceUrl){let source;try{source=new URL(metadata.sourceUrl);}catch{throw new Error('Use a valid source URL.');}if(!['http:','https:'].includes(source.protocol))throw new Error('Use a public source URL.');}
  await operation('readwrite',store=>store.put({key:`${scope}:${metadata.id}`,scope,...metadata,blob:file}));return metadata;
 }finally{if(clip){element.removeAttribute('src');element.load();}URL.revokeObjectURL(url);}
}

export async function loadReactionMedia(scope,video,library,templates=[]){
 const clipMetadata=library.find(row=>row.id===video.reaction.clipId&&row.kind==='clip');
 if(!clipMetadata)throw new Error('Choose a reaction clip to preview and export.');
 const ready=templates.find(row=>row.id===clipMetadata.id),clipBlob=ready?null:await mediaBlob(scope,clipMetadata.id);if(!ready&&!clipBlob)throw new Error('This clip is missing from this browser. Import it again or choose another clip.');
 const urls=[],clip=document.createElement('video');clip.muted=true;clip.playsInline=true;clip.preload='auto';
 const close=()=>{clip.pause();clip.removeAttribute('src');clip.load();urls.forEach(url=>URL.revokeObjectURL(url));};
 try{
  const clipUrl=ready?.mediaUrl||URL.createObjectURL(clipBlob);if(!ready)urls.push(clipUrl);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('The reaction clip did not load.')),10000);clip.onloadeddata=()=>{clearTimeout(timer);resolve();};clip.onerror=()=>{clearTimeout(timer);reject(new Error('The reaction clip could not be decoded.'));};clip.src=clipUrl;});
  let background=null;
  if(video.reaction.backgroundId){
   const row=library.find(asset=>asset.id===video.reaction.backgroundId&&asset.kind==='background'),blob=row&&await mediaBlob(scope,row.id);
   if(!blob)throw new Error('This background is missing from this browser. Choose another image.');
   background=new Image();const url=URL.createObjectURL(blob);urls.push(url);
   await new Promise((resolve,reject)=>{background.onload=resolve;background.onerror=()=>reject(new Error('The background image could not be decoded.'));background.src=url;});
  }
  return {clip,background,mode:clipMetadata.mode,assembled:Boolean(ready),close};
 }catch(error){close();throw error;}
}
export async function seekClip(clip,time){
 if(Math.abs(clip.currentTime-time)<0.02&&clip.readyState>=2)return;
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('The clip could not seek to this moment.'));},5000);const done=()=>{cleanup();resolve();};const fail=()=>{cleanup();reject(new Error('The clip stopped loading.'));};const cleanup=()=>{clearTimeout(timer);clip.removeEventListener('seeked',done);clip.removeEventListener('error',fail);};clip.addEventListener('seeked',done,{once:true});clip.addEventListener('error',fail,{once:true});clip.currentTime=time;});
}
