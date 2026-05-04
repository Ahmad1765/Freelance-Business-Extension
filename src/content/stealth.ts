export function jitter(base: number, pct = 0.4): number {
  const delta = base * pct * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + delta));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(
  fn: () => T | null | undefined,
  timeoutMs: number,
  pollMs = 150
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(pollMs);
  }
  return null;
}

export function speedToBaseDelay(speed: 'slow' | 'medium' | 'fast'): number {
  if (speed === 'slow') return 2500;
  if (speed === 'fast') return 800;
  return 1500;
}

export async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
