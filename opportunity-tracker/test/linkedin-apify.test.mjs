import test from 'node:test';
import assert from 'node:assert/strict';
import {ApifyLinkedInAdapter,normalizeApifyLinkedInPost,LINKEDIN_ACTOR} from '../linkedin/apify.mjs';
import {createLinkedInAdapter,linkedinConfigured} from '../linkedin/adapter.mjs';
import {discover} from '../discovery.mjs';
import {canonicalPost} from '../qualification.mjs';

const now = Date.parse('2026-10-06T12:00:00Z');
const id = '7507254982996332545';
const post = (overrides = {}) => ({type:'post',id,linkedinUrl:`https://www.linkedin.com/posts/demo-person_product-tracking-activity-${id}-AbCd?tracking=remove`,
  content:'I need subscription reminders. My calendar is hard to manage.',
  author:{name:'Demo Person',linkedinUrl:'https://www.linkedin.com/in/demo-person?miniProfileUrn=remove'},
  postedAt:{timestamp:now-3600_000,date:new Date(now-3600_000).toISOString()},...overrides});
const run = (status = 'SUCCEEDED',overrides = {}) => ({data:{id:'Run123',defaultDatasetId:'Dataset123',status,usageTotalUsd:0.06,...overrides}});
const product = {id:'fixture',name:'QuietBoard',description:'Track subscriptions and renewal reminders.',url:'https://quietboard.dev',
  keywords:['subscription reminders'],aliases:['QuietBoard'],communities:[],linkedin:true,monitoring:true};
function client({items = [post()],status = 'SUCCEEDED',...options} = {}) {
  const calls = [];
  const adapter = new ApifyLinkedInAdapter({token:'private-test-token',now:() => now,fetchImpl:async (value,config) => {
    const url = new URL(value); calls.push({url,config});
    return Response.json(url.pathname.endsWith('/items') ? items : run(status));
  },...options});
  return {adapter,calls};
}

test('structured post attribution preserves original text, ID, date, canonical URL and qualification identity', () => {
  const row = normalizeApifyLinkedInPost({...post(),repostedPost:{content:'A different author needs something else.'}},new Date(now).toISOString());
  assert.equal(row.author,'Demo Person');assert.equal(row.snippet,post().content);
  assert.equal(row.sourceId,`li_${id}`);assert.equal(row.postId,id);assert.equal(row.provider,'linkedin-apify');
  assert.equal(row.publishedAt,new Date(now-3600_000).toISOString());assert(!row.url.includes('?'));
  assert.equal(canonicalPost(row).identity,`linkedin:${id}`);
  assert.equal(normalizeApifyLinkedInPost({...post(),postedAt:undefined},new Date(now).toISOString()).publishedAt,null);
  const underscore = post({linkedinUrl:`https://www.linkedin.com/posts/demo-person_product_tracking-activity-${id}-AbCd`});
  assert(normalizeApifyLinkedInPost(underscore,new Date(now).toISOString()));
});

test('unattributed, contradictory, foreign and unsupported records cannot become LinkedIn evidence', () => {
  for (const invalid of [post({type:'comment'}),post({id:7507254982996332545}),post({id:'7507254982996332546'}),
    post({content:''}),post({linkedinUrl:`https://evil.test/posts/demo-person_product-activity-${id}-AbCd`}),
    post({author:{name:'Wrong Person',linkedinUrl:'https://www.linkedin.com/in/someone-else'}}),
    post({postedAt:{timestamp:now,date:new Date(now-3600_000).toISOString()}}),post({postedAt:{timestamp:now+600_000}}),
    post({postedAt:{timestamp:now,date:'invalid'}})]) {
    assert.equal(normalizeApifyLinkedInPost(invalid,new Date(now).toISOString()),null);
  }
});

