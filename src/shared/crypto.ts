// Light obfuscation for at-rest API keys in chrome.storage.
// NOT real security: a local attacker with code-exec can recover the key.
// Threat model: casual disk inspection, sync to cloud backup.

const SALT_KEY = '__lbe_salt__';
const ITER = 100_000;

function buf(u: Uint8Array): ArrayBuffer {
  // TS 5.7 narrows Uint8Array<ArrayBufferLike>; WebCrypto wants BufferSource.
  // Slice into a fresh ArrayBuffer to satisfy the strict type.
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

async function getDeviceKey(): Promise<CryptoKey> {
  const stored = await chrome.storage.local.get(SALT_KEY);
  const existing = stored[SALT_KEY] as number[] | undefined;
  let salt: Uint8Array;
  if (existing) {
    salt = new Uint8Array(existing);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await chrome.storage.local.set({ [SALT_KEY]: Array.from(salt) });
  }
  const id = chrome.runtime.id ?? 'lbe-dev';
  const baseKey = await crypto.subtle.importKey(
    'raw',
    buf(new TextEncoder().encode(id)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: buf(salt), iterations: ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(plaintext: string): Promise<string> {
  if (!plaintext) return '';
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv) },
    key,
    buf(new TextEncoder().encode(plaintext))
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return 'aesgcm:' + btoa(String.fromCharCode(...Array.from(out)));
}

export async function decrypt(payload: string): Promise<string> {
  if (!payload) return '';
  if (!payload.startsWith('aesgcm:')) return payload;
  const bytes = Uint8Array.from(atob(payload.slice(7)), (c) => c.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const key = await getDeviceKey();
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(ct));
  return new TextDecoder().decode(pt);
}

export async function sha1(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', buf(new TextEncoder().encode(s)));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
