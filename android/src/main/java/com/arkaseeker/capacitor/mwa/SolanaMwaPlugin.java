package com.arkaseeker.capacitor.mwa;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

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
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "SolanaMwa")
public class SolanaMwaPlugin extends Plugin {

    private static final int DEFAULT_TIMEOUT_MS = 20000;

    /**
     * The scenario's futures BLOCK. They must never run on the main thread: a
     * blocking get() on the UI thread is an ANR, and an app with few sessions
     * cannot rely on Play vitals to notice, so it would ship invisibly.
     */
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

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
            call.reject("Could not start a local association: " + e.getMessage(), "SIGN_FAILED");
            return;
        }

        if (associationIntent == null) {
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
                cluster, identityName, identityUri, iconRelativeUri));
    }

    private void runSession(PluginCall call, Session session, LocalAssociationScenario scenario,
                            byte[][] payloads, String cluster, String identityName,
                            String identityUri, String iconRelativeUri) {
        try {
            MobileWalletAdapterClient client = scenario.start().get();

            MobileWalletAdapterClient.AuthorizationResult auth = client.authorize(
                    Uri.parse(identityUri),
                    iconRelativeUri == null ? null : Uri.parse(iconRelativeUri),
                    identityName,
                    cluster).get();

            // No authToken argument on signAndSendTransactions: authorization is
            // bound to THIS session, which is why authorize and sign live in one
            // plugin call rather than two.
            MobileWalletAdapterClient.SignAndSendTransactionsResult signed =
                    client.signAndSendTransactions(payloads, null /* minContextSlot */).get();

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
        }
    }

    /**
     * Map each failure to its own code. The entire argument for MWA over a
     * deeplink is that a deeplink cannot distinguish "in flight" from "failed";
     * collapsing every cause into one rejection would throw that away.
     */
    private String classify(Throwable cause, Session session) {
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
