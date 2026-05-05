import type {
  AuditFinding,
  AuditReport,
  BusinessImpact,
  FindingCategory,
  FindingSeverity,
  Lead,
  Settings,
} from '../shared/types';
import { hasHostPermissions } from './probe';

interface RunOpts {
  lead: Lead;
  settings: Settings;
}

// Single chokepoint for audit logs. Every line carries the lead id (truncated)
// + url + phase so a noisy SW console is still grep-able. Use this instead of
// console.* directly so context never gets lost.
function alog(
  level: 'log' | 'warn' | 'error',
  ctx: { leadId?: string; url?: string; phase?: string },
  msg: string,
  ...rest: unknown[]
): void {
  const tag =
    `[audit` +
    (ctx.phase ? `:${ctx.phase}` : '') +
    (ctx.leadId ? ` ${ctx.leadId.slice(0, 8)}` : '') +
    (ctx.url ? ` ${ctx.url}` : '') +
    `]`;
  if (rest.length) console[level](tag, msg, ...rest);
  else console[level](tag, msg);
}

export async function runAudit({ lead, settings }: RunOpts): Promise<AuditReport> {
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  const url = lead.website ?? '';
  const ctx = { leadId: lead.id, url };

  alog('log', { ...ctx, phase: 'start' }, `runAudit begin (lead="${lead.name}")`);

  try {
    if (!url) {
      alog('warn', { ...ctx, phase: 'validate' }, 'lead has no website');
      return baseReport(id, lead.id, url, startedAt, false, `lead "${lead.name}" has no website`);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      alog('warn', { ...ctx, phase: 'validate' }, 'invalid URL', e);
      return baseReport(
        id,
        lead.id,
        url,
        startedAt,
        false,
        `invalid URL "${url}": ${errMsg(e)}`
      );
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      alog('warn', { ...ctx, phase: 'validate' }, `unsupported protocol "${parsed.protocol}"`);
      return baseReport(
        id,
        lead.id,
        url,
        startedAt,
        false,
        `unsupported protocol "${parsed.protocol}" — only http: and https: can be audited`
      );
    }
    if (/^(www\.)?google\.(com|[a-z]{2})\/(aclk|url|adurl)\b/.test(parsed.host + parsed.pathname)) {
      alog('warn', { ...ctx, phase: 'validate' }, 'lead URL is a Google ad redirect');
      return baseReport(
        id,
        lead.id,
        url,
        startedAt,
        false,
        'Google ad tracking URL — cannot audit redirected destination. Edit the lead and paste the real website URL.'
      );
    }

    let granted: boolean;
    try {
      granted = await hasHostPermissions([parsed.origin]);
    } catch (e) {
      alog('error', { ...ctx, phase: 'permission' }, 'permission check threw', e);
      return baseReport(
        id,
        lead.id,
        url,
        startedAt,
        false,
        `permission check failed for ${parsed.origin}: ${errMsg(e)}`
      );
    }
    if (!granted) {
      alog('warn', { ...ctx, phase: 'permission' }, `missing host permission for ${parsed.origin}`);
      return baseReport(
        id,
        lead.id,
        url,
        startedAt,
        false,
        `host permission missing for ${parsed.origin}. Click "Audit" in the popup and approve the Chrome permission prompt.`
      );
    }

    const findings: AuditFinding[] = [];
    let html = '';
    let pageBytes = 0;
    let loadMs = 0;
    let linksChecked = 0;
    let linksBroken = 0;

    let res: Response;
    let fetchedUrl = parsed.href;
    {
      const candidates = fetchCandidates(parsed);
      alog(
        'log',
        { ...ctx, phase: 'fetch' },
        `trying ${candidates.length} candidate URL(s)`,
        candidates
      );
      const t0 = performance.now();
      const errors: string[] = [];
      let success: Response | null = null;
      for (const candidate of candidates) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), settings.auditTimeoutMs);
        try {
          success = await fetch(candidate, { redirect: 'follow', signal: ctl.signal });
          fetchedUrl = candidate;
          alog(
            'log',
            { ...ctx, phase: 'fetch' },
            `fetched ${candidate} → HTTP ${success.status} (final=${success.url})`
          );
          break;
        } catch (e) {
          const msg = describeFetchError(e, candidate, settings.auditTimeoutMs);
          errors.push(`${candidate} → ${msg}`);
          alog('warn', { ...ctx, phase: 'fetch' }, `attempt failed: ${candidate}`, msg);
        } finally {
          clearTimeout(timer);
        }
      }
      loadMs = Math.round(performance.now() - t0);
      if (!success) {
        alog('error', { ...ctx, phase: 'fetch' }, `all candidates failed`, errors);
        return baseReport(
          id,
          lead.id,
          url,
          startedAt,
          false,
          `all fetch attempts failed:\n${errors.join('\n')}`
        );
      }
      res = success;
      if (fetchedUrl !== parsed.href) {
        findings.push(
          mkFinding({
            severity: 'warning',
            category: 'http',
            impact: 'reach',
            title: 'Original URL is unreachable',
            detail: `${parsed.href} could not load; we audited ${fetchedUrl} instead.`,
            recommendation: `Update this lead's saved website to ${fetchedUrl} so future visitors aren't dropped.`,
          })
        );
      }
    }

    try {
      html = await res.text();
      pageBytes = new Blob([html]).size;
      alog(
        'log',
        { ...ctx, phase: 'parse' },
        `read ${pageBytes} bytes in ${loadMs}ms`
      );
    } catch (e) {
      alog('error', { ...ctx, phase: 'parse' }, 'read body failed', e);
      return baseReport(
        id,
        lead.id,
        url,
        startedAt,
        false,
        `failed to read response body from ${fetchedUrl} (HTTP ${res.status}): ${errMsg(e)}`
      );
    }

    const fetchedParsed = (() => {
      try {
        return new URL(fetchedUrl);
      } catch {
        return parsed;
      }
    })();

    if (!res.ok) {
      findings.push(
        mkFinding({
          severity: 'critical',
          category: 'http',
          impact: 'reach',
          title: `Homepage is broken (HTTP ${res.status})`,
          detail: `${fetchedUrl} returned ${res.status} ${res.statusText || ''}`.trim(),
          recommendation:
            'Visitors hitting your homepage see an error page. Restore the page or set up a redirect to a working URL.',
        })
      );
    }

    if (fetchedParsed.protocol !== 'https:') {
      findings.push(
        mkFinding({
          severity: 'critical',
          category: 'trust',
          impact: 'trust',
          title: `Browsers warn visitors "Not Secure" before reaching your site`,
          detail: `${fetchedUrl} is served over plain HTTP — Chrome and Safari display a security warning.`,
          recommendation:
            'Install a free SSL certificate (Let\'s Encrypt) and redirect all HTTP traffic to HTTPS.',
        })
      );
    }
    let finalUrl: URL | null = null;
    try {
      finalUrl = new URL(res.url);
    } catch {}
    if (
      fetchedParsed.protocol === 'http:' &&
      finalUrl &&
      finalUrl.protocol !== 'https:'
    ) {
      findings.push(
        mkFinding({
          severity: 'critical',
          category: 'trust',
          impact: 'trust',
          title: 'Site stays on HTTP even after redirects',
          detail: `Following redirects from ${fetchedUrl} ended on ${finalUrl.href}, still unencrypted.`,
          recommendation:
            'Configure your server to permanently redirect every HTTP URL to its HTTPS equivalent.',
        })
      );
    }

    runCheckBlock(ctx, 'meta', findings, () => checkMeta(html, fetchedParsed));
    runCheckBlock(ctx, 'seo', findings, () => checkSeo(html));
    runCheckBlock(ctx, 'contact', findings, () => checkContact(html));
    runCheckBlock(ctx, 'performance', findings, () =>
      checkPerformance(loadMs, pageBytes)
    );
    runCheckBlock(ctx, 'trust', findings, () => checkTrust(html, fetchedParsed));
    runCheckBlock(ctx, 'local-seo', findings, () => checkLocalSeo(html, lead));
    runCheckBlock(ctx, 'freshness', findings, () => checkFreshness(html));
    runCheckBlock(ctx, 'marketing', findings, () => checkAnalytics(html));

    try {
      const links = collectInternalLinks(html, fetchedParsed, settings.auditMaxLinks);
      alog('log', { ...ctx, phase: 'links' }, `checking ${links.length} internal link(s)`);
      const results = await checkLinks(links, settings.auditTimeoutMs);
      linksChecked = results.length;
      for (const r of results) {
        if (!r.ok) {
          linksBroken += 1;
          findings.push(
            mkFinding({
              severity: r.status >= 500 ? 'critical' : 'warning',
              category: 'links',
              impact: 'reach',
              title: 'A link on your homepage leads to a broken page',
              detail: r.error
                ? `${r.url} → ${r.error}`
                : `${r.url} → ${r.status || 'fetch error'}`,
              evidence: r.url,
              recommendation:
                'Edit the homepage link to point at a working page, or remove the link.',
            })
          );
        }
      }
      alog(
        'log',
        { ...ctx, phase: 'links' },
        `link check complete: ${linksBroken}/${linksChecked} broken`
      );
    } catch (e) {
      alog('warn', { ...ctx, phase: 'links' }, 'link sweep failed', e);
      findings.push(
        mkFinding({
          severity: 'suggestion',
          category: 'links',
          impact: 'polish',
          title: 'Link check skipped',
          detail: `internal link sweep failed: ${errMsg(e)}`,
        })
      );
    }

    const deduped = dedupeFindings(findings);
    const score = computeScore(deduped);
    const summary = computeSummary(deduped);

    alog(
      'log',
      { ...ctx, phase: 'done' },
      `audit complete: score=${score}, findings=${deduped.length}, top="${summary[0] ?? '(none)'}"`
    );

    return {
      id,
      leadId: lead.id,
      url,
      ranAt: startedAt,
      durationMs: Date.now() - startedAt,
      ok: true,
      findings: deduped,
      stats: {
        linksChecked,
        linksBroken,
        pageBytes,
        requests: 1 + linksChecked,
        loadMs,
      },
      score,
      summary,
    };
  } catch (e) {
    alog('error', { ...ctx, phase: 'crash' }, 'unexpected failure', e);
    return baseReport(
      id,
      lead.id,
      url,
      startedAt,
      false,
      `unexpected audit failure: ${errMsg(e)}`
    );
  }
}

