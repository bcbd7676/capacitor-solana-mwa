# Changelog

## 0.1.1 - 2026-11-03

### Fixed

- **Legacy sessions now receive a legacy network name.** On a session that falls back to MWA 1.x, the plugin passed the caller's chain identifier straight through as `cluster`. Phantom refused `solana:mainnet` with "example.com is trying to use testnet mode", so mainnet did not work with Phantom at all. The plugin now sends `mainnet-beta`, `devnet` or `testnet`, and callers still pass `solana:mainnet` as before.
- **The example app no longer logs the RPC URL.** It put the full URL, API key included, on the screen and in logcat. It now logs the host only.

### Added

- The example app has a devnet/mainnet switch, and it checks the chain before reporting success. A signature from a wallet does not prove the transaction landed.
- Unit tests for the cluster mapping, Base58 and the web fallback, run in CI on GitHub Actions.
- Mainnet results for Phantom, the Seeker wallet and Jupiter in the README's compatibility table.

## 0.1.0 - 2026-09-18

First release: `authorizeAndSignAndSend`, `signMessages` and `walletAvailable`.
