import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAppReference,safeIconUrl} from '../src/metadata.js';
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
  const config=readConfiguration({NODE_ENV:'production',PUBLIC_URL:'https://example.com'});
  assert.equal(config.demoEnabled,false);assert.equal(config.registrationEnabled,false);
});
