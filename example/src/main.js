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
// DEVNET on purpose. This exercises the identical plugin path -- authorize, then
// signAndSendTransactions -- with no real money involved, so the only funding
// needed is a free faucet airdrop for the fee. Switching to mainnet is a one-line
// change once the path is proven, and there is no reason to spend a real fee to
// learn something devnet answers identically.
const CLUSTER = 'solana:devnet';
const RPC_URL = 'https://api.devnet.solana.com';

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

    log('inf', 'Fetching a recent blockhash from ' + RPC_URL + ' ...');
    const connection = new Connection(RPC_URL, 'confirmed');
    const { blockhash } = await connection.getLatestBlockhash('finalized');

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
      cluster: CLUSTER,
      ...IDENTITY,
      payloads: [payloadBase64],
    });

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
      log('inf', 'https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
    }
    log('ok', 'ROUND TRIP COMPLETE -- authorize + signAndSendTransactions both succeeded.');
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
  log('inf', 'Ready. Cluster: ' + CLUSTER);
  try {
    const { available } = await SolanaMwa.walletAvailable();
    log(available ? 'ok' : 'bad', 'auto-check: walletAvailable() -> ' + available);
  } catch (e) {
    log('bad', 'auto-check: walletAvailable threw: ' + (e && e.message ? e.message : e));
  }
})();
