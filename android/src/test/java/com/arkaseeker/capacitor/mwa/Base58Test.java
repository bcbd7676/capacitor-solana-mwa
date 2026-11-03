package com.arkaseeker.capacitor.mwa;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class Base58Test {

    @Test
    public void emptyAndNullEncodeToEmpty() {
        assertEquals("", Base58.encode(new byte[0]));
        assertEquals("", Base58.encode(null));
    }

    @Test
    public void leadingZeroBytesBecomeOnes() {
        assertEquals("1", Base58.encode(new byte[] {0}));
        assertEquals("111", Base58.encode(new byte[] {0, 0, 0}));
        assertEquals("112", Base58.encode(new byte[] {0, 0, 1}));
    }

    @Test
    public void matchesKnownVectors() {
        assertEquals("2g", Base58.encode(new byte[] {0x61}));
        assertEquals("a3gV", Base58.encode(new byte[] {0x62, 0x62, 0x62}));
        // The all-zero 32-byte public key is Solana's System Program address.
        assertEquals("11111111111111111111111111111111", Base58.encode(new byte[32]));
    }

    @Test
    public void encodesAKnownSolanaPublicKey() {
        // The System Program's neighbour, a 32-byte key ending in 1.
        byte[] key = new byte[32];
        key[31] = 1;
        assertEquals("11111111111111111111111111111112", Base58.encode(key));
    }
}
