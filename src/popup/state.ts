import { create } from 'zustand';
import type {
  Lead,
  AuditReport,
  OutreachItem,
  Template,
  Settings,
  ScrapeProgress,
  SearchSession,
} from '../shared/types';
import { send } from '../shared/messages';

type Tab = 'scrape' | 'leads' | 'audits' | 'outreach' | 'settings';

interface State {
  tab: Tab;
  setTab: (t: Tab) => void;

  progress: ScrapeProgress;
  refreshProgress: () => Promise<void>;
  startScrape: (max: number, speed: Settings['scrapeSpeed']) => Promise<void>;
  stopScrape: () => Promise<void>;

  leads: Lead[];
  leadFilter: 'all' | 'present' | 'missing' | 'dead';
  query: string;
  sessionFilter: string; // '' = all sessions, 'current' = active, or session id
  sessions: SearchSession[];
  selected: Set<string>;
  refreshLeads: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  setLeadFilter: (f: State['leadFilter']) => void;
  setQuery: (q: string) => void;
  setSessionFilter: (id: string) => void;
  toggleSelect: (id: string) => void;
  selectAll: () => void;
  clearSelect: () => void;
  deleteSelected: () => Promise<void>;
  exportSelectedCsv: () => Promise<void>;
  clearAllLeads: () => Promise<number>;

  detailLeadId: string | null;
  openDetail: (id: string | null) => void;
  updateLead: (id: string, patch: Partial<Lead>) => Promise<void>;
  isSidePanel: boolean;
  setSidePanel: (b: boolean) => void;

  audits: AuditReport[];
  refreshAudits: () => Promise<void>;
  runAudit: (leadId: string, force?: boolean) => Promise<AuditReport | undefined>;

  outreach: OutreachItem[];
  refreshOutreach: () => Promise<void>;
  draftOutreach: (leadId: string, templateId: string) => Promise<{ ok: boolean; error?: string }>;
  queueOutreach: (id: string) => Promise<void>;
  sendOutreachNow: (id: string) => Promise<{ ok: boolean; error?: string }>;
  deleteOutreach: (id: string) => Promise<void>;

  templates: Template[];
  refreshTemplates: () => Promise<void>;

  settings: Settings;
  refreshSettings: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;

  gmail: { connected: boolean; email?: string };
  refreshGmail: () => Promise<void>;
  connectGmail: () => Promise<void>;
  disconnectGmail: () => Promise<void>;
}

