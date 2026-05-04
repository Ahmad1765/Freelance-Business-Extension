import Dexie, { Table } from 'dexie';
import type {
  Lead,
  AuditReport,
  OutreachItem,
  Template,
  Settings,
  ScrapeProgress,
  SearchSession,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

class LBE extends Dexie {
  leads!: Table<Lead, string>;
  audits!: Table<AuditReport, string>;
  outreach!: Table<OutreachItem, string>;
  templates!: Table<Template, string>;
  optouts!: Table<{ email: string; addedAt: number }, string>;
  sessions!: Table<SearchSession, string>;

  constructor() {
    super('local-biz-engine');
    this.version(1).stores({
      leads: 'id, websiteStatus, scrapedAt, name',
      audits: 'id, leadId, ranAt',
      outreach: 'id, leadId, status, scheduledAt',
      templates: 'id, name, updatedAt',
      optouts: 'email, addedAt',
    });
    this.version(2).stores({
      leads: 'id, websiteStatus, scrapedAt, name, searchSessionId',
      sessions: 'id, startedAt',
    });
    this.version(3)
      .stores({
        leads: 'id, websiteStatus, scrapedAt, name, searchSessionId, status',
      })
      .upgrade(async (tx) => {
        await tx
          .table('leads')
          .toCollection()
          .modify((l: Lead) => {
            if (!l.status) l.status = 'new';
          });
      });
  }
}

const db = new LBE();

export const leadStore = {
  async upsertMany(ls: Lead[]) {
    if (!ls.length) return;
    await db.leads.bulkPut(ls);
  },
  async list(filter?: { websiteStatus?: Lead['websiteStatus']; q?: string; sessionId?: string; status?: Lead['status'] }) {
    const coll = db.leads.orderBy('scrapedAt').reverse();
    let arr = await coll.toArray();
    if (filter?.sessionId) arr = arr.filter((l) => l.searchSessionId === filter.sessionId);
    if (filter?.websiteStatus) arr = arr.filter((l) => l.websiteStatus === filter.websiteStatus);
    if (filter?.status) arr = arr.filter((l) => (l.status ?? 'new') === filter.status);
    if (filter?.q) {
      const q = filter.q.toLowerCase();
      arr = arr.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          (l.address ?? '').toLowerCase().includes(q) ||
          (l.category ?? '').toLowerCase().includes(q)
      );
    }
    return arr;
  },
  async get(id: string) {
    return db.leads.get(id);
  },
  async update(id: string, patch: Partial<Lead>) {
    await db.leads.update(id, patch);
  },
  async deleteMany(ids: string[]) {
    await db.leads.bulkDelete(ids);
    return ids.length;
  },
  async clear() {
    const n = await db.leads.count();
    await db.leads.clear();
    return n;
  },
  async count() {
    return db.leads.count();
  },
  async countForSession(sessionId: string) {
    return db.leads.where('searchSessionId').equals(sessionId).count();
  },
};

export const sessionStore = {
  async create(s: SearchSession) {
    await db.sessions.put(s);
  },
  async update(id: string, patch: Partial<SearchSession>) {
    await db.sessions.update(id, patch);
  },
  async list(): Promise<SearchSession[]> {
    return db.sessions.orderBy('startedAt').reverse().toArray();
  },
  async get(id: string) {
    return db.sessions.get(id);
  },
};

export const auditStore = {
  async insert(report: AuditReport) {
    await db.audits.put(report);
  },
  async list(leadId?: string) {
    const all = await db.audits.orderBy('ranAt').reverse().toArray();
    return leadId ? all.filter((r) => r.leadId === leadId) : all;
  },
  async latestForLead(leadId: string) {
    const all = await db.audits.where('leadId').equals(leadId).toArray();
    return all.sort((a, b) => b.ranAt - a.ranAt)[0];
  },
  async delete(id: string) {
    await db.audits.delete(id);
  },
};

export const outreachStore = {
  async insert(item: OutreachItem) {
    await db.outreach.put(item);
  },
  async update(id: string, patch: Partial<OutreachItem>) {
    await db.outreach.update(id, patch);
  },
  async get(id: string) {
    return db.outreach.get(id);
  },
  async list(filter?: { status?: OutreachItem['status'] }) {
    const all = await db.outreach.orderBy('scheduledAt').toArray();
    return filter?.status ? all.filter((i) => i.status === filter.status) : all;
  },
  async delete(id: string) {
    await db.outreach.delete(id);
  },
  async countSentOn(yyyymmdd: string) {
    const all = await db.outreach.where('status').equals('sent').toArray();
    return all.filter((i) => toDay(i.sentAt) === yyyymmdd).length;
  },
  async sentToDomainToday(domain: string) {
    const today = toDay(Date.now());
    const all = await db.outreach.where('status').equals('sent').toArray();
    return all.some((i) => toDay(i.sentAt) === today && toDomain(i.to) === domain);
  },
};

export const templateStore = {
  async list() {
    return db.templates.orderBy('updatedAt').reverse().toArray();
  },
  async upsert(tpl: Template) {
    await db.templates.put({ ...tpl, updatedAt: Date.now() });
  },
  async delete(id: string) {
    await db.templates.delete(id);
  },
};

export const optoutStore = {
  async add(email: string) {
    const e = email.trim().toLowerCase();
    if (!e) return;
    await db.optouts.put({ email: e, addedAt: Date.now() });
  },
  async has(email: string) {
    return !!(await db.optouts.get(email.trim().toLowerCase()));
  },
  async list() {
    return (await db.optouts.toArray()).map((r) => r.email);
  },
  async remove(email: string) {
    await db.optouts.delete(email.trim().toLowerCase());
  },
};

const SETTINGS_KEY = 'settings';
export const settingsStore = {
  async get(): Promise<Settings> {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...((r[SETTINGS_KEY] as Partial<Settings>) ?? {}) };
  },
  async set(patch: Partial<Settings>): Promise<Settings> {
    const cur = await this.get();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  },
};

const PROGRESS_KEY = 'scrape_progress';
export const progressStore = {
  async get(): Promise<ScrapeProgress> {
    const r = await chrome.storage.local.get(PROGRESS_KEY);
    return ((r[PROGRESS_KEY] as ScrapeProgress) ?? { active: false, found: 0, target: 0 });
  },
  async set(p: Partial<ScrapeProgress>) {
    const cur = await this.get();
    const next = { ...cur, ...p, lastUpdate: Date.now() };
    await chrome.storage.local.set({ [PROGRESS_KEY]: next });
    return next;
  },
};

function toDay(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toISOString().slice(0, 10);
}
function toDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}
