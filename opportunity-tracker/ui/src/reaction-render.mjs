import {isSocialCaptionStyle} from '../../caption-styles.mjs';

export function keyGreenPixels(pixels){
 for(let i=0;i<pixels.length;i+=4){const r=pixels[i],g=pixels[i+1],b=pixels[i+2],dominance=g-Math.max(r,b);if(g<65||dominance<20)continue;const strength=Math.max(0,Math.min(1,(dominance-20)/65));pixels[i+3]=Math.round(pixels[i+3]*(1-strength));pixels[i+1]=Math.min(g,Math.max(r,b)+25);}
 return pixels;
}
function contain(ctx,source,x,y,w,h){const sw=source.videoWidth||source.naturalWidth,sh=source.videoHeight||source.naturalHeight;if(!sw||!sh)return;const scale=Math.min(w/sw,h/sh);ctx.drawImage(source,x+(w-sw*scale)/2,y+(h-sh*scale)/2,sw*scale,sh*scale);}
function cover(ctx,source,w,h){const sw=source.naturalWidth,sh=source.naturalHeight,scale=Math.max(w/sw,h/sh);ctx.drawImage(source,(w-sw*scale)/2,(h-sh*scale)/2,sw*scale,sh*scale);}
export function drawReactionFrame(ctx,video,media,{fitted,width=1080,height=1920}){
 const social=isSocialCaptionStyle(video.template),dark=video.template==='charcoal',foreground=social||dark?'#fff':'#252525';
 ctx.fillStyle=dark?'#252525':'#fff';ctx.fillRect(0,0,width,height);
 if(media?.background)cover(ctx,media.background,width,height);
 const title=fitted(ctx,video.scenes[0].headline,{size:70,width:900,maxLines:5,weight:650});
 const headerHeight=social?0:Math.max(440,title.lines.length*title.size*1.16+150),contentHeight=social?height:height-headerHeight-120;
 if(media?.clip&&media.clip.readyState>=2){
  if(media.assembled){ctx.drawImage(media.clip,0,0,width,height);}
  else if(media.mode==='green'){
   if(!media.keyCanvas){media.keyCanvas=document.createElement('canvas');media.keyCanvas.width=540;media.keyContext=media.keyCanvas.getContext('2d',{willReadFrequently:true});}if(media.keyCanvas.height!==Math.round(contentHeight/2))media.keyCanvas.height=Math.round(contentHeight/2);
   const key=media.keyContext;const kh=media.keyCanvas.height;key.clearRect(0,0,540,kh);contain(key,media.clip,0,0,540,kh);const frame=key.getImageData(0,0,540,kh);keyGreenPixels(frame.data);key.putImageData(frame,0,0);ctx.drawImage(media.keyCanvas,0,headerHeight,width,contentHeight);
  }else contain(ctx,media.clip,0,headerHeight,width,contentHeight);
 }else{
  ctx.fillStyle=dark?'#bcbcbc':'#707070';ctx.font='400 30px "Geist Variable", sans-serif';ctx.textAlign='center';ctx.fillText('Choose a reaction template',width/2,1100);ctx.textAlign='left';
 }
 // Social captions overlay the scene; saved classic layouts retain their band.
 if(social)drawSocialCaption(ctx,video.scenes[0].headline,video.template,{fitted,width,height});
 else {ctx.fillStyle=dark?'#252525':'#fff';ctx.fillRect(0,0,width,headerHeight);
 ctx.textBaseline='top';ctx.fillStyle=foreground;ctx.font=`650 ${title.size}px "Geist Variable", sans-serif`;
 title.lines.forEach((line,index)=>ctx.fillText(line,90,105+index*title.size*1.16));}
 if(video.affiliation){ctx.textBaseline='top';ctx.textAlign='left';ctx.fillStyle=social?'rgba(0,0,0,0.72)':dark?'#252525':'#fff';ctx.fillRect(0,height-170,width,170);const footer=fitted(ctx,video.affiliation,{size:26,width:900,maxLines:3,weight:500});ctx.fillStyle=foreground;ctx.font=`500 ${footer.size}px "Geist Variable", sans-serif`;footer.lines.forEach((line,index)=>ctx.fillText(line,90,height-150+index*34));}
}


export function drawSocialCaption(ctx,text,style,{fitted,width=1080,height=1920}){
 const snap=style==='snapchat',title=fitted(ctx,text,{size:snap?64:74,width:width-144,maxLines:5,weight:snap?450:800});
 if(!title.lines.length)return;
 const lineHeight=title.size*(snap?1.24:1.16),textHeight=title.lines.length*lineHeight,y=Math.max(180,height*0.32-textHeight/2);
 ctx.save();ctx.textAlign='center';ctx.textBaseline='top';ctx.font=`${snap?450:800} ${title.size}px "Geist Variable", sans-serif`;
 if(snap){ctx.fillStyle='rgba(0,0,0,0.72)';ctx.fillRect(0,y-28,width,textHeight+56);}
 else{ctx.strokeStyle='#171717';ctx.lineWidth=Math.max(5,title.size*0.10);ctx.lineJoin='round';ctx.shadowColor='rgba(0,0,0,0.30)';ctx.shadowBlur=7;ctx.shadowOffsetY=3;}
 ctx.fillStyle='#fff';title.lines.forEach((line,index)=>{const top=y+index*lineHeight;if(!snap)ctx.strokeText(line,width/2,top);ctx.fillText(line,width/2,top);});ctx.restore();
}