// Keep one bad regex from killing the whole audit. Each check function is
// isolated and any thrown error becomes a single soft finding.
function runCheckBlock(
  ctx: { leadId?: string; url?: string },
  phase: string,
  out: AuditFinding[],
  fn: () => AuditFinding[]
): void {
  try {
    const got = fn();
    out.push(...got);
    alog('log', { ...ctx, phase }, `produced ${got.length} finding(s)`);
  } catch (e) {
    alog('warn', { ...ctx, phase }, 'check threw', e);
    out.push(
      mkFinding({
        severity: 'suggestion',
        category: 'meta',
        impact: 'polish',
        title: `${phase} check skipped`,
        detail: `analyzer error: ${errMsg(e)}`,
      })
    );
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.name === 'Error' ? e.message : `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function describeFetchError(e: unknown, href: string, timeoutMs: number): string {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return `request to ${href} timed out after ${timeoutMs}ms (raise auditTimeoutMs in settings if the site is slow)`;
  }
  if (e instanceof TypeError) {
    return `network error fetching ${href}: ${e.message} (DNS failure, SSL error, site offline, blocked by network, or redirect target lacks host permission)`;
  }
  return `fetch failed for ${href}: ${errMsg(e)}`;
}

function fetchCandidates(parsed: URL): string[] {
  if (!/^https?:$/.test(parsed.protocol)) return [parsed.href];
  const host = parsed.hostname.toLowerCase();
  const altHost = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  const path = parsed.pathname + parsed.search;
  const isHttps = parsed.protocol === 'https:';
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (scheme: string, h: string) => {
    const u = `${scheme}://${h}${path}`;
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  push(parsed.protocol.slice(0, -1), host);
  if (!isHttps) push('https', host);
  push(isHttps ? 'https' : 'http', altHost);
  if (!isHttps) push('https', altHost);
  return out;
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
    score: 0,
    summary: error ? [error.split('\n')[0]] : [],
  };
}

