import {assertFeature, planFor} from './plans.mjs';
import {accessContext, authorizeProduct} from './workspace.mjs';

const fail = message => { throw Object.assign(new Error(message), {status:400,code:'report_invalid'}); };
export function canonicalConversationKey(item) {
  try {
    const url = new URL(item.url);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return null;
    const parts = url.pathname.split('/').filter(Boolean), host = url.hostname.toLowerCase();
    if (/(^|\.)reddit\.com$/.test(host) && parts[0] === 'r' && parts[2] === 'comments' && /^[a-z0-9]+$/i.test(parts[3] || '')) return `reddit:${parts[5] ? `t1_${parts[5]}` : `t3_${parts[3]}`}`;
    if (/(^|\.)(x\.com|twitter\.com)$/.test(host) && /\/status\/\d+/.test(url.pathname)) return `x:${url.pathname.match(/\/status\/(\d+)/)[1]}`;
    if (/(^|\.)linkedin\.com$/.test(host)) { const id = url.pathname.match(/activity[-:](\d{10,20})/) || url.pathname.match(/-(\d{10,20})-/); if(id)return `linkedin:${id[1]}`; }
    if (/(^|\.)instagram\.com$/.test(host) && ['p','reel','reels','tv'].includes(parts[0]) && parts[1]) return item.type === 'comment' && item.sourceId ? `instagram-comment:${item.sourceId}` : `instagram:${parts[1]}`;
    if (/(^|\.)tiktok\.com$/.test(host) && /\/video\/(\d+)/.test(url.pathname)) return item.type === 'comment' && item.sourceId ? `tiktok-comment:${item.sourceId}` : `tiktok:${url.pathname.match(/\/video\/(\d+)/)[1]}`;
    if (host === 'news.ycombinator.com' && url.pathname === '/item' && /^\d+$/.test(url.searchParams.get('id') || '')) return `hn:${url.searchParams.get('id')}`;
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|ref|tracking)$/i.test(key)) url.searchParams.delete(key);
    url.hash = ''; return url.href;
  } catch { return null; }
}
export function attributedConversation(item, product, client) {
  return {conversationId:item.id,sourceKey:canonicalConversationKey(item),productId:product.id,product:product.name || '',clientId:product.clientId || null,client:client?.name || '',source:item.source || '',url:item.url || '',author:item.author || '',title:item.title || '',text:typeof item.snippet === 'string' ? item.snippet : typeof item.text === 'string' ? item.text : '',publishedAt:item.publishedAt || null,foundAt:item.foundAt || null,status:item.status || 'new'};
}
export function buildReport(data, principal, {productIds,clientId,from,to,dateField='publishedAt',now=Date.now()} = {}) {
  assertFeature(data,'reports',{now}); const plan = planFor(data), context = accessContext(data,principal,clientId === undefined ? {} : {clientId},plan);
  if (!['publishedAt','foundAt'].includes(dateField)) fail('Choose publication date or discovery date.');
  const start = Date.parse(from), end = Date.parse(to);
  if (typeof from !== 'string' || typeof to !== 'string' || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) fail('Choose a valid report date range.');
  if (productIds === undefined && clientId === undefined) fail('Choose products or a client for this report.');
  const ids = productIds ?? (data.products || []).filter(p => p.clientId === clientId && context.productIds.includes(p.id)).map(p => p.id);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) fail('Choose distinct product IDs.');
  const products = ids.map(id => authorizeProduct(data,principal,id,{},plan));
  if (clientId !== undefined && products.some(p => p.clientId !== clientId)) fail('Every selected product must belong to the selected client.');
  const byId = new Map(products.map(p => [p.id,p])), seen = new Set(), rows = []; let excludedUndated = 0, excludedInvalidSource = 0, duplicates = 0;
  for (const item of data.items || []) {
    const product = byId.get(item.productId); if(!product)continue;
    const at = Date.parse(item[dateField]); if(!Number.isFinite(at)) { excludedUndated++; continue; }
    if(at < start || at >= end)continue;
    const source = canonicalConversationKey(item); if(!source) { excludedInvalidSource++; continue; }
    const key = `${product.id}\n${source}`; if(seen.has(key)) { duplicates++; continue; } seen.add(key);
    rows.push(attributedConversation(item,product,data.workspace.clients[product.clientId]));
  }
  rows.sort((a,b) => Date.parse(a[dateField]) - Date.parse(b[dateField]) || String(a.conversationId).localeCompare(String(b.conversationId)));
  return {version:1,type:'conversation-report',workspaceId:context.workspaceId,generatedAt:new Date(now).toISOString(),scope:{productIds:ids,...(clientId === undefined ? {} : {clientId}),from:new Date(start).toISOString(),to:new Date(end).toISOString(),dateField,endExclusive:true},counts:{conversations:new Set(rows.map(row=>row.sourceKey)).size,productMatches:rows.length,authors:new Set(rows.filter(r=>r.author).map(r=>`${r.source.replace(/ comment$/i,'')}:${r.author}`)).size,sources:Object.fromEntries([...new Set(rows.map(r=>r.source))].map(source=>[source,new Set(rows.filter(row=>row.source===source).map(row=>row.sourceKey)).size])),excludedUndated,excludedInvalidSource,duplicates},rows};
}
const columns = ['conversationId','productId','product','clientId','client','source','url','author','title','text','publishedAt','foundAt','status'];
export function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Spreadsheet formula evaluation can ignore whitespace/control prefixes.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
export function reportCSV(report) { return [columns.map(csvCell).join(','),...report.rows.map(row=>columns.map(key=>csvCell(row[key])).join(','))].join('\r\n') + '\r\n'; }
export function reportJSON(report) { return JSON.stringify(report,null,2); }
