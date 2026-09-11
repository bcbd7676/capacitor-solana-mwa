# capacitor-solana-mwa

Solana [Mobile Wallet Adapter](https://docs.solanamobile.com/) for [Capacitor](https://capacitorjs.com/) apps on Android.

> **Status: pre-release (0.1.0). Device-proven.** A full `authorize` + `signAndSendTransactions` round trip has been completed against Phantom on a Samsung Galaxy S10 (Android 12), devnet, Sep 10 2026 — transaction [`3G3SqCPG…kKzvCp`](https://explorer.solana.com/tx/3G3SqCPGVU4YT16S4HR2AD3bUYVUMdMCvsxJsK4612wp2UjSJfXLFdVgC5fgyddSMAi9DZBSwkmCJtWXV9kKzvCp?cluster=devnet), finalized, `err: null`, confirmed by `getSignatureStatuses` rather than by the app's own report.
>
> **What that does and does not cover.** Devnet only, and there is no test suite. **Phantom passes on two handsets** (Galaxy S10 / Android 12, and Seeker / Android 16) and **Seed Vault wallet 1.16.0 passes on a Seeker** — three round trips, each signature verified on chain rather than from the client's claim of success. **THE TWO WALLETS NEED DIFFERENT AUTHORIZE REQUESTS: Phantom falls back to a legacy MWA 1.x session and Seed Vault negotiates 2.0, and the client library sends whichever overload you call regardless.** This plugin therefore asks the wallet what it is, via `get_capabilities`, before it asks it for anything — see [Wallet compatibility](#wallet-compatibility), which also records the earlier version of this line reporting Seed Vault as broken when the fault was ours. **MWA's whole point is that the wallet is pluggable, so a pass on one is not a pass on another.** Treat the plugin as working-but-young, and do not put it on a money path without testing the path you actually use.

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

Measured on hardware, not inferred. Every row is a real run against a real wallet, and every signature below
was verified by reading the transaction back from the cluster rather than trusting the client.

| wallet | device | session | authorize shape it needs | round trip |
| --- | --- | --- | --- | --- |
| Phantom 26.6.0 | Galaxy S10, Android 12 | legacy | 1.x (`cluster`) | yes — `3G3SqCPG…kKzvCp` (predates the negotiation change) |
| Phantom 26.6.0 | Seeker, Android 16 | legacy | 1.x (`cluster`) | **yes — `2iCSVNJc…fdULWFg`** |
| Seed Vault wallet 1.16.0 (build 19824) | Seeker, Android 16 | **properties v1 (MWA 2.0)** | **2.0 (`chain`)** | **yes — `5oFoCRHZ…5po4bjvV`** |

The two Seeker signatures are from the SAME build, minutes apart, each verified on chain. The S10 row is
kept because the handset is not to hand, and is labelled rather than quietly presented as current.

### The two wallets do not speak the same protocol version, and this library will not notice

**THIS IS THE THING WORTH TAKING AWAY FROM THIS REPO.** Two wallets on one handset, consecutive runs of the
same APK, negotiate differently:

```
Phantom 26.6.0  : MobileWalletAdapterSession: could not parse session properties, falling back on legacy session
Seed Vault 1.16 : MobileWalletAdapterSession: Received session properties: version = 1
```

`mobile-wallet-adapter-clientlib` 2.1.0 offers two `authorize` overloads and **sends whichever one you call,
with no regard for what the session negotiated:**

```java
authorize(Uri, Uri, String, String)                    // 1.x -- sends "cluster"   (deprecated)
authorize(Uri, Uri, String, String, String, String[], byte[][], SignInWithSolana.Payload)
                                                       // 2.0 -- sends "chain"
```

**SEND THE 1.x SHAPE TO A 2.0 WALLET AND SEED VAULT DRAWS A SHEET WITH NOTHING IN IT AND NEVER REPLIES.** The
association is healthy, the encrypted session is established, the wallet reads its own vault
(`getAuthorizedSeeds success - found 1 seed(s)`), and then the request expires. What you see is a full-screen,
`VISIBLE`, `HAS_DRAWN` window with your dApp showing through it undimmed, repainting at `fps=0.03` until
somebody gives up.

**So this plugin asks the session what it negotiated, and does not infer it:**

```java
scenario.getSession().getSessionProperties().protocolVersion   // LEGACY | V1
```

`LocalAssociationScenario.getSession()` is public, costs no round trip, and is the exact value the library
itself prints to logcat -- so the code and the log can never disagree. It fails TOWARDS legacy if that read
throws, because a wrong guess towards 2.0 silently drops the network (see below), which is worse than being
refused.

**>>> AN EARLIER VERSION GUESSED FROM `get_capabilities` INSTEAD, ON THE THEORY THAT A WALLET ADVERTISING
OPTIONAL FEATURES ANSWERS IN 2.0 TERMS. MEASURED ON HARDWARE, THAT SIGNAL HAS NO DISCRIMINATING POWER AT
ALL. <<<** Both wallets return **identical** capabilities while negotiating **opposite** session versions:

| wallet | session | `get_capabilities` |
| --- | --- | --- |
| Phantom 26.6.0 | legacy | `optionalFeatures=1, signAndSend=false` |
| Seed Vault 1.16.0 | v1 | `optionalFeatures=1, signAndSend=false` |

It cost a real regression, and the symptom is worth knowing because it names the wrong thing: **Phantom got
the 2.0 request, which carries `chain` and no `cluster`, so it saw no network at all and defaulted to
mainnet** -- surfacing to the user as *"this app is trying to use mainnet, but you are in testnet mode"*. A
network error, from a protocol-version bug.

### Two gotchas that cost an evening each

**>>> THE WALLET MUST BE ON THE SAME NETWORK AS THE CLUSTER YOU REQUEST, AND A HEALTHY WALLET SAYS SO. <<<**
Seed Vault set to mainnet, asked to authorize `solana:devnet`, shows a clear "network mismatch" dialog and
returns a real protocol error. **THE SAME MISMATCH UNDER THE WRONG AUTHORIZE SHAPE IS THE SILENT EMPTY SHEET
ABOVE** -- which is almost certainly what the empty sheet always was: a dialog the wallet could not render
because it could not interpret the request that provoked it.

**>>> DO NOT GATE ON `supportsSignAndSendTransactions`. *BOTH* WALLETS REPORT `false` AND *BOTH* THEN PERFORM
SIGN-AND-SEND SUCCESSFULLY. <<<** Measured on each: `optionalFeatures=1 signAndSend=false`, followed by a
completed `sign_and_send_transactions` and a confirmed devnet signature. The capability flag and the
behaviour disagree, so trust the behaviour. This plugin does not read that field at all.

### A correction, kept deliberately

**AN EARLIER VERSION OF THIS SECTION REPORTED THAT SEED VAULT 1.16.0 "DOES NOT COMPLETE MWA", WITH EIGHT
HYPOTHESES RULED OUT ACROSS EIGHT CONTROLLED RUNS. THAT CONCLUSION WAS WRONG, AND THE FAULT WAS THIS
PLUGIN'S.** It is recorded here rather than quietly deleted, because the failure mode is instructive and
because the report was one edit away from being sent to the wallet's authors as a bug in their software.

**WHAT THE EIGHT RUNS ACTUALLY ESTABLISHED WAS THAT THE CAUSE WAS NOT ANY OF THE EIGHT THINGS TESTED.** Each
hypothesis was killed honestly and the conclusion still did not follow: "not A through H" is not "the wallet
is broken", and the gap between those two was never closed by evidence. The control -- Phantom succeeding on
the same handset in the same session -- felt like it isolated the wallet, and it did not: **both wallets were
exercised through the same code path, but that code path was correct for exactly one of them.** A control
only isolates the variable you actually varied.

**WHAT WOULD HAVE CAUGHT IT SOONER: the compiler said so.** Building this plugin emits `uses or overrides a
deprecated API` -- the 1.x `authorize` -- and that warning sat in the build output through every one of those
runs. **AND ONE LINE OF THE WALLET'S OWN LOGGING NAMED THE PROBLEM** (`Received session properties: version =
1`); it was captured, and read as noise, because the investigation was looking for a reason the wallet was
at fault.

**THE PART THAT IS STILL NOT ISOLATED, STATED PLAINLY: the run that first rendered a sheet changed TWO
variables** -- the wallet process was restarted AND the authorize shape changed. The network mismatch was a
third factor discovered immediately after. So "the 1.x shape causes the empty sheet" is the leading
explanation and is consistent with everything observed, **but it has not been isolated by a controlled run,
and it should not be written up as though it had.**

### Reproducing any of this

Install the example app on a Seeker, set an RPC endpoint that does not 403 a `localhost` origin (see the
blockhash field note), put **the address of the account that wallet actually holds** in the fee-payer field,
and tap **Authorize + sign + send**.

**>>> THE FEE PAYER MUST BE AN ACCOUNT THE WALLET CAN SIGN FOR, AND GETTING IT WRONG IS NOT A CLEAN ERROR. <<<**
An earlier version of this line said "any valid base58 address". Pointed at an address Phantom does not hold,
Phantom rendered its sheet, took a fingerprint, accepted the approval -- and then never returned a result, so
the plugin reported `ASSOCIATION_TIMEOUT`. Nothing reached the chain. **A timeout AFTER a sheet rendered and
the user approved is a wrong fee payer; a timeout with NO sheet is a protocol-shape or network mismatch.**

**AND RESTART THE WALLET BETWEEN FAILED RUNS.** After roughly six failed associations the Seed Vault wallet
began closing the session ~50 ms after launch (`mobile-wallet-adapter session closed`) and never connected
back to the local socket at all, giving `Failed establishing a WebSocket connection`. Swiping it from recents
cleared it every time. **A wallet that has been left holding half-dead sessions is not a clean test
subject** -- and several of the eight "controlled" runs above were taken against one.


## Errors

Rejections carry a `code`, because the entire reason to prefer MWA over a deeplink is that a deeplink cannot tell "in flight" from "failed". Collapsing every cause into one rejection would throw away the property you came for.

| code | meaning |
| --- | --- |
| `NO_WALLET` | nothing on the device implements the MWA endpoint |
| `DECLINED` | the user dismissed or rejected the wallet UI |
| `ASSOCIATION_TIMEOUT` | the wallet never connected back, or never answered, within `timeoutMs` |
| `ALREADY_IN_FLIGHT` | another wallet interaction is still running — see below |
| `SIGN_FAILED` | the wallet reported a failure signing or submitting |
| `NOT_SUBMITTED` | signed, but the wallet did not submit it to the cluster |
| `INVALID_PAYLOAD` | a payload was missing or not valid base64 |
| `UNSUPPORTED_PLATFORM` | called on web or iOS |

Payloads are decoded **before** any wallet UI is shown, so a malformed transaction fails immediately rather than after a round trip.

### One interaction at a time, and one deadline across all three stages

**A second concurrent call is rejected immediately with `ALREADY_IN_FLIGHT` rather than queued.** A user cannot approve two wallet prompts at once, so a second call can only be a mis-tap or an impatient retry — and queueing it caused a real hang.

On a Seeker, four taps against a wallet that never answered left the app unusable until the handset was restarted. The mechanism is the interaction between two lines that each look correct: `startActivityForResult` fires on the caller's thread per tap, but sessions run on a **single-threaded** executor. So every tap launched a wallet while only the first tap's session actually ran; the rest queued behind a blocking `get()`, each having already allocated a local port that `scenario.close()` — living in the session's `finally` — could never reach. Four taps meant four leaked ports, four unsettled promises and a queue minutes deep.

**`timeoutMs` is a deadline across association, authorize and sign — not a timeout for each.** Three separate timeouts would let a wallet occupy the worker for `3 × timeoutMs` while appearing to honour the value you passed. Exceeding it yields `ASSOCIATION_TIMEOUT`, or `DECLINED` if the user had already backed out of the wallet.

Those `get()` calls were previously **unbounded**, relying entirely on the client library's internal timeouts. Those do fire in practice — Seed Vault's failures arrived as "Timed out waiting for response" — but a plugin that delegates its own liveness to a dependency has no answer when the dependency does not.

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
