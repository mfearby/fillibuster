/**
 * Encryption primitives for Fillibuster's optional at-rest protection (Req 8).
 *
 * Encryption is opt-in behind a single master passphrase with no recovery
 * (design "Encryption Design"). This module is the browser-free, unit-testable
 * core of that flow, built entirely on the Web Crypto API (`crypto.subtle`) so
 * it runs unchanged in the extension and in Node (20+ ships a global `crypto`):
 *
 *  - {@link deriveKey} turns a passphrase + stored `salt`/`iterations` into a
 *    256-bit AES-GCM {@link CryptoKey} via PBKDF2/SHA-256 (Req 8.7). The key is
 *    non-extractable; only the derived `CryptoKey` leaves this module, never the
 *    passphrase.
 *  - {@link makeVerifier} / {@link checkVerifier} encrypt and re-check a known
 *    constant so we can tell "right passphrase" from "wrong" without storing the
 *    passphrase (Req 8.9). A wrong key fails AES-GCM's auth tag; `checkVerifier`
 *    reports that as `false` rather than throwing.
 *  - {@link generateSalt} and {@link DEFAULT_ITERATIONS} supply fresh KDF
 *    parameters when the developer first enables encryption (Req 8.7).
 *
 * The shared base64 <-> bytes and envelope (de)serialization helpers live here
 * too, since config-level encryption (task 5.2) reuses the same wire format
 * ({@link CipherEnvelope}) and AES-GCM key.
 *
 * Requirements: 8.7, 8.9
 */

import type { CipherEnvelope, FieldStep } from './schema';

/**
 * Default PBKDF2 iteration count for newly enabled encryption (design:
 * "e.g. 300k, SHA-256"). Stored alongside the salt so future changes don't
 * break existing vaults — the value used to derive a key is always read back
 * from `settings.kdf.iterations`, never assumed.
 */
export const DEFAULT_ITERATIONS = 300_000;

/** Salt length in bytes for PBKDF2 (128-bit, the common recommendation). */
const SALT_BYTES = 16;

/** AES-GCM IV length in bytes (96-bit, the recommended size for GCM). */
const IV_BYTES = 12;

/** Derived AES-GCM key length in bits. */
const KEY_BITS = 256;

/**
 * The known plaintext encrypted under the master key to form the verifier. Its
 * exact contents are irrelevant to security (AES-GCM's auth tag does the work);
 * it just needs to be a fixed, non-secret constant both encrypt and check agree
 * on.
 */
const VERIFIER_CONSTANT = 'fillibuster:verifier:v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode raw bytes as a standard base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Decode a standard base64 string back into raw bytes. The result is backed by
 * a plain `ArrayBuffer` (not a `SharedArrayBuffer`) so it satisfies the
 * `BufferSource` inputs `crypto.subtle` expects.
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a string to UTF-8 bytes backed by a plain `ArrayBuffer`, so the result
 * is accepted directly as a `crypto.subtle` `BufferSource`. (`TextEncoder.encode`
 * is typed as the buffer-agnostic `Uint8Array`, which recent TypeScript treats
 * as possibly `SharedArrayBuffer`-backed.)
 */
function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  const source = encoder.encode(text);
  const bytes = new Uint8Array(source.length);
  bytes.set(source);
  return bytes;
}

/** Generate a fresh random PBKDF2 salt, base64-encoded for storage. */
export function generateSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return bytesToBase64(salt);
}

/**
 * Derive a 256-bit AES-GCM key from a passphrase using PBKDF2/SHA-256 (Req 8.7).
 *
 * `salt` is the base64 salt stored in `settings.kdf`; `iterations` is the stored
 * iteration count (defaulting to {@link DEFAULT_ITERATIONS}). The returned
 * {@link CryptoKey} is non-extractable and usable only for encrypt/decrypt, so
 * the raw key material never surfaces. The passphrase is consumed here and never
 * persisted.
 */
export async function deriveKey(
  passphrase: string,
  salt: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', utf8Bytes(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(salt),
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: KEY_BITS },
    // Extractable so the session layer can export the raw key bytes into
    // memory-only `storage.session` and re-import them across service-worker
    // restarts. A `CryptoKey` does not round-trip through `storage.session`
    // consistently across MV3 engines — Firefox preserves it, but Chrome yields
    // an inert object that fails `crypto.subtle.encrypt`'s CryptoKey check.
    // Storing raw bytes is correct on both. The bytes never touch disk.
    true,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt raw bytes under `key` with a fresh random IV, returning an envelope. */
export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<CipherEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) };
}

/**
 * Decrypt an envelope produced by {@link encryptBytes}. Throws if the key is
 * wrong or the ciphertext was tampered with (AES-GCM auth-tag failure); callers
 * that want a boolean instead should use {@link checkVerifier}.
 */
export async function decryptBytes(key: CryptoKey, envelope: CipherEnvelope): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.data),
  );
  return new Uint8Array(plaintext);
}

/**
 * Encrypt the known verifier constant under `key` and serialize it to a base64
 * string suitable for `settings.verifier` (Req 8.9). The string is a base64
 * JSON {@link CipherEnvelope}, matching the wire format used elsewhere so the
 * same helpers round-trip it.
 */
export async function makeVerifier(key: CryptoKey): Promise<string> {
  const envelope = await encryptBytes(key, utf8Bytes(VERIFIER_CONSTANT));
  return bytesToBase64(utf8Bytes(JSON.stringify(envelope)));
}

/**
 * Check a stored verifier against `key` (Req 8.9). Returns `true` only when the
 * key correctly decrypts the verifier back to the known constant. A wrong
 * passphrase (auth-tag failure) or a malformed/tampered verifier returns `false`
 * rather than throwing, so callers can show a clean "wrong passphrase" message
 * and leave stored data untouched.
 */
export async function checkVerifier(key: CryptoKey, verifier: string): Promise<boolean> {
  try {
    const envelope = JSON.parse(decoder.decode(base64ToBytes(verifier))) as CipherEnvelope;
    if (typeof envelope?.iv !== 'string' || typeof envelope?.data !== 'string') return false;
    const plaintext = await decryptBytes(key, envelope);
    return decoder.decode(plaintext) === VERIFIER_CONSTANT;
  } catch {
    return false;
  }
}

/**
 * Encrypt a config's ordered {@link FieldStep}s at rest (Req 8.7). The steps are
 * JSON-serialized and encrypted with {@link encryptBytes}, so a fresh random IV
 * and AES-GCM's auth tag protect every stored config. The result is the same
 * {@link CipherEnvelope} wire format used everywhere else and is what gets stored
 * as `StoredConfig.cipher`.
 */
export async function encryptSteps(steps: FieldStep[], key: CryptoKey): Promise<CipherEnvelope> {
  return encryptBytes(key, utf8Bytes(JSON.stringify(steps)));
}

/**
 * Decrypt an envelope produced by {@link encryptSteps} back into the original
 * {@link FieldStep}s. Rejects when the key is wrong or the envelope was tampered
 * with — AES-GCM's auth tag fails and {@link decryptBytes} throws, so a wrong
 * passphrase never yields silently corrupt steps (Req 8.9).
 */
export async function decryptSteps(envelope: CipherEnvelope, key: CryptoKey): Promise<FieldStep[]> {
  const plaintext = await decryptBytes(key, envelope);
  return JSON.parse(decoder.decode(plaintext)) as FieldStep[];
}
