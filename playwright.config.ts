import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 4173);
const explicitBaseUrl = process.env.E2E_BASE_URL;
if (process.env.E2E_MUTATIONS === '1') {
  throw new Error('Mutating E2E dinonaktifkan: aplikasi menggunakan satu database production.');
}
const baseURL = explicitBaseUrl ?? `http://localhost:${PORT}`;
const e2eClientIp = process.env.E2E_CLIENT_IP;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'readonly.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    extraHTTPHeaders: {
      Origin: baseURL,
      ...(e2eClientIp ? { 'X-Forwarded-For': e2eClientIp } : {}),
    },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 800 } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm build && pnpm exec vite preview --host --port ' + PORT + ' --strictPort',
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
