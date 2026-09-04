export type AppleEnvironment = 'Production' | 'Sandbox';
export type EventEnvironment = AppleEnvironment | 'Demo';
export type EventKind = 'sale' | 'renewal' | 'refund' | 'refund_reversed' | 'trial' | 'auto_renew_disabled' | 'auto_renew_enabled' | 'billing_issue' | 'expired' | 'test' | 'other';

export interface User { id: string; email: string }
export interface Preferences {
  sales: boolean;
  refunds: boolean;
  lifecycle: boolean;
  sandbox: boolean;
  hideAmounts: boolean;
}
export interface ConnectedApp {
  id: string;
  name: string;
  bundleId: string;
  appleId: string;
  source: 'apple' | 'revenuecat';
  iconUrl: string | null;
  createdAt: string;
  webhookUrls: { production: string; sandbox: string };
  forwardingUrl?: string;
  lastProductionEventAt: string | null;
  lastSandboxEventAt: string | null;
}
export interface ActivityEvent {
  id: string;
  appId: string;
  appName: string;
  kind: EventKind;
  title: string;
  detail: string;
  amountMilliunits: number | null;
  currency: string | null;
  productId: string | null;
  transactionId: string | null;
  environment: EventEnvironment;
  occurredAt: string;
  receivedAt: string;
  notificationType: string;
  subtype: string | null;
  isMonetary: boolean;
}
export interface RegisteredDevice {
  id: string;
  name: string;
  environment: 'production' | 'sandbox';
  createdAt: string;
  lastSeenAt: string;
  active: boolean;
}
