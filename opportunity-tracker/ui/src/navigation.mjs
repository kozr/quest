import {normalizePurposes,purposes} from './purposes.mjs';

export const workspaceViews={...Object.fromEntries(purposes.map(p=>[p.id,p.label])),actions:'Actions',replies:'Auto-draft replies',content:'Videos & captions',settings:'Settings'};

export function resolveWorkspaceRoute(hash,enabled,last){
 const selected=normalizePurposes(enabled),home=selected.includes(last)?last:selected[0];
 const [requested,detail]=(hash||'').replace(/^#/,'').split('/');
 if(requested==='products')return 'settings';
 if(requested==='listening')return 'settings/monitoring';
 if(requested==='insights')return `${selected.includes('feedback')?'feedback':home}/patterns`;
 if(requested==='research'){
  const target=home!=='mentions'?home:selected.find(id=>id!=='mentions');
  return target?`${target}/explore`:home;
 }
 if(purposes.some(p=>p.id===requested)){
  if(!selected.includes(requested))return home;
  return detail==='patterns'||detail==='explore'&&requested!=='mentions'?`${requested}/${detail}`:requested;
 }
 if(requested==='settings')return detail==='monitoring'?'settings/monitoring':'settings';
 return Object.hasOwn(workspaceViews,requested)?requested:home;
}
