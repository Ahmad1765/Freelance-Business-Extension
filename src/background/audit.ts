import type {
  AuditFinding,
  AuditReport,
  AiRecommendation,
  BusinessImpact,
  FindingCategory,
  FindingSeverity,
  Lead,
  SecurityHeaders,
  Settings,
} from '../shared/types';
import { hasHostPermissions } from './probe';
import { decrypt } from '../shared/crypto';

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

    // New extended checks
    runCheckBlock(ctx, 'social-meta',  findings, () => checkSocialMeta(html));
    runCheckBlock(ctx, 'heading-hier', findings, () => checkHeadingHierarchy(html));
    runCheckBlock(ctx, 'robots-meta',  findings, () => checkRobotsMeta(html));
    runCheckBlock(ctx, 'url-struct',   findings, () => checkUrlStructure(fetchedParsed));
    runCheckBlock(ctx, 'perf-proxy',   findings, () => checkPerformanceProxies(html));
    runCheckBlock(ctx, 'cms-detect',   findings, () => checkCmsDetection(html));

    try {
      const robotsFindings = await checkRobotsTxt(fetchedParsed, 5000);
      findings.push(...robotsFindings);
    } catch (e) {
      alog('warn', { ...ctx, phase: 'robots-txt' }, 'robots.txt check failed', e);
    }

    const securityHeaders = extractSecurityHeaders(res);
    runCheckBlock(ctx, 'sec-headers', findings, () =>
      checkSecurityHeaders(securityHeaders, fetchedParsed.protocol === 'https:')
    );

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

    const auditResult: AuditReport = {
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
      securityHeaders,
      aiEnhanced: false,
    };

    return tryAiEnrich(auditResult, lead, settings);
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

// ─── New extended checks ──────────────────────────────────────────────────────

