/** Only OP image attachments from the collector are eligible, never comment
 * images, avatars, link thumbnails, or arbitrary URLs supplied in post text. */
export const MAX_POST_IMAGES=2;
// Conservative reservation allowance, not an estimate of actual image tokens.
// The API's total input usage settles the charge, under the existing spend caps.
export const IMAGE_INPUT_TOKEN_ALLOWANCE=40_000;
const imageHosts=new Set(['i.redd.it','preview.redd.it','i.imgur.com']);
export function normalizedPostImages(value:unknown):string[] {
  if(!Array.isArray(value)) return [];
  const result:string[]=[];
  for(const raw of value.slice(0,40)) {
    if(typeof raw!=='string'||raw.length>2048) continue;
    try {
      const url=new URL(raw.replace(/&amp;/g,'&'));
      if(url.protocol!=='https:'||url.username||url.password||url.port||!imageHosts.has(url.hostname)||!/^\/[a-zA-Z0-9_\-/%.]+\.(png|jpe?g|webp)$/i.test(url.pathname)) continue;
      url.hash='';
      if(!result.includes(url.href)) result.push(url.href);
      if(result.length===MAX_POST_IMAGES) break;
    } catch { /* Ignore malformed collector media. */ }
  }
  return result;
}
export function extractPostImages(row:Record<string,unknown>):string[] {
  if(row.isVideo===true||row.postType==='video'||row.mediaType==='video') return [];
  if(row.postType==='link'||row.mediaType==='link') return [];
  const assets=Array.isArray(row.mediaAssets)?row.mediaAssets.slice(0,40).flatMap(asset=>{
    if(!asset||typeof asset!=='object') return [];
    const {mimeType,url}=asset as Record<string,unknown>;
    return typeof mimeType==='string'&&/^image\/(png|jpeg|webp)$/i.test(mimeType)?[url]:[];
  }):[];
  // Prefer full-size gallery assets; do not pay for the same photo's preview too.
  for(const urls of [assets,row.galleryImages]) {
    const images=normalizedPostImages(urls);if(images.length) return images;
  }
  if(row.postType==='image'||row.mediaType==='image') {
    const direct=normalizedPostImages([row.contentUrl,row.urlOverriddenByDest]);
    if(direct.length) return direct;
  }
  return normalizedPostImages(row.images);
}
