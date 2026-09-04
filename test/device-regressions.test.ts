import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { ApnsClient, type PushResult, type PushTransport } from '../src/apns.js';
import { createApplication, type ApplicationOptions } from '../src/app.js';
import { Store, type DeviceRow } from '../src/database.js';
import { DeliveryWorker } from '../src/worker.js';
import {firebaseOptions,testStore,resetAccounts,rows,jobs} from './firebase-fixture.js';
import {createSession,tokenHash} from '../src/auth.js';

const configuration: ApplicationOptions = {
  port: 4317, host: '127.0.0.1', publicUrl: 'http://localhost:4317', ...firebaseOptions,
  production: false, registrationEnabled: true, demoEnabled: false,
  appleRootDirectory: '/not-used-by-this-test', apns: null,
};
const password = 'Regression-test-password!';
const email = 'device-regression@example.test';
const appInput = { name: 'Revenue fixture', bundleId: 'com.example.regression', appleId: '123456789', source: 'apple' };
const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);

async function fixture(pushTransport: PushTransport = { send: async () => ({ ok: true }) }) {
  const store=testStore();await resetAccounts(store,[email]);
  const instance = createApplication({
    ...configuration, pushTransport,store,
    // Test-only injection exercises the entire authenticated registration and
    // durable webhook/queue pipeline without ever accepting unsigned production data.
    verify: async (payload, context) => ({
      context: { ...context, appleId: Number(context.appleId) },
      notification: { notificationType: 'ONE_TIME_CHARGE', notificationUUID: payload, signedDate: Date.now(), version: '2.0' },
      transaction: {
        bundleId: context.bundleId, environment: context.environment, transactionId: payload,
        productId: 'regression.product', price: 4_990, currency: 'USD', inAppOwnershipType: 'PURCHASED', purchaseDate: Date.now(),
      },
      renewal: null,
    }),
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, options: { method?: string; token?: string; cookie?: string; body?: unknown; origin?: string } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  const registered = await request('/api/auth/register', { method: 'POST', body: { email, password, client: 'ios' } });
  assert.equal(registered.status, 201);
  const token: string = registered.body.token;
  const app = await request('/api/apps', { method: 'POST', token, body: appInput });
  assert.equal(app.status, 201);
  const webhook = new URL(app.body.app.webhookUrls.production).pathname;
  const registerDevice = async (apnsToken = tokenA) => {
    const result = await request('/api/devices', {
      method: 'POST', token, body: { token: apnsToken, name: 'Regression phone', environment: 'sandbox' },
    });
    assert.equal(result.status, 200);
    return result.body.device as { id: string; active: boolean; lastSeenAt: string };
  };
  const sale = async (id: string) => {
    const result = await request(webhook, { method: 'POST', body: { signedPayload: id } });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'received');
  };
  const close = async () => {
    await instance.worker.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    instance.store.close();
  };
  return { ...instance, token, request, registerDevice, sale, close };
}

test('A → B → A token registration leaves one active installation and never resends cancelled monetary jobs', async () => {
  const sent: Array<{ token: string; eventId: unknown }> = [];
  const f = await fixture({ send: async (device, payload) => { sent.push({ token: device.token, eventId: payload.eventId }); return { ok: true }; } });
  try {
    const first = await f.registerDevice(tokenA);
    await f.sale('rotation-sale-a');
    const second = await f.registerDevice(tokenB);
    await f.sale('rotation-sale-b');
    const returned = await f.registerDevice(tokenA);
    assert.equal(returned.id, first.id);
    assert.deepEqual((await rows(f.store,'devices')).sort((a,b)=>a.token.localeCompare(b.token)).map(({id,active})=>({id,active})), [
      { id: first.id, active: 1 }, { id: second.id, active: 0 },
    ]);
    await f.worker.tick();
    assert.deepEqual((await jobs(f.store)).map(row=>row.state), ['cancelled', 'cancelled']);
    await f.sale('rotation-sale-current');
    await f.worker.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.token, tokenA);
    assert.equal((await rows(f.store,'events')).filter(e=>e.isMonetary).length,3);
    assert.equal((await jobs(f.store)).filter(j=>j.state==='sent').length,1);
  } finally { await f.close(); }
});

