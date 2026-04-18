/** Encodes a byte buffer as a contiguous uppercase hex string (e.g. `AABBCC`). */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0").toUpperCase();
  }
  return out;
}

/**
 * Decodes a hex string into bytes. Accepts any whitespace between pairs and is
 * case-insensitive. Throws on odd length or invalid characters.
 */
export function fromHex(hex: string): Uint8Array {
  const stripped = hex.replace(/\s+/g, "");
  if (stripped.length % 2 !== 0) {
    throw new Error(
      `Invalid hex string: expected even length, got ${String(stripped.length)}.`,
    );
  }
  if (!/^[0-9a-fA-F]*$/.test(stripped)) {
    throw new Error("Invalid hex string: contains non-hex characters.");
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.substr(i * 2, 2), 16);
  }
  return out;
}