function checkSocialMeta(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const head = headOf(html);
  const ogProps = ['og:title', 'og:description', 'og:url', 'og:type'];
  for (const prop of ogProps) {
    const val = pickAttr(head, new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*>`, 'i'), 'content');
    if (!val) {
      findings.push(
        mkFinding({
          severity: 'warning',
          category: 'social-meta',
          impact: 'visibility',
          title: `Missing Open Graph tag: ${prop}`,
          detail: `No <meta property="${prop}"> found. Social shares on Facebook/WhatsApp/LinkedIn show blank or wrong info.`,
          recommendation: `Add <meta property="${prop}" content="..."> to your page <head>.`,
        })
      );
    }
  }
  const twitterCard = pickAttr(head, /<meta[^>]+name=["']twitter:card["'][^>]*>/i, 'content');
  if (!twitterCard) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'social-meta',
        impact: 'visibility',
        title: 'No Twitter/X card tag — links look plain when shared',
        detail: 'No <meta name="twitter:card"> found.',
        recommendation: 'Add <meta name="twitter:card" content="summary_large_image"> to enable rich link previews on X/Twitter.',
      })
    );
  }
  return findings;
}

function checkHeadingHierarchy(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  const h2Count = (html.match(/<h2\b/gi) ?? []).length;
  const h3Count = (html.match(/<h3\b/gi) ?? []).length;

  if (h1Count > 1) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'seo',
        impact: 'visibility',
        title: `Multiple H1 headings found (${h1Count}) — dilutes SEO focus`,
        detail: `The page has ${h1Count} <h1> tags. Search engines expect exactly one.`,
        recommendation: 'Keep one <h1> for the main page topic; use <h2> for section headers.',
      })
    );
  }
  if (h2Count > 0 && h1Count === 0) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'seo',
        impact: 'visibility',
        title: 'Page uses H2 headings but has no H1',
        detail: 'Heading structure starts at H2, skipping H1.',
        recommendation: 'Add an <h1> above the H2 sections describing the page topic.',
      })
    );
  }
  if (h3Count > 0 && h2Count === 0) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'seo',
        impact: 'visibility',
        title: 'Heading levels skip from H1 to H3',
        detail: 'H3 headings present but no H2 — heading hierarchy is non-sequential.',
        recommendation: 'Use H2 for main sections and H3 only for sub-sections within H2 blocks.',
      })
    );
  }
  return findings;
}

function checkRobotsMeta(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const head = headOf(html);
  const robotsContent = pickAttr(head, /<meta[^>]+name=["']robots["'][^>]*>/i, 'content')?.toLowerCase() ?? '';
  if (robotsContent.includes('noindex')) {
    findings.push(
      mkFinding({
        severity: 'critical',
        category: 'robots',
        impact: 'visibility',
        title: 'Homepage is hidden from Google — "noindex" is set',
        detail: `<meta name="robots" content="${robotsContent}"> blocks search engine indexing.`,
        recommendation: 'Remove "noindex" from the robots meta tag unless you intentionally want this page hidden.',
      })
    );
  } else if (robotsContent.includes('nofollow')) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'robots',
        impact: 'visibility',
        title: 'Homepage has "nofollow" — Google won\'t crawl your links',
        detail: `<meta name="robots" content="${robotsContent}"> tells Google not to follow any links on this page.`,
        recommendation: 'Remove "nofollow" unless you have a specific reason to block link crawling on the homepage.',
      })
    );
  }
  return findings;
}

async function checkRobotsTxt(rootUrl: URL, timeoutMs: number): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const robotsUrl = `${rootUrl.origin}/robots.txt`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 5000));
    let res: Response;
    try {
      res = await fetch(robotsUrl, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      findings.push(
        mkFinding({
          severity: 'suggestion',
          category: 'robots',
          impact: 'visibility',
          title: 'No robots.txt file found',
          detail: `${robotsUrl} returned HTTP ${res.status}.`,
          recommendation: 'Create a /robots.txt file to guide search engine crawlers and list your sitemap URL.',
        })
      );
      return findings;
    }
    const text = await res.text();
    if (!text.includes('Sitemap:')) {
      findings.push(
        mkFinding({
          severity: 'suggestion',
          category: 'robots',
          impact: 'visibility',
          title: 'robots.txt has no Sitemap directive',
          detail: 'The robots.txt file exists but does not reference a sitemap.',
          recommendation: 'Add "Sitemap: https://yoursite.com/sitemap.xml" to help Google discover all your pages.',
        })
      );
    }
    if (/^disallow:\s*\/\s*$/im.test(text) && /user-agent:\s*\*/im.test(text)) {
      findings.push(
        mkFinding({
          severity: 'critical',
          category: 'robots',
          impact: 'visibility',
          title: 'robots.txt blocks ALL search engines from the entire site',
          detail: 'Found "Disallow: /" under "User-agent: *" — no search engine can index any page.',
          recommendation: 'Remove or correct the "Disallow: /" rule in robots.txt unless you intentionally want zero search traffic.',
        })
      );
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return findings;
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'robots',
        impact: 'visibility',
        title: 'Could not check robots.txt',
        detail: `Fetch failed: ${errMsg(e)}`,
      })
    );
  }
  return findings;
}

function checkUrlStructure(url: URL): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const path = url.pathname + url.search;
  if (/[?&](PHPSESSID|sid|sessionid)=/i.test(path)) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'seo',
        impact: 'visibility',
        title: 'Session ID visible in URL — creates duplicate content for Google',
        detail: `URL contains a session parameter: ${url.href}`,
        recommendation: 'Configure your server to store session IDs in cookies instead of URLs.',
      })
    );
  }
  if (/\.(html?|php)$/i.test(url.pathname)) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'seo',
        impact: 'polish',
        title: 'URL includes a file extension (.html / .php)',
        detail: `${url.pathname} — file extensions are unnecessary and look dated.`,
        recommendation: 'Configure URL rewriting to remove extensions for cleaner, shareable URLs.',
      })
    );
  }
  const depth = url.pathname.split('/').filter(Boolean).length;
  if (depth > 4) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'seo',
        impact: 'polish',
        title: 'URL is deeply nested (more than 4 path segments)',
        detail: `${url.pathname} has ${depth} path segments.`,
        recommendation: 'Flatten your URL structure so important pages are closer to the root.',
      })
    );
  }
  return findings;
}

function checkPerformanceProxies(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const head = headOf(html);

  const scriptRx = /<script\b[^>]+src=["'][^"']+["'][^>]*>/gi;
  const renderBlocking = Array.from(head.matchAll(scriptRx)).filter(
    (m) => !/\b(?:defer|async)\b/i.test(m[0])
  );
  if (renderBlocking.length > 0) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'speed',
        impact: 'speed',
        title: `${renderBlocking.length} render-blocking script(s) slow down page load`,
        detail: 'Scripts in <head> without defer or async block the browser from showing content.',
        recommendation: 'Add the "defer" attribute to <script src="..."> tags in your <head>.',
      })
    );
  }

  const imgTags = Array.from(html.matchAll(/<img\b[^>]*>/gi));
  if (imgTags.length >= 3 && !imgTags.some((m) => /loading=["']lazy["']/i.test(m[0]))) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'speed',
        impact: 'speed',
        title: `${imgTags.length} images load eagerly — slowing initial page render`,
        detail: 'No images use loading="lazy", so all images download immediately on page load.',
        recommendation: 'Add loading="lazy" to images below the fold to improve load time.',
      })
    );
  }

  if (!/<link\b[^>]+rel=["']preload["'][^>]*>/i.test(head)) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'speed',
        impact: 'speed',
        title: 'No resource preloading configured',
        detail: 'No <link rel="preload"> found in <head>.',
        recommendation: 'Preload critical fonts or hero images with <link rel="preload"> to improve perceived load speed.',
      })
    );
  }
  return findings;
}

function checkCmsDetection(html: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (/\/sites\/default\/files\//i.test(html) || /name=["']generator["'][^>]*content=["'][^"']*drupal/i.test(html)) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'trust',
        impact: 'polish',
        title: 'Site runs on Drupal CMS',
        detail: 'Drupal detected from page source.',
        recommendation: 'Ensure Drupal core and all modules are up to date to avoid known vulnerabilities.',
      })
    );
  } else if (/\/media\/joomla_/i.test(html) || /name=["']generator["'][^>]*content=["'][^"']*joomla/i.test(html)) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'trust',
        impact: 'polish',
        title: 'Site runs on Joomla CMS',
        detail: 'Joomla detected from page source.',
        recommendation: 'Keep Joomla and its extensions updated to patch security vulnerabilities.',
      })
    );
  } else if (/squarespace\.com/i.test(html)) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'trust',
        impact: 'polish',
        title: 'Site is hosted on Squarespace',
        detail: 'Squarespace platform detected from asset URLs.',
        recommendation: 'Squarespace is fully managed — ensure your subscription is active and CMS is up to date.',
      })
    );
  } else if (/wixstatic\.com/i.test(html)) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'trust',
        impact: 'polish',
        title: 'Site is hosted on Wix',
        detail: 'Wix platform detected from asset URLs.',
        recommendation: 'Wix is fully managed — ensure your plan is active. Custom domains improve trust and SEO.',
      })
    );
  }
  return findings;
}

function extractSecurityHeaders(res: Response): SecurityHeaders {
  const h = res.headers;
  const server = h.get('server') ?? h.get('x-powered-by') ?? null;
  const serverLeaks = server && /[\d.]{3,}/.test(server) ? server : null;
  return {
    csp:               !!h.get('content-security-policy'),
    xFrameOptions:     !!h.get('x-frame-options'),
    xContentTypeOpts:  !!h.get('x-content-type-options'),
    hsts:              !!h.get('strict-transport-security'),
    referrerPolicy:    !!h.get('referrer-policy'),
    permissionsPolicy: !!h.get('permissions-policy'),
    serverLeaks,
  };
}

function checkSecurityHeaders(headers: SecurityHeaders, isHttps: boolean): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (!headers.csp) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'security',
        impact: 'trust',
        title: 'No Content Security Policy header — XSS attacks are easier',
        detail: 'Missing Content-Security-Policy response header.',
        recommendation: 'Add a CSP header via your server or CDN to restrict which scripts can run on your pages.',
      })
    );
  }
  if (isHttps && !headers.hsts) {
    findings.push(
      mkFinding({
        severity: 'warning',
        category: 'security',
        impact: 'trust',
        title: 'HSTS not enabled — browser may allow plain HTTP connections',
        detail: 'Missing Strict-Transport-Security header on HTTPS site.',
        recommendation: 'Add "Strict-Transport-Security: max-age=31536000; includeSubDomains" to force HTTPS.',
      })
    );
  }
  if (!headers.xFrameOptions && !headers.csp) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'security',
        impact: 'trust',
        title: 'Site can be embedded in iframes (clickjacking risk)',
        detail: 'Missing X-Frame-Options header.',
        recommendation: 'Add "X-Frame-Options: SAMEORIGIN" to prevent your site from being embedded in malicious frames.',
      })
    );
  }
  if (!headers.xContentTypeOpts) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'security',
        impact: 'trust',
        title: 'Missing X-Content-Type-Options header',
        detail: 'Browsers may try to "sniff" content types, enabling certain attacks.',
        recommendation: 'Add "X-Content-Type-Options: nosniff" to your server response headers.',
      })
    );
  }
  if (headers.serverLeaks) {
    findings.push(
      mkFinding({
        severity: 'suggestion',
        category: 'security',
        impact: 'trust',
        title: 'Server version info is publicly visible',
        detail: `Response header reveals: "${headers.serverLeaks}"`,
        recommendation: 'Configure your web server to hide version information from response headers.',
      })
    );
  }
  return findings;
}

async function tryAiEnrich(
  report: AuditReport,
  lead: Lead,
  settings: Settings
): Promise<AuditReport> {
  if (!settings.aiEnabled || !settings.aiApiKey) return report;

  let apiKey: string;
  try {
    apiKey = await decrypt(settings.aiApiKey);
    if (!apiKey) return report;
  } catch {
    return report;
  }

  const endpoint = settings.aiProvider === 'nvidia'
    ? 'https://integrate.ai.api.nvidia.com/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  const criticals = report.findings.filter((f) => f.severity === 'critical');
  const warnings  = report.findings.filter((f) => f.severity === 'warning');
  const suggs     = report.findings.filter((f) => f.severity === 'suggestion');

  const fmtList = (fs: AuditFinding[]) =>
    fs.length ? fs.map((f) => `- ${f.title}: ${f.detail}`).join('\n') : '(none)';

  const userPrompt = `You are a web consultant. Analyze this website audit and return JSON only.

Business: ${lead.name ?? 'Unknown'} (${lead.category ?? 'local business'}) — ${report.url}
Score: ${report.score ?? 0}/100

Issues found:
CRITICAL:
${fmtList(criticals)}

WARNINGS:
${fmtList(warnings)}

SUGGESTIONS:
${fmtList(suggs.slice(0, 5))}

Return this exact JSON (no markdown, no explanation, no code fences):
{"aiSummary":"2-3 sentence summary for the business owner in plain English","aiRecommendations":[{"priority":1,"title":"...","action":"start with a verb","impact":"trust"}]}

Rules: 3-5 recommendations, priority 1 = most urgent, impact must be one of: trust, reach, visibility, speed, polish.`;

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(settings.aiProvider === 'openrouter' ? { 'HTTP-Referer': 'chrome-extension://lbe' } : {}),
        },
        body: JSON.stringify({
          model: settings.aiModel,
          messages: [{ role: 'user', content: userPrompt }],
          max_tokens: 600,
          temperature: 0.3,
        }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      alog('warn', { url: report.url }, `AI provider returned HTTP ${res.status}`);
      return report;
    }

    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    const raw = json?.choices?.[0]?.message?.content ?? '';
    if (!raw) return report;

    let parsed: { aiSummary?: string; aiRecommendations?: AiRecommendation[] } = {};
    try {
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch { return report; }
      } else {
        return report;
      }
    }

    const validImpacts = new Set(['trust', 'reach', 'visibility', 'speed', 'polish']);
    const recs = (parsed.aiRecommendations ?? [])
      .filter((r) => r && typeof r.title === 'string' && typeof r.action === 'string')
      .map((r) => ({
        priority: ([1, 2, 3].includes(r.priority) ? r.priority : 3) as 1 | 2 | 3,
        title: String(r.title).slice(0, 120),
        action: String(r.action).slice(0, 200),
        impact: (validImpacts.has(r.impact) ? r.impact : 'polish') as AiRecommendation['impact'],
      }));

    return {
      ...report,
      aiSummary: typeof parsed.aiSummary === 'string' ? parsed.aiSummary.slice(0, 500) : undefined,
      aiRecommendations: recs.length ? recs : undefined,
      aiEnhanced: true,
    };
  } catch (e) {
    alog('warn', { url: report.url }, `AI enrichment failed: ${errMsg(e)}`);
    return report;
  }
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