test('same-token registration version increases even when stored timestamp is ahead of the wall clock', async () => {
  const f = await fixture();
  try {
    const original = await f.registerDevice();
    const previous = Date.now() + 60_000;
    await f.store.set('devices',original.id,{last_seen_at:new Date(previous).toISOString()},true);
    const refreshed = await f.registerDevice();
    assert.equal(refreshed.id, original.id);
    assert.equal(Date.parse(refreshed.lastSeenAt), previous + 1);
    const again = await f.registerDevice();
    assert.equal(Date.parse(again.lastSeenAt), previous + 2);
  } finally { await f.close(); }
});

test('late invalid-token response cannot disable a newer registration or cancel its next sale', { timeout: 10_000 }, async () => {
  let release: ((result: PushResult) => void) | undefined;
  let announceStarted: (() => void) | undefined;
  let calls = 0;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  const f = await fixture({ send: async () => {
    if (++calls === 1) {
      announceStarted!();
      return new Promise<PushResult>((resolve) => { release = resolve; });
    }
    return { ok: true };
  } });
  let tick: Promise<void> | undefined;
  try {
    const device = await f.registerDevice();
    await f.sale('inflight-old');
    tick = f.worker.tick();
    await started;
    const registeredAgain = await f.registerDevice();
    assert.ok(Date.parse(registeredAgain.lastSeenAt) > Date.parse(device.lastSeenAt));
    await f.sale('inflight-new');
    release!({ ok: false, invalidDevice: true, error: 'Unregistered' });
    await tick;
    assert.equal((await f.store.get<DeviceRow>('devices',device.id))!.active,1);
    await f.worker.tick();
    assert.equal(calls, 2);
    assert.deepEqual((await jobs(f.store)).map(row=>row.state), ['failed', 'sent']);
  } finally {
    release?.({ ok: false, retryable: true, error: 'Test teardown' });
    await tick;
    await f.close();
  }
});

async function storeFixture(transport: PushTransport) {
  const store = testStore();await resetAccounts(store,['worker@example.test']);
  const identity=await store.identity.signIn('worker@example.test','Worker-fixture-password!',true);
  const token=await createSession(store,identity.user.id,identity.authTime);
  const timestamp = Date.now() - 1_000;
  const date = new Date(timestamp).toISOString();
  await store.set('users',identity.user.id,identity.user);
  await store.set('devices','device',{id:'device',user_id:identity.user.id,session_hash:tokenHash(token),token:tokenA,environment:'sandbox',name:'Worker fixture',created_at:date,last_seen_at:date,active:1,generation:1});
  return { store, userId:identity.user.id,timestamp, worker: new DeliveryWorker(store, transport) };
}

test('historical APNs 410 invalidation does not disable a registration that is already newer', async () => {
  let timestamp = 0;
  const f = await storeFixture({ send: async () => ({ ok: false, invalidDevice: true, invalidatedAt: timestamp - 1, error: 'Unregistered' }) });
  timestamp = f.timestamp;
  try {
    await f.store.enqueue('device',f.userId);
    await f.worker.tick();
    assert.equal((await rows(f.store,'devices'))[0].active,1);
    assert.equal((await jobs(f.store))[0].state,'failed');
  } finally { await f.worker.stop(); f.store.close(); }
});

test('current, later, and undated invalid-token responses still disable the device and cancel queued jobs', async () => {
  for (const delta of [0, 1_000, undefined]) {
    let timestamp = 0;
    let calls = 0;
    const f = await storeFixture({ send: async () => {
      calls++;
      return { ok: false, invalidDevice: true, invalidatedAt: delta === undefined ? undefined : timestamp + delta, error: 'Unregistered' };
    } });
    timestamp = f.timestamp;
    try {
      await f.store.enqueue('device',f.userId);
      await f.store.enqueue('device',f.userId);
      await f.worker.tick();
      assert.equal(calls, 1);
      assert.equal((await rows(f.store,'devices'))[0].active,0);
      assert.deepEqual((await jobs(f.store)).map(row=>row.state),['failed','cancelled']);
    } finally { await f.worker.stop(); f.store.close(); }
  }
});

