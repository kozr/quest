import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import https from 'node:https';
import http from 'node:http';

const blocked4 = new BlockList();
const blocked6 = new BlockList();
// Keep the lists separate: Node checks IPv4 addresses as IPv4-mapped IPv6,
// so putting the mapped-IPv6 block in the IPv4 list rejects every public IPv4.
for (const [base, size] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked4.addSubnet(base, size, 'ipv4');
for (const [base, size] of [['::',96],['::ffff:0:0',96],['100::',64],['2001:db8::',32],['fc00::',7],['fe80::',10],['ff00::',8]]) blocked6.addSubnet(base, size, 'ipv6');
export function isPrivateAddress(address, family=isIP(address)) { return family===4 ? blocked4.check(address,'ipv4') : family===6 ? blocked6.check(address,'ipv6') : true; }

export function publicUrl(value) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`); } catch { throw new Error('Enter a valid website or App Store URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host) || host.endsWith('.local') || (isIP(host) && isPrivateAddress(host))) throw new Error('Use a public website URL without credentials or a custom port.');
  url.hash = '';
  return url;
}

export async function fetchPublicText(value, redirects = 0) {
  const url = publicUrl(String(value));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let lookupTimer;
  const addresses = await Promise.race([lookup(host, { all: true }),new Promise((_resolve,reject)=>{lookupTimer=setTimeout(()=>reject(new Error('The website could not be reached in time. Enter its details manually.')),10000);})]).finally(()=>clearTimeout(lookupTimer));
  if (!addresses.length || addresses.some(a => isPrivateAddress(a.address,a.family))) throw new Error('This address does not resolve to a public website.');
  const chosen = addresses.find(a=>a.family===4) || addresses[0];
  const response = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      timeout: 10000,
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'ProductMentionTracker/1.0 (personal metadata lookup)', Accept: 'text/html,application/json', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) { res.resume(); resolve({ redirect: new URL(res.headers.location, url).href }); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`The website returned HTTP ${res.statusCode}. You can enter its details manually.`)); return; }
      const chunks = []; let length = 0;
      res.on('data', chunk => { length += chunk.length; if (length > 1_500_000) { res.destroy(); reject(new Error('The page is too large to import. Enter the details manually.')); } else chunks.push(chunk); });
      res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), url: url.href }));
      res.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('The website took too long to respond. Enter its details manually.')));
    request.on('error', reject);
  });
  if (response.redirect) {
    if (redirects >= 3) throw new Error('Too many redirects. Enter the product details manually.');
    return fetchPublicText(response.redirect, redirects + 1);
  }
  return response;
}

export function plainText(value) {
  return String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&nbsp;/gi,' ').replace(/&#(\d+);/g,(_,n)=>Number(n)<=0x10ffff ? String.fromCodePoint(Number(n)) : '').replace(/\s+/g,' ').trim();
}

export function htmlMetadata(html, url) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
    if (attrs.name || attrs.property) meta[(attrs.name || attrs.property).toLowerCase()] = attrs.content;
  }
  return { name: plainText(meta['og:site_name'] || meta['og:title'] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || new URL(url).hostname).slice(0,120), description: plainText(meta.description || meta['og:description'] || '').slice(0,3000), url, type: 'website' };
}

export async function importMetadata(input) {
  const url = publicUrl(input);
  if (url.hostname === 'apps.apple.com') {
    const id = url.pathname.match(/\/id(\d+)/)?.[1];
    if (!id) throw new Error('Use an App Store link with an app ID, or enter the details manually.');
    const country = url.pathname.match(/^\/([a-z]{2})\//)?.[1] || 'us';
    const result = await fetchPublicText(`https://itunes.apple.com/lookup?id=${id}&country=${country}`);
    const app = JSON.parse(result.text).results?.[0];
    if (!app?.trackName) throw new Error('This app was not found in that App Store. Enter its details manually.');
    return { name: app.trackName.slice(0,120), description: plainText(app.description).slice(0,3000), url: app.trackViewUrl || url.href, type: 'app_store' };
  }
  const page = await fetchPublicText(url.href);
  return htmlMetadata(page.text, page.url);
}