// ─── Checks (owner-facing copy) ──────────────────────────────────────────────

function checkMeta(html: string, url: URL): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const head = headOf(html);

  const title = pick(head, /<title[^>]*>([\s\S]*?)<\/title>/i)?.trim();
  if (!title) {
    findings.push(
      mkFinding({
        severity: 'critical',
        category: 'meta',
        impact: 'visibility',
        title: 'Google search results show no headline for your site',
        detail: 'The homepage has no <title> tag.',
        recommendation: `Set a homepage title like "Your Business Name — ${url.hostname}". 30–60 characters works best.`,
      })
    );
  } else if (title.length < 15) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'meta',
        impact: 'visibility',
        title: 'Page title is too short to compete on Google',
        detail: `"${title}" is only ${title.length} characters; aim for 30–60.`,
        recommendation:
          'Expand the title to mention your business name, what you do, and the city you serve.',
      })
    );
  } else if (title.length > 70) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'meta',
        impact: 'visibility',
        title: 'Page title gets cut off in Google search results',
        detail: `"${title.slice(0, 80)}…" is ${title.length} characters; Google trims around 60.`,
        recommendation: 'Trim the title so the most important words appear first.',
      })
    );
  }

  const desc = pickAttr(head, /<meta[^>]+name=["']description["'][^>]*>/i, 'content');
  if (!desc) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'meta',
        impact: 'visibility',
        title: 'Google search shows no preview text under your business',
        detail: 'No <meta name="description"> on the homepage.',
        recommendation:
          'Add a 1–2 sentence summary of what your business offers; this is what people see in Google before clicking.',
      })
    );
  }

  const viewport = pickAttr(head, /<meta[^>]+name=["']viewport["'][^>]*>/i, 'content');
  if (!viewport) {
    findings.push(
      mkFinding({
        severity: 'critical',
        category: 'mobile',
        impact: 'reach',
        title: 'Site looks tiny and zoomed-out on mobile phones',
        detail: 'No <meta name="viewport"> tag — the site renders at desktop width on phones.',
        recommendation:
          'Add <meta name="viewport" content="width=device-width, initial-scale=1"> in the page head. Most visits come from phones.',
      })
    );
  }

  const ogImage = pickAttr(head, /<meta[^>]+property=["']og:image["'][^>]*>/i, 'content');
  if (!ogImage) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'seo',
        impact: 'visibility',
        title: 'Sharing your site on Facebook or WhatsApp shows no preview image',
        detail: 'No Open Graph image tag.',
        recommendation:
          'Pick one strong photo of the business or product and reference it via <meta property="og:image">.',
      })
    );
  }

  return findings;
}

