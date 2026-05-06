import type {
  Lead,
  AuditReport,
  OutreachItem,
  ScrapeProgress,
  Settings,
  Template,
  SearchSession,
} from './types';

export type Msg =
  | { kind: 'PING' }
  | { kind: 'SCRAPE_START'; payload: { maxResults: number; speed: Settings['scrapeSpeed'] } }
  | { kind: 'SCRAPE_STOP' }
  | { kind: 'SCRAPE_BATCH'; payload: { leads: Lead[]; done: boolean; error?: string; query?: string } }
  | { kind: 'SCRAPE_PROGRESS_GET' }
  | { kind: 'SESSIONS_LIST' }
  | { kind: 'LEADS_LIST'; payload?: { websiteStatus?: Lead['websiteStatus']; q?: string; sessionId?: string; status?: Lead['status'] } }
  | { kind: 'LEAD_GET'; payload: { id: string } }
  | { kind: 'LEAD_UPDATE'; payload: { id: string; patch: Partial<Lead> } }
  | { kind: 'LEADS_DELETE'; payload: { ids: string[] } }
  | { kind: 'LEADS_CLEAR_ALL' }
  | { kind: 'LEADS_EXPORT_CSV'; payload?: { ids?: string[]; sessionId?: string } }
  | { kind: 'AUDIT_RUN'; payload: { leadId: string; force?: boolean } }
  | { kind: 'AUDIT_LIST'; payload?: { leadId?: string } }
  | { kind: 'AUDIT_DELETE'; payload: { id: string } }
  | { kind: 'AI_TEST'; payload: { provider: string; apiKey: string } }
  | { kind: 'OUTREACH_DRAFT'; payload: { leadId: string; templateId: string } }
  | { kind: 'OUTREACH_QUEUE'; payload: { id: string } }
  | { kind: 'OUTREACH_SEND_NOW'; payload: { id: string } }
  | { kind: 'OUTREACH_LIST'; payload?: { status?: OutreachItem['status'] } }
  | { kind: 'OUTREACH_DELETE'; payload: { id: string } }
  | { kind: 'GMAIL_CONNECT' }
  | { kind: 'GMAIL_DISCONNECT' }
  | { kind: 'GMAIL_STATUS' }
  | { kind: 'TEMPLATE_LIST' }
  | { kind: 'TEMPLATE_UPSERT'; payload: Template }
  | { kind: 'TEMPLATE_DELETE'; payload: { id: string } }
  | { kind: 'SETTINGS_GET' }
  | { kind: 'SETTINGS_SET'; payload: Partial<Settings> }
  | { kind: 'OPTOUT_ADD'; payload: { email: string } }
  | { kind: 'OPTOUT_LIST' }
  | { kind: 'OPTOUT_REMOVE'; payload: { email: string } };

export interface MsgResponses {
  PING: { ok: true; ts: number };
  SCRAPE_START: { ok: boolean; error?: string };
  SCRAPE_STOP: { ok: boolean };
  SCRAPE_BATCH: { ok: boolean };
  SCRAPE_PROGRESS_GET: ScrapeProgress;
  SESSIONS_LIST: { sessions: SearchSession[] };
  LEADS_LIST: { leads: Lead[] };
  LEAD_GET: { lead: Lead | null };
  LEAD_UPDATE: { ok: boolean; lead?: Lead };
  LEADS_DELETE: { ok: boolean; deleted: number };
  LEADS_CLEAR_ALL: { ok: boolean; cleared: number };
  LEADS_EXPORT_CSV: { ok: boolean; csv: string; filename: string };
  AUDIT_RUN: { ok: boolean; report?: AuditReport; error?: string };
  AUDIT_LIST: { reports: AuditReport[] };
  AUDIT_DELETE: { ok: boolean };
  AI_TEST: { ok: boolean; model?: string; error?: string };
  OUTREACH_DRAFT: { ok: boolean; item?: OutreachItem; error?: string };
  OUTREACH_QUEUE: { ok: boolean; error?: string };
  OUTREACH_SEND_NOW: { ok: boolean; error?: string };
  OUTREACH_LIST: { items: OutreachItem[] };
  OUTREACH_DELETE: { ok: boolean };
  GMAIL_CONNECT: { ok: boolean; email?: string; error?: string };
  GMAIL_DISCONNECT: { ok: boolean };
  GMAIL_STATUS: { connected: boolean; email?: string };
  TEMPLATE_LIST: { templates: Template[] };
  TEMPLATE_UPSERT: { ok: boolean };
  TEMPLATE_DELETE: { ok: boolean };
  SETTINGS_GET: Settings;
  SETTINGS_SET: { ok: boolean; settings: Settings };
  OPTOUT_ADD: { ok: boolean };
  OPTOUT_LIST: { emails: string[] };
  OPTOUT_REMOVE: { ok: boolean };
}

export type MsgKind = Msg['kind'];
export type MsgFor<K extends MsgKind> = Extract<Msg, { kind: K }>;
export type RespFor<K extends MsgKind> = K extends keyof MsgResponses ? MsgResponses[K] : never;
type PayloadFor<K extends MsgKind> =
  MsgFor<K> extends { payload?: infer P } ? P | undefined : undefined;

export async function send<K extends MsgKind>(
  kind: K,
  payload?: PayloadFor<K>
): Promise<RespFor<K>> {
  const msg = (payload === undefined ? { kind } : { kind, payload }) as Msg;
  return chrome.runtime.sendMessage(msg);
}
