import {matchesConversation} from './feed.mjs';

export function feedProgress(state,products,now=Date.now()){
 const ids=new Set(products.map(p=>p.id)),progress=products.map(p=>state.discovery?.[p.id]).filter(Boolean);
 const phase=progress.some(p=>p.phase==='finding')?'finding':progress.some(p=>p.phase==='paused')?'paused':'idle';
 const ready=state.items.filter(i=>ids.has(i.productId)&&matchesConversation(i)).length;
 const updatedAt=progress.map(p=>p.updatedAt).filter(Boolean).sort().at(-1);
 let message;
 if(phase==='finding')message=ready?`${ready} ${ready===1?'conversation':'conversations'} ready to review · Finding more conversations…`:'Finding conversations…';
 else if(phase==='paused')message=progress.some(p=>p.reason==='allowance')?'Updates paused until tomorrow.':'Updates paused. Check your setup in Listening.';
 else if(updatedAt)message=now-Date.parse(updatedAt)<60000?'Updated just now.':`Updated ${new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(updatedAt))}.`;
 else message='Ready to find conversations.';
 return {phase,ready,message,partial:progress.some(p=>p.partial)};
}
