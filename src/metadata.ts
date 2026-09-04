export function parseAppReference(input: string): { appleId: string; country: string } {
  if (/^\d{1,15}$/.test(input.trim())) return {appleId:input.trim(),country:'us'};
  let url: URL;
  try {url=new URL(input);} catch {throw new Error('Paste a public App Store link, an App Store Connect app link, or its numeric Apple ID.');}
  if (url.protocol!=='https:' || url.username || url.password || url.port || !['apps.apple.com','appstoreconnect.apple.com'].includes(url.hostname)) {
    throw new Error('Use an HTTPS link from apps.apple.com or appstoreconnect.apple.com.');
  }
  const match=url.hostname==='apps.apple.com' ? url.pathname.match(/\/id(\d{1,15})(?:\/|$)/) : url.pathname.match(/\/apps\/(\d{1,15})(?:\/|$)/);
  if (!match) throw new Error('This link does not contain an app ID. You can enter the app details manually.');
  return {appleId:match[1],country:url.hostname==='apps.apple.com' && /^\/[a-z]{2}\//i.test(url.pathname) ? url.pathname.slice(1,3).toLowerCase() : 'us'};
}
export function safeIconUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {const url=new URL(value); return url.protocol==='https:' && !url.username && !url.password && !url.port &&
    (url.hostname==='mzstatic.com' || url.hostname.endsWith('.mzstatic.com')) ? url.toString() : null;} catch {return null;}
}
export async function lookupApp(input: string) {
  const {appleId,country}=parseAppReference(input);
  const url=new URL('https://itunes.apple.com/lookup');
  url.search=new URLSearchParams({id:appleId,entity:'software',country}).toString();
  const response=await fetch(url,{signal:AbortSignal.timeout(8000),redirect:'error',headers:{Accept:'application/json'}});
  if (!response.ok) throw new Error('Apple lookup is unavailable. Enter your app details manually.');
  const body=await response.text();
  if (body.length>1024*1024) throw new Error('Apple lookup returned too much data. Enter app details manually.');
  const data=JSON.parse(body) as {results?: Array<Record<string,unknown>>};
  const app=data.results?.find(item=>String(item.trackId)===appleId && typeof item.bundleId==='string');
  if (!app || typeof app.trackName!=='string') throw new Error('No public app was found in that storefront. Enter the name, Apple ID, and bundle ID manually.');
  return {name:app.trackName,bundleId:String(app.bundleId),appleId,iconUrl:safeIconUrl(String(app.artworkUrl512 ?? app.artworkUrl100 ?? '')),
    appStoreUrl:`https://apps.apple.com/${country}/app/id${appleId}`};
}
