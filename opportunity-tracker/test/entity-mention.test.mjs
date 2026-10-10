import test from 'node:test';
import assert from 'node:assert/strict';
import {ENTITY_MATCH_VERSION,entityMentionEvidence,needsEntityReview,validEntityMatch} from '../entity-mention.mjs';
import {conversationSignals,ownsQuote} from '../conversation-purpose.mjs';
import {validateEntityMatch} from '../listening-qualification.mjs';
const cafe={name:'Wren Café',aliases:['Wren Cafe'],url:'https://www.wrencafe.ca/',businessProfileV2:{reviewed:true,constraints:[{quote:'at 280 Nelson Street in Yaletown, Vancouver, BC'}],offerings:[{quote:'sculpted mousse desserts'}]}};
const app={name:'Blind Box Tracker',aliases:['BlindBoxTracker'],url:'https://apps.apple.com/us/app/blind-box-tracker/id6742131820'};
const verdict=(overrides={})=>({version:ENTITY_MATCH_VERSION,status:'confirmed',basis:'business_context',reference:'Wren Cafe',quote:'Wren Cafe in Yaletown!',identityQuote:'Wren Cafe in Yaletown!',businessQuote:'Yaletown, Vancouver',contextSource:'own',reason:'The named cafe is in its reviewed location.',...overrides});
const projected=(source,entityMatch,product=cafe)=>entityMentionEvidence(product,source,{current:true,decision:{entityMatch,relevant:true,purposes:[]}});
test('official own references confirm creator or otherwise irrelevant posts without AI',()=>{
 for(const body of ['Visit https://www.wrencafe.ca/menu','wrencafe.ca is our website.'])assert.equal(entityMentionEvidence(cafe,{type:'comment',text:body}).basis,'identifier');
 const text='I made this app: https://apps.apple.com/ca/app/blind-box-tracker/id6742131820?uo=4';assert.equal(entityMentionEvidence(app,{text}).reference,'id6742131820');
 assert.equal(conversationSignals(app,{text},{relevant:false,purposes:[]},{current:true})[0].purpose,'mention');
});
test('spoofed hosts, credentials, URL paths and a different app cannot establish identity',()=>{
 for(const text of ['https://wrencafe.ca.evil.example','https://wrencafe.ca@evil.example','https://evil.example/path/wrencafe.ca','https://evil.example/?next=wrencafe.ca','https://wrencafe.ca:444/menu','https://fakewrencafe.ca'])assert.equal(entityMentionEvidence(cafe,{text}),null,text);
 for(const text of ['https://apps.apple.com/us/app/other/id6742131821','https://apps.apple.com.evil.example/app/id6742131820','https://evil.example/apps.apple.com/app/id6742131820'])assert.equal(entityMentionEvidence(app,{text}),null,text);
});
test('old AI purpose labels and broad generic names do not establish identity',()=>{
 for(const text of ['Wren Cafe is nice.','Wren Cafe in London.'])assert.equal(entityMentionEvidence(cafe,{text},{current:true,decision:{relevant:true,purposes:[{purpose:'mention',quote:text,reference:'Wren Cafe'}]}}),null);
 assert.equal(entityMentionEvidence(app,{text:'I made a blind box tracker spreadsheet.'},{current:true,decision:{relevant:true}}),null);
});
test('current structured business context confirms precise local identity and rejects invented evidence',()=>{
 const row={type:'comment',text:'Wren Cafe in Yaletown!'};assert.equal(projected(row,verdict()).basis,'business_context');
 assert.equal(projected(row,verdict({identityQuote:'Wren Cafe in London!'})),null);
 assert.equal(projected(row,verdict({businessQuote:'Yaletown cafe is world famous'})),null);
 assert.equal(entityMentionEvidence(cafe,row,{current:false,decision:{entityMatch:verdict()}}),null);
 assert.throws(()=>validateEntityMatch({...verdict(),businessQuote:'Invented Vancouver fact'},cafe,row),/corroborating/);
});
test('a bound parent can disambiguate a named reply but cannot supply its mention or override a wrong city',()=>{
 const row={type:'comment',text:'Wren Cafe!',context:'Cafes in Yaletown, Vancouver',threadId:'reddit:abc'};
 const q=verdict({quote:'Wren Cafe!',identityQuote:'Yaletown, Vancouver',contextSource:'parent'});
 assert(projected(row,q));assert.equal(projected({...row,text:'Thanks!',title:'Wren Cafe!'},q),null);assert.equal(ownsQuote({...row,text:'Thanks!',title:'Wren Cafe!'},'Wren Cafe!'),false);
 assert.equal(projected({...row,text:'Wren Cafe in London!'}, {...q,quote:'Wren Cafe in London!'}),null);
 assert.equal(projected({...row,threadId:undefined},q),null);
});
test('uncertain and different verdicts finish a targeted review without affirming the entity',()=>{
 const source={text:'Wren Cafe is nice.'};assert.equal(needsEntityReview(cafe,{...source,qualification:{relevant:true,purposes:[]}}),true);
 for(const status of ['uncertain','different']){const q={version:ENTITY_MATCH_VERSION,status,basis:'none',reference:'',quote:'',identityQuote:'',businessQuote:'',contextSource:'none',reason:'Not enough identifying context.'};assert(validEntityMatch(cafe,source,q));assert.equal(projected(source,q),null);assert.equal(needsEntityReview(cafe,{...source,qualification:{entityMatch:q}}),false);}
 assert.equal(needsEntityReview(cafe,{text:'https://wrencafe.ca',qualification:{}}),false);
});
test('generic words are not corroborating identity facts',()=>{
 const p={...app,businessProfileV2:{reviewed:true,offerings:[{quote:'A free app for tracking a blind box collection'}],constraints:[]}};
 const source={text:'I made a free blind box tracker app.'};const q=verdict({reference:'blind box tracker',quote:source.text,identityQuote:source.text,businessQuote:'A free app for tracking a blind box collection'});
 assert.equal(projected(source,q,p),null);
});

