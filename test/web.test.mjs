// Tests the web and iOS fallback against the built output. Run with: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SolanaMwaWeb } from '../dist/esm/web.js';

const options = {
  cluster: 'solana:mainnet',
  identityName: 'Test',
  identityUri: 'https://example.com',
};

test('walletAvailable resolves false instead of throwing', async () => {
  assert.deepEqual(await new SolanaMwaWeb().walletAvailable(), { available: false });
});

test('authorizeAndSignAndSend rejects rather than silently doing nothing', async () => {
  await assert.rejects(new SolanaMwaWeb().authorizeAndSignAndSend({ ...options, payloads: ['AA=='] }), /Android-only/);
});

test('signMessages rejects rather than silently doing nothing', async () => {
  await assert.rejects(new SolanaMwaWeb().signMessages({ ...options, messages: ['AA=='] }), /Android-only/);
});
