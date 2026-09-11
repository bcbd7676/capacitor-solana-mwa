# capacitor-solana-mwa

Solana [Mobile Wallet Adapter](https://docs.solanamobile.com/) for [Capacitor](https://capacitorjs.com/) apps on Android.

> **Status: pre-release (0.1.0). Device-proven.** A full `authorize` + `signAndSendTransactions` round trip has been completed against Phantom on a Samsung Galaxy S10 (Android 12), devnet, Sep 10 2026 — transaction [`3G3SqCPG…kKzvCp`](https://explorer.solana.com/tx/3G3SqCPGVU4YT16S4HR2AD3bUYVUMdMCvsxJsK4612wp2UjSJfXLFdVgC5fgyddSMAi9DZBSwkmCJtWXV9kKzvCp?cluster=devnet), finalized, `err: null`, confirmed by `getSignatureStatuses` rather than by the app's own report.
>
> **What that does and does not cover.** Devnet only, and there is no test suite. **Phantom passes on two handsets** (Galaxy S10 / Android 12, and Seeker / Android 16). **Seed Vault 1.16.0 on a Seeker does NOT complete** — association and session establish and the wallet reads its own vault, but it never presents an approval UI and never answers the request. That is characterised, with the six ruled-out explanations and the same-device Phantom control, under [Wallet compatibility](#wallet-compatibility). **MWA's whole point is that the wallet is pluggable, so a pass on one is not a pass on another — and this is the case that proves it.** Treat the plugin as working-but-young, and do not put it on a money path without testing the path you actually use.

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

It has **two fields, and both are required**: an RPC endpoint and the wallet address to use as fee
payer. The endpoint is a field rather than a baked-in default because the public devnet RPC refuses
`localhost` origins (see Field notes), so there is no default that would work — and because an API
key does not belong in a public repository. Both persist to `localStorage`, since typing base58 on a
phone keyboard is where device testing goes to die.

**On Windows, `npm run build:android` silently fails its gradle step** — npm runs scripts through
`cmd.exe`, where `./gradlew` is not a command, so the sync succeeds and the build never runs and you
install yesterday's APK. Run `cd android && ./gradlew assembleDebug` from a POSIX shell instead.

It checks for a wallet on load, and before reporting success it **asserts that the authorized address is the one you entered**, aborting on a mismatch. That matters because the wallet shows an account picker: if the handset holds more than one account, a mis-tap authorizes the wrong wallet, and `authorize()` hands the public key back so this is free to check.

## Field notes — four things that cost an evening

All four were found bringing this plugin up on a real device on Sep 10 2026. None is documented
anywhere I could find, and each one presents as a symptom that names the wrong culprit. They are
listed by **symptom**, because that is what you will be searching for at midnight.

### `ASSOCIATION_TIMEOUT` / `ECONNREFUSED` from a port that is definitely listening

**Cause: Android Battery Saver.** MWA local association requires your app — which is now in the
*background*, because it just launched the wallet — to hold an outbound socket to the wallet's local
WebSocket server. Battery Saver activates the `powersave` netd firewall chain, and a backgrounded
app's UID gets `rules=64 (REJECT_ALL)`. A firewall REJECT surfaces as `ECONNREFUSED`, which reads
exactly like "nothing is listening".

It is not subtle once you look, and it is invisible until you do:

```
19:16:48.101  Firewall rule changed: 10558-powersave-allow      ← foreground, allowed
19:16:56.355  Firewall rule changed: 10558-powersave-default    ← backgrounded, REJECT_ALL
19:16:56.913  Phantom: onScenarioReady                          ← wallet listening, happily
                     34 connect attempts over 36 seconds, all refused
```

The tell that settles it in one command: `adb shell` is not subject to those chains, so it can
connect to the very port your app cannot.

```bash
adb shell "dumpsys netpolicy | grep 'UID=<your uid>'"     # rules=64 (REJECT_ALL) is the smoking gun
adb shell "echo | nc -w 3 127.0.0.1 <port>; echo \$?"      # 0 from shell + refused in-app = firewall
```

**This is not Capacitor-specific and not plugin-specific — it breaks any MWA app on any framework.**
Turn Battery Saver off, or exempt your app from battery optimisation.

### `TypeError: Failed to fetch` when getting a blockhash

**Cause: `api.devnet.solana.com` returns 403 to any request carrying a `localhost` origin.** A
Capacitor Android WebView's origin is exactly `https://localhost`, so the public endpoint refuses
every Capacitor app by construction. Measured from one IP within seconds of each other:

| `Origin` | result |
| --- | --- |
| `https://localhost` | **403** |
| `http://localhost` | **403** |
| `https://example.com` | 200 |
| *(no Origin header)* | 200 |

The browser converts a 403 on the CORS preflight into a bare `TypeError: Failed to fetch`, naming
neither the status nor the cause. **Use your own RPC endpoint.** This has nothing to do with MWA —
it bites any Capacitor app talking to Solana from JavaScript.

### `SIGN_FAILED — Timed out waiting for response`, with the wallet still on screen

**Cause: a timeout chosen for machines when the counterparty is a person.** This library's default
was 20 seconds; a real approval — read a security warning, pick an account, maybe a biometric — took
26. The default is now **90 seconds**; pass `timeoutMs` to change it.

### Phantom rejects the sign request with `invalid_type` on `minContextSlot`

**Cause: an interop divergence.** `min_context_slot` is **optional** in the MWA specification, and
Phantom's schema validation makes it **required**:

```json
{ "code": "invalid_type", "expected": "number", "received": "undefined",
  "path": ["params", "minContextSlot"], "message": "Required" }
```

So a spec-compliant omission is a failure in practice. Pass `minContextSlot` — it is
`context.slot` from `getLatestBlockhashAndContext()`, which is why the example uses that variant
rather than plain `getLatestBlockhash()`.

### Bonus: "this app could not be verified"

Expected, and not a defect. The wallet tries to verify the dApp identity against `identityUri`; the
example declares the placeholder `https://example.com`, which hosts no association for it. Point
`identityUri` at a domain you control to get rid of the warning.

## Wallet compatibility

Measured on hardware, not inferred. Every row is a real run against a real wallet.

| wallet | device | `walletAvailable()` | association + session | wallet UI | wallet responds | round trip |
| --- | --- | --- | --- | --- | --- | --- |
| Phantom 26.6.0 | Galaxy S10, Android 12 | yes | yes | renders | yes | **yes — signature `3G3SqCPG…kKzvCp`** |
| Phantom 26.6.0 | Seeker, Android 16 | yes | yes | renders | yes — MWA protocol errors | not attempted (unfunded test wallet) |
| Seed Vault wallet 1.16.0 (build 19824) | Seeker, Android 16 | yes | yes | **never renders** | **never responds** | no |

### Seed Vault wallet 1.16.0 — association succeeds, the request is never answered

**This is a wallet-side observation, and it is deliberately worded narrowly: what is established is that
*this* dApp cannot complete MWA with *this* wallet build. The plugin has not been tested against Seed
Vault from a non-Capacitor dApp, so nothing here supports the broader claim that the wallet's MWA is
broken in general.**

Everything up to the approval is healthy. The association is created, retried with backoff while the
wallet starts, and establishes; the wallet then reads its own vault successfully:

```
15:04:20.020  LocalAssociationScenario: Creating local association scenario for ws://127.0.0.1:54536/solana-wallet
15:04:20.196  LocalAssociationScenario: Connect attempt failed, retrying in 150 ms      <- wallet still starting
              ... backoff 200, 500, 500, 750, 750, 1000 ms ...
15:04:30.097  SeekerWalletSMS: getAuthorizedSeeds success - found 1 seed(s)
15:04:30.148  LocalAssociationScenario: WebSocket connection established
15:04:30.160  LocalAssociationScenario: Session established, scenario ready for use
15:04:30.154  receiverMessageReceived: size=129        <- encrypted session traffic, both directions
15:06:03.890  FAILED [SIGN_FAILED] Timed out waiting for response with id=1
```

**No approval UI is ever drawn.** `MWABottomSheetActivity` becomes the top resumed activity and dims the
dApp behind it, but `BufferQueueProducer` reports a single frame and then `fps=0.03` — one paint, then
nothing. There is no prompt, nothing to tap, and the request expires at the 90s timeout.

**Reproduced six times across two builds.** Ruled out, each by a separate run:

| hypothesis | how it was killed |
| --- | --- |
| user missed a biometric prompt | no prompt is drawn; the `BiometricService` lines are capability checks, not prompts |
| screen timeout hid the sheet | reproduced with the screen held awake |
| notification shade stole focus | reproduced with the shade closed |
| icon fetch blocking the sheet | reproduced with `iconRelativeUri` omitted entirely |
| wallet not on the requested cluster | reproduced with the wallet explicitly in devnet mode |
| screenshot protection hiding a real sheet | Phantom blanks captures via `FLAG_SECURE`; Seed Vault's did not — the dApp was visible underneath, so the sheet was genuinely empty |

**The control is the valuable half.** The *same APK*, on the *same device*, in the *same session*, drives
Phantom 26.6.0 to a rendered sheet and to real protocol-level replies — `-3/sign request declined` and a
`CancellationException`, which this plugin maps to `SIGN_FAILED` and `DECLINED` respectively. So the
association code, the session layer, the payload and the error mapping are all exercised and correct on
that hardware. The difference is the wallet.

To reproduce: install the example app on a Seeker, set an RPC endpoint that does not 403 a `localhost`
origin (see the blockhash field note), put any valid base58 address in the fee-payer field, and tap
**Authorize + sign + send**. Seed Vault must be the handler — if Phantom or Jupiter is also installed,
Android may offer a chooser.

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
