import type { Msg } from '../shared/messages';
import type { Lead, OutreachItem, Settings, Template } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import {
  leadStore,
  auditStore,
  outreachStore,
  templateStore,
  optoutStore,
  settingsStore,
  progressStore,
  sessionStore,
} from './storage';
import { probeWebsite } from './probe';
import { runAudit } from './audit';
import { installQueueAlarm, sendNow, tickQueue } from './queue';
import { disconnect, getToken, whoAmI } from './gmail';
import { leadsToCsv } from '../shared/csv';
import { newTemplate, render, buildVars, geoGate, TemplateValidationError } from '../shared/templates';

installQueueAlarm();

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSeedTemplates();
  await migrateUnknownStatus();
});

chrome.runtime.onStartup.addListener(() => {
  void migrateUnknownStatus();
});

async function migrateUnknownStatus() {
  const all = await leadStore.list();
  const targets = all.filter((l) => l.websiteStatus === ('unknown' as any) && !!l.website);
  for (const l of targets) {
    await leadStore.update(l.id, { websiteStatus: 'present' });
  }
}

async function broadcastLeadChange(id?: string) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.google.com/maps/*' });
    for (const t of tabs) {
      if (!t.id) continue;
      try {
        await chrome.tabs.sendMessage(t.id, { kind: 'LEAD_CHANGED', payload: { id } });
      } catch {
        // tab may not have content script loaded; ignore
      }
    }
  } catch {}
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
  handle(msg)
    .then(reply)
    .catch((e) => reply({ ok: false, error: String(e) }));
  return true; // async reply
});

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.kind) {
    case 'PING':
      return { ok: true, ts: Date.now() };

    case 'SCRAPE_START':
      return startScrape(msg.payload);

    case 'SCRAPE_STOP':
      return stopScrape();

    case 'SCRAPE_BATCH':
      return ingestBatch(msg.payload);

    case 'SCRAPE_PROGRESS_GET':
      return progressStore.get();

    case 'SESSIONS_LIST':
      return { sessions: await sessionStore.list() };

    case 'LEADS_LIST': {
      const leads = await leadStore.list(msg.payload);
      return { leads };
    }
    case 'LEAD_GET': {
      const lead = (await leadStore.get(msg.payload.id)) ?? null;
      return { lead };
    }
    case 'LEAD_UPDATE': {
      const patch: Partial<Lead> = { ...msg.payload.patch };
      if (patch.status) patch.statusUpdatedAt = Date.now();
      await leadStore.update(msg.payload.id, patch);
      const lead = await leadStore.get(msg.payload.id);
      void broadcastLeadChange(msg.payload.id);
      return { ok: true, lead };
    }
    case 'LEADS_DELETE': {
      const deleted = await leadStore.deleteMany(msg.payload.ids);
      void broadcastLeadChange();
      return { ok: true, deleted };
    }
    case 'LEADS_CLEAR_ALL': {
      const cleared = await leadStore.clear();
      void broadcastLeadChange();
      return { ok: true, cleared };
    }
    case 'LEADS_EXPORT_CSV': {
      const all = await leadStore.list({ sessionId: msg.payload?.sessionId });
      const subset = msg.payload?.ids
        ? all.filter((l) => msg.payload!.ids!.includes(l.id))
        : all;
      const csv = leadsToCsv(subset);
      const filename = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
      return { ok: true, csv, filename };
    }

    case 'AUDIT_RUN': {
      const lead = await leadStore.get(msg.payload.leadId);
      if (!lead) return { ok: false, error: `lead not found: ${msg.payload.leadId}` };
      if (!msg.payload.force) {
        const cached = await auditStore.latestForLead(lead.id);
        if (cached && Date.now() - cached.ranAt < 7 * 86400_000) {
          return { ok: true, report: cached };
        }
      }
      const settings = await settingsStore.get();
      let report;
      try {
        report = await runAudit({ lead, settings });
      } catch (e) {
        const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        console.error('AUDIT_RUN: runAudit threw', e);
        return { ok: false, error: `audit crashed: ${error}` };
      }
      try {
        await auditStore.insert(report);
      } catch (e) {
        console.warn('AUDIT_RUN: failed to persist report', e);
      }
      return { ok: true, report };
    }
    case 'AUDIT_LIST':
      return { reports: await auditStore.list(msg.payload?.leadId) };
    case 'AUDIT_DELETE':
      await auditStore.delete(msg.payload.id);
      return { ok: true };

    case 'OUTREACH_DRAFT':
      return draftOutreach(msg.payload.leadId, msg.payload.templateId);
    case 'OUTREACH_QUEUE': {
      await outreachStore.update(msg.payload.id, { status: 'queued' });
      tickQueue().catch(() => {});
      return { ok: true };
    }
    case 'OUTREACH_SEND_NOW':
      return sendNow(msg.payload.id);
    case 'OUTREACH_LIST':
      return { items: await outreachStore.list(msg.payload) };
    case 'OUTREACH_DELETE':
      await outreachStore.delete(msg.payload.id);
      return { ok: true };

    case 'GMAIL_CONNECT':
      return connectGmail();
    case 'GMAIL_DISCONNECT':
      await disconnect();
      return { ok: true };
    case 'GMAIL_STATUS': {
      const token = await getToken(false).catch(() => null);
      if (!token) return { connected: false };
      const me = await whoAmI();
      return { connected: true, email: me.email };
    }

    case 'TEMPLATE_LIST':
      return { templates: await templateStore.list() };
    case 'TEMPLATE_UPSERT':
      await templateStore.upsert(msg.payload);
      return { ok: true };
    case 'TEMPLATE_DELETE':
      await templateStore.delete(msg.payload.id);
      return { ok: true };

    case 'SETTINGS_GET':
      return settingsStore.get();
    case 'SETTINGS_SET': {
      const settings = await settingsStore.set(msg.payload);
      return { ok: true, settings };
    }

    case 'OPTOUT_ADD':
      await optoutStore.add(msg.payload.email);
      return { ok: true };
    case 'OPTOUT_LIST':
      return { emails: await optoutStore.list() };
    case 'OPTOUT_REMOVE':
      await optoutStore.remove(msg.payload.email);
      return { ok: true };

    default:
      return { ok: false, error: `unknown msg: ${(msg as any).kind}` };
  }
}

async function startScrape(payload: { maxResults: number; speed: Settings['scrapeSpeed'] }) {
  const tab = await getMapsTab();
  if (!tab?.id) {
    return { ok: false, error: 'Open Google Maps in a tab and run a search first.' };
  }
  await progressStore.set({
    active: true,
    found: 0,
    target: payload.maxResults,
    startedAt: Date.now(),
    lastError: undefined,
    // Clear previous session pointer so the next batch opens a fresh session.
    sessionId: undefined,
    query: undefined,
  });
  try {
    await chrome.tabs.sendMessage(tab.id, { kind: 'SCRAPE_START', payload });
  } catch (e) {
    await progressStore.set({ active: false, lastError: String(e) });
    return { ok: false, error: `Could not message Maps tab: ${e}. Reload the Maps tab.` };
  }
  return { ok: true };
}

async function stopScrape() {
  const tab = await getMapsTab();
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { kind: 'SCRAPE_STOP' });
    } catch {}
  }
  await progressStore.set({ active: false });
  return { ok: true };
}

async function ingestBatch(payload: { leads: Lead[]; done: boolean; error?: string; query?: string }) {
  if (payload.error) {
    const cur = await progressStore.get();
    if (cur.sessionId) await sessionStore.update(cur.sessionId, { endedAt: Date.now() });
    await progressStore.set({ active: false, lastError: payload.error });
    return { ok: true };
  }

  // Open a new session on the first batch (no leads, query announced).
  let progress = await progressStore.get();
  if (payload.query && (!progress.sessionId || progress.query !== payload.query || !progress.active)) {
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      query: payload.query,
      startedAt: Date.now(),
      leadCount: 0,
    };
    await sessionStore.create(session);
    progress = await progressStore.set({
      sessionId,
      query: payload.query,
      active: true,
      found: 0,
    });
  }

  const sessionId = progress.sessionId;
  const searchQuery = progress.query;

  const enriched = await Promise.all(
    payload.leads.map(async (l) => {
      const stamped: Lead = {
        ...l,
        searchSessionId: sessionId,
        searchQuery,
        status: l.status ?? 'new',
      };
      if (!l.website) return stamped;
      try {
        const probe = await probeWebsite(l.website);
        return { ...stamped, websiteStatus: probe.status, websiteHttpStatus: probe.code };
      } catch {
        return stamped;
      }
    })
  );
  await leadStore.upsertMany(enriched);
  void broadcastLeadChange();

  if (sessionId) {
    const count = await leadStore.countForSession(sessionId);
    await sessionStore.update(sessionId, {
      leadCount: count,
      endedAt: payload.done ? Date.now() : undefined,
    });
    await progressStore.set({
      active: !payload.done,
      found: count,
    });
  } else {
    const total = await leadStore.count();
    await progressStore.set({ active: !payload.done, found: total });
  }

  if (payload.done && sessionId) {
    await sessionStore.update(sessionId, { endedAt: Date.now() });
  }
  return { ok: true };
}

async function getMapsTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: 'https://www.google.com/maps/*' });
  if (!tabs.length) return undefined;
  const active = tabs.find((t) => t.active);
  return active ?? tabs[0];
}

async function draftOutreach(leadId: string, templateId: string) {
  const lead = await leadStore.get(leadId);
  if (!lead) return { ok: false, error: 'lead not found' };
  const tpls = await templateStore.list();
  const tpl = tpls.find((t) => t.id === templateId);
  if (!tpl) return { ok: false, error: 'template not found' };
  const settings = await settingsStore.get();

  const gate = geoGate(lead.address, tpl, settings.geoStrictMode);
  if (!gate.allow) return { ok: false, error: `geo-gate: ${gate.reason}` };

  // Pull the most recent successful audit for this lead so {{AUDIT_*}} tokens
  // can be filled in. Failed-audit reports are skipped (their summary contains
  // the error string, not findings — useless for outreach).
  let latestAudit = null;
  try {
    const candidate = await auditStore.latestForLead(lead.id);
    if (candidate?.ok) latestAudit = candidate;
  } catch (e) {
    console.warn('draftOutreach: failed to load latest audit', leadId, e);
  }

  const optOutLink = settings.defaultOptOutBaseUrl;
  const vars = buildVars(lead, settings, optOutLink, latestAudit);

  let rendered;
  try {
    rendered = render(tpl, vars);
  } catch (e) {
    if (e instanceof TemplateValidationError) return { ok: false, error: e.message };
    throw e;
  }

  const to = await guessEmail(lead);
  if (!to) {
    return { ok: false, error: 'no email available; add Hunter.io key in settings or set manually' };
  }

  const item: OutreachItem = {
    id: crypto.randomUUID(),
    leadId: lead.id,
    channel: 'email',
    templateId: tpl.id,
    to,
    subject: rendered.subject,
    body: rendered.bodyText,
    bodyHtml: rendered.bodyHtml,
    status: 'draft',
    attempts: 0,
  };
  await outreachStore.insert(item);
  return { ok: true, item };
}

async function guessEmail(lead: Lead): Promise<string | null> {
  if (!lead.website) return null;
  let domain: string;
  try {
    domain = new URL(lead.website).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  const settings = await settingsStore.get();
  if (!settings.hunterApiKey) return `info@${domain}`;
  try {
    const { decrypt } = await import('../shared/crypto');
    const key = await decrypt(settings.hunterApiKey);
    const r = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${encodeURIComponent(key)}&limit=3`
    );
    if (!r.ok) return `info@${domain}`;
    const j = (await r.json()) as { data?: { emails?: { value: string; confidence: number }[] } };
    const best = j.data?.emails?.sort((a, b) => b.confidence - a.confidence)[0];
    return best?.value ?? `info@${domain}`;
  } catch {
    return `info@${domain}`;
  }
}

async function connectGmail() {
  try {
    await getToken(true);
    const me = await whoAmI();
    return { ok: true, email: me.email };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function ensureSeedTemplates() {
  const existing = await templateStore.list();
  if (existing.length) return;
  const noSite = newTemplate({ name: 'No-website outreach', forCohort: 'no-website' });
  const hasSite = newTemplate({
    name: 'Audit findings outreach',
    forCohort: 'has-website',
    subject: 'Quick fixes I spotted on {{BUSINESS_NAME}}\'s site',
    bodyText: `Hi {{BUSINESS_NAME}},

I ran a quick technical check on your site and noticed a few items that might be worth fixing — broken links, mobile-friendliness, and missing SEO tags can quietly cost local businesses traffic.

Happy to share the full report. Just reply if you'd like it.

Thanks,
{{SENDER_NAME}}
{{SENDER_EMAIL}}

---
{{SENDER_ADDRESS}}
Don't want to hear from me? Unsubscribe: {{OPTOUT_LINK}}
`,
    bodyHtml: `<p>Hi {{BUSINESS_NAME}},</p>
<p>I ran a quick technical check on your site and noticed a few items that might be worth fixing — broken links, mobile-friendliness, and missing SEO tags can quietly cost local businesses traffic.</p>
<p>Happy to share the full report. Just reply if you'd like it.</p>
<p>Thanks,<br/>{{SENDER_NAME}}<br/>{{SENDER_EMAIL}}</p>
<hr/>
<p style="color:#888;font-size:12px">{{SENDER_ADDRESS}}<br/>Don't want to hear from me? <a href="{{OPTOUT_LINK}}">Unsubscribe</a>.</p>`,
  });
  await templateStore.upsert(noSite);
  await templateStore.upsert(hasSite);
}

// Keep the service worker alive for the duration of a scrape.
// The content script opens a long-lived port; we send periodic heartbeats
// so MV3's idle timer is reset on every message.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'scrape-keepalive') return;
  const interval = setInterval(() => {
    try {
      port.postMessage({ kind: 'HEARTBEAT', ts: Date.now() });
    } catch {
      clearInterval(interval);
    }
  }, 20_000);
  port.onDisconnect.addListener(() => {
    clearInterval(interval);
  });
});
