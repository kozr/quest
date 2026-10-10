import {normalizeCaptionStyle} from '../../caption-styles.mjs';
const memory=new Map();
export const templateDraftKey=scope=>`hearwhispers-ready-template:v1:${scope}`;
export function normalizeTemplateDraft(value,templates){
 return {templateId:templates.some(row=>row.id===value?.templateId)?value.templateId:templates[0]?.id||'',headline:typeof value?.headline==='string'?value.headline.slice(0,240):'',caption:typeof value?.caption==='string'?value.caption.slice(0,2200):'',captionStyle:normalizeCaptionStyle(value?.captionStyle)};
}
export function readTemplateDraft(scope,templates,storage){
 try{return normalizeTemplateDraft(memory.get(scope)||JSON.parse((storage||globalThis.localStorage)?.getItem(templateDraftKey(scope))||'null'),templates);}
 catch{return normalizeTemplateDraft(memory.get(scope),templates);}
}
export function writeTemplateDraft(scope,draft,storage){
 const value={templateId:draft.templateId,headline:draft.headline.slice(0,240),caption:draft.caption.slice(0,2200),captionStyle:normalizeCaptionStyle(draft.captionStyle)};memory.set(scope,value);
 try{(storage||globalThis.localStorage).setItem(templateDraftKey(scope),JSON.stringify(value));return true;}catch{return false;}
}
