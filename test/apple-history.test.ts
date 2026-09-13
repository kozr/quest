import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {callAppleHistory,historyWindow,historyCursor} from '../src/apple-history.js';
const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const input={environment:'Production' as const,keyId:'ABCDEFGHIJ',issuerId:'12345678-1234-4123-8123-123456789abc',privateKey:privateKey.export({type:'pkcs8',format:'pem'}).toString()};
test('maximum history windows and app/environment bound continuation tokens',()=>{
  const now=Date.now();
  for(const environment of ['Production','Sandbox'] as const) {
    const window=historyWindow(environment,'secret',undefined,now);
    assert.equal(window.endDate-window.startDate,(environment==='Production'?180:30)*86400000);
    const next={...window,paginationToken:'next-page'};
    const cursor=historyCursor(next,'secret');
    assert.deepEqual(historyWindow(environment,'secret',cursor,now+1),next);
    assert.throws(()=>historyWindow(environment,'other-app',cursor,now+1),/invalid/);
    assert.throws(()=>historyWindow(environment==='Production'?'Sandbox':'Production','secret',cursor,now+1),/invalid/);
    assert.throws(()=>historyWindow(environment,'secret',cursor,now+86400001),/expired/);
  }
});
test('history requests keep the original dates and paginate without sending the private key',async()=>{
  const window=historyWindow('Production','secret');
  const calls:any[]=[];
  const request=(async(url,options)=>{
    calls.push({url,options});
    assert.equal(options!.method,'POST');
    assert.equal(options!.redirect,'error');
    assert.deepEqual(JSON.parse(options!.body as string),{startDate:window.startDate,endDate:window.endDate});
    assert(!JSON.stringify(options).includes('PRIVATE KEY'));
    return Response.json(calls.length===1?{hasMore:true,paginationToken:'next/page',notificationHistory:[{signedPayload:'signed'}]}:{hasMore:false,notificationHistory:[]});
  }) as typeof fetch;
  const page=await callAppleHistory(input,'com.example.app',window,request);
  await callAppleHistory(input,'com.example.app',{...window,paginationToken:page.paginationToken},request);
  assert.match(calls[0].url,/^https:\/\/api.storekit.apple.com\/inApps\/v1\/notifications\/history$/);
  assert.match(calls[1].url,/paginationToken=next%2Fpage$/);
});
test('bad Apple responses and repeating pagination fail safely without echoing secrets',async()=>{
  const window=historyWindow('Production','secret');
  for(const body of [{hasMore:true},{hasMore:true,paginationToken:'same'},{hasMore:false,notificationHistory:[{}]}]) {
    await assert.rejects(callAppleHistory(input,'bundle',{...window,paginationToken:'same'},(async()=>Response.json(body)) as typeof fetch),/notification history/);
  }
  await assert.rejects(callAppleHistory(input,'bundle',window,(async()=>Response.json({error:input.privateKey},{status:401})) as typeof fetch),/rejected the credentials/);
});

test('history distinguishes Apple timeouts, network failures and malformed responses',async()=>{
  const window=historyWindow('Production','secret');
  for (const [failure,status,message] of [
    [new DOMException('Timeout','TimeoutError'),504,/took too long/],
    [new TypeError('fetch failed'),502,/Could not reach Apple/],
  ] as const) {
    await assert.rejects(callAppleHistory(input,'bundle',window,(async()=>{throw failure;}) as typeof fetch),
      (error:any)=>error.status===status && message.test(error.message) && !error.message.includes(input.privateKey));
  }
  await assert.rejects(callAppleHistory(input,'bundle',window,(async()=>new Response('not JSON')) as typeof fetch),/unreadable/);
  await assert.rejects(callAppleHistory(input,'bundle',window,(async()=>Response.json({hasMore:'wrong'})) as typeof fetch),/unexpected/);
});
