import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyResearchProspects,searchResearchProspects,type ProspectCandidate} from '../src/market-prospects.js';
const capability='70000000-0000-4000-8000-000000000001';
const candidate:ProspectCandidate={sourceUrl:'https://www.reddit.com/r/coffee/comments/abc123/title/',relationship:'potential_user',problem:'Logging caffeine takes too much effort',fitReason:'The app supports quick caffeine logging',excerpt:'I need faster caffeine logging',matchedCapabilityIds:[capability]};
const mock=(body:unknown,urls:string[]=[])=>((async(url:any,init:any)=>{urls.push(url);assert.equal(init.redirect,'error');return new Response(JSON.stringify(body));}) as typeof fetch);
const reddit=[{data:{children:[{kind:'t3',data:{id:'abc123',author:'coffee_person',title:'Logging coffee',selftext:'I need faster caffeine logging every morning.',created_utc:1700000000}}]}}];
test('creates review-only records from platform-verified author and exact public excerpt, deduplicated by author',async()=>{
 const urls:string[]=[];const rows=await verifyResearchProspects([candidate,candidate],[capability],mock(reddit,urls),new Date('2026-09-25T08:00:00Z'));
 assert.equal(rows.length,1);assert.equal(rows[0]!.publicHandle,'coffee_person');assert.equal(rows[0]!.status,'needs_review');assert.equal(rows[0]!.evidence.length,1);assert.equal(rows[0]!.evidence[0]!.publishedAt,'2023-11-14T22:13:20.000Z');assert.match(urls[0]!,/^https:\/\/www.reddit.com\//);
});
test('rejects fabricated excerpts, deleted authors, unrelated capabilities and arbitrary hosts',async()=>{
 assert.deepEqual(await verifyResearchProspects([{...candidate,excerpt:'This is a fabricated quotation'}],[capability],mock(reddit)),[]);
 assert.deepEqual(await verifyResearchProspects([candidate],[],mock(reddit)),[]);
 const deleted=structuredClone(reddit);deleted[0]!.data.children[0]!.data.author='[deleted]';assert.deepEqual(await verifyResearchProspects([candidate],[capability],mock(deleted)),[]);
 let called=false;assert.deepEqual(await verifyResearchProspects([{...candidate,sourceUrl:'https://127.0.0.1/private'}],[capability],(async()=>{called=true;throw Error();}) as typeof fetch),[]);assert.equal(called,false);
});
test('YouTube verifies video and channel metadata but never classifies it as personal need',async()=>{
 const video={...candidate,sourceUrl:'https://www.youtube.com/watch?v=abcdefghijk',relationship:'creator_partner' as const,excerpt:'Tracking caffeine and sleep'};
 const response={author_name:'Coffee Channel',author_url:'https://www.youtube.com/@CoffeeChannel',title:'Tracking caffeine and sleep: my workflow'};
 const rows=await verifyResearchProspects([video],[capability],mock(response));assert.equal(rows.length,1);assert.equal(rows[0]!.provider,'youtube');assert.equal(rows[0]!.evidence[0]!.verification,'video_metadata');assert.equal(rows[0]!.evidence[0]!.publishedAt,null);
 assert.deepEqual(await verifyResearchProspects([{...video,relationship:'potential_user'}],[capability],mock(response)),[]);
 assert.deepEqual(await verifyResearchProspects([{...video,excerpt:'A claim allegedly spoken in the video'}],[capability],mock(response)),[]);
 assert.deepEqual(await verifyResearchProspects([video],[capability],mock({...response,author_url:'https://evil.example/@CoffeeChannel'})),[]);
});
test('X verifies attribution through the public embed and refuses mismatched authors',async()=>{
 const post={...candidate,sourceUrl:'https://x.com/coffee_person/status/123456789'};
 const embed={author_name:'Coffee Person',author_url:'https://twitter.com/coffee_person',html:'<blockquote><p>I need faster caffeine logging every morning.</p></blockquote>'};
 const rows=await verifyResearchProspects([post],[capability],mock(embed));assert.equal(rows.length,1);assert.equal(rows[0]!.provider,'x');
 assert.deepEqual(await verifyResearchProspects([post],[capability],mock({...embed,author_url:'https://twitter.com/other_person'})),[]);
});
test('unavailable or redirected public content creates no prospect instead of inventing an identity',async()=>{
 assert.deepEqual(await verifyResearchProspects([candidate],[capability],(async()=>new Response('',{status:403})) as typeof fetch),[]);
 assert.deepEqual(await verifyResearchProspects([candidate],[capability],(async()=>{throw new Error('redirect blocked');}) as typeof fetch),[]);
});

test('searched YouTube metadata can independently create a creator candidate for a clear capability overlap',async()=>{
 const {discoverVideoProspects}=await import('../src/market-prospects.js');
 const metadata={author_name:'Coffee Channel',author_url:'https://www.youtube.com/@CoffeeChannel',title:'How caffeine affects sleep'};
 const caps=[{id:capability,text:'Understand caffeine effects on sleep'}];
 const results=await discoverVideoProspects(['https://youtu.be/abcdefghijk'],caps,mock(metadata));assert.equal(results.length,1);assert.equal(results[0]!.relationship,'creator_partner');assert.equal(results[0]!.evidence[0]!.excerpt,metadata.title);
 assert.deepEqual(await discoverVideoProspects(['https://youtu.be/abcdefghijk'],[{id:capability,text:'Track owned toy collectibles'}],mock(metadata)),[]);
});

test('web search discovery retains supported authors and preserves unknown identity',()=>{
 const identified=searchResearchProspects([{...candidate,publicHandle:'coffee_person',displayName:'coffee_person'}],[capability]);
 assert.equal(identified[0]?.publicHandle,'coffee_person');
 assert.equal(identified[0]?.evidence[0]?.verification,'web_search');
 assert.equal(identified[0]?.profileUrl,'https://www.reddit.com/user/coffee_person/');
 const unknown=searchResearchProspects([candidate],[capability]);
 assert.equal(unknown[0]?.displayName,'Author not identified');assert.equal(unknown[0]?.profileUrl,'');
 assert.deepEqual(searchResearchProspects([candidate],[]),[]);
 assert.deepEqual(searchResearchProspects([{...candidate,sourceUrl:'https://unrelated.example/post'}],[capability]),[]);
});

test('problem matches require named source evidence and retain later resolution when deduplicating',()=>{
 const first:ProspectCandidate={...candidate,publicHandle:'Coffee_Person',sourceEvidence:'Coffee_Person: I need faster caffeine logging',matchType:'exact',needStatus:'unresolved_at_posting'};
 const later:ProspectCandidate={...first,publicHandle:'coffee_person',sourceUrl:'https://www.reddit.com/r/coffee/comments/abc123/comment/def456/',sourceEvidence:'coffee_person: I found a solution that works',excerpt:'I found a solution that works',needStatus:'subsequently_resolved',fitReason:'The author later confirmed a solution.'};
 const rows=searchResearchProspects([first,later],[capability]);
 assert.equal(rows.length,1);assert.equal(rows[0]?.evidence.length,2);
 assert.equal(rows[0]?.needStatus,'subsequently_resolved');assert.equal(rows[0]?.fitReason,later.fitReason);
 assert.equal(searchResearchProspects([{...first,matchedCapabilityIds:[]}],[]).length,1);
 for(const changed of [{publicHandle:null},{publicHandle:'AutoModerator'},{excerpt:'This quote was never in the source'},
  {sourceEvidence:'Mentioned coffee_person_else: I need faster caffeine logging'},
  {sourceUrl:'https://www.youtube.com/watch?v=abcdefghijk',relationship:'creator_partner' as const}]){
  assert.deepEqual(searchResearchProspects([{...first,...changed}],[capability]),[]);
 }
});
