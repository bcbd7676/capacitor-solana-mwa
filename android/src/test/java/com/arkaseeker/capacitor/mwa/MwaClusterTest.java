package com.arkaseeker.capacitor.mwa;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class MwaClusterTest {

    @Test
    public void mapsChainIdentifiersToLegacyClusterNames() {
        assertEquals("mainnet-beta", MwaCluster.legacy("solana:mainnet"));
        assertEquals("devnet", MwaCluster.legacy("solana:devnet"));
        assertEquals("testnet", MwaCluster.legacy("solana:testnet"));
    }

    @Test
    public void passesThroughAnythingItDoesNotRecognise() {
        assertEquals("mainnet-beta", MwaCluster.legacy("mainnet-beta"));
        assertEquals("solana:unknown", MwaCluster.legacy("solana:unknown"));
        assertNull(MwaCluster.legacy(null));
    }
}
