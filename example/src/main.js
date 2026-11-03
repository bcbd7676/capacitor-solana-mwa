import { SolanaMwa } from 'capacitor-solana-mwa';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// DEVNET BY DEFAULT, and the choice is never saved, so every launch starts there.
// Mainnet runs the identical plugin path with real SOL: a 1-lamport transfer to the
// same wallet, so the only real cost is the network fee. Use a wallet that holds only
// a small amount. The wallet app must be set to the same network, or it refuses.
const NETWORKS = {
  devnet: { cluster: 'solana:devnet', rpc: 'https://api.devnet.solana.com', explorer: '?cluster=devnet' },
  mainnet: { cluster: 'solana:mainnet', rpc: 'https://api.mainnet-beta.solana.com', explorer: '' },
};
// >>> THE PUBLIC DEVNET ENDPOINT DOES NOT WORK FROM A CAPACITOR APP, AND THE
// FAILURE IS OPAQUE. api.devnet.solana.com RETURNS 403 TO ANY REQUEST CARRYING A
// localhost ORIGIN -- measured Sep 10 2026: Origin https://localhost -> 403,
// http://localhost -> 403, https://example.com -> 200, no Origin header -> 200,
// all from the same IP within seconds, so it is an origin rule and not rate
// limiting. A Capacitor Android WebView's origin is exactly https://localhost,
// so every Capacitor app is refused by construction.
//
// The browser turns the 403 on the CORS preflight into "TypeError: Failed to
// fetch", which names neither the status nor the cause and reads like a dead
// network. Supply your own endpoint in the RPC field instead; it is kept out of
// this source deliberately so that no API key is ever committed to a public repo.
const RPC_KEY = { devnet: 'mwa_example_rpc', mainnet: 'mwa_example_rpc_mainnet' };
const ADDR_KEY = 'mwa_example_addr';

const IDENTITY = {
  identityName: 'MWA Example',
  identityUri: 'https://example.com',
  iconRelativeUri: 'favicon.ico', // relative to identityUri, never absolute
};

// ---------------------------------------------------------------------------
// UI plumbing
// ---------------------------------------------------------------------------
const out = document.getElementById('log');
const expectedInput = document.getElementById('expected');
const rpcInput = document.getElementById('rpc');
const networkInput = document.getElementById('network');
const networkNote = document.getElementById('network-note');

function networkName() {
  return networkInput.value === 'mainnet' ? 'mainnet' : 'devnet';
}
function network() {
  return NETWORKS[networkName()];
}

// Both fields persist locally, because retyping a base58 address and an endpoint
// with an API key on a phone keyboard is where device testing actually goes to die.
// This is a test harness, so localStorage is the right amount of machinery -- but
// it does mean the endpoint (and any key in it) lives on the handset. Use a
// throwaway key if that matters to you.
try {
  rpcInput.value = localStorage.getItem(RPC_KEY.devnet) || '';
  expectedInput.value = localStorage.getItem(ADDR_KEY) || '';
} catch { /* private mode or blocked storage -- the fields just start empty */ }

// One saved endpoint per network: a devnet endpoint used for a mainnet transaction
// returns a blockhash the wallet's network has never seen.
rpcInput.addEventListener('change', () => {
  try { localStorage.setItem(RPC_KEY[networkName()], rpcInput.value.trim()); } catch {}
});
expectedInput.addEventListener('change', () => {
  try { localStorage.setItem(ADDR_KEY, expectedInput.value.trim()); } catch {}
});

// Falls back to the public endpoint so the app still runs unconfigured -- it will
// fail, but it fails with the explanation above rather than a bare TypeError.
function rpcUrl() {
  return rpcInput.value.trim() || network().rpc;
}

function log(cls, msg) {
  console.log('[example] ' + msg);
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = msg;
  out.prepend(el);
}

function short(s) {
  // Truncate for DISPLAY only. Never truncate a value someone might copy and
  // reuse as a key -- a shortened address pasted back in is a silent wrong answer.
  return s.length > 16 ? s.slice(0, 8) + '..' + s.slice(-6) : s;
}

