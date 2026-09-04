import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ActivityEvent, ConnectedApp, Preferences, RegisteredDevice } from './types.js';

export interface AppRow {
  id: string; user_id: string; name: string; bundle_id: string; apple_id: string;
  source: 'apple' | 'revenuecat'; icon_url: string | null; webhook_secret: string;
  created_at: string; last_production_at: string | null; last_sandbox_at: string | null;
}
export interface DeviceRow {
  id: string; user_id: string; session_hash: string; token: string; name: string;
  environment: 'production' | 'sandbox'; created_at: string; last_seen_at: string; active: number;
}
export interface EventRow {
  seq: number; id: string; app_id: string; kind: ActivityEvent['kind']; title: string; detail: string;
  amount_milliunits: number | null; currency: string | null; product_id: string | null;
  transaction_id: string | null; environment: ActivityEvent['environment']; occurred_at: string;
  received_at: string; notification_type: string; subtype: string | null; is_monetary: number;
  signed_date: number; economic_key: string | null; app_name?: string;
}
export const defaultPreferences: Preferences = { sales: true, refunds: true, lifecycle: false, sandbox: false, hideAmounts: false };

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS browser_pairings (
        id TEXT PRIMARY KEY, browser_secret_hash TEXT NOT NULL UNIQUE, approval_token_hash TEXT NOT NULL,
        code TEXT NOT NULL, browser_name TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','consumed','cancelled')),
        approved_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        approver_session_hash TEXT REFERENCES sessions(token_hash) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS browser_pairings_expiry ON browser_pairings(expires_at);
      CREATE TABLE IF NOT EXISTS preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        sales INTEGER NOT NULL DEFAULT 1, refunds INTEGER NOT NULL DEFAULT 1,
        lifecycle INTEGER NOT NULL DEFAULT 0, sandbox INTEGER NOT NULL DEFAULT 0,
        hide_amounts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, bundle_id TEXT NOT NULL, apple_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('apple','revenuecat')), icon_url TEXT,
        webhook_secret TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        last_production_at TEXT, last_sandbox_at TEXT, UNIQUE(user_id, bundle_id)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        environment TEXT NOT NULL, notification_uuid TEXT NOT NULL,
        notification_type TEXT NOT NULL, signed_date INTEGER NOT NULL, received_at TEXT NOT NULL,
        UNIQUE(app_id, environment, notification_uuid)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
        amount_milliunits INTEGER, currency TEXT, product_id TEXT, transaction_id TEXT,
        environment TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
        notification_type TEXT NOT NULL, subtype TEXT, is_monetary INTEGER NOT NULL,
        signed_date INTEGER NOT NULL, economic_key TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS economic_event ON events(app_id,environment,economic_key) WHERE economic_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS events_app_sequence ON events(app_id,seq DESC);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        token TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('production','sandbox')),
        name TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(token,environment)
      );
      CREATE TABLE IF NOT EXISTS delivery_jobs (
        id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('event','test')),
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','sent','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        next_attempt_at INTEGER NOT NULL, lease_until INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(event_id,device_id)
      );
      CREATE INDEX IF NOT EXISTS delivery_due ON delivery_jobs(state,next_attempt_at);
      PRAGMA user_version = 2;
    `);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getApp(id: string, userId?: string): AppRow | undefined {
    return (userId ? this.db.prepare('SELECT * FROM apps WHERE id=? AND user_id=?').get(id,userId)
      : this.db.prepare('SELECT * FROM apps WHERE id=?').get(id)) as unknown as AppRow | undefined;
  }
  appResponse(row: AppRow, publicUrl: string): ConnectedApp & { forwardingUrl: string } {
    const base = `${publicUrl}/webhooks/apple/${row.webhook_secret}`;
    return { id: row.id, name: row.name, bundleId: row.bundle_id, appleId: row.apple_id, source: row.source,
      iconUrl: row.icon_url, createdAt: row.created_at,
      webhookUrls: { production: `${base}/production`, sandbox: `${base}/sandbox` }, forwardingUrl: `${base}/forward`,
      lastProductionEventAt: row.last_production_at, lastSandboxEventAt: row.last_sandbox_at };
  }
  preferences(userId: string): Preferences {
    const p = this.db.prepare('SELECT * FROM preferences WHERE user_id=?').get(userId);
    if (!p) return { ...defaultPreferences };
    return { sales: !!p.sales, refunds: !!p.refunds, lifecycle: !!p.lifecycle, sandbox: !!p.sandbox, hideAmounts: !!p.hide_amounts };
  }
  eventResponse(row: EventRow): ActivityEvent {
    return { id: row.id, appId: row.app_id, appName: row.app_name ?? this.getApp(row.app_id)?.name ?? 'App',
      kind: row.kind, title: row.title, detail: row.detail, amountMilliunits: row.amount_milliunits,
      currency: row.currency, productId: row.product_id, transactionId: row.transaction_id,
      environment: row.environment, occurredAt: row.occurred_at, receivedAt: row.received_at,
      notificationType: row.notification_type, subtype: row.subtype, isMonetary: !!row.is_monetary };
  }
  insertEvent(event: ActivityEvent, economicKey: string | null, signedDate: number): EventRow {
    this.db.prepare(`INSERT INTO events (id,app_id,kind,title,detail,amount_milliunits,currency,product_id,
      transaction_id,environment,occurred_at,received_at,notification_type,subtype,is_monetary,signed_date,economic_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.id,event.appId,event.kind,event.title,event.detail,
      event.amountMilliunits,event.currency,event.productId,event.transactionId,event.environment,event.occurredAt,
      event.receivedAt,event.notificationType,event.subtype,Number(event.isMonetary),signedDate,economicKey);
    return this.db.prepare('SELECT * FROM events WHERE id=?').get(event.id) as unknown as EventRow;
  }
  queueEvent(event: ActivityEvent, userId: string) {
    if (!shouldNotify(event, this.preferences(userId))) return;
    const devices = this.db.prepare('SELECT id FROM devices WHERE user_id=? AND active=1').all(userId);
    for (const device of devices) this.enqueue(String(device.id), event.id);
  }
  enqueue(deviceId: string, eventId: string | null = null): string {
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO delivery_jobs (id,event_id,device_id,kind,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id,eventId,deviceId,eventId ? 'event' : 'test',Date.now(),now,now);
    return id;
  }
  deviceResponse(row: DeviceRow): RegisteredDevice {
    return { id: row.id, name: row.name, environment: row.environment, createdAt: row.created_at,
      lastSeenAt: row.last_seen_at, active: !!row.active };
  }
  disableDevice(id: string, userId?: string) {
    const clause = userId ? 'id=? AND user_id=?' : 'id=?'; const args = userId ? [id,userId] : [id];
    this.db.prepare(`UPDATE devices SET active=0 WHERE ${clause}`).run(...args);
    this.db.prepare(`UPDATE delivery_jobs SET state='cancelled',updated_at=? WHERE device_id=?
      AND state IN ('pending','processing') AND device_id IN (SELECT id FROM devices WHERE ${clause})`)
      .run(new Date().toISOString(),id,...args);
  }
}

export function newWebhookSecret() { return randomBytes(32).toString('base64url'); }
export function shouldNotify(event: ActivityEvent, p: Preferences): boolean {
  if (event.environment === 'Demo') return true;
  if (event.environment === 'Sandbox' && !p.sandbox) return false;
  if (event.kind === 'test') return false;
  if (event.kind === 'refund' || event.kind === 'refund_reversed') return p.refunds;
  if (event.kind === 'sale' || event.kind === 'renewal') return p.sales;
  return p.lifecycle;
}
