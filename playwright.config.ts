import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const channel = process.env.PLAYWRIGHT_CHANNEL || (existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined);

export default defineConfig({
  testDir: './test',
  testMatch: ['**/browser.spec.ts', '**/qr.browser.spec.ts'],
  outputDir: './test-results/ui',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4318',
    browserName: 'chromium',
    channel,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: 'node --import tsx test/browser-server.ts',
    url: 'http://127.0.0.1:4318/healthz',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '4318', PUBLIC_URL: 'http://127.0.0.1:4318',
      FIREBASE_PROJECT_ID: 'demo-iap-notifications', IAP_FIREBASE_WEB_API_KEY: 'demo-key',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8088', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9098',
      ALLOW_REGISTRATION: 'true', ENABLE_DEMO: 'true',
      APNS_TEAM_ID: '', APNS_KEY_ID: '', APNS_TOPIC: '', APNS_PRIVATE_KEY_PATH: '',
    },
  },
});