function checkSeo(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  if (h1Count === 0) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'seo',
        impact: 'visibility',
        title: 'Homepage has no main heading',
        detail: 'No <h1> on the page.',
        recommendation:
          'Add one clear <h1> with your business name and core offer (e.g. "Solar Installation in Lahore").',
      })
    );
  }

  const imgCount = (html.match(/<img\b[^>]*>/gi) ?? []).length;
  const imgWithAlt = (html.match(/<img\b[^>]*\balt=/gi) ?? []).length;
  const imgsNoAlt = imgCount - imgWithAlt;
  if (imgsNoAlt > 0) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'a11y',
        impact: 'visibility',
        title: `${imgsNoAlt} of ${imgCount} photos can't be read by Google or screen readers`,
        detail: `${imgsNoAlt}/${imgCount} <img> tags have no alt text.`,
        recommendation:
          'Add a one-line description (alt text) to each image so they appear in Google Image search and work for visually impaired visitors.',
      })
    );
  }

  return findings;
}

function checkContact(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const stripped = stripTags(html).slice(0, 200_000);
  const hasEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(stripped);
  const hasPhone = /(\+?\d[\d\s().-]{8,}\d)/.test(stripped);
  if (!hasEmail && !hasPhone) {
    findings.push(
      mkFinding({
        severity: 'critical',
        category: 'contact',
        impact: 'reach',
        title: 'No phone or email visible on your homepage',
        detail: 'Visitors have no way to contact you without leaving the page.',
        recommendation:
          'Add a phone number, email, or contact form prominently on the homepage — ideally in the header or hero section.',
      })
    );
    return findings;
  }

  // Above-the-fold check: roughly the first 5KB of body text.
  const bodyMatch = html.match(/<body[\s\S]*?>([\s\S]*)/i);
  const bodyHead = stripTags(bodyMatch ? bodyMatch[1] : html).slice(0, 5000);
  const phoneAboveFold = /(\+?\d[\d\s().-]{8,}\d)/.test(bodyHead);
  if (hasPhone && !phoneAboveFold) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'contact',
        impact: 'reach',
        title: 'Phone number is buried — visitors must scroll to find it',
        detail: 'No phone number detected in the first screen of content.',
        recommendation:
          'Add your phone number in the site header or hero so it\'s visible without scrolling.',
      })
    );
  }
  return findings;
}

