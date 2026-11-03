package com.arkaseeker.capacitor.mwa;

/**
 * Network names for a legacy (MWA 1.x) session.
 *
 * The client library defines two separate sets: 1.x cluster names such as CLUSTER_MAINNET_BETA
 * ("mainnet-beta"), and 2.0 chain identifiers such as CHAIN_SOLANA_MAINNET ("solana:mainnet").
 * This plugin's API takes the 2.0 form, so a legacy session needs it translated. Sending
 * "solana:mainnet" to Phantom 26.36.0 on a legacy session was refused in a mainnet device test on
 * Nov 3 2026, with "example.com is trying to use testnet mode".
 */
final class MwaCluster {

    private MwaCluster() {}

    /** The 1.x cluster name for a chain identifier. An unrecognised value passes through unchanged. */
    static String legacy(String cluster) {
        if ("solana:mainnet".equals(cluster)) return "mainnet-beta";
        if ("solana:devnet".equals(cluster)) return "devnet";
        if ("solana:testnet".equals(cluster)) return "testnet";
        return cluster;
    }
}
