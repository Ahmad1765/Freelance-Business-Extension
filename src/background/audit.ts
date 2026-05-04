import type { AuditFinding, AuditReport, Lead, Settings } from '../shared/types';
import { hasHostPermissions } from './probe';

interface RunOpts {
  lead: Lead;
  settings: Settings;
}

export async function runAudit({ lead, settings }: RunOpts): Promise<AuditReport> {
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  const url = lead.website ?? '';

  if (!url) {
    return baseReport(id, lead.id, url, startedAt, false, 'lead has no website');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return baseReport(id, lead.id, url, startedAt, false, 'invalid url');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return baseReport(id, lead.id, url, startedAt, false, 'non-http url');
  }

  const granted = await hasHostPermissions([parsed.origin]);
  if (!granted) {
    return baseReport(
      id,
      lead.id,
      url,
      startedAt,
      false,
      `host permission missing for ${parsed.origin} — grant it from the popup before running audit`
    );
  }

  const findings: AuditFinding[] = [];
  let html = '';
  let pageBytes = 0;
  let loadMs = 0;
  let linksChecked = 0;
  let linksBroken = 0;

  try {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), settings.auditTimeoutMs);
    const res = await fetch(parsed.href, { redirect: 'follow', signal: ctl.signal });
    clearTimeout(timer);
    loadMs = Math.round(performance.now() - t0);
    html = await res.text();
    pageBytes = new Blob([html]).size;

    if (parsed.protocol !== 'https:') {
      findings.push(crit('security', 'Site not on HTTPS', `${parsed.href} served over HTTP`));
    }
    const finalUrl = new URL(res.url);
    if (parsed.protocol === 'http:' && finalUrl.protocol !== 'https:') {
      findings.push(crit('security', 'No HTTP→HTTPS redirect', 'site stays on HTTP after follow'));
    }

    findings.push(...checkMeta(html, parsed));
    findings.push(...checkSeo(html));
    findings.push(...checkContact(html));
    findings.push(...checkSecurityHeaders(res));
  } catch (e) {
    return baseReport(id, lead.id, url, startedAt, false, `fetch failed: ${e}`);
  }

  try {
    const links = collectInternalLinks(html, parsed, settings.auditMaxLinks);
    const results = await checkLinks(links, settings.auditTimeoutMs);
    linksChecked = results.length;
    for (const r of results) {
      if (!r.ok) {
        linksBroken += 1;
        findings.push({
          id: `link:${r.url}`,
          severity: r.status >= 500 ? 'critical' : 'warning',
          category: 'links',
          title: 'Broken link',
          detail: `${r.url} → ${r.status || 'fetch error'}`,
          evidence: r.url,
        });
      }
    }
  } catch {}

  return {
    id,
    leadId: lead.id,
    url,
    ranAt: startedAt,
    durationMs: Date.now() - startedAt,
    ok: true,
    findings: dedupeFindings(findings),
    stats: {
      linksChecked,
      linksBroken,
      pageBytes,
      requests: 1 + linksChecked,
      loadMs,
    },
  };
}

function baseReport(
  id: string,
  leadId: string,
  url: string,
  startedAt: number,
  ok: boolean,
  error?: string
): AuditReport {
  return {
    id,
    leadId,
    url,
    ranAt: startedAt,
    durationMs: Date.now() - startedAt,
    ok,
    error,
    findings: [],
    stats: { linksChecked: 0, linksBroken: 0, pageBytes: 0, requests: 0, loadMs: 0 },
  };
}

