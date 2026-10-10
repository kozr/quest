import {drawReactionFrame} from './reaction-render.mjs';
import {seekClip} from './video-media.mjs';
export const VIDEO_WIDTH=1080,VIDEO_HEIGHT=1920;
export const videoDuration=video=>video.scenes.reduce((total,scene)=>total+Number(scene.seconds),0);
export function sceneAt(video,time){let start=0;for(let index=0;index<video.scenes.length;index++){const end=start+Number(video.scenes[index].seconds);if(time<end||index===video.scenes.length-1)return {scene:video.scenes[index],index,start,end};start=end;}}
const stamp=seconds=>{const ms=Math.round(seconds*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
export function videoSubtitles(video){let elapsed=0;return video.scenes.map((scene,index)=>{const start=elapsed;elapsed+=Number(scene.seconds);return `${index+1}\n${stamp(start)} --> ${stamp(elapsed)}\n${scene.headline}${scene.body?'\n'+scene.body:''}${video.affiliation?'\n'+video.affiliation:''}\n`;}).join('\n');}
export function downloadBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
export const videoFilename=video=>video.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,70)||'hearwhispers-video';

export function wrapText(ctx,text,width){
 const lines=[];let line='';
 for(const word of String(text).split(/\s+/).filter(Boolean)){
  if(ctx.measureText(word).width>width){
   if(line){lines.push(line);line='';}
   let fragment='';for(const char of word){if(fragment&&ctx.measureText(fragment+char).width>width){lines.push(fragment);fragment='';}fragment+=char;}line=fragment;
  }else if(line&&ctx.measureText(line+' '+word).width>width){lines.push(line);line=word;}else line=line?line+' '+word:word;
 }if(line)lines.push(line);return lines;
}
export function fitted(ctx,text,{size,width,maxLines,weight=500}){let lines;do{ctx.font=`${weight} ${size}px "Geist Variable", sans-serif`;lines=wrapText(ctx,text,width);if(lines.length<=maxLines)break;size-=2;}while(size>20);return {lines,size};}

export function drawVideoFrame(canvas,video,time=0,media){
 if(video.format==='reaction'){const ctx=canvas.getContext('2d');ctx.save();ctx.scale(canvas.width/VIDEO_WIDTH,canvas.height/VIDEO_HEIGHT);drawReactionFrame(ctx,video,media,{fitted});ctx.restore();return;}
 const ctx=canvas.getContext('2d'),{scene,index,start,end}=sceneAt(video,time),dark=video.template==='charcoal';
 const foreground=dark?'#ffffff':'#252525',muted=dark?'#bcbcbc':'#707070',background=dark?'#252525':'#ffffff';
 ctx.save();ctx.scale(canvas.width/VIDEO_WIDTH,canvas.height/VIDEO_HEIGHT);
 ctx.fillStyle=background;ctx.fillRect(0,0,VIDEO_WIDTH,VIDEO_HEIGHT);
 ctx.fillStyle=foreground;ctx.fillRect(84,220,90,8);
 ctx.font='500 26px "Geist Variable", sans-serif';ctx.fillStyle=muted;
 ctx.fillText(scene.role==='hook'?'A useful starting point':scene.role==='close'?'Take this with you':`Step ${index}`,84,292);
 const title=fitted(ctx,scene.headline,{size:88,width:900,maxLines:5,weight:650});
 const body=fitted(ctx,scene.body,{size:44,width:900,maxLines:8,weight:400});
 const titleHeight=title.lines.length*title.size*1.12,bodyHeight=body.lines.length*body.size*1.42;
 let y=Math.max(470,900-(titleHeight+bodyHeight+72)/2);
 ctx.textBaseline='top';ctx.fillStyle=foreground;ctx.font=`650 ${title.size}px "Geist Variable", sans-serif`;
 for(const line of title.lines){ctx.fillText(line,84,y);y+=title.size*1.12;}
 y+=56;ctx.fillStyle=muted;ctx.font=`400 ${body.size}px "Geist Variable", sans-serif`;
 for(const line of body.lines){ctx.fillText(line,84,y);y+=body.size*1.42;}
 ctx.fillStyle=dark?'#414141':'#eeeeee';ctx.fillRect(84,1560,900,4);
 ctx.fillStyle=foreground;ctx.fillRect(84,1560,900*Math.max(0,Math.min(1,(time-start)/(end-start))),4);
 const footer=fitted(ctx,video.affiliation||`From ${video.businessName||'your team'}`,{size:26,width:800,maxLines:3,weight:500});
 ctx.fillStyle=muted;ctx.font=`500 ${footer.size}px "Geist Variable", sans-serif`;
 footer.lines.forEach((line,i)=>ctx.fillText(line,84,1610+i*36));
 ctx.font='500 26px "Geist Variable", sans-serif';ctx.textAlign='right';ctx.fillText(`${index+1} / ${video.scenes.length}`,996,1610);
 ctx.restore();
}

export function videoExportType(){
 if(typeof MediaRecorder==='undefined'||!globalThis.HTMLCanvasElement?.prototype.captureStream)return null;
 return ['video/mp4;codecs=avc1.42001E','video/mp4','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported(type))||null;
}
export async function renderVideo(video,{signal,onProgress=()=>{},media}={}){
 const mimeType=videoExportType();if(!mimeType)throw new Error('This browser cannot export video. Open this workspace in Chrome or Safari, or download the script and subtitles.');
 if(document.visibilityState==='hidden')throw new Error('Keep this tab visible during export.');
 if(video.format==='reaction'){if(!media?.clip)throw new Error('Choose a reaction clip before exporting.');if(video.reaction.clipStart+videoDuration(video)>media.clip.duration+0.02)throw new Error('The selected clip is too short for this scene.');await seekClip(media.clip,video.reaction.clipStart);}
 await document.fonts.ready;
 if(signal?.aborted)throw new DOMException('Export cancelled.','AbortError');
 const canvas=document.createElement('canvas');canvas.width=VIDEO_WIDTH;canvas.height=VIDEO_HEIGHT;
 drawVideoFrame(canvas,video,0,media);const stream=canvas.captureStream(30),chunks=[];
 let recorder;try{recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:6000000});}catch(error){stream.getTracks().forEach(track=>track.stop());throw error;}
 return new Promise((resolve,reject)=>{
  let frame=0,settled=false,started=0,visibility;
  const cleanup=()=>{media?.clip?.pause();if(media?.clip)media.clip.onwaiting=null;cancelAnimationFrame(frame);stream.getTracks().forEach(track=>track.stop());signal?.removeEventListener('abort',abort);document.removeEventListener('visibilitychange',visibility);};
  const fail=error=>{if(settled)return;settled=true;if(recorder.state!=='inactive')recorder.stop();cleanup();reject(error);};
  const abort=()=>fail(new DOMException('Export cancelled.','AbortError'));
  visibility=()=>{if(document.visibilityState==='hidden')fail(new Error('Export stopped when this tab was hidden. Keep the tab visible and try again.'));};
  recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
  recorder.onerror=()=>fail(new Error('Video export failed. Try again or download the script and subtitles.'));
  recorder.onstop=()=>{if(settled)return;settled=true;cleanup();const blob=new Blob(chunks,{type:recorder.mimeType});if(!blob.size){reject(new Error('The exported video is empty. Try again.'));return;}resolve({blob,extension:recorder.mimeType.startsWith('video/mp4')?'mp4':'webm'});};
  signal?.addEventListener('abort',abort,{once:true});document.addEventListener('visibilitychange',visibility);
  const tick=now=>{const seconds=(now-started)/1000;drawVideoFrame(canvas,video,Math.min(seconds,videoDuration(video)),media);onProgress(Math.min(1,seconds/videoDuration(video)));if(seconds>=videoDuration(video)){recorder.stop();return;}frame=requestAnimationFrame(tick);};
  const start=async()=>{try{if(media?.clip){media.clip.onwaiting=()=>fail(new Error('The clip paused while loading. Wait for it to load and try again.'));await media.clip.play();}if(settled)return;if(signal?.aborted){abort();return;}recorder.start(250);started=performance.now();frame=requestAnimationFrame(tick);}catch(error){fail(error);}};start();
 });
}