function checkPerformance(loadMs: number, pageBytes: number): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (loadMs > 6000) {
    findings.push(
      mkFinding({
        severity: 'critical',
        category: 'speed',
        impact: 'speed',
        title: `Homepage takes ${(loadMs / 1000).toFixed(1)} seconds to load`,
        detail: 'Most visitors abandon a site that takes more than 3 seconds.',
        recommendation:
          'Compress images, enable caching, and move to a faster host. Even getting under 4 seconds will recover lost visitors.',
      })
    );
  } else if (loadMs > 3000) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'speed',
        impact: 'speed',
        title: `Homepage takes ${(loadMs / 1000).toFixed(1)} seconds to load`,
        detail: 'Sites slower than ~3 seconds lose roughly 1 in 3 mobile visitors.',
        recommendation:
          'Compress images and enable a caching plugin. Most quick wins live there.',
      })
    );
  }

  if (pageBytes > 4_000_000) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'speed',
        impact: 'speed',
        title: `Homepage weighs ${(pageBytes / 1024 / 1024).toFixed(1)} MB — slow on mobile data`,
        detail: 'Heavy pages eat your visitors\' data plans and battery.',
        recommendation:
          'Replace large hero photos with compressed JPEGs/WebP under 200 KB each.',
      })
    );
  }
  return findings;
}

