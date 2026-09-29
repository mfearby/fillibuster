import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
  checkVerifier,
  decryptSteps,
  deriveKey,
  encryptSteps,
  generateSalt,
  makeVerifier,
} from './crypto';
import type { CipherEnvelope, FieldStep } from './schema';

/** A representative mix of step types, fresh per call so tests can mutate. */
function sampleSteps(): FieldStep[] {
  return [
    { id: 's1', type: 'text', target: { by: 'id', value: 'first' }, value: 'Ada' },
    { id: 's2', type: 'select', target: { by: 'name', value: 'state' }, value: 'CA', matchBy: 'value' },
    { id: 's3', type: 'check', target: { by: 'css', value: '#agree' }, checked: true },
    {
      id: 's4',
      type: 'contenteditable',
      target: { by: 'css', value: '.bio' },
      html: '<b>hi</b>',
      allowHtml: true,
    },
  ];
}

/** Derive a key from a passphrase, generating a fresh salt each time. */
async function keyFor(passphrase: string, salt = generateSalt()): Promise<CryptoKey> {
  // Keep iterations low so the test suite stays fast; correctness is unchanged.
  return deriveKey(passphrase, salt, 1_000);
}

/** Flip one bit of the first byte of a base64-encoded blob. */
function tamper(base64: string): string {
  const bytes = base64ToBytes(base64);
  bytes[0] = bytes[0]! ^ 0x01;
  return bytesToBase64(bytes);
}

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 42]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('deriveKey + verifier (Req 8.7, 8.9)', () => {
  it('accepts the correct passphrase', async () => {
    const salt = generateSalt();
    const key = await keyFor('correct horse battery staple', salt);
    const verifier = await makeVerifier(key);

    // Re-derive from the same passphrase+salt, as a fresh session would.
    const reKey = await keyFor('correct horse battery staple', salt);
    expect(await checkVerifier(reKey, verifier)).toBe(true);
  });

  it('rejects a wrong passphrase without throwing (Req 8.9)', async () => {
    const salt = generateSalt();
    const key = await keyFor('the right one', salt);
    const verifier = await makeVerifier(key);

    const wrong = await keyFor('a different one', salt);
    expect(await checkVerifier(wrong, verifier)).toBe(false);
  });

  it('returns false for a malformed verifier rather than throwing', async () => {
    const key = await keyFor('whatever');
    expect(await checkVerifier(key, 'not-a-valid-verifier')).toBe(false);
  });
});

describe('encryptSteps / decryptSteps (Req 8.7, 8.9)', () => {
  it('round-trips steps (encrypt -> decrypt)', async () => {
    const key = await keyFor('master pass');
    const steps = sampleSteps();

    const envelope = await encryptSteps(steps, key);
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.data).toBe('string');

    const decrypted = await decryptSteps(envelope, key);
    expect(decrypted).toEqual(steps);
  });

  it('uses a fresh random IV per encryption', async () => {
    const key = await keyFor('master pass');
    const steps = sampleSteps();
    const a = await encryptSteps(steps, key);
    const b = await encryptSteps(steps, key);
    expect(a.iv).not.toBe(b.iv);
    // Same plaintext + same key + different IV => different ciphertext.
    expect(a.data).not.toBe(b.data);
  });

  it('rejects decryption under a different key (wrong passphrase)', async () => {
    const salt = generateSalt();
    const key = await keyFor('right pass', salt);
    const envelope = await encryptSteps(sampleSteps(), key);

    const wrongKey = await keyFor('wrong pass', salt);
    await expect(decryptSteps(envelope, wrongKey)).rejects.toBeTruthy();
  });

  it('fails the auth tag when the ciphertext is tampered with', async () => {
    const key = await keyFor('master pass');
    const envelope = await encryptSteps(sampleSteps(), key);
    const tampered: CipherEnvelope = { ...envelope, data: tamper(envelope.data) };
    await expect(decryptSteps(tampered, key)).rejects.toBeTruthy();
  });

  it('fails the auth tag when the IV is tampered with', async () => {
    const key = await keyFor('master pass');
    const envelope = await encryptSteps(sampleSteps(), key);
    const tampered: CipherEnvelope = { ...envelope, iv: tamper(envelope.iv) };
    await expect(decryptSteps(tampered, key)).rejects.toBeTruthy();
  });
});
