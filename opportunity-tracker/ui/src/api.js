let token='';
export function setToken(value){token=value||'';}
export async function api(path,{method='GET',body,headers={},...options}={}) {
  const response=await fetch('/api'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Tracker-Token':token,...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),...options});
  if(response.status===401&&!['/auth','/login/google'].includes(path))window.dispatchEvent(new Event('tracker:unauthorized'));
  const data=await response.json().catch(()=>({error:'The server could not complete this request. Try again.'}));
  if(!response.ok)throw new Error(data.error||'The request failed. Try again.');
  return data;
}
export const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Date unavailable';
export const platform=item=>item.source?.startsWith('Reddit')?'reddit':item.source==='X'?'x':item.source==='LinkedIn'?'linkedin':item.source?.startsWith('Instagram')?'instagram':item.source?.startsWith('TikTok')?'tiktok':item.source==='Google Maps review'||item.source==='App Store review'?'reviews':item.source==='Web'?'web':'other';
export function sourceLabel(item){try{const m=new URL(item.url).pathname.match(/^\/r\/([^/]+)/);if(m)return `r/${m[1]}${item.type==='comment'?' · comment':''}`;}catch{}return item.source||'Source';}
export function safeURL(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:undefined;}catch{return undefined;}}
export const lines=value=>value.split('\n').map(s=>s.trim()).filter(Boolean);