// ---------------------------------------------------------------------------
// 1. Capability check
// ---------------------------------------------------------------------------
// The auth token from the last successful call, reused on the next one. THIS IS THE
// DIFFERENCE BETWEEN ONE WALLET PROMPT AND TWO -- without it every call is a fresh
// authorize followed by a sign, and the wallet gates each behind its own unlock.
//
// Kept in memory ON PURPOSE for a test harness: persisting it would hide exactly the
// behaviour this button exists to demonstrate, since a reload would skip the first
// prompt and the difference would be invisible.
// >>> KEYED BY ADDRESS, BECAUSE AN AUTH TOKEN BELONGS TO ONE WALLET AND ONE ACCOUNT.
// Measured Sep 11 2026: a token issued by Seed Vault was presented to Phantom on the
// next tap -- Android had shown the chooser and a different wallet was picked -- and
// Phantom rejected it with -1/authorization request failed. That is CORRECT of Phantom.
// The plugin falls back to a full authorize so nothing breaks, but a caller that stores
// one token globally will pay an extra prompt every time the wallet changes.
let lastAuth = { address: null, token: null };

networkInput.addEventListener('change', () => {
  const name = networkName();
  try { rpcInput.value = localStorage.getItem(RPC_KEY[name]) || ''; } catch { rpcInput.value = ''; }
  // An authorization belongs to one network, so never carry a token across the switch.
  lastAuth = { address: null, token: null };
  networkNote.textContent = name === 'mainnet'
    ? 'MAINNET: real SOL. Sends 1 lamport to the same wallet, so you pay only the network fee. Set the wallet to mainnet and use one holding a small amount.'
    : 'Devnet. Signs a 1-lamport self-transfer, so nothing of value moves.';
  networkNote.className = name === 'mainnet' ? 'sub warn' : 'sub';
  log(name === 'mainnet' ? 'bad' : 'inf', 'Network: ' + network().cluster);
});

document.getElementById('btn-check').addEventListener('click', async () => {
  try {
    const { available } = await SolanaMwa.walletAvailable();
    log(available ? 'ok' : 'bad', 'walletAvailable() -> ' + available);
    if (!available) {
      log(
        'inf',
        'No MWA wallet visible. Either none is installed, or the <queries> declaration is missing ' +
          'from the merged manifest -- those look identical from here.',
      );
    }
  } catch (e) {
    log('bad', 'walletAvailable threw: ' + e.message);
  }
});

// ---------------------------------------------------------------------------
// 2. The real test: authorize, then sign+send a dust self-transfer
// ---------------------------------------------------------------------------
document.getElementById('btn-send').addEventListener('click', async () => {
  const expected = expectedInput.value.trim();

  try {
    const { available } = await SolanaMwa.walletAvailable();
    if (!available) {
      log('bad', 'No wallet available -- nothing to test against.');
      return;
    }

    // The address is REQUIRED INPUT here, not a convenience field, and the reason
    // is structural: a transaction needs its fee payer set before it can be
    // serialized, but this plugin authorizes and signs in a single call, so the
    // transaction has to be built BEFORE the wallet has told us who it is.
    //
    // Supplying the address up front resolves that, and the same value then serves
    // as the safety assertion after authorize returns. A real app that has already
    // authorized once would cache the address instead.
    if (!expected) {
      log('bad', 'Enter the throwaway wallet address first -- it is the fee payer AND the safety check.');
      return;
    }

    let payer;
    try {
      payer = new PublicKey(expected);
    } catch {
      log('bad', 'That is not a valid base58 public key.');
      return;
    }

    // Host only: an RPC URL usually carries an API key, and this line reaches the screen and logcat.
    log("inf", "Fetching a recent blockhash from " + new URL(rpcUrl()).host + " ...");
    const connection = new Connection(rpcUrl(), "confirmed");
    // getLatestBlockhashAndContext, NOT getLatestBlockhash: Phantom REQUIRES minContextSlot
    // (see the plugin comment), and the slot that pairs with this blockhash is only
    // available from the ...AndContext variant.
    const { context: _ctx, value: _bh } = await connection.getLatestBlockhashAndContext('finalized');
    const blockhash = _bh.blockhash;
    const minContextSlot = _ctx.slot;

    // Dust self-transfer: touches no program of ours, no Firestore, no callable.
    // 1 lamport to itself, so the only real cost is the network fee.
    const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: payer,
        lamports: 1,
      }),
    );

    // requireAllSignatures false: it is UNSIGNED at this point -- the wallet signs it.
    const payloadBase64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    log('inf', 'Opening the wallet. Approve the transaction to continue...');

    const res = await SolanaMwa.authorizeAndSignAndSend({
      cluster: network().cluster,
      ...IDENTITY,
      payloads: [payloadBase64],
      minContextSlot,
      ...(lastAuth.token ? { authToken: lastAuth.token } : {}),
    });
    lastAuth = { address: res.address, token: res.authToken || null };

    // >>> THE SAFETY ASSERTION. The wallet shows an account picker, and on a handset
    // whose Phantom install also holds a wallet that matters, a mis-tap authorizes
    // the wrong account. authorize() hands the key back, so check it rather than
    // trusting the tap. A mismatch is a hard stop, not a warning.
    if (res.address !== expected) {
      log(
        'bad',
        'ABORT: authorized ' + short(res.address) + ' but expected ' + short(expected) +
          '. The wrong account was selected in the wallet. Full authorized address: ' + res.address,
      );
      return;
    }

    log('ok', 'authorized ' + res.address + ' (matches expected)');
    for (const sig of res.signatures) {
      log('ok', 'signature: ' + sig);
      log('inf', 'https://explorer.solana.com/tx/' + sig + network().explorer);
    }

    // A SIGNATURE FROM A WALLET DOES NOT PROVE THE TRANSACTION LANDED. Measured Nov 3 2026: Jupiter
    // returned a signature for a devnet request from a wallet holding no devnet SOL, and it never
    // appeared on any cluster. So only the chain gets to report success here.
    log('inf', 'Signed. Checking the chain...');
    let landed = null;
    for (let i = 0; i < 15 && !landed; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2000));
      const { value } = await connection.getSignatureStatuses(res.signatures, { searchTransactionHistory: true });
      if (value.every((s) => s && s.confirmationStatus)) landed = value;
    }
    if (!landed) {
      log('bad', 'NOT FOUND ON CHAIN after 30 seconds. The wallet returned a signature, but the transaction has not landed.');
    } else if (landed.some((s) => s.err)) {
      log('bad', 'FAILED ON CHAIN: ' + JSON.stringify(landed.map((s) => s.err)));
    } else {
      log('ok', 'ROUND TRIP COMPLETE -- confirmed on chain (' + landed.map((s) => s.confirmationStatus).join(', ') + ').');
    }
  } catch (e) {
    // The codes are the point: a deeplink cannot tell these apart, and this can.
    const code = e && e.code ? e.code : '(no code)';
    log('bad', 'FAILED [' + code + '] ' + (e && e.message ? e.message : e));
    if (code === 'ASSOCIATION_TIMEOUT') {
      log('inf', 'The wallet never connected back. If you dismissed it, expect DECLINED instead.');
    }
    if (code === 'NOT_SUBMITTED') {
      log('inf', 'Signed but not submitted -- the signature may still be valid; check the explorer.');
    }
  }
});

