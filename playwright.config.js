// Testes de navegador (npm run test:e2e). O servidor sobe com o build de
// produção e dados fixos (SIMULABR_FIXTURES=1), sem depender do GE nem da ESPN.
import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = 4310;
// Localmente dá para usar o Chrome instalado: PW_CHANNEL=chrome npm run test:e2e
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel } },
    { name: 'celular', use: { ...devices['Pixel 7'], channel } },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(port),
      SERVE_DIST: '1',
      SIMULABR_FIXTURES: '1',
      RUNTIME_DIR: path.join(tmpdir(), 'simulabr-e2e'),
    },
  },
});
