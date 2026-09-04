import { resolve } from 'node:path';

export interface ApnsConfiguration {
  teamId: string;
  keyId: string;
  topic: string;
  privateKeyPath: string;
}
export interface Configuration {
  port: number;
  host: string;
  publicUrl: string;
  databasePath: string;
  production: boolean;
  registrationEnabled: boolean;
  demoEnabled: boolean;
  appleRootDirectory: string;
  apns: ApnsConfiguration | null;
}

export function readConfiguration(env = process.env): Configuration {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port.');
  const publicUrl = new URL(env.PUBLIC_URL ?? `http://localhost:${port}`);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_URL must be an origin, without a path, credentials, query, or fragment.');
  }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || (production && publicUrl.protocol !== 'https:')) {
    throw new Error('PUBLIC_URL must use HTTPS in production.');
  }
  const fields = [env.APNS_TEAM_ID, env.APNS_KEY_ID, env.APNS_TOPIC, env.APNS_PRIVATE_KEY_PATH];
  if (fields.some(Boolean) && !fields.every(Boolean)) throw new Error('Set all four APNS_* values, or leave all four empty.');
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    publicUrl: publicUrl.origin,
    databasePath: env.DATABASE_PATH ?? resolve('data/iap.sqlite'),
    production,
    registrationEnabled: env.ALLOW_REGISTRATION ? env.ALLOW_REGISTRATION === 'true' : !production,
    demoEnabled: env.ENABLE_DEMO ? env.ENABLE_DEMO === 'true' : !production,
    appleRootDirectory: env.APPLE_ROOT_CERTS_DIR ?? resolve('certificates'),
    apns: fields.every(Boolean) ? {
      teamId: env.APNS_TEAM_ID!, keyId: env.APNS_KEY_ID!, topic: env.APNS_TOPIC!,
      privateKeyPath: resolve(env.APNS_PRIVATE_KEY_PATH!),
    } : null,
  };
}