test('only named cached conversations lacking identity verdict join the targeted queue; prior purposes survive',async()=>{
 const {captureEvidence,pendingEvidenceAll,qualificationInputHash,saveConversationReview}=await import('../conversation-evidence.mjs');
 const product={...cafe,id:'cafe',listeningVersion:'v2',searchPlanV2:{themes:[]}},data={subscription:{planId:'growth'},products:[product],items:[]};
 const at='2026-10-09T17:00:00.000Z';
 const rows=['Wren Cafe is nice.','Generic lunch advice.','Visit https://wrencafe.ca/menu'].map((text,i)=>({source:'Reddit',type:'post',title:'Discussion',snippet:text,url:`https://www.reddit.com/r/vancouver/comments/target${i}/`,publishedAt:at,queryFamily:'long_tail'}));
 captureEvidence(data,product,rows,at);
 for(const row of data.conversationEvidence.cafe)row.qualification={profileHash:qualificationInputHash(product),relevant:true,directFit:false,offeringIds:[],reason:'Prior review',purposes:[{purpose:'feedback',quote:row.text,reason:'Prior feedback',offeringIds:['o1']}]};
 const before=structuredClone(data.conversationEvidence.cafe.map(row=>row.qualification));
 const pending=pendingEvidenceAll(data,product);assert.equal(pending.length,1);assert.equal(pending[0].text,'Wren Cafe is nice.');assert.deepEqual(data.conversationEvidence.cafe.map(row=>row.qualification),before);
 const row=pending[0],entityMatch={version:ENTITY_MATCH_VERSION,status:'uncertain',basis:'none',reference:'',quote:'',identityQuote:'',businessQuote:'',contextSource:'none',reason:'No distinguishing context.'};
 saveConversationReview(data,product,row,{...row.qualification,entityMatch},at,'fixture');assert.equal(pendingEvidenceAll(data,product).length,0);
});

