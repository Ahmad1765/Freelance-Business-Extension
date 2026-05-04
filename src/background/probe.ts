import type { WebsiteStatus } from '../shared/types';

interface Probe {
  status: WebsiteStatus;
  code?: number;
}

const TIMEOUT_MS = 8000;

export async function probeWebsite(rawUrl: string): Promise<Probe> {
  if (!rawUrl) return { status: 'missing' };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: 'dead' };
  }
  if (!/^https?:$/.test(url.protocol)) return { status: 'dead' };

  const granted = await ensureHostPermission(url.origin);
  if (!granted) {
    // Without host permission we can't verify the site is reachable.
    // Trust Maps' data and classify as 'present' so the lead is filterable.
    // Audit will request permission explicitly when the user clicks it.
    return { status: 'present' };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let r = await fetch(url.href, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (r.status === 405 || r.status === 501) {
      r = await fetch(url.href, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
    }
    if (r.ok) return { status: 'present', code: r.status };
    if (r.status >= 400) return { status: 'dead', code: r.status };
    return { status: 'present', code: r.status };
  } catch {
    return { status: 'dead' };
  } finally {
    clearTimeout(t);
  }
}

const askedOrigins = new Set<string>();

async function ensureHostPermission(origin: string): Promise<boolean> {
  const pattern = `${origin}/*`;
  try {
    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (has) return true;
    if (askedOrigins.has(origin)) return false;
    askedOrigins.add(origin);
    // Cannot prompt from SW silently — return false; UI must request via button click.
    return false;
  } catch {
    return false;
  }
}

export async function requestHostPermissions(origins: string[]): Promise<boolean> {
  const patterns = origins.map((o) => {
    try {
      return new URL(o).origin + '/*';
    } catch {
      return null;
    }
  }).filter((p): p is string => !!p);
  if (!patterns.length) return true;
  return chrome.permissions.request({ origins: patterns });
}

// Service-worker-safe variant: only checks; never prompts.
// chrome.permissions.request() requires a user gesture in an extension UI
// surface and silently fails from the background SW, so audit code must use
// this and rely on the popup to have already requested the permission.
export async function hasHostPermissions(origins: string[]): Promise<boolean> {
  const patterns = origins.map((o) => {
    try {
      return new URL(o).origin + '/*';
    } catch {
      return null;
    }
  }).filter((p): p is string => !!p);
  if (!patterns.length) return true;
  try {
    return await chrome.permissions.contains({ origins: patterns });
  } catch {
    return false;
  }
}
