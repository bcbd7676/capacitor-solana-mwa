# capacitor-solana-mwa

Solana [Mobile Wallet Adapter](https://docs.solanamobile.com/) for [Capacitor](https://capacitorjs.com/) apps on Android.

> **Status: pre-release (0.1.0). The Android library and the TypeScript API build and typecheck, and the native API is verified against the shipped `mobile-wallet-adapter-clientlib` 2.1.0 signatures. A full authorize-and-sign round trip against a real wallet has NOT yet been performed on a device. Do not put this on a money path until it has.**

## Why this exists

**The JavaScript MWA libraries cannot connect from a Capacitor WebView, and the reason is not what most people guess.**

MWA's browser transport associates by opening a `solana-wallet:` intent and then connecting as a WebSocket client to `ws://localhost:<port>/solana-wallet`. Inside a Capacitor WebView that connection fails, and it is *not* mixed-content blocking:

| what was changed | result |
| --- | --- |
| nothing (stock Capacitor, `targetSdk 36`) | `ws://localhost` and `ws://127.0.0.1` fail in **7–70 ms**, `code=1006`, **no TCP attempt is ever made** |
| `android.allowMixedContent: true` | **identical failure** — so mixed content was never the cause |
| a `networkSecurityConfig` permitting cleartext to loopback | the refusal stops; the WebView emits **real TCP SYNs** to `127.0.0.1` and `::1` |

The blocker is **Android's cleartext-traffic policy**, which has denied cleartext to *every* host — loopback included, there is no localhost exemption — by default since API 28. It is an app-level platform restriction and has nothing to do with the WebView's mixed-content mode.

So the JS route works only if you add a cleartext exemption to your manifest. On an app that handles wallets or payments, that is a real security concession, and `android:usesCleartextTraffic="true"` is a much worse one than a loopback-scoped `networkSecurityConfig`.

**This plugin needs no such exemption.** The native `mobile-wallet-adapter-clientlib` transports over [nv-websocket-client](https://github.com/TakahikoKawasaki/nv-websocket-client), which opens a raw `java.net.Socket` and contains **zero** references to `NetworkSecurityPolicy` or `isCleartextTrafficPermitted`. Android's cleartext enforcement is a voluntary userspace convention that `HttpURLConnection`, OkHttp, Cronet and the WebView all opt into; a raw-socket library that never consults it is not subject to it.

### The debugging trap worth knowing

**A cleartext refusal is indistinguishable from "nothing was listening", from JavaScript.** The `WebSocket` constructor does not throw, and the close code is always `1006` — "abnormal closure". So the symptom of a policy block is exactly the symptom of a wallet that is not running, and anyone debugging it concludes the wallet is at fault. That is why this costs a day to work out.

## Install

```bash
npm install capacitor-solana-mwa
npx cap sync android
```

Android only. The plugin ships the Android 11+ `<queries>` declaration for the `solana-wallet` scheme in its own manifest, so package visibility arrives by manifest merge — without it, `walletAvailable()` returns `false` on a device that *does* have a wallet installed, and the failure looks like "no wallet" instead of "cannot see the wallet".

## Usage

```ts
import { SolanaMwa } from 'capacitor-solana-mwa';

const { available } = await SolanaMwa.walletAvailable();
if (!available) {
  // Fall back to your own flow (Solana Pay, a deeplink, or an explanation).
  return;
}

const { address, signatures } = await SolanaMwa.authorizeAndSignAndSend({
  cluster: 'solana:mainnet',
  identityName: 'My App',
  identityUri: 'https://example.com',
  iconRelativeUri: 'favicon.ico', // relative to identityUri, not absolute
  payloads: [base64EncodedTransaction],
});
// address and signatures are base58. Base64 in, base58 out.
```

### `walletAvailable()` answers "is there a wallet", not "is this a Solana phone"

A Seeker or Saga with no wallet endpoint returns `false`; a stock Android handset with Phantom installed returns `true`. Gate on this, never on device model or user agent.

### Why authorize and sign are one call

`signAndSendTransactions` on the native client takes **no auth token** — authorization is bound to the live association session. Splitting this into two plugin methods would force the plugin to hold a `LocalAssociationScenario` open across two JavaScript round trips, leaking the local port and racing the wallet's activity result. One call, one session.

## Example app

`example/` is a runnable Capacitor app used to exercise the plugin on a real device. It targets **devnet** and signs a **1-lamport self-transfer**, so nothing of value moves and no third-party endpoint is involved.

```bash
cd example
npm install
npm run build:android   # bundle + cap sync + assembleDebug
```

It checks for a wallet on load, and before reporting success it **asserts that the authorized address is the one you entered**, aborting on a mismatch. That matters because the wallet shows an account picker: if the handset holds more than one account, a mis-tap authorizes the wrong wallet, and `authorize()` hands the public key back so this is free to check.

## Errors

Rejections carry a `code`, because the entire reason to prefer MWA over a deeplink is that a deeplink cannot tell "in flight" from "failed". Collapsing every cause into one rejection would throw away the property you came for.

| code | meaning |
| --- | --- |
| `NO_WALLET` | nothing on the device implements the MWA endpoint |
| `DECLINED` | the user dismissed or rejected the wallet UI |
| `ASSOCIATION_TIMEOUT` | the wallet never connected back within `timeoutMs` |
| `SIGN_FAILED` | the wallet reported a failure signing or submitting |
| `NOT_SUBMITTED` | signed, but the wallet did not submit it to the cluster |
| `INVALID_PAYLOAD` | a payload was missing or not valid base64 |
| `UNSUPPORTED_PLATFORM` | called on web or iOS |

Payloads are decoded **before** any wallet UI is shown, so a malformed transaction fails immediately rather than after a round trip.

## Notes for contributors

- **`nv-websocket-client` arrives transitively at `<scope>runtime</scope>`**, so it is absent from the compile classpath. Do not conclude from a compile-classpath audit that the client library has no third-party dependencies — that transitive dependency *is* the entire transport, and a missing runtime dependency compiles perfectly and then throws `NoClassDefFoundError` on the first association. Check `:dependencies --configuration debugRuntimeClasspath`.
- **`new LocalAssociationScenario(int)` takes a timeout in milliseconds, not a port.** The port is read back out via `getPort()`. Passing a port compiles fine and associates against nothing.
- **The Maven group is `com.solanamobile`; the Java package is `com.solana.mobilewalletadapter.clientlib`.** Imports guessed from the coordinate will not resolve.
- The scenario's futures block, so they must not run on the main thread, and `scenario.close()` belongs in a `finally` — an unclosed scenario leaks the local port and the next attempt then fails for a reason that looks nothing like the cause.
- `--` is illegal inside an XML comment, and the manifest merger reports it as `Error parsing AndroidManifest.xml` with no line number. Validate the manifest before running a build.

## Contact

Bugs and questions are best raised as a GitHub issue. For anything that does not belong in public, email info@arkaseeker.com.

## License

MIT
