import type { Lead } from '../shared/types';
import type { Msg } from '../shared/messages';
import { jitter, sleep, waitFor, speedToBaseDelay, sha1Hex } from './stealth';

const FEED_SELECTOR = 'div[role="feed"]';
const CARD_SELECTORS = [
  'div[role="feed"] > div > div[jsaction]',
  'div[role="feed"] a[href*="/maps/place"]',
];
const PLACE_LINK = 'a[href*="/maps/place"]';

interface Cfg {
  maxResults: number;
  speed: 'slow' | 'medium' | 'fast';
}

let running = false;
let seen = new Set<string>();
let port: chrome.runtime.Port | null = null;

chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
  if (msg.kind === 'SCRAPE_START') {
    if (running) {
      reply({ ok: false, error: 'already running' });
      return;
    }
    start(msg.payload).catch((e) => reportError(String(e)));
    reply({ ok: true });
    return;
  }
  if (msg.kind === 'SCRAPE_STOP') {
    running = false;
    reply({ ok: true });
    return;
  }
});

async function start(cfg: Cfg) {
  running = true;
  seen = new Set();
  openPort();

  const query = readQueryFromPage();

  const feed = await waitFor(() => document.querySelector<HTMLElement>(FEED_SELECTOR), 10_000);
  if (!feed) {
    sendBatch([], true, 'Could not find Google Maps result feed. Run a search first.', query);
    closePort();
    running = false;
    return;
  }

  // Announce the search query so the background can open a session.
  sendBatch([], false, undefined, query);

  const baseDelay = speedToBaseDelay(cfg.speed);
  const STALL_BAIL = 12;
  const PENDING_WAIT_MAX = 6;
  let stall = 0;
  let lastFoundCount = 0;

  while (running && seen.size < cfg.maxResults) {
    let harvested = await harvestVisible(feed);
    let pendingWaits = 0;
    while (running && harvested.pending > 0 && pendingWaits < PENDING_WAIT_MAX) {
      // Skeleton cards visible — let them render before we scroll past them.
      await sleep(jitter(baseDelay * 0.6, 0.3));
      harvested = await harvestVisible(feed);
      pendingWaits += 1;
    }

    const fresh: Lead[] = [];
    for (const l of harvested.leads) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        fresh.push(l);
        if (seen.size >= cfg.maxResults) break;
      }
    }
    if (fresh.length) sendBatch(fresh, false);

    const grewByLeads = seen.size > lastFoundCount;
    lastFoundCount = seen.size;

    const beforeHeight = feed.scrollHeight;
    feed.scrollTop = feed.scrollHeight;
    feed.scrollBy({ top: jitter(800, 0.3) });
    await sleep(jitter(baseDelay, 0.4));
    const grewByHeight = feed.scrollHeight > beforeHeight;

    // Only treat lead growth as real progress. Height growth alone is often
    // skeleton placeholders that never resolve and would mask a true stall.
    if (grewByLeads) {
      stall = 0;
    } else {
      stall += 1;
      if (stall >= 3) {
        const last = feed.querySelector<HTMLElement>(`${CARD_SELECTORS[1]}:last-of-type`);
        last?.scrollIntoView({ block: 'end' });
        await sleep(jitter(baseDelay * 1.5, 0.3));
      }
      if (stall >= STALL_BAIL && isAtEndOfResults(feed)) break;
      if (stall >= STALL_BAIL && !grewByHeight) break;
      if (stall >= STALL_BAIL * 2) break;
    }
  }

  sendBatch([], true);
  closePort();
  running = false;
}

function isAtEndOfResults(feed: HTMLElement): boolean {
  const text = (feed.lastElementChild?.textContent ?? '').toLowerCase();
  if (text.includes("you've reached the end")) return true;
  if (text.includes('end of the list')) return true;
  return false;
}

