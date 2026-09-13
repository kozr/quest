import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAppReference,safeIconUrl,searchApps} from '../src/metadata.js';
import {readConfiguration} from '../src/config.js';

test('Apple URL parsing preserves storefront and handles Connect/numeric references',()=>{
  assert.deepEqual(parseAppReference('https://apps.apple.com/ca/app/example/id123456789?utm_source=test'),{appleId:'123456789',country:'ca'});
  assert.deepEqual(parseAppReference('https://appstoreconnect.apple.com/apps/123456789/distribution/info'),{appleId:'123456789',country:'us'});
  assert.deepEqual(parseAppReference('123456789'),{appleId:'123456789',country:'us'});
});
test('metadata lookup cannot be used to fetch arbitrary or private URLs',()=>{
  for(const url of ['http://127.0.0.1/id123','https://evil.example/id123','https://apps.apple.com.evil.example/id123','https://evil@apps.apple.com/id123','https://apps.apple.com:8443/id123','file:///etc/passwd','https://appstoreconnect.apple.com/']) assert.throws(()=>parseAppReference(url));
});
test('only Apple CDN icons are displayed',()=>{
  assert.equal(safeIconUrl('https://is1-ssl.mzstatic.com/image/thumb.png'),'https://is1-ssl.mzstatic.com/image/thumb.png');
  for(const url of ['javascript:alert(1)','https://evil.example/image','https://mzstatic.com.evil.example/image','http://is1-ssl.mzstatic.com/image']) assert.equal(safeIconUrl(url),null);
});
test('production configuration requires HTTPS and defaults registration/demo to off',()=>{
  assert.throws(()=>readConfiguration({NODE_ENV:'production',PUBLIC_URL:'http://example.com'}));
  assert.throws(()=>readConfiguration({PUBLIC_URL:'https://example.com/subpath'}));
  assert.throws(()=>readConfiguration({APNS_TEAM_ID:'SOMEID'}));
  const config=readConfiguration({NODE_ENV:'production',PUBLIC_URL:'https://example.com',FIREBASE_PROJECT_ID:'test-project',IAP_FIREBASE_WEB_API_KEY:'test-key'});
  assert.equal(config.demoEnabled,false);assert.equal(config.registrationEnabled,false);
});

test('title search encodes the query, filters invalid results, and exposes developer details',async(t)=>{
  t.mock.method(globalThis,'fetch',async(input:URL,init:RequestInit)=>{
    assert.equal(input.origin,'https://itunes.apple.com');
    assert.equal(input.pathname,'/search');
    assert.equal(input.searchParams.get('term'),'Weather & 雨');
    assert.equal(input.searchParams.get('country'),'us');
    assert.equal(input.searchParams.get('entity'),'software');
    assert.equal(input.searchParams.get('limit'),'10');
    assert.equal(init.redirect,'error');
    return new Response(JSON.stringify({results:[
      {trackId:123,trackName:'Weather & 雨',bundleId:'com.example.weather',artistName:'Example Developer',artworkUrl100:'https://evil.example/icon.png'},
      {trackId:123,trackName:'Duplicate',bundleId:'com.example.duplicate'},
      {trackId:456,trackName:'Other Weather',bundleId:'com.example.other',sellerName:'Other Developer'},
      {trackId:789,trackName:'Missing bundle'},null,{trackId:'nope',trackName:'Invalid ID',bundleId:'com.example.invalid'},
    ]}));
  });
  const apps=await searchApps('  Weather & 雨  ');
  assert.equal(apps.length,2);
  assert.deepEqual(apps[0],{name:'Weather & 雨',bundleId:'com.example.weather',appleId:'123',developer:'Example Developer',iconUrl:null,appStoreUrl:'https://apps.apple.com/us/app/id123'});
  assert.equal(apps[1].developer,'Other Developer');
});

test('title search handles empty, failed, and malformed responses and rejects invalid terms',async(t)=>{
  let response=new Response(JSON.stringify({results:[]}));
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>response);
  await assert.rejects(searchApps('a'));
  await assert.rejects(searchApps('a'.repeat(101)));
  assert.equal(fetchMock.mock.callCount(),0);
  assert.deepEqual(await searchApps('No results'),[]);
  response=new Response('{}',{status:503});
  await assert.rejects(searchApps('Unavailable'),/unavailable/);
  response=new Response(JSON.stringify({results:{}}));
  await assert.rejects(searchApps('Malformed'),/unexpected response/);
  response=new Response('x'.repeat(1024*1024+1));
  await assert.rejects(searchApps('Oversized'),/too much data/);
});