export const useApp = create<State>((set, get) => ({
  tab: 'scrape',
  setTab: (tab) => {
    set({ tab });
    void hydrateForTab(tab, get);
  },

  progress: { active: false, found: 0, target: 0 },
  refreshProgress: async () => set({ progress: await send('SCRAPE_PROGRESS_GET') }),
  startScrape: async (max, speed) => {
    const r = await send('SCRAPE_START', { maxResults: max, speed });
    if (!r.ok) {
      set((s) => ({ progress: { ...s.progress, lastError: r.error } }));
    }
    void get().refreshProgress();
  },
  stopScrape: async () => {
    await send('SCRAPE_STOP');
    void get().refreshProgress();
  },

  leads: [],
  leadFilter: 'all',
  query: '',
  sessionFilter: 'current',
  sessions: [],
  selected: new Set(),
  refreshSessions: async () => {
    const r = await send('SESSIONS_LIST');
    set({ sessions: r.sessions });
  },
  refreshLeads: async () => {
    const { leadFilter, query, sessionFilter, progress, sessions } = get();
    let sessionId: string | undefined;
    if (sessionFilter === 'current') {
      sessionId = progress.sessionId ?? sessions[0]?.id;
    } else if (sessionFilter && sessionFilter !== 'all') {
      sessionId = sessionFilter;
    }
    const r = await send('LEADS_LIST', {
      websiteStatus: leadFilter === 'all' ? undefined : (leadFilter as Lead['websiteStatus']),
      q: query || undefined,
      sessionId,
    });
    set({ leads: r.leads });
  },
  setLeadFilter: (leadFilter) => {
    set({ leadFilter, selected: new Set() });
    void get().refreshLeads();
  },
  setQuery: (query) => {
    set({ query });
    void get().refreshLeads();
  },
  setSessionFilter: (sessionFilter) => {
    set({ sessionFilter, selected: new Set() });
    void get().refreshLeads();
  },
  clearAllLeads: async () => {
    const r = await send('LEADS_CLEAR_ALL');
    set({ selected: new Set() });
    void get().refreshLeads();
    void get().refreshSessions();
    return r.cleared;
  },
  toggleSelect: (id) => {
    const cur = new Set(get().selected);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    set({ selected: cur });
  },
  selectAll: () => set({ selected: new Set(get().leads.map((l) => l.id)) }),
  clearSelect: () => set({ selected: new Set() }),
  deleteSelected: async () => {
    const ids = Array.from(get().selected);
    if (!ids.length) return;
    await send('LEADS_DELETE', { ids });
    set({ selected: new Set() });
    void get().refreshLeads();
  },
  exportSelectedCsv: async () => {
    const { selected, sessionFilter, progress, sessions } = get();
    const ids = Array.from(selected);
    let sessionId: string | undefined;
    if (!ids.length) {
      if (sessionFilter === 'current') sessionId = progress.sessionId ?? sessions[0]?.id;
      else if (sessionFilter && sessionFilter !== 'all') sessionId = sessionFilter;
    }
    const payload = ids.length ? { ids } : sessionId ? { sessionId } : undefined;
    const r = await send('LEADS_EXPORT_CSV', payload);
    const blob = new Blob(['﻿' + r.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = r.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  detailLeadId: null,
  openDetail: (id) => set({ detailLeadId: id }),
  updateLead: async (id, patch) => {
    await send('LEAD_UPDATE', { id, patch });
    void get().refreshLeads();
  },
  isSidePanel: false,
  setSidePanel: (b) => set({ isSidePanel: b }),

  audits: [],
  refreshAudits: async () => set({ audits: (await send('AUDIT_LIST')).reports }),
  runAudit: async (leadId, force) => {
    // chrome.permissions.request() must run in a user-gesture context from a
    // UI surface; the SW cannot prompt. Do it here, then dispatch AUDIT_RUN.
    const lead = get().leads.find((l) => l.id === leadId);
    if (lead?.website) {
      try {
        const origin = new URL(lead.website).origin;
        const pattern = `${origin}/*`;
        const has = await chrome.permissions.contains({ origins: [pattern] });
        if (!has) {
          const granted = await chrome.permissions.request({ origins: [pattern] });
          if (!granted) {
            console.warn('audit: host permission denied for', pattern);
            return undefined;
          }
        }
      } catch (e) {
        console.warn('audit: permission preflight failed', e);
      }
    }
    const r = await send('AUDIT_RUN', { leadId, force });
    void get().refreshAudits();
    if (!r.ok) console.warn('audit failed', r.error);
    return r.report;
  },

  outreach: [],
  refreshOutreach: async () => set({ outreach: (await send('OUTREACH_LIST')).items }),
  draftOutreach: async (leadId, templateId) => {
    const r = await send('OUTREACH_DRAFT', { leadId, templateId });
    void get().refreshOutreach();
    return { ok: r.ok, error: r.error };
  },
  queueOutreach: async (id) => {
    await send('OUTREACH_QUEUE', { id });
    void get().refreshOutreach();
  },
  sendOutreachNow: async (id) => {
    const r = await send('OUTREACH_SEND_NOW', { id });
    void get().refreshOutreach();
    return r;
  },
  deleteOutreach: async (id) => {
    await send('OUTREACH_DELETE', { id });
    void get().refreshOutreach();
  },

  templates: [],
  refreshTemplates: async () => set({ templates: (await send('TEMPLATE_LIST')).templates }),

  settings: {
    scrapeMaxResults: 120,
    scrapeSpeed: 'medium',
    outreachDailyCap: 30,
    outreachPerDomainCap: 1,
    outreachJitterMinSeconds: 30,
    outreachJitterMaxSeconds: 120,
    senderName: '',
    senderEmail: '',
    senderAddress: '',
    defaultOptOutBaseUrl: 'mailto:unsubscribe@example.com?subject=unsubscribe',
    auditMaxLinks: 50,
    auditTimeoutMs: 60_000,
    geoStrictMode: true,
    acknowledgedLegal: false,
  },
  refreshSettings: async () => set({ settings: await send('SETTINGS_GET') }),
  saveSettings: async (patch) => {
    const r = await send('SETTINGS_SET', patch);
    set({ settings: r.settings });
  },

  gmail: { connected: false },
  refreshGmail: async () => set({ gmail: await send('GMAIL_STATUS') }),
  connectGmail: async () => {
    await send('GMAIL_CONNECT');
    void get().refreshGmail();
  },
  disconnectGmail: async () => {
    await send('GMAIL_DISCONNECT');
    void get().refreshGmail();
  },
}));

async function hydrateForTab(tab: Tab, get: () => State) {
  const s = get();
  if (tab === 'scrape') {
    void s.refreshProgress();
    void s.refreshSessions();
  }
  if (tab === 'leads') {
    void s.refreshSessions();
    void s.refreshLeads();
  }
  if (tab === 'audits') void s.refreshAudits();
  if (tab === 'outreach') {
    void s.refreshOutreach();
    void s.refreshTemplates();
  }
  if (tab === 'settings') {
    void s.refreshSettings();
    void s.refreshGmail();
    void s.refreshTemplates();
  }
}