async function harvestVisible(feed: HTMLElement): Promise<{ leads: Lead[]; pending: number }> {
  const out: Lead[] = [];
  let pending = 0;

  let cards: HTMLElement[] = [];
  for (const sel of CARD_SELECTORS) {
    cards = Array.from(feed.querySelectorAll<HTMLElement>(sel));
    if (cards.length) break;
  }
  if (!cards.length) cards = Array.from(feed.querySelectorAll<HTMLElement>('div[jsaction]'));

  for (const card of cards) {
    if (!isLikelyResultCard(card)) continue;

    const link = card.matches(PLACE_LINK)
      ? (card as HTMLAnchorElement)
      : card.querySelector<HTMLAnchorElement>(PLACE_LINK);
    if (!link?.href) {
      pending += 1;
      continue;
    }
    const placeUrl = link.href;

    const name =
      pickName(card, link) ??
      '';
    if (!name) {
      pending += 1;
      continue;
    }

    const id = await sha1Hex(placeUrl);

    const { rating, reviewCount } = pickRating(card);
    const facts = collectFactCells(card);
    const { phone, address, category } = classifyFacts(facts, name);

    const websiteEl =
      card.querySelector<HTMLAnchorElement>('a[data-value="Website" i]') ||
      card.querySelector<HTMLAnchorElement>('a[aria-label*="Website" i]') ||
      card.querySelector<HTMLAnchorElement>('a[data-tooltip*="website" i]');
    const rawWebsite = websiteEl?.href || null;
    // Google wraps sponsored-result website clicks in aclk/adclick redirectors.
    // The destination isn't querystring-extractable when adurl= is empty, and
    // fetching google.com/aclk causes CORS errors for the redirected response.
    // Store null so the audit doesn't attempt it; user can paste the real URL.
    const website = rawWebsite && isGoogleRedirector(rawWebsite) ? null : rawWebsite;

    out.push({
      id,
      name,
      category,
      address,
      phone,
      website,
      rating,
      reviewCount,
      coords: parseCoords(placeUrl),
      placeUrl,
      scrapedAt: Date.now(),
      websiteStatus: website ? 'present' : 'missing',
      source: 'maps-scrape',
    });
  }
  return { leads: out, pending };
}

// A real result card has visible dimensions. Skeletons + the "Loading…" /
// end-of-list footers render with zero height; treat them as not-yet-cards
// so they don't inflate the pending count or trigger false stalls.
function isLikelyResultCard(card: HTMLElement): boolean {
  const rect = card.getBoundingClientRect();
  return rect.height > 20 && rect.width > 20;
}

// Google wraps sponsored-result website buttons in click-tracking redirectors.
// The actual destination is not reliably encoded in the URL params (adurl= is
// often empty), and fetching the redirector from an extension context causes a
// CORS error on the redirected response. Detect these so callers can discard.
const GOOGLE_REDIRECTORS = /^https?:\/\/(www\.)?google\.(com|[a-z]{2})\/(aclk|url|adurl)\b/;
function isGoogleRedirector(url: string): boolean {
  return GOOGLE_REDIRECTORS.test(url);
}

function pickName(card: HTMLElement, link: HTMLAnchorElement): string | null {
  const headline = card.querySelector('.fontHeadlineSmall, .qBF1Pd');
  if (headline?.textContent) return headline.textContent.trim();
  const aria = link.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  return null;
}

function pickRating(card: HTMLElement): { rating: number | null; reviewCount: number | null } {
  const ratingEl = card.querySelector<HTMLElement>('.MW4etd, span.fontBodyMedium > span[role="img"]');
  let rating: number | null = null;
  if (ratingEl) {
    const direct = (ratingEl.textContent ?? '').trim();
    const m = direct.match(/^\d+(\.\d+)?/);
    if (m) rating = parseFloat(m[0]);
    if (rating == null) {
      const aria = ratingEl.getAttribute('aria-label') ?? '';
      const a = aria.match(/(\d+(\.\d+)?)/);
      if (a) rating = parseFloat(a[1]);
    }
  }
  const revEl = card.querySelector<HTMLElement>('.UY7F9, span.fontBodyMedium > span[aria-label*="review" i]');
  let reviewCount: number | null = null;
  if (revEl) {
    const m = (revEl.textContent ?? '').match(/(\d[\d,]*)/);
    if (m) reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
  }
  if (reviewCount == null) {
    // Fallback: parenthesized number anywhere in card
    const m = card.textContent?.match(/\(([\d,]+)\)/);
    if (m) reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
  }
  return { rating: Number.isFinite(rating ?? NaN) ? rating : null, reviewCount };
}

