package com.arkaseeker.capacitor.mwa;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient;
import com.solana.mobilewalletadapter.clientlib.scenario.LocalAssociationIntentCreator;
import com.solana.mobilewalletadapter.clientlib.scenario.LocalAssociationScenario;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "SolanaMwa")
public class SolanaMwaPlugin extends Plugin {

    private static final String TAG = "SolanaMwa";

    // >>> 90 SECONDS, NOT 20, AND THE REASON IS A DEVICE MEASUREMENT RATHER THAN A GUESS.
    // This value bounds BOTH the association and the wait for each JSON-RPC response,
    // and the second of those is a HUMAN sitting in the wallet's approval screen. On
    // Sep 10 2026 a real run failed with SIGN_FAILED "Timed out waiting for response
    // with id=2": the session established at 19:25:53.402 and the request expired at
    // 19:26:19.861 while the user was still reading Phantom's "this app could not be
    // verified" warning. Authorize had already succeeded, so the association was fine;
    // only the clock was wrong.
    //
    // A wallet may show a security warning, ask the user to pick an account, or require
    // a biometric -- so anything on the order of a few seconds is a value chosen for a
    // machine when the counterparty is a person. Callers who want the old behaviour can
    // still pass timeoutMs explicitly.
    private static final int DEFAULT_TIMEOUT_MS = 90000;

    // Deliberately SMALL and separate from the main deadline: this is a machine-to-machine
    // request with no human in it, so a wallet that has not answered in this long is not
    // going to. Spending the user's whole budget waiting for a discovery call would turn a
    // helpful probe into the thing that causes the timeout.
    private static final long CAPABILITIES_PROBE_SECONDS = 10;

    /**
     * The scenario's futures BLOCK. They must never run on the main thread: a
     * blocking get() on the UI thread is an ANR, and an app with few sessions
     * cannot rely on Play vitals to notice, so it would ship invisibly.
     */
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    /**
     * >>> ONE WALLET INTERACTION AT A TIME, REJECTED FAST RATHER THAN QUEUED. <<<
     *
     * This is the fix for a REAL HANG, found on a Seeker on Sep 11 2026: four taps
     * against a wallet that never answered left the app unusable until the handset
     * was restarted.
     *
     * The mechanism is the interaction between two correct-looking lines. The worker
     * is SINGLE-THREADED (deliberately -- see above), but startActivityForResult fires
     * on the caller's thread BEFORE the session is queued. So every tap launched a
     * wallet while only the first tap's runSession actually ran; the rest sat in the
     * queue behind a get() blocking for the full timeout. Their scenarios had already
     * allocated local ports, and scenario.close() lives in runSession's finally, which
     * a queued task never reaches. Four taps therefore meant four leaked ports, four
     * unsettled promises, and a queue minutes deep.
     *
     * QUEUEING IS THE WRONG SEMANTIC ANYWAY: a user cannot approve two wallet prompts
     * at once, so a second concurrent call can only ever be a mis-tap or an impatient
     * retry. Failing it immediately is both honest and what makes the hang impossible.
     */
    private final AtomicBoolean inFlight = new AtomicBoolean(false);

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    /** Per-call state, so two overlapping flows cannot corrupt each other. */
    private static final class Session {
        final AtomicBoolean settled = new AtomicBoolean(false);
        final AtomicBoolean userCancelled = new AtomicBoolean(false);
    }

