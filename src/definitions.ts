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
   * How long to wait for the wallet to associate, in milliseconds.
   * Defaults to 20000. This is the ASSOCIATION timeout, not a signing deadline.
   */
  timeoutMs?: number;
}

export interface AuthorizeAndSignResult {
  /** The authorized account's public key, base58. */
  address: string;

  /** One base58 signature per submitted payload, in the same order. */
  signatures: string[];

  /**
   * Auth token for a later `reauthorize`. Retained for completeness; a single
   * call already authorizes and signs inside one session, so most callers can
   * ignore this.
   */
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
   * Whether an MWA wallet is installed. Use this to decide whether to offer the
   * MWA path at all, instead of sniffing the device model or user agent.
   */
  walletAvailable(): Promise<WalletAvailableResult>;
}
