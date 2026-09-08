import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {appleTestInput,callAppleTest} from '../src/apple-test.js';

const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const credentials={environment:'Sandbox' as const,keyId:'ABCDEFGHIJ',issuerId:'12345678-1234-4123-8123-123456789abc',privateKey:privateKey.export({type:'pkcs8',format:'pem'}).toString()};

test('Apple test uses fixed environment endpoints, short-lived app-bound ES256 JWT and no raw key on the wire',async()=>{
  const calls:any[]=[];
  const request=(async(url,options)=>{
    calls.push({url,options});
    const jwt=String((options!.headers as any).Authorization).slice(7);
    const [header,payload,signature]=jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header,'base64url').toString()),{alg:'ES256',kid:credentials.keyId,typ:'JWT'});
    const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
    assert.equal(claims.bid,'com.example.test');assert.equal(claims.iss,credentials.issuerId);assert.equal(claims.aud,'appstoreconnect-v1');assert.equal(claims.exp-claims.iat,300);
    assert(verify('sha256',Buffer.from(`${header}.${payload}`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));
    assert(!JSON.stringify({url,options}).includes('PRIVATE KEY'));
    assert.equal(options!.redirect,'error');assert(options!.signal);
    return Response.json(options!.method==='POST' ? {testNotificationToken:'test-token'} : {sendAttempts:[{sendAttemptResult:'SUCCESS'}]});
  }) as typeof fetch;
  assert.equal((await callAppleTest(credentials,'com.example.test',undefined,request)).testNotificationToken,'test-token');
  await callAppleTest({...credentials,environment:'Production'},'com.example.test','test-token',request);
  assert.equal(calls[0].url,'https://api.storekit-sandbox.apple.com/inApps/v1/notifications/test');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[1].url,'https://api.storekit.apple.com/inApps/v1/notifications/test/test-token');
  assert.equal(calls[1].options.method,'GET');
});

test('invalid keys and inputs fail before network access; remote errors never echo secrets',async()=>{
  assert(!appleTestInput.safeParse({...credentials,environment:'other'}).success);
  assert(!appleTestInput.safeParse({...credentials,keyId:'bad'}).success);
  let calls=0;
  const request=(async()=>{calls++;return Response.json({errorMessage:credentials.privateKey},{status:401});}) as typeof fetch;
  await assert.rejects(callAppleTest({...credentials,privateKey:'not a key'},'com.example.test',undefined,request),/valid In-App Purchase/);
  assert.equal(calls,0);
  await assert.rejects(callAppleTest(credentials,'com.example.test',undefined,request),/Apple rejected the credentials/);
  const offline=(async()=>{throw new Error(credentials.privateKey);}) as typeof fetch;
  await assert.rejects(callAppleTest(credentials,'com.example.test',undefined,offline),/usable response in time/);
  const missing=(async()=>Response.json({}, {status:404})) as typeof fetch;
  assert.deepEqual(await callAppleTest(credentials,'com.example.test','token',missing),{});
  await assert.rejects(callAppleTest(credentials,'com.example.test',undefined,missing),/notification URL/);
});
