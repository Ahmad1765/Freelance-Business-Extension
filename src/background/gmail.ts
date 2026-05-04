interface SendOpts {
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  fromName?: string;
  fromEmail?: string;
}

let cachedToken: string | null = null;

export async function getToken(interactive = true): Promise<string> {
  if (cachedToken) return cachedToken;
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) return reject(new Error(err?.message ?? 'no token'));
      cachedToken = typeof token === 'string' ? token : (token as any).token ?? null;
      if (!cachedToken) return reject(new Error('empty token'));
      resolve(cachedToken);
    });
  });
}

export async function disconnect(): Promise<void> {
  if (!cachedToken) {
    try {
      const t = await getToken(false);
      cachedToken = t;
    } catch {}
  }
  if (cachedToken) {
    try {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${cachedToken}`);
    } catch {}
    chrome.identity.removeCachedAuthToken({ token: cachedToken }, () => {});
    cachedToken = null;
  }
  await chrome.identity.clearAllCachedAuthTokens?.();
}

export async function whoAmI(): Promise<{ email?: string }> {
  const token = await getToken(false).catch(() => null);
  if (!token) return {};
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return {};
    const j = (await r.json()) as { email?: string };
    return { email: j.email };
  } catch {
    return {};
  }
}

export async function sendEmail(opts: SendOpts): Promise<{ id: string; threadId: string }> {
  const token = await getToken(true);
  const raw = buildRfc822(opts);
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: base64Url(raw) }),
  });
  if (r.status === 401) {
    chrome.identity.removeCachedAuthToken({ token }, () => {});
    cachedToken = null;
    throw new Error('Gmail token invalid; reconnect from Settings.');
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gmail send failed (${r.status}): ${text.slice(0, 200)}`);
  }
  return (await r.json()) as { id: string; threadId: string };
}

function buildRfc822({ to, subject, bodyText, bodyHtml, fromName, fromEmail }: SendOpts): string {
  const boundary = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const fromHeader = fromEmail
    ? fromName
      ? `From: ${rfc2047(fromName)} <${fromEmail}>`
      : `From: ${fromEmail}`
    : '';
  const lines = [
    `To: ${to}`,
    fromHeader,
    `Subject: ${rfc2047(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    bodyText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    bodyHtml,
    '',
    `--${boundary}--`,
  ].filter(Boolean);
  return lines.join('\r\n');
}

function rfc2047(s: string): string {
  if (!/[^\x20-\x7e]/.test(s)) return s;
  const utf8 = unescape(encodeURIComponent(s));
  return `=?UTF-8?B?${btoa(utf8)}?=`;
}

function base64Url(s: string): string {
  const utf8 = unescape(encodeURIComponent(s));
  return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
