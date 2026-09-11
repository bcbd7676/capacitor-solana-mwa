import { WebPlugin } from '@capacitor/core';

import type {
  AuthorizeAndSignOptions,
  AuthorizeAndSignResult,
  SignMessagesOptions,
  SignMessagesResult,
  SolanaMwaPlugin,
  WalletAvailableResult,
} from './definitions';

/**
 * Web/iOS stub. MWA is an Android protocol built on Android intents, so there is
 * nothing to fall back TO here.
 *
 * walletAvailable() resolves false rather than throwing, so callers can use it
 * as a plain capability check on every platform without a try/catch.
 * authorizeAndSignAndSend() rejects, because silently doing nothing on a money
 * path is worse than an explicit failure.
 */
export class SolanaMwaWeb extends WebPlugin implements SolanaMwaPlugin {
  async walletAvailable(): Promise<WalletAvailableResult> {
    return { available: false };
  }

  async signMessages(_options: SignMessagesOptions): Promise<SignMessagesResult> {
    throw this.unavailable(
      'Mobile Wallet Adapter is Android-only. Check walletAvailable() first and fall back to your own flow.',
    );
  }

  async authorizeAndSignAndSend(
    _options: AuthorizeAndSignOptions,
  ): Promise<AuthorizeAndSignResult> {
    throw this.unavailable(
      'Mobile Wallet Adapter is Android-only. Check walletAvailable() first and fall back to your own flow.',
    );
  }
}
