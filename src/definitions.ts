export interface AuthorizeAndSignOptions {
  /**
   * Solana cluster identifier, e.g. "solana:mainnet", "solana:devnet".
   */
  cluster: string;

  /** Display name shown to the user by the wallet. */
  identityName: string;

  /** Your app's https identity URI, e.g. "https://example.com". */
  identityUri: string;

  /** Icon path RELATIVE to identityUri, e.g. "favicon.ico". Not absolute. */
  iconRelativeUri?: string;

  /**
   * Transactions to sign and submit, each base64-encoded.
   *
   * Base64 in, base58 out: this plugin owns both conversions so no caller ever
   * handles an encoding. The native API is raw bytes at every boundary.
   */
  payloads: string[];

  /**
   * An `authToken` from a PREVIOUS result, to reuse that authorization.
   *
   * WITHOUT IT, EVERY CALL IS A FRESH AUTHORIZE FOLLOWED BY A SIGN, AND A WALLET
   * GATES EACH BEHIND ITS OWN UNLOCK -- so signing two things in a row can mean
   * four unlocks. Supplying it turns the pair into one prompt.
   *
   * Safe to store and safe to send stale: a token the wallet no longer recognises
   * falls back to a full authorize rather than failing, because a user who
   * disconnects the app in their wallet leaves the caller holding a value it has
   * no way to know is dead.
   */
  authToken?: string;

  /**
   * Slot to pass as `min_context_slot`, normally `context.slot` from
   * `getLatestBlockhashAndContext()`.
   *
   * Optional in the MWA specification and REQUIRED BY PHANTOM in practice: omitting
   * it makes Phantom reject the request with `invalid_type / expected number /
   * received undefined` on `params.minContextSlot`. Supply it unless you have a
   * reason not to.
   */
  minContextSlot?: number;

  /**
   * A DEADLINE FOR THE WHOLE INTERACTION, in milliseconds. Defaults to 90000.
   *
   * It spans association, authorize and sign together rather than applying to each:
   * three separate timeouts would let a wallet occupy the plugin's single worker for
   * `3 x timeoutMs` while appearing to honour the value you passed.
   *
   * IT INCLUDES HUMAN TIME. A wallet may show a chooser, a security warning, an
   * account picker and a biometric prompt before the user ever reaches the approval,
   * so this is a budget for a person rather than for a machine. An earlier default of
   * 20000 expired while a user was still reading Phantom's "could not be verified"
   * warning, which is why it is no longer that.
   *
   * Exceeding it yields `ASSOCIATION_TIMEOUT`, or `DECLINED` if the user had already
   * backed out of the wallet.
   */
  timeoutMs?: number;
}

export interface AuthorizeAndSignResult {
  /** The authorized account's public key, base58. */
  address: string;

  /** One base58 signature per submitted payload, in the same order. */
  signatures: string[];

  /**
   * Auth token for this authorization. PASS IT BACK ON THE NEXT CALL: it is what
   * turns two wallet prompts into one. Store it per wallet, not per transaction.
   */
  authToken: string;

  /** Wallet-supplied label for the account, when it provides one. */
  accountLabel?: string;
}

export interface SignMessagesOptions
  extends Omit<AuthorizeAndSignOptions, 'payloads' | 'minContextSlot'> {
  /** Messages to sign, each base64-encoded. Arbitrary bytes, not transactions. */
  messages: string[];
}

export interface SignMessagesResult {
  /** The authorized account's public key, base58 -- the key that signed. */
  address: string;

  /** One base58 signature per message, in the same order. Detached. */
  signatures: string[];

  /** Auth token for this authorization; pass it back to skip the connect prompt. */
  authToken: string;

  /** Wallet-supplied label for the account, when it provides one. */
  accountLabel?: string;
}

export interface WalletAvailableResult {
  /**
   * True when an MWA wallet endpoint is installed and resolvable.
   *
   * This answers "is there a wallet", NOT "is this a Solana phone". A Seeker or
   * Saga with no wallet endpoint returns false; a stock Android handset with
   * Phantom returns true. The wallet is what matters, not the hardware -- so do
   * not gate on device model.
   */
  available: boolean;
}

/**
 * Error codes returned in `error.code`. They are distinguished on purpose: the
 * whole reason to prefer this over a deeplink is that a deeplink cannot tell
 * "in flight" from "failed", and collapsing every cause into one rejection
 * throws away the property being bought.
 */
export type SolanaMwaErrorCode =
  | 'NO_WALLET' // nothing on the device implements the MWA endpoint
  | 'DECLINED' // the user dismissed or rejected the wallet UI
  | 'ASSOCIATION_TIMEOUT' // the wallet never connected back within timeoutMs
  | 'SIGN_FAILED' // the wallet reported a failure signing or submitting
  | 'NOT_SUBMITTED' // signed, but the wallet did not submit it to the cluster
  | 'INVALID_PAYLOAD' // a payload was rejected as malformed
  | 'UNSUPPORTED_PLATFORM'; // called on web or iOS

export interface SolanaMwaPlugin {
  /**
   * Authorize and sign+send in ONE call, inside ONE association session.
   *
   * This is deliberately not two methods. `signAndSendTransactions` on the
   * native client takes no auth token -- authorization is bound to the live
   * session -- so splitting them would force this plugin to hold a
   * LocalAssociationScenario open across two JS round-trips, leaking the local
   * port and racing the activity result.
   */
  authorizeAndSignAndSend(
    options: AuthorizeAndSignOptions,
  ): Promise<AuthorizeAndSignResult>;

  /**
   * Sign arbitrary messages -- what a wallet-auth challenge needs.
   *
   * >>> THIS IS THE METHOD A SOLANA PAY DEEPLINK CANNOT PROVIDE AT ALL. <<< A
   * deeplink carries a TRANSACTION and nothing else, so an app built on that rail
   * cannot answer "prove you hold this key", and any service wanting a signed
   * challenge has to be told to trust the app instead.
   *
   * Signatures come back DETACHED, so a verifier gets the signature itself rather
   * than having to slice it off a combined buffer.
   *
   * The signing key is taken from the authorize RESULT, never from the caller: a
   * caller-supplied address could disagree with what the wallet actually granted.
   */
  signMessages(options: SignMessagesOptions): Promise<SignMessagesResult>;

  /**
   * Whether an MWA wallet is installed. Use this to decide whether to offer the
   * MWA path at all, instead of sniffing the device model or user agent.
   */
  walletAvailable(): Promise<WalletAvailableResult>;
}