test('paid run uses the fixed post-search actor, bounded inputs, header-only token and per-run charge/time limits', async () => {
  const {adapter,calls} = client();
  const result = await adapter.search({query:'subscription reminders',datePosted:'past-month',limit:20});
  assert.equal(calls.length,2);assert.equal(calls[0].url.pathname,`/v2/actors/${LINKEDIN_ACTOR}/runs`);
  assert.equal(calls[0].url.searchParams.get('maxTotalChargeUsd'),'0.10');
  assert.equal(calls[0].url.searchParams.get('timeout'),'45');assert.equal(calls[0].url.searchParams.get('restartOnError'),'false');
  assert.deepEqual(JSON.parse(calls[0].config.body),{searchQueries:['subscription reminders'],maxPosts:20,sortBy:'date',postedLimit:'month',
    profileScraperMode:'short',scrapeComments:false,scrapeReactions:false,postNestedComments:false,postNestedReactions:false});
  assert(calls.every(({url,config}) => url.origin === 'https://api.apify.com' && !url.href.includes('private-test-token') &&
    config.headers.Authorization === 'Bearer private-test-token' && config.redirect === 'error'));
  assert.equal(calls[1].url.searchParams.get('limit'),'20');assert.equal(result.rows.length,1);
  assert.equal(result.coverage.complete,false);assert.equal(result.coverage.costFinal,false);
  await adapter.search({query:'"QuietBoard"'});
  assert.equal(JSON.parse(calls[2].config.body).postedLimit,'any');
  for (const input of [{query:''},{query:'x'.repeat(501)},{query:'x',limit:0},{query:'x',limit:31},{query:'x',datePosted:'all'}]) {
    await assert.rejects(adapter.search(input),/invalid_request/);
  }
  assert.equal(calls.length,4);
});

test('running actors are polled by ID without starting another billable run', async () => {
  const calls = [];
  const adapter = new ApifyLinkedInAdapter({token:'private-test-token',now:() => now,fetchImpl:async (url,config) => {
    calls.push({url,config});
    return Response.json(config.method === 'POST' ? run('RUNNING') : url.includes('/items') ? [post()] : run());
  }});
  assert.equal((await adapter.search({query:'x'})).rows.length,1);
  assert.equal(calls.filter(call => call.config.method === 'POST').length,1);
  assert(calls[1].url.endsWith('/actor-runs/Run123?waitForFinish=10'));
});

test('identical concurrent searches share a paid run; validated results cache and expire without mutating each other', async () => {
  let clock = now, release;
  const gate = new Promise(resolve => {release = resolve;});let starts = 0;
  const adapter = new ApifyLinkedInAdapter({token:'private-test-token',now:() => clock,fetchImpl:async (url,config) => {
    if (config.method === 'POST') {starts++;await gate;return Response.json(run());}
    return Response.json([post()]);
  }});
  const first = adapter.search({query:'x'}), second = adapter.search({query:'x'});release();
  const [a,b] = await Promise.all([first,second]);assert.equal(starts,1);assert.deepEqual(a,b);
  a.rows[0].author = 'Mutated';
  const cached = await adapter.search({query:'x'});assert.equal(cached.rows[0].author,'Demo Person');
  assert.equal(cached.coverage.cacheHit,true);assert.equal(starts,1);
  clock += 300_001;await adapter.search({query:'x'});assert.equal(starts,2);
});

test('uncertain paid starts and authorization failures are never retried or leaked', async () => {
  for (const failure of ['network',401,429,500]) {
    let calls = 0;
    const adapter = new ApifyLinkedInAdapter({token:'private-test-token',fetchImpl:async () => {
      calls++;if (failure === 'network') throw Error('private-test-token');
      return Response.json({error:{message:'private-test-token'}},{status:failure});
    }});
    await assert.rejects(adapter.search({query:'x'}),error => !error.message.includes('private-test-token'));
    assert.equal(calls,1);
  }
});

test('malformed datasets and ID changes fail visibly and are not cached', async () => {
  for (const items of [{error:'private-test-token'},[post({author:null})],Array.from({length:31},() => post())]) {
    const {adapter,calls} = client({items});
    for (let i = 0; i < 2; i++) await assert.rejects(adapter.search({query:'x'}),/schema_changed/);
    assert.equal(calls.length,4);
  }
  const {adapter} = client({fetchImpl:async (_url,config) => Response.json(config.method === 'POST' ? run('RUNNING') : run('SUCCEEDED',{id:'OtherRun'}))});
  await assert.rejects(adapter.search({query:'x'}),/schema_changed/);
});