// Check for a wallet on load rather than waiting for a tap. It costs one
// PackageManager query, needs no wallet interaction and no funds, and it means
// the screen answers "can this device do MWA at all" before anyone touches it.
(async () => {
  log('inf', 'Ready. Network: ' + network().cluster);
  try {
    const { available } = await SolanaMwa.walletAvailable();
    log(available ? 'ok' : 'bad', 'auto-check: walletAvailable() -> ' + available);
  } catch (e) {
    log('bad', 'auto-check: walletAvailable threw: ' + (e && e.message ? e.message : e));
  }
})();

// ---------------------------------------------------------------------------
// 3. Sign a message -- the wallet-auth case a Solana Pay deeplink cannot do at all.
// Nothing is submitted and no money moves; the wallet just proves it holds the key.
// ---------------------------------------------------------------------------
document.getElementById('btn-sign').addEventListener('click', async () => {
  try {
    const { available } = await SolanaMwa.walletAvailable();
    if (!available) {
      log('bad', 'No wallet available -- nothing to test against.');
      return;
    }

    // A nonce is what makes a signature proof of possession NOW rather than a replay
    // of one captured earlier. A real verifier issues this server-side and remembers it.
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const message = 'MWA Example wants to verify your wallet. nonce: ' + nonce;
    const messageB64 = btoa(message);

    log('inf', 'Signing: "' + message + '"');
    if (lastAuth.token) log('inf', 'Reusing the token from ' + short(lastAuth.address) + ' -- if you pick a DIFFERENT wallet it will be rejected and re-authorize.');

    const res = await SolanaMwa.signMessages({
      cluster: network().cluster,
      ...IDENTITY,
      messages: [messageB64],
      ...(lastAuth.token ? { authToken: lastAuth.token } : {}),
    });
    lastAuth = { address: res.address, token: res.authToken || null };

    log('ok', 'signed by ' + res.address);
    res.signatures.forEach((s) => log('ok', 'signature: ' + s));
    log('ok', 'MESSAGE SIGNED -- this is the call a deeplink cannot make.');
  } catch (e) {
    const code = e && e.code ? e.code : '(no code)';
    log('bad', 'FAILED [' + code + '] ' + (e && e.message ? e.message : e));
  }
});
