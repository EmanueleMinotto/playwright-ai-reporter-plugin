import { expect, test } from '@playwright/test';

test('passes', () => {
  expect(1 + 1).toBe(2);
});

test('fails on purpose', () => {
  expect('42').toBe(42);
});
