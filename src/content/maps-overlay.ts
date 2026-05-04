// Visual overlay: paints a status dot on each Maps result card
// indicating whether we already have a lead for that place and what
// pipeline status it's in. Runs in parallel with maps-scraper.ts.

import type { Lead, LeadStatus } from '../shared/types';

const BADGE_ATTR = 'data-lbe-badge';
const KEY_ATTR = 'data-lbe-place';

const COLOR_BY_STATUS: Record<LeadStatus, string> = {
  new: '#8b94a3',
  contacted: '#5b9bff',
  replied: '#4ade80',
  qualified: '#34d399',
  won: '#fbbf24',
  lost: '#f87171',
  archived: '#4b5563',
};

let leadIndex = new Map<string, Lead>();
let observer: MutationObserver | null = null;
let scheduled = false;

bootstrap().catch((e) => console.warn('[lbe overlay] bootstrap failed', e));

async function bootstrap() {
  await reloadIndex();
  paintAll();
  hookMutations();
  hookMessageBus();
}

function hookMutations() {
  observer?.disconnect();
  observer = new MutationObserver(schedulePaint);
  observer.observe(document.body, { childList: true, subtree: true });
}

function hookMessageBus() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === 'LEAD_CHANGED') {
      void reloadIndex().then(paintAll);
    }
  });
}

async function reloadIndex() {
  try {
    const r = (await chrome.runtime.sendMessage({ kind: 'LEADS_LIST' })) as { leads: Lead[] };
    leadIndex = new Map();
    for (const l of r.leads) {
      const k = keyForUrl(l.placeUrl);
      if (k) leadIndex.set(k, l);
    }
  } catch {
    // service worker may be waking; try again later
  }
}

function schedulePaint() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    paintAll();
  });
}

function paintAll() {
  const cards = document.querySelectorAll<HTMLElement>(
    'div[role="feed"] a[href*="/maps/place"], div[role="article"] a[href*="/maps/place"]'
  );
  cards.forEach((a) => {
    const card = (a.closest('div[role="article"]') ?? a.parentElement) as HTMLElement | null;
    if (!card) return;
    const key = keyForUrl(a.getAttribute('href') ?? '');
    if (!key) return;
    const lead = leadIndex.get(key);
    upsertBadge(card, key, lead);
  });
}

function upsertBadge(card: HTMLElement, key: string, lead: Lead | undefined) {
  let badge = card.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
  if (!lead) {
    if (badge) badge.remove();
    card.removeAttribute(KEY_ATTR);
    return;
  }
  card.setAttribute(KEY_ATTR, key);
  const status = (lead.status ?? 'new') as LeadStatus;
  const color = COLOR_BY_STATUS[status];

  if (!badge) {
    badge = document.createElement('div');
    badge.setAttribute(BADGE_ATTR, '1');
    Object.assign(badge.style, {
      position: 'absolute',
      top: '6px',
      right: '6px',
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 6px',
      borderRadius: '4px',
      fontSize: '10px',
      fontFamily: 'system-ui, sans-serif',
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      pointerEvents: 'none',
      zIndex: '5',
    } as Partial<CSSStyleDeclaration>);
    if (getComputedStyle(card).position === 'static') {
      card.style.position = 'relative';
    }
    card.appendChild(badge);
  }

  badge.style.background = color + '33';
  badge.style.border = `1px solid ${color}`;
  badge.style.color = color;
  badge.textContent = status === 'new' ? '● scraped' : `● ${status}`;
}

function keyForUrl(href: string): string {
  if (!href) return '';
  try {
    const u = new URL(href, location.origin);
    // Use the place segment + the !1s<hex> id when present — survives query churn.
    const m = u.pathname.match(/\/place\/([^/]+)(?:\/data=[^!]*!1s([^!?]+))?/);
    if (m) return `${m[1]}|${m[2] ?? ''}`;
    return u.pathname;
  } catch {
    return href;
  }
}
