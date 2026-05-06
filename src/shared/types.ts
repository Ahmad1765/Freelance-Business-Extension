export type WebsiteStatus = 'present' | 'missing' | 'dead' | 'unknown';

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'replied'
  | 'qualified'
  | 'won'
  | 'lost'
  | 'archived';

export const LEAD_STATUS_ORDER: LeadStatus[] = [
  'new',
  'contacted',
  'replied',
  'qualified',
  'won',
  'lost',
  'archived',
];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  replied: 'Replied',
  qualified: 'Qualified',
  won: 'Won',
  lost: 'Lost',
  archived: 'Archived',
};

export interface Lead {
  id: string;
  name: string;
  category: string | null;
  address: string;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  coords: { lat: number; lng: number } | null;
  placeUrl: string;
  scrapedAt: number;
  websiteStatus: WebsiteStatus;
  websiteHttpStatus?: number;
  source: 'maps-scrape' | 'places-api' | 'manual';
  searchQuery?: string;
  searchSessionId?: string;
  status?: LeadStatus;
  statusUpdatedAt?: number;
  notes?: string;
  tags?: string[];
}

export interface SearchSession {
  id: string;
  query: string;
  startedAt: number;
  endedAt?: number;
  leadCount: number;
}

export type FindingSeverity = 'critical' | 'warning' | 'suggestion';
export type FindingCategory =
  | 'links'
  | 'meta'
  | 'security'
  | 'mobile'
  | 'speed'
  | 'seo'
  | 'contact'
  | 'a11y'
  | 'http'
  | 'trust'
  | 'freshness'
  | 'marketing'
  | 'social-meta'
  | 'robots';

// Business buckets surfaced in the UI; technical category stays for internal
// grouping. Optional on AuditFinding so legacy reports without it still render.
export type BusinessImpact =
  | 'reach'        // customers can't get in touch / use the site
  | 'visibility'   // search & social discovery
  | 'trust'        // security, "Not Secure", outdated software
  | 'speed'        // load time, weight
  | 'polish';      // minor cosmetic / nice-to-have

export interface AuditFinding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  detail: string;
  evidence?: string;
  impact?: BusinessImpact;
  recommendation?: string;
}

export interface SecurityHeaders {
  csp:               boolean;
  xFrameOptions:     boolean;
  xContentTypeOpts:  boolean;
  hsts:              boolean;
  referrerPolicy:    boolean;
  permissionsPolicy: boolean;
  serverLeaks:       string | null;
}

export interface AiRecommendation {
  priority: 1 | 2 | 3;
  title:    string;
  action:   string;
  impact:   BusinessImpact;
}

export interface AuditReport {
  id: string;
  leadId: string;
  url: string;
  ranAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  findings: AuditFinding[];
  stats: {
    linksChecked: number;
    linksBroken: number;
    pageBytes: number;
    requests: number;
    loadMs: number;
  };
  // 0-100, higher is healthier. Optional so legacy reports still type-check.
  score?: number;
  // 1-3 plain-English headlines used in the audits tab and outreach templates.
  summary?: string[];
  securityHeaders?:   SecurityHeaders;
  aiEnhanced?:        boolean;
  aiSummary?:         string;
  aiRecommendations?: AiRecommendation[];
}

export type OutreachStatus =
  | 'draft'
  | 'queued'
  | 'sent'
  | 'bounced'
  | 'replied'
  | 'opted-out'
  | 'failed';

export interface OutreachItem {
  id: string;
  leadId: string;
  channel: 'email' | 'contact-form';
  templateId: string;
  to: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  status: OutreachStatus;
  scheduledAt?: number;
  sentAt?: number;
  threadId?: string;
  messageId?: string;
  error?: string;
  attempts: number;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  geoAllowList?: string[];
  geoDenyList?: string[];
  createdAt: number;
  updatedAt: number;
  forCohort: 'no-website' | 'has-website' | 'any';
}

export interface Settings {
  scrapeMaxResults: number;
  scrapeSpeed: 'slow' | 'medium' | 'fast';
  outreachDailyCap: number;
  outreachPerDomainCap: number;
  outreachJitterMinSeconds: number;
  outreachJitterMaxSeconds: number;
  senderName: string;
  senderEmail: string;
  senderAddress: string;
  defaultOptOutBaseUrl: string;
  hunterApiKey?: string;
  auditMaxLinks: number;
  auditTimeoutMs: number;
  geoStrictMode: boolean;
  acknowledgedLegal: boolean;
  aiEnabled:    boolean;
  aiProvider:   'openrouter' | 'nvidia';
  aiModel:      string;
  aiApiKey?:    string;
}

export const DEFAULT_SETTINGS: Settings = {
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
  aiEnabled:  false,
  aiProvider: 'openrouter',
  aiModel:    'meta-llama/llama-3.1-8b-instruct:free',
};

export interface ScrapeProgress {
  active: boolean;
  found: number;
  target: number;
  startedAt?: number;
  lastUpdate?: number;
  lastError?: string;
  query?: string;
  sessionId?: string;
}
