import type { AuditReport, Lead, Settings, Template } from './types';

const TOKEN = /\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g;

export interface RenderVars extends Record<string, string> {
  BUSINESS_NAME: string;
  BUSINESS_ADDRESS: string;
  BUSINESS_PHONE: string;
  BUSINESS_CATEGORY: string;
  SENDER_NAME: string;
  SENDER_EMAIL: string;
  SENDER_ADDRESS: string;
  OPTOUT_LINK: string;
  AUDIT_SCORE: string;
  AUDIT_TOP_ISSUE: string;
  AUDIT_TOP_3: string;
  AUDIT_TOP_3_HTML: string;
  AUDIT_URL: string;
}

export function buildVars(
  lead: Lead,
  settings: Settings,
  optOutLink?: string,
  audit?: AuditReport | null
): RenderVars {
  const top = audit?.summary && audit.summary.length ? audit.summary : [];
  return {
    BUSINESS_NAME: lead.name || 'there',
    BUSINESS_ADDRESS: lead.address || '',
    BUSINESS_PHONE: lead.phone || '',
    BUSINESS_CATEGORY: lead.category || '',
    SENDER_NAME: settings.senderName,
    SENDER_EMAIL: settings.senderEmail,
    SENDER_ADDRESS: settings.senderAddress,
    OPTOUT_LINK: optOutLink || settings.defaultOptOutBaseUrl,
    AUDIT_SCORE: typeof audit?.score === 'number' ? `${audit.score}/100` : '',
    AUDIT_TOP_ISSUE: top[0] ?? '',
    AUDIT_TOP_3: top.length ? top.map((t) => `- ${t}`).join('\n') : '',
    AUDIT_TOP_3_HTML: top.length
      ? `<ul>${top.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : '',
    AUDIT_URL: audit?.url || lead.website || '',
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class TemplateValidationError extends Error {}

export function render(
  tpl: Template,
  vars: RenderVars
): { subject: string; bodyText: string; bodyHtml: string } {
  const fill = (s: string) => s.replace(TOKEN, (_, k) => vars[k] ?? '');
  const subject = fill(tpl.subject);
  const bodyText = fill(tpl.bodyText);
  const bodyHtml = fill(tpl.bodyHtml);

  const required: (keyof RenderVars)[] = ['SENDER_NAME', 'SENDER_ADDRESS', 'OPTOUT_LINK'];
  for (const k of required) {
    if (!vars[k]) throw new TemplateValidationError(`missing required variable: ${k}`);
  }
  if (!bodyText.includes(vars.OPTOUT_LINK) && !bodyHtml.includes(vars.OPTOUT_LINK)) {
    throw new TemplateValidationError('opt-out link must appear in email body (CAN-SPAM)');
  }
  if (!bodyText.includes(vars.SENDER_ADDRESS) && !bodyHtml.includes(vars.SENDER_ADDRESS)) {
    throw new TemplateValidationError('sender postal address must appear in body (CAN-SPAM)');
  }
  return { subject, bodyText, bodyHtml };
}

const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES',
  'SE', 'GB', 'CH', 'NO', 'IS',
]);
const STRICT_OPT_IN_ONLY = new Set(['CA', 'AU']);

export function geoGate(addressGuess: string, tpl: Template, strict: boolean): { allow: boolean; reason?: string } {
  const cc = guessCountryCode(addressGuess);
  if (tpl.geoDenyList?.includes(cc)) return { allow: false, reason: `template denies ${cc}` };
  if (tpl.geoAllowList?.length && !tpl.geoAllowList.includes(cc)) {
    return { allow: false, reason: `${cc} not in template allow-list` };
  }
  if (strict && STRICT_OPT_IN_ONLY.has(cc)) {
    return { allow: false, reason: `${cc} requires opt-in (CASL/SPAM Act); strict mode on` };
  }
  if (strict && EU_COUNTRY_CODES.has(cc) && tpl.forCohort !== 'has-website') {
    return { allow: false, reason: `EU prospect; strict mode requires legitimate-interest copy` };
  }
  return { allow: true };
}

function guessCountryCode(s: string): string {
  if (!s) return 'XX';
  const upper = s.toUpperCase();
  const tail = upper.split(',').slice(-1)[0]?.trim() ?? '';
  if (/^USA?$|UNITED STATES/.test(tail)) return 'US';
  if (/CANADA/.test(tail)) return 'CA';
  if (/UNITED KINGDOM|^UK$|ENGLAND|SCOTLAND|WALES|NORTHERN IRELAND/.test(tail)) return 'GB';
  if (/AUSTRALIA/.test(tail)) return 'AU';
  if (/GERMANY|DEUTSCHLAND/.test(tail)) return 'DE';
  if (/FRANCE/.test(tail)) return 'FR';
  if (/SPAIN/.test(tail)) return 'ES';
  if (/ITALY/.test(tail)) return 'IT';
  if (/INDIA/.test(tail)) return 'IN';
  if (/MEXICO/.test(tail)) return 'MX';
  if (/BRAZIL/.test(tail)) return 'BR';
  if (/JAPAN/.test(tail)) return 'JP';
  if (/[A-Z]{2}\s*\d{5}/.test(s)) return 'US';
  return 'XX';
}

export function newTemplate(partial: Partial<Template> = {}): Template {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: 'Untitled',
    subject: 'Quick note about {{BUSINESS_NAME}}',
    bodyText: defaultBodyText,
    bodyHtml: defaultBodyHtml,
    forCohort: 'any',
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

const defaultBodyText = `Hi {{BUSINESS_NAME}},

I came across your listing for {{BUSINESS_CATEGORY}} at {{BUSINESS_ADDRESS}} and noticed you don't have a website set up. I help small local businesses get a clean one-page site live in a week.

If that's something you'd like a free mockup for, just reply to this email.

Thanks,
{{SENDER_NAME}}
{{SENDER_EMAIL}}

---
{{SENDER_ADDRESS}}
Don't want to hear from me? Unsubscribe: {{OPTOUT_LINK}}
`;

const defaultBodyHtml = `<p>Hi {{BUSINESS_NAME}},</p>
<p>I came across your listing for {{BUSINESS_CATEGORY}} at {{BUSINESS_ADDRESS}} and noticed you don't have a website set up. I help small local businesses get a clean one-page site live in a week.</p>
<p>If that's something you'd like a free mockup for, just reply to this email.</p>
<p>Thanks,<br/>{{SENDER_NAME}}<br/>{{SENDER_EMAIL}}</p>
<hr/>
<p style="color:#888;font-size:12px">{{SENDER_ADDRESS}}<br/>Don't want to hear from me? <a href="{{OPTOUT_LINK}}">Unsubscribe</a>.</p>
`;