function checkTrust(html: string, url: URL): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // Mixed content: any http:// resource referenced from an https page makes
  // browsers downgrade the lock icon and may block the resource entirely.
  if (url.protocol === 'https:') {
    const mixedRe = /\b(?:src|href|action)=["'](http:\/\/[^"']+)["']/gi;
    const mixed = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = mixedRe.exec(html)) && mixed.size < 5) {
      // ignore intentionally-non-resource hrefs (mailto, tel are not http)
      mixed.add(m[1]);
    }
    if (mixed.size) {
      findings.push(
        mkFinding({
          severity: 'critical',
          category: 'trust',
          impact: 'trust',
          title: 'Site mixes secure and insecure content — browsers show a warning',
          detail: `Found ${mixed.size}+ resources loaded over plain HTTP on an HTTPS page.`,
          evidence: Array.from(mixed).slice(0, 3).join('\n'),
          recommendation:
            'Update those URLs to https:// (or use protocol-relative //). Browsers may otherwise block them and break the page.',
        })
      );
    }

    const formActionHttp = html.match(/<form[^>]+action=["'](http:\/\/[^"']+)["']/i);
    if (formActionHttp) {
      findings.push(
        mkFinding({
          severity: 'critical',
          category: 'trust',
          impact: 'trust',
          title: 'A form on your site sends visitor data unencrypted',
          detail: `Form posts to ${formActionHttp[1]} over plain HTTP.`,
          evidence: formActionHttp[0].slice(0, 200),
          recommendation:
            'Change the form action to use https://. Browsers warn visitors when they submit and may block submission entirely.',
        })
      );
    }
  }

  // Outdated CMS detection — the cheap, high-signal version: WordPress generator.
  const generator = pickAttr(
    html,
    /<meta[^>]+name=["']generator["'][^>]*>/i,
    'content'
  );
  if (generator) {
    const wp = generator.match(/WordPress\s+(\d+)\.(\d+)/i);
    if (wp) {
      const major = parseInt(wp[1], 10);
      const minor = parseInt(wp[2], 10);
      // Anything below WordPress 6.0 is clearly old (released May 2022).
      if (major < 6) {
        findings.push(
          mkFinding({
            severity: 'warning',
            category: 'trust',
            impact: 'trust',
            title: `Site runs WordPress ${major}.${minor} — outdated, with known vulnerabilities`,
            detail: `<meta name="generator"> reports WordPress ${major}.${minor}.`,
            evidence: generator,
            recommendation:
              'Update WordPress core, theme, and plugins. Every major version since 6.x patches security holes.',
          })
        );
      }
    }
  }

  return findings;
}

function checkLocalSeo(html: string, lead: Lead): AuditFinding[] {
  const findings: AuditFinding[] = [];

  const jsonLdBlocks = collectJsonLd(html);
  const hasLocalBusiness = jsonLdBlocks.some((blob) => /"@type"\s*:\s*"[^"]*(LocalBusiness|Restaurant|Store|Dentist|MedicalBusiness|HomeAndConstructionBusiness|ProfessionalService|AutomotiveBusiness|Plumber|Electrician)[^"]*"/i.test(blob));
  if (!hasLocalBusiness) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'seo',
        impact: 'visibility',
        title: 'Google can\'t show your hours, address, or phone in search results',
        detail: 'No LocalBusiness structured data on the homepage.',
        recommendation:
          'Add a JSON-LD <script type="application/ld+json"> block describing your business as a LocalBusiness with name, address, phone, and opening hours.',
      })
    );
  }

  const city = guessCity(lead.address);
  if (city) {
    const head = headOf(html);
    const title = pick(head, /<title[^>]*>([\s\S]*?)<\/title>/i)?.toLowerCase() ?? '';
    if (title && !title.includes(city.toLowerCase())) {
      findings.push(
        mkFinding({
          severity: 'suggestion',
          category: 'seo',
          impact: 'visibility',
          title: `Page title doesn't mention "${city}" — losing local search rankings`,
          detail: `Title: "${pick(head, /<title[^>]*>([\s\S]*?)<\/title>/i)?.trim()}"`,
          recommendation: `Include "${city}" in the homepage title so you rank for searches like "${(lead.category || 'business').toLowerCase()} in ${city}".`,
        })
      );
    }
  }
  return findings;
}

function checkFreshness(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  // Look at the last ~10KB of body which is where footers tend to live.
  const tailText = stripTags(html).slice(-10_000);
  const yearMatches = Array.from(
    tailText.matchAll(/(?:©|\bcopyright\b|&copy;)[^\d]{0,12}(20\d{2})/gi),
    (m) => parseInt(m[1], 10)
  ).filter((y) => y >= 2000 && y <= 2099);

  if (yearMatches.length === 0) return findings;
  const newest = Math.max(...yearMatches);
  const thisYear = new Date().getUTCFullYear();
  if (thisYear - newest >= 2) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'freshness',
        impact: 'trust',
        title: `Footer shows © ${newest} — visitors may think you've closed`,
        detail: `Newest copyright year detected in footer: ${newest}; today is ${thisYear}.`,
        recommendation: `Update the footer copyright to ${thisYear} (a one-line change in the footer template).`,
      })
    );
  }
  return findings;
}

