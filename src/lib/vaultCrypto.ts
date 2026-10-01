/**
 * Memory Vault — end-to-end encryption primitives (WebCrypto only).
 *
 * Key derivation: the user signs a fixed message with their Solana wallet;
 * the signature is fed through HKDF-SHA256 to derive an AES-256-GCM key.
 * The key never leaves the device, and the same wallet always re-derives it.
 *
 * Encrypted payloads are ready to be pushed to any MemoryStorageAdapter
 * (Arweave, IPFS, local) — only ciphertext ever leaves the client.
 */

export const VAULT_KEY_MESSAGE = 'AstraJournal vault key v1 — signing this unlocks your private sky.';

export interface EncryptedPayload {
  v: 1;
  iv: string; // base64
  ciphertext: string; // base64
}

/** Storage backends implement this; the app only ever hands them ciphertext. */
export interface MemoryStorageAdapter {
  readonly name: 'local' | 'arweave' | 'ipfs';
  put(payload: EncryptedPayload): Promise<string>; // returns a content id / tx id
  get(id: string): Promise<EncryptedPayload>;
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function deriveVaultKey(walletSignature: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', walletSignature, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('astrajournal'), info: new TextEncoder().encode('vault') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptText(key: CryptoKey, plaintext: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { v: 1, iv: toB64(iv), ciphertext: toB64(new Uint8Array(buf)) };
}

export async function decryptText(key: CryptoKey, payload: EncryptedPayload): Promise<string> {
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.ciphertext));
  return new TextDecoder().decode(buf);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