test('remote browser removal revokes the phone session and its queued data while preserving the browser session', async () => {
  const f = await fixture();
  try {
    const device = await f.registerDevice();
    await f.sale('remote-revoke-sale');
    const browser = await f.request('/api/auth/login', { method: 'POST', body: { email, password }, origin: configuration.publicUrl });
    assert.equal(browser.status, 200);
    const cookie = browser.headers.get('set-cookie')!.split(';')[0]!;
    const removed = await f.request(`/api/devices/${device.id}`, { method: 'DELETE', cookie, origin: configuration.publicUrl });
    assert.equal(removed.status, 200);
    assert.equal((await f.request('/api/auth/me', { token: f.token })).status, 401);
    assert.equal((await f.request('/api/devices', { method: 'POST', token: f.token, body: { token: tokenA, name: 'Stale phone', environment: 'sandbox' } })).status, 401);
    assert.equal((await f.request('/api/auth/me', { cookie })).status, 200);
    await f.worker.tick();
    assert.equal((await rows(f.store,'devices'))[0].active,0);
    assert.equal((await jobs(f.store))[0].state,'cancelled');
    assert.equal((await rows(f.store,'events')).length,1);
  } finally { await f.close(); }
});

test('native self-unregister keeps its session alive long enough to complete explicit logout', async () => {
  const f = await fixture();
  try {
    const device = await f.registerDevice();
    await f.sale('self-unregister-sale');
    assert.equal((await f.request(`/api/devices/${device.id}`, { method: 'DELETE', token: f.token })).status, 200);
    assert.equal((await f.request('/api/auth/me', { token: f.token })).status, 200);
    await f.worker.tick();
    assert.equal((await f.store.get<DeviceRow>('devices',device.id))!.active,0);
    assert.equal((await jobs(f.store))[0].state,'cancelled');
    assert.equal((await f.request('/api/auth/logout', { method: 'POST', token: f.token })).status, 200);
    assert.equal((await f.request('/api/auth/me', { token: f.token })).status, 401);
  } finally { await f.close(); }
});

class ResponseStream extends EventEmitter {
  constructor(private status: number, private response: unknown, private earlyClose = false) { super(); }
  setEncoding() { return this; }
  setTimeout() { return this; }
  close() { this.emit('close'); }
  end() {
    queueMicrotask(() => {
      if (this.earlyClose) return this.close();
      this.emit('response', { ':status': this.status });
      this.emit('data', JSON.stringify(this.response));
      this.emit('end');
      this.emit('close');
    });
  }
}

async function apnsResponse(status: number, response: unknown, earlyClose = false) {
  const stream = new ResponseStream(status, response, earlyClose);
  // Exercise the real response parser without a private key or network connection.
  const client = Object.assign(Object.create(ApnsClient.prototype), {
    config: { topic: 'com.example.companion' },
    session: () => ({ request: () => stream }),
    authorization: () => 'bearer test-only',
  }) as ApnsClient;
  return client.send({ token: tokenA, environment: 'sandbox' } as DeviceRow, { aps: { alert: 'Test' } }, 'test-job');
}

test('APNs response parser retains only valid 410 millisecond invalidation timestamps', async () => {
  const timestamp = 1_750_000_000_000;
  assert.equal((await apnsResponse(410, { reason: 'Unregistered', timestamp })).invalidatedAt, timestamp);
  for (const invalid of [undefined, '1750000000000', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    const result = await apnsResponse(410, { reason: 'Unregistered', timestamp: invalid });
    assert.equal(result.invalidatedAt, undefined);
    assert.equal(result.invalidDevice, true);
  }
  assert.equal((await apnsResponse(400, { reason: 'BadDeviceToken', timestamp })).invalidatedAt, undefined);
});

test('APNs stream closed without a response resolves as retryable instead of hanging the worker', { timeout: 1_000 }, async () => {
  const result = await apnsResponse(0, {}, true);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});