test('timed-out runs retain attributed partial results and expose incomplete coverage; empty failed runs are errors', async () => {
  const {adapter,calls} = client({status:'TIMED-OUT'});
  const result = await adapter.search({query:'x'});
  assert.equal(result.rows.length,1);assert.deepEqual(result.coverage.errors,['linkedin_timeout']);
  await adapter.search({query:'x'});assert.equal(calls.length,4,'Partial failures are not cached as successful searches');
  const failed = client({status:'FAILED',items:[]});await assert.rejects(failed.adapter.search({query:'x'}),/provider_failed/);
  const empty = client({items:[]});assert.deepEqual((await empty.adapter.search({query:'x'})).rows,[]);
});

test('caller cancellation attempts to abort the known remote run without repeating its paid start', async () => {
  const controller = new AbortController();let entered;
  const started = new Promise(resolve => {entered = resolve;});const calls = [];
  const adapter = new ApifyLinkedInAdapter({token:'private-test-token',fetchImpl:async (url,config) => {
    calls.push({url,config});
    if (url.endsWith('/abort')) return Response.json(run('ABORTED'));
    if (config.method === 'POST') return Response.json(run('RUNNING'));
    entered();return new Promise((_,reject) => config.signal.addEventListener('abort',() => reject(config.signal.reason),{once:true}));
  }});
  const result = adapter.search({query:'x',signal:controller.signal});await started;controller.abort();
  await assert.rejects(result,/linkedin_timeout/);
  assert(calls.at(-1).url.endsWith('/actor-runs/Run123/abort'));assert.equal(calls.filter(call => call.url.includes('/actors/')).length,1);
});

test('Apify configuration is independent of Reddit; explicit provider choices never fall back', () => {
  assert.equal(linkedinConfigured({LINKEDIN_PROVIDER:'apify',REDLIB_BRIDGE_URL:'https://bridge.test',REDLIB_BRIDGE_TOKEN:'x'.repeat(32)}),false);
  assert.throws(() => createLinkedInAdapter({env:{LINKEDIN_PROVIDER:'apify'}}),/APIFY_TOKEN/);
  assert.equal(linkedinConfigured({APIFY_TOKEN:'test',SCRAPEBADGER_API_KEY:'reddit'}),true);
  assert.equal(createLinkedInAdapter({env:{APIFY_TOKEN:'test',REDDIT_PROVIDER:'scrapebadger'}}).id,'linkedin-apify');
  assert.equal(createLinkedInAdapter({env:{LINKEDIN_PROVIDER:'linkedin-mcp',APIFY_TOKEN:'test',REDLIB_BRIDGE_URL:'https://bridge.test',REDLIB_BRIDGE_TOKEN:'x'.repeat(32)}}).id,'linkedin-mcp');
  assert.throws(() => createLinkedInAdapter({env:{LINKEDIN_PROVIDER:'unknown',APIFY_TOKEN:'test'}}),/Choose/);
});

test('discovery keeps post provenance, separates recent needs from exact mentions, and reports Apify coverage', async () => {
  const {adapter,calls} = client();
  const result = await discover(product,{watchOnly:true,linkedinAdapter:adapter,now:new Date(now)});
  assert.equal(calls.filter(call => call.config.method === 'POST').length,2);
  assert.equal(result.items.length,1);assert.equal(result.items[0].kind,'opportunity');assert.equal(result.items[0].provider,'linkedin-apify');
  assert.equal(result.items[0].sourceId,`li_${id}`);assert.equal(result.sources[0].provider,'linkedin-apify');
  assert.match(result.sources[0].message,/past month/);assert.match(result.sources[0].message,/provider-reported/);
  const old = client({items:[post({postedAt:{timestamp:now-100*86400000}})]});
  assert.equal((await discover(product,{watchOnly:true,linkedinAdapter:old.adapter,now:new Date(now)})).items.length,0);
  const unrelated = client({items:[post({content:'We launched a new subscription reminders service. Try it today!'})]});
  assert.equal((await discover(product,{watchOnly:true,linkedinAdapter:unrelated.adapter,now:new Date(now)})).items.length,0);
});
