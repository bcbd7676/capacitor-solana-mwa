package com.arkaseeker.capacitor.mwa;

/**
 * Minimal Base58 encoder (Bitcoin alphabet), which is what Solana uses for
 * public keys and signatures.
 *
 * Hand-rolled on purpose: the native MWA client hands back raw byte[] for both
 * the public key and each signature, and pulling in a whole crypto library to
 * encode 32 and 64 bytes would be the only third-party dependency this plugin
 * has beyond the client itself.
 *
 * Encode only -- nothing here needs to decode base58.
 */
final class Base58 {

    private static final char[] ALPHABET =
            "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".toCharArray();

    private Base58() {}

    static String encode(byte[] input) {
        if (input == null || input.length == 0) return "";

        // Leading zero bytes are not represented by the arithmetic below; each one
        // becomes a literal '1'. Dropping them would silently produce a DIFFERENT
        // key, which is the kind of bug that only shows up on the rare address
        // that happens to start with a zero byte.
        int zeros = 0;
        while (zeros < input.length && input[zeros] == 0) zeros++;

        byte[] in = input.clone();
        char[] out = new char[in.length * 2]; // generous; base58 expands ~1.37x
        int outIndex = out.length;

        int start = zeros;
        while (start < in.length) {
            int remainder = 0;
            for (int i = start; i < in.length; i++) {
                int digit = (in[i] & 0xFF) + remainder * 256;
                in[i] = (byte) (digit / 58);
                remainder = digit % 58;
            }
            out[--outIndex] = ALPHABET[remainder];
            if (in[start] == 0) start++; // this byte is exhausted
        }

        while (zeros-- > 0) out[--outIndex] = ALPHABET[0];

        return new String(out, outIndex, out.length - outIndex);
    }
}