// Collect atomic info cells. Maps puts each fact in its own .W4Efsd > span,
// with a literal "·" separator span between them. We grab leaf-only spans
// to avoid the parent container's concatenated textContent leaking in.
function collectFactCells(card: HTMLElement): string[] {
  const out: string[] = [];
  const seenStr = new Set<string>();
  const nodes = card.querySelectorAll<HTMLElement>('.W4Efsd span, .UaQhfb span');
  nodes.forEach((s) => {
    if (s.children.length > 0) return; // leaf only
    const t = (s.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (t === '·' || t === '⋅' || t === '•') return;
    if (/^\(\d[\d,]*\)$/.test(t)) return; // review count "(48)"
    if (/^\d+(\.\d+)?$/.test(t)) return; // bare rating "4.5"
    if (seenStr.has(t)) return;
    seenStr.add(t);
    out.push(t);
  });
  return out;
}

function classifyFacts(
  facts: string[],
  name: string
): { phone: string | null; address: string; category: string | null } {
  const HOURS_RX = /\b(open|closed|closes|opens|opening|24\s*hours|permanently)\b/i;
  const PHONE_RX = /^\+?[\d\s().-]{8,}$/;
  const STREET_RX = /\d+\s+\S|,/;
  const lower = (s: string) => s.toLowerCase();

  let phone: string | null = null;
  let address = '';
  let category: string | null = null;

  for (const raw of facts) {
    const f = raw.trim();
    if (!f) continue;
    if (lower(f) === lower(name)) continue;
    if (HOURS_RX.test(f) && !STREET_RX.test(f)) continue; // hours line
    if (!phone && PHONE_RX.test(f) && countDigits(f) >= 8) {
      phone = f;
      continue;
    }
    if (!address && STREET_RX.test(f) && !HOURS_RX.test(f)) {
      address = f;
      continue;
    }
    if (!category && /[a-z]/i.test(f) && f.length <= 60) {
      category = f;
      continue;
    }
  }
  return { phone, address, category };
}

function countDigits(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

function parseCoords(url: string): { lat: number; lng: number } | null {
  const m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
}

function sendBatch(leads: Lead[], done: boolean, error?: string, query?: string) {
  const msg: Msg = { kind: 'SCRAPE_BATCH', payload: { leads, done, error, query } };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function readQueryFromPage(): string {
  // /maps/search/<query>/@... — query is URL-encoded with + for spaces.
  const m = location.pathname.match(/\/maps\/search\/([^/@]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
    } catch {}
  }
  // Fallback: page title "<query> - Google Maps"
  const t = (document.title || '').replace(/\s*-\s*Google Maps\s*$/i, '').trim();
  if (t && t !== 'Google Maps') return t;
  // Fallback: search input
  const input = document.querySelector<HTMLInputElement>('input[id="searchboxinput"], input[aria-label*="search" i]');
  return (input?.value ?? '').trim();
}

function reportError(error: string) {
  sendBatch([], true, error);
  closePort();
  running = false;
}

function openPort() {
  try {
    closePort();
    port = chrome.runtime.connect({ name: 'scrape-keepalive' });
    port.onDisconnect.addListener(() => {
      port = null;
    });
  } catch {
    port = null;
  }
}

function closePort() {
  try {
    port?.disconnect();
  } catch {}
  port = null;
}