test('exact standalone App Store identifier confirms, but the same token in a wrong URL does not',()=>{
 assert.equal(entityMentionEvidence(app,{text:'App Store: id6742131820.'}).basis,'identifier');
 for(const text of ['id67421318201','xid6742131820','https://evil.example/id6742131820','https://evil.example/?app=id6742131820'])assert.equal(entityMentionEvidence(app,{text}),null,text);
});
test('coffee vocabulary and iPhone alone are insufficient corroborating identity',()=>{
 const row={text:'Wren Cafe sells coffee.'};const q=verdict({quote:row.text,identityQuote:row.text,businessQuote:'We sell coffee.'});
 const p={...cafe,businessProfileV2:{...cafe.businessProfileV2,offerings:[{quote:'We sell coffee.'}]}};assert.equal(projected(row,q,p),null);
 const phone={...app,businessProfileV2:{reviewed:true,offerings:[{quote:'A blind box tracker for iPhone'}],constraints:[]}},source={text:'My blind box tracker spreadsheet works on iPhone.'};assert.equal(projected(source,verdict({reference:'blind box tracker',quote:source.text,identityQuote:source.text,businessQuote:'A blind box tracker for iPhone'}),phone),null);
});
test('evicted saved mentions are bounded read-only review candidates with historical provenance unchanged',async()=>{
 const {savedItemIdentityEvidence,pendingEvidenceAll,findEvidence,qualificationInputHash}=await import('../conversation-evidence.mjs');
 const product={...cafe,id:'cafe',listeningVersion:'v2',searchPlanV2:{themes:[]}},q={profileHash:qualificationInputHash(product),relevant:true,purposes:[]};
 const data={products:[product],items:Array.from({length:30},(_,i)=>({id:`item${i}`,productId:'cafe',url:`https://www.reddit.com/r/vancouver/comments/old${i}/`,type:'post',title:'Discussion',snippet:'Wren Cafe in Yaletown!',context:'',queryFamilies:['long_tail'],qualification:q,status:'saved',note:'Keep this',historical:true,foundAt:'2026-10-08T00:00:00.000Z'})),subscription:{planId:'growth'}};
 const before=structuredClone(data);const candidates=savedItemIdentityEvidence(data,product);assert.equal(candidates.length,24);assert.equal(pendingEvidenceAll(data,product).length,24);assert.equal(findEvidence(data,product,candidates[0].id).savedItemIdentityReview,true);assert.equal(candidates[0].historical,true);assert.equal(candidates[0].backfillId,undefined);assert.deepEqual(data,before);
});

test('legacy search references remain hash-compatible while identity uses exact shared-host targets',async()=>{
 const {businessReferences}=await import('../entity-mention.mjs');
 const p={name:'Example',url:'https://play.google.com/store/apps/details?id=com.example.app'};
 assert.deepEqual(businessReferences(p),['Example','play.google.com']);assert.equal(entityMentionEvidence(p,{text:'https://play.google.com/store/apps/details?id=com.other.app'}),null);assert.equal(entityMentionEvidence(p,{text:p.url}).reference,'com.example.app');
 const social={name:'Example',url:'https://x.com/example'};assert.deepEqual(businessReferences(social),['Example','x.com']);assert.equal(entityMentionEvidence(social,{text:'https://x.com/another'}),null);assert.equal(entityMentionEvidence(social,{text:social.url}).reference,'@example');
});
test('recapture preserves allowance adoption only from unchanged trusted prior content',async()=>{
 const {captureEvidence}=await import('../conversation-evidence.mjs');const product={...cafe,id:'cafe',listeningVersion:'v2'},data={products:[product],items:[],subscription:{planId:'growth'}};
 const row={source:'Reddit',url:'https://www.reddit.com/r/vancouver/comments/adopt/',title:'Wren Cafe',snippet:'Yaletown',historicalAllowanceBackfillId:'forged',allowanceAttribution:{kind:'forged'}};
 captureEvidence(data,product,[row],'2026-10-09T17:00:00.000Z');let saved=data.conversationEvidence.cafe[0];assert.equal(saved.historicalAllowanceBackfillId,undefined);
 saved.historicalAllowanceBackfillId='trusted-run';saved.allowanceAttribution={kind:'saved-archive-adoption'};captureEvidence(data,product,[row],'2026-10-09T17:01:00.000Z');saved=data.conversationEvidence.cafe[0];assert.equal(saved.historicalAllowanceBackfillId,'trusted-run');assert.equal(saved.allowanceAttribution.kind,'saved-archive-adoption');
 captureEvidence(data,product,[{...row,snippet:'Changed source'}],'2026-10-09T17:02:00.000Z');assert.equal(data.conversationEvidence.cafe[0].historicalAllowanceBackfillId,undefined);
});