    @PluginMethod
    public void walletAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        // The honest capability test: is a wallet ENDPOINT installed. Not "is this
        // a Solana phone" -- a Seeker without a wallet is false, a stock handset
        // with Phantom is true.
        ret.put("available", LocalAssociationIntentCreator
                .isWalletEndpointAvailable(getContext().getPackageManager()));
        call.resolve(ret);
    }

    @PluginMethod
    public void authorizeAndSignAndSend(PluginCall call) {
        final String cluster = call.getString("cluster", "solana:mainnet");
        final String identityName = call.getString("identityName", "");
        final String identityUri = call.getString("identityUri");
        final String iconRelativeUri = call.getString("iconRelativeUri");
        final int timeoutMs = call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS);
        // OPTIONAL IN THE MWA SPEC, REQUIRED BY PHANTOM. Measured Sep 10 2026: passing
        // null made Phantom reject sol_mwa_sign_and_send_transactions with
        // {"code":"invalid_type","expected":"number","received":"undefined",
        // "path":["params","minContextSlot"],"message":"Required"} -- so a spec-compliant
        // omission is an interop failure in practice. Callers should pass the slot from
        // getLatestBlockhashAndContext(); it is still allowed to be absent here.
        final Integer minContextSlot = call.getInt("minContextSlot", null);

        if (identityUri == null || identityUri.isEmpty()) {
            call.reject("identityUri is required", "INVALID_PAYLOAD");
            return;
        }

        // Decode payloads UP FRONT, before any wallet UI is shown. A malformed
        // payload should fail immediately rather than after the user has been sent
        // to their wallet and back.
        final byte[][] payloads;
        try {
            payloads = decodePayloads(call.getArray("payloads"));
        } catch (Exception e) {
            call.reject("payloads must be a non-empty array of base64 strings", "INVALID_PAYLOAD");
            return;
        }

        if (!LocalAssociationIntentCreator.isWalletEndpointAvailable(getContext().getPackageManager())) {
            call.reject("No Mobile Wallet Adapter wallet is installed", "NO_WALLET");
            return;
        }

        // Claim the slot BEFORE allocating a scenario, so a rejected concurrent call
        // never creates a port it will not close.
        if (!inFlight.compareAndSet(false, true)) {
            call.reject("A wallet interaction is already in progress", "ALREADY_IN_FLIGHT");
            return;
        }

        final LocalAssociationScenario scenario;
        final Intent associationIntent;
        try {
            // The int is a TIMEOUT IN MILLISECONDS, not a port. The port is read
            // back out of the scenario and handed to the intent creator. Passing a
            // port here compiles fine and associates against nothing.
            scenario = new LocalAssociationScenario(timeoutMs);
            associationIntent = LocalAssociationIntentCreator.createAssociationIntent(
                    null /* default endpoint prefix */, scenario.getPort(), scenario.getSession());
        } catch (Exception e) {
            inFlight.set(false);
            call.reject("Could not start a local association: " + e.getMessage(), "SIGN_FAILED");
            return;
        }

        if (associationIntent == null) {
            // Release AND close: the scenario above already holds a port.
            inFlight.set(false);
            try { scenario.close(); } catch (Throwable ignored) { }
            call.reject("No wallet could handle the association intent", "NO_WALLET");
            return;
        }

        final Session session = new Session();
        sessions.put(call.getCallbackId(), session);
        call.setKeepAlive(true);

        // Launch the wallet, then drive the session off-thread. The activity result
        // is NOT the authoritative signal -- the scenario is -- so it is used only
        // to turn a silent association timeout into an honest "user declined".
        startActivityForResult(call, associationIntent, "walletResult");

        worker.execute(() -> runSession(call, session, scenario, payloads,
                cluster, identityName, identityUri, iconRelativeUri, minContextSlot, timeoutMs));
    }

    private void runSession(PluginCall call, Session session, LocalAssociationScenario scenario,
                            byte[][] payloads, String cluster, String identityName,
                            String identityUri, String iconRelativeUri, Integer minContextSlot,
                            int timeoutMs) {
        // >>> ONE DEADLINE ACROSS ALL THREE STAGES, NOT A TIMEOUT EACH. <<<
        // Three separate timeouts would let a wallet hold the single worker thread for
        // 3x timeoutMs while appearing to respect the caller's value. A deadline is
        // also what the caller actually asked for: "do not take longer than this".
        //
        // These get() calls were previously UNBOUNDED, relying entirely on the client
        // library's internal timeouts. Those do fire -- Seed Vault's failures arrived
        // as "Timed out waiting for response" -- but a plugin that hands its liveness
        // to a dependency has no answer when the dependency does not.
        final long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        try {
            MobileWalletAdapterClient client = scenario.start().get(remaining(deadline), TimeUnit.NANOSECONDS);

            MobileWalletAdapterClient.AuthorizationResult auth = authorizeNegotiated(
                    client, identityUri, iconRelativeUri, identityName, cluster, deadline);

            // No authToken argument on signAndSendTransactions: authorization is
            // bound to THIS session, which is why authorize and sign live in one
            // plugin call rather than two.
            MobileWalletAdapterClient.SignAndSendTransactionsResult signed =
                    client.signAndSendTransactions(payloads, minContextSlot)
                            .get(remaining(deadline), TimeUnit.NANOSECONDS);

            JSArray signatures = new JSArray();
            if (signed.signatures != null) {
                for (byte[] sig : signed.signatures) {
                    signatures.put(Base58.encode(sig));
                }
            }

            JSObject ret = new JSObject();
            ret.put("address", Base58.encode(auth.publicKey));
            ret.put("signatures", signatures);
            ret.put("authToken", auth.authToken);
            if (auth.accountLabel != null) ret.put("accountLabel", auth.accountLabel);

            settle(call, session, () -> call.resolve(ret));
        } catch (Throwable t) {
            final Throwable cause = t.getCause() != null ? t.getCause() : t;
            final String code = classify(cause, session);
            final String message = cause.getMessage() == null
                    ? cause.getClass().getSimpleName()
                    : cause.getMessage();
            settle(call, session, () -> call.reject(message, code));
        } finally {
            // Always close. An unclosed scenario leaks the local port, and the NEXT
            // attempt then fails for a reason that looks nothing like the cause.
            try {
                scenario.close();
            } catch (Throwable ignored) {
                // Closing is best-effort; a failure here must not mask the real result.
            }
            sessions.remove(call.getCallbackId());
            // Last, and only after the port is released: let the next call in.
            inFlight.set(false);
        }
    }

    /**
     * Map each failure to its own code. The entire argument for MWA over a
     * deeplink is that a deeplink cannot distinguish "in flight" from "failed";
     * collapsing every cause into one rejection would throw that away.
     */
    /**
     * >>> ASK THE WALLET WHAT PROTOCOL IT SPEAKS BEFORE ASKING IT FOR A SIGNATURE. <<<
     *
     * MWA has two authorize shapes and this library will send whichever overload you
     * call, with no regard for what the session negotiated: the four-argument form
     * sends `cluster` (1.x) and the eight-argument form sends `chain` (2.0). Send the
     * wrong one and a strict wallet has a request it cannot interpret.
     *
     * WHY THIS IS NOT PARANOIA -- the two wallets on one Seeker negotiate DIFFERENTLY,
     * measured Sep 11 2026 in consecutive runs of the same APK:
     *
     *   Phantom 26.6.0 : could not parse session properties, falling back on legacy session
     *   Seed Vault 1.16: Received session properties: version = 1
     *
     * `get_capabilities` is the protocol's own discovery call and it renders NO UI, so
     * it costs the user nothing and tells us which shape to send. A wallet advertising
     * optional features is answering in 2.0 terms.
     *
     * IT FAILS SAFE, AND THAT IS THE POINT OF THE SEPARATE BUDGET: if the probe times
     * out we fall through to the legacy shape, which is exactly what this plugin sent
     * before and is device-proven against Phantom on two handsets. The worst case is
     * today's behaviour, reached a few seconds later -- never a new failure mode.
     */
    private MobileWalletAdapterClient.AuthorizationResult authorizeNegotiated(
            MobileWalletAdapterClient client, String identityUri, String iconRelativeUri,
            String identityName, String cluster, long deadline) throws Exception {

        final Uri idUri = Uri.parse(identityUri);
        final Uri iconUri = iconRelativeUri == null ? null : Uri.parse(iconRelativeUri);

        boolean walletSpeaksV2 = false;
        try {
            long probeBudget = Math.min(remaining(deadline),
                    TimeUnit.SECONDS.toNanos(CAPABILITIES_PROBE_SECONDS));
            MobileWalletAdapterClient.GetCapabilitiesResult caps =
                    client.getCapabilities().get(probeBudget, TimeUnit.NANOSECONDS);
            walletSpeaksV2 = caps.supportedOptionalFeatures != null
                    && caps.supportedOptionalFeatures.length > 0;
            Log.i(TAG, "get_capabilities answered: optionalFeatures="
                    + (caps.supportedOptionalFeatures == null
                        ? "null" : String.valueOf(caps.supportedOptionalFeatures.length))
                    + " signAndSend=" + caps.supportsSignAndSendTransactions
                    + " -> sending the " + (walletSpeaksV2 ? "2.0 (chain)" : "legacy (cluster)")
                    + " authorize");
        } catch (TimeoutException e) {
            // The wallet did not answer a request that draws no UI at all. That is worth
            // saying out loud, because it means the silence is not about the approval.
            Log.w(TAG, "get_capabilities did not answer within " + CAPABILITIES_PROBE_SECONDS
                    + "s -- the wallet is ignoring a NON-UI request. Falling back to the"
                    + " legacy authorize.");
        } catch (Exception e) {
            Log.w(TAG, "get_capabilities failed (" + e.getClass().getSimpleName()
                    + "), falling back to the legacy authorize", e);
        }

        if (walletSpeaksV2) {
            // `cluster` and `chain` carry the same identifiers ("solana:devnet"), so the
            // caller's value needs no translation -- only the parameter it lands in.
            return client.authorize(idUri, iconUri, identityName, cluster,
                    null /* authToken */, null /* features */, null /* addresses */,
                    null /* signInPayload */).get(remaining(deadline), TimeUnit.NANOSECONDS);
        }
        return client.authorize(idUri, iconUri, identityName, cluster)
                .get(remaining(deadline), TimeUnit.NANOSECONDS);
    }

    /** Nanoseconds left before the deadline, never negative -- get(0) fails fast. */
    private static long remaining(long deadline) {
        return Math.max(0L, deadline - System.nanoTime());
    }

    private String classify(Throwable cause, Session session) {
        // Our own deadline elapsing is an association timeout from the caller's point
        // of view: the wallet never came back. Reported distinctly from a library
        // failure so the two are not confused when debugging.
        if (cause instanceof TimeoutException) {
            return session.userCancelled.get() ? "DECLINED" : "ASSOCIATION_TIMEOUT";
        }
        if (cause instanceof MobileWalletAdapterClient.InvalidPayloadsException) {
            return "INVALID_PAYLOAD";
        }
        if (cause instanceof MobileWalletAdapterClient.NotSubmittedException) {
            return "NOT_SUBMITTED";
        }
        if (cause instanceof LocalAssociationScenario.ConnectionFailedException) {
            // The wallet never connected back. If the user dismissed it, say so --
            // "timed out" would be technically true and actively misleading.
            return session.userCancelled.get() ? "DECLINED" : "ASSOCIATION_TIMEOUT";
        }
        if (session.userCancelled.get()) {
            return "DECLINED";
        }
        return "SIGN_FAILED";
    }

    private void settle(PluginCall call, Session session, Runnable action) {
        // Whichever finishes first -- the worker or the cancelled activity -- wins.
        // Resolving a Capacitor call twice is a hard error.
        if (session.settled.compareAndSet(false, true)) {
            call.setKeepAlive(false);
            action.run();
        }
    }

    @ActivityCallback
    private void walletResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Session session = sessions.get(call.getCallbackId());
        if (session == null) return;

        // Do NOT settle here on success: the wallet returning does not mean the
        // session finished, and the scenario is the authority. Only record that the
        // user backed out, so the worker can report DECLINED instead of a timeout.
        if (result.getResultCode() != android.app.Activity.RESULT_OK) {
            session.userCancelled.set(true);
        }
    }

    private static byte[][] decodePayloads(JSArray array) throws Exception {
        if (array == null) throw new IllegalArgumentException("payloads missing");
        List<String> list = array.toList();
        if (list.isEmpty()) throw new IllegalArgumentException("payloads empty");
        List<byte[]> decoded = new ArrayList<>(list.size());
        for (Object o : list) {
            if (!(o instanceof String)) throw new IllegalArgumentException("payload not a string");
            decoded.add(Base64.decode((String) o, Base64.NO_WRAP));
        }
        return decoded.toArray(new byte[0][]);
    }
}
