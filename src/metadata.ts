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

export async function searchApps(term: string) {
  const query=term.trim();
  if (query.length<2 || query.length>100) throw new Error('Enter an app title between 2 and 100 characters.');
  const url=new URL('https://itunes.apple.com/search');
  url.search=new URLSearchParams({term:query,entity:'software',media:'software',country:'us',limit:'10'}).toString();
  const response=await fetch(url,{signal:AbortSignal.timeout(8000),redirect:'error',headers:{Accept:'application/json'}});
  if (!response.ok) throw new Error('App Store search is unavailable. Try again or enter your app details manually.');
  const body=await response.text();
  if (body.length>1024*1024) throw new Error('App Store search returned too much data. Try a more specific title.');
  const data=JSON.parse(body) as {results?: unknown};
  if (!Array.isArray(data.results)) throw new Error('App Store search returned an unexpected response. Try again.');
  const seen=new Set<string>();
  return data.results.flatMap((item: unknown)=>{
    if (!item || typeof item!=='object') return [];
    const app=item as Record<string,unknown>;
    const appleId=String(app.trackId);
    if (!/^[1-9]\d{0,14}$/.test(appleId) || typeof app.trackName!=='string' || !app.trackName.trim() ||
      typeof app.bundleId!=='string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(app.bundleId) || seen.has(appleId)) return [];
    seen.add(appleId);
    return [{name:app.trackName,bundleId:app.bundleId,appleId,
      developer:typeof app.artistName==='string' ? app.artistName : typeof app.sellerName==='string' ? app.sellerName : '',
      iconUrl:safeIconUrl(String(app.artworkUrl100 ?? app.artworkUrl512 ?? '')),
      appStoreUrl:`https://apps.apple.com/us/app/id${appleId}`}];
  }).slice(0,10);
}

/** Fixed-host App Store description lookup for server-side lead setup. */
export async function lookupAppDescription(appleId:string,country='us',request:typeof fetch=fetch) {
  if(!/^[1-9]\d{0,14}$/.test(appleId)||!/^[a-z]{2}$/i.test(country)) throw new Error('A connected app needs a valid Apple ID and storefront.');
  const storefront=country.toLowerCase();
  const url=new URL('https://itunes.apple.com/lookup');
  url.search=new URLSearchParams({id:appleId,entity:'software',country:storefront}).toString();
  const response=await request(url,{signal:AbortSignal.timeout(8000),redirect:'error',headers:{Accept:'application/json'}});
  if(!response.ok) throw new Error('Apple lookup is unavailable.');
  const body=await response.text();if(body.length>1024*1024) throw new Error('Apple lookup returned too much data.');
  const data=JSON.parse(body) as {results?:Array<Record<string,unknown>>};
  const app=data.results?.find(row=>String(row.trackId)===appleId&&typeof row.bundleId==='string');
  if(!app||typeof app.description!=='string') return null;
  const description=app.description.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,' ').replace(/\s+/g,' ').trim().slice(0,12000);
  if(!description) return null;
  return {appleId,country:storefront,description,appName:typeof app.trackName==='string'?app.trackName:'',bundleId:String(app.bundleId),fetchedAt:new Date().toISOString(),
    appStoreUrl:`https://apps.apple.com/${storefront}/app/id${appleId}`};
}