function checkAnalytics(html: string): AuditFinding[] {
  const patterns = [
    /googletagmanager\.com\/gtag\/js/i,
    /www\.google-analytics\.com\/analytics\.js/i,
    /\bgtag\s*\(/,
    /\bga\s*\(\s*['"]create['"]/,
    /connect\.facebook\.net\/[^"']+\/fbevents\.js/i,
    /\bfbq\s*\(/,
    /plausible\.io\/js\//i,
    /umami\.[a-z]+\/script\.js/i,
    /matomo\.js|piwik\.js/i,
    /_paq\.push/,
  ];
  const found = patterns.some((rx) => rx.test(html));
  if (!found) {
    return [
      mkFinding({
        severity: 'suggestion',
        category: 'marketing',
        impact: 'polish',
        title: 'No analytics installed — you can\'t see who visits or where they come from',
        detail:
          'No Google Analytics, GTM, Facebook Pixel, Plausible, Umami, or Matomo tag detected.',
        recommendation:
          'Install a free analytics tool. Plausible or GA4 take ~5 minutes and tell you which marketing actually works.',
      }),
    ];
  }
  return [];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collectJsonLd(html: string): string[] {
  const out: string[] = [];
  const rx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html))) out.push(m[1]);
  return out;
}

function guessCity(address: string | null | undefined): string | null {
  if (!address) return null;
  // Google Maps addresses look like "123 Foo St, Lahore, Punjab 54000, Pakistan".
  // The 2nd comma-segment is typically the city.
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const candidate = parts[1];
  // Strip postal code style suffixes "Punjab 54000" → "Punjab".
  const cleaned = candidate.replace(/\s+\d.*$/, '').trim();
  if (!cleaned || cleaned.length > 40) return null;
  return cleaned;
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
  error?: string;
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
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { url, status: 0, ok: false, error: `timeout after ${timeoutMs}ms` };
    }
    if (e instanceof TypeError) {
      return { url, status: 0, ok: false, error: `network error: ${e.message}` };
    }
    return { url, status: 0, ok: false, error: errMsg(e) };
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
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

interface MkFindingOpts {
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string;
  impact?: BusinessImpact;
  recommendation?: string;
  evidence?: string;
}

function mkFinding(o: MkFindingOpts): AuditFinding {
  return {
    id: `${o.category}:${o.title}`,
    severity: o.severity,
    category: o.category,
    title: o.title,
    detail: o.detail,
    evidence: o.evidence,
    impact: o.impact,
    recommendation: o.recommendation,
  };
}

function dedupeFindings(fs: AuditFinding[]): AuditFinding[] {
  const seen = new Set<string>();
  return fs.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

// 100 = healthy. Each finding chips away based on severity. We deliberately
// don't compound — owners care more about "fix these 3" than a perfectly
// calibrated score.
export function computeScore(findings: AuditFinding[]): number {
  let s = 100;
  for (const f of findings) {
    if (f.severity === 'critical') s -= 12;
    else if (f.severity === 'warning') s -= 5;
    else s -= 1;
  }
  return Math.max(0, Math.min(100, s));
}

const SEV_RANK: Record<FindingSeverity, number> = { critical: 0, warning: 1, suggestion: 2 };
const IMPACT_RANK: Record<BusinessImpact, number> = {
  reach: 0,
  trust: 1,
  visibility: 2,
  speed: 3,
  polish: 4,
};

export function computeSummary(findings: AuditFinding[]): string[] {
  return [...findings]
    .sort((a, b) => {
      const sev = SEV_RANK[a.severity] - SEV_RANK[b.severity];
      if (sev !== 0) return sev;
      return (
        (a.impact ? IMPACT_RANK[a.impact] : 99) -
        (b.impact ? IMPACT_RANK[b.impact] : 99)
      );
    })
    .slice(0, 3)
    .map((f) => f.title);
}