function checkMeta(html: string, url: URL): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const head = headOf(html);

  const title = pick(head, /<title[^>]*>([\s\S]*?)<\/title>/i)?.trim();
  if (!title) findings.push(crit('meta', 'Missing <title>', 'Search engines need a page title.'));
  else if (title.length < 15)
    findings.push(warn('meta', 'Title too short', `${title.length} chars; aim 30–60`));
  else if (title.length > 70)
    findings.push(warn('meta', 'Title too long', `${title.length} chars; aim 30–60`));

  const desc = pickAttr(head, /<meta[^>]+name=["']description["'][^>]*>/i, 'content');
  if (!desc)
    findings.push(warn('meta', 'Missing meta description', 'Affects click-through from search.'));

  const viewport = pickAttr(head, /<meta[^>]+name=["']viewport["'][^>]*>/i, 'content');
  if (!viewport)
    findings.push(crit('mobile', 'Missing viewport meta', `Site won't render correctly on mobile.`));

  const canonical = pickAttr(head, /<link[^>]+rel=["']canonical["'][^>]*>/i, 'href');
  if (!canonical)
    findings.push(suggest('seo', 'Missing canonical link', 'Helps avoid duplicate-content issues.'));

  const ogImage = pickAttr(head, /<meta[^>]+property=["']og:image["'][^>]*>/i, 'content');
  if (!ogImage)
    findings.push(suggest('seo', 'Missing og:image', 'Social shares show no preview image.'));

  const twitter = pickAttr(head, /<meta[^>]+name=["']twitter:card["'][^>]*>/i, 'content');
  if (!twitter)
    findings.push(suggest('seo', 'Missing twitter:card', 'Twitter previews will be plain text.'));

  if (!/<link[^>]+rel=["']icon["']/i.test(head))
    findings.push(suggest('meta', 'Missing favicon', 'Browser tab/bookmark icon absent.'));

  return findings;
}

function checkSeo(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  if (h1Count === 0) findings.push(warn('seo', 'No <h1>', 'Hurts SEO and accessibility.'));
  else if (h1Count > 1)
    findings.push(suggest('seo', 'Multiple <h1>', `${h1Count} H1s; one is conventional.`));

  const imgCount = (html.match(/<img\b[^>]*>/gi) ?? []).length;
  const imgWithAlt = (html.match(/<img\b[^>]*\balt=/gi) ?? []).length;
  const imgsNoAlt = imgCount - imgWithAlt;
  if (imgsNoAlt > 0)
    findings.push(
      warn('a11y', 'Images missing alt text', `${imgsNoAlt}/${imgCount} <img> without alt`)
    );

  const hasJsonLd = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
  if (!hasJsonLd)
    findings.push(suggest('seo', 'No structured data', 'Schema.org markup boosts rich results.'));

  return findings;
}

function checkContact(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const stripped = stripTags(html).slice(0, 200_000);
  const hasEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(stripped);
  const hasPhone = /(\+?\d[\d\s().-]{8,}\d)/.test(stripped);
  if (!hasEmail && !hasPhone)
    findings.push(warn('contact', 'No visible contact info', 'No email or phone found in page text.'));
  return findings;
}

function checkSecurityHeaders(res: Response): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const wanted = [
    ['Strict-Transport-Security', 'HSTS missing', 'critical'],
    ['X-Content-Type-Options', 'X-Content-Type-Options missing', 'warning'],
    ['Referrer-Policy', 'Referrer-Policy missing', 'suggestion'],
    ['Content-Security-Policy', 'CSP missing', 'suggestion'],
  ] as const;
  for (const [h, label, sev] of wanted) {
    if (!res.headers.get(h)) {
      findings.push({
        id: `hdr:${h}`,
        severity: sev,
        category: 'security',
        title: label,
        detail: `${h} response header not set`,
      });
    }
  }
  return findings;
}

function collectInternalLinks(html: string, root: URL, max: number): string[] {
  const out = new Set<string>();
  const rx = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html))) {
    try {
      const u = new URL(m[1], root);
      if (u.hostname !== root.hostname) continue;
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      out.add(u.href);
      if (out.size >= max) break;
    } catch {}
  }
  return Array.from(out);
}

interface LinkResult {
  url: string;
  status: number;
  ok: boolean;
}

async function checkLinks(urls: string[], timeoutMs: number): Promise<LinkResult[]> {
  const concurrency = 5;
  const out: LinkResult[] = [];
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      const u = urls[idx];
      out.push(await checkOne(u, timeoutMs));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

async function checkOne(url: string, timeoutMs: number): Promise<LinkResult> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
    if (r.status === 405 || r.status === 501) {
      r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal });
    }
    return { url, status: r.status, ok: r.ok };
  } catch {
    return { url, status: 0, ok: false };
  } finally {
    clearTimeout(t);
  }
}

function headOf(html: string): string {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : html.slice(0, 50_000);
}
function pick(s: string, rx: RegExp): string | null {
  const m = s.match(rx);
  return m ? m[1] : null;
}
function pickAttr(s: string, tagRx: RegExp, attr: string): string | null {
  const m = s.match(tagRx);
  if (!m) return null;
  const a = m[0].match(new RegExp(`${attr}=["']([^"']+)["']`, 'i'));
  return a ? a[1] : null;
}
function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}
function crit(category: AuditFinding['category'], title: string, detail: string): AuditFinding {
  return { id: `${category}:${title}`, severity: 'critical', category, title, detail };
}
function warn(category: AuditFinding['category'], title: string, detail: string): AuditFinding {
  return { id: `${category}:${title}`, severity: 'warning', category, title, detail };
}
function suggest(category: AuditFinding['category'], title: string, detail: string): AuditFinding {
  return { id: `${category}:${title}`, severity: 'suggestion', category, title, detail };
}
function dedupeFindings(fs: AuditFinding[]): AuditFinding[] {
  const seen = new Set<string>();
  return fs.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}
