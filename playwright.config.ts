import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: '**/fixtures/**',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
