import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import { send } from '../../shared/messages';
import { LEAD_STATUS_LABELS, LEAD_STATUS_ORDER } from '../../shared/types';
import type { AuditReport, Lead, LeadStatus, OutreachItem, Template } from '../../shared/types';

interface Props {
  leadId: string;
  onClose: () => void;
  variant: 'modal' | 'pane';
}

export function LeadDetail({ leadId, onClose, variant }: Props) {
  const updateLead = useApp((s) => s.updateLead);
  const runAudit = useApp((s) => s.runAudit);
  const draftOutreach = useApp((s) => s.draftOutreach);
  const refreshOutreach = useApp((s) => s.refreshOutreach);

  const [lead, setLead] = useState<Lead | null>(null);
  const [audits, setAudits] = useState<AuditReport[]>([]);
  const [outreach, setOutreach] = useState<OutreachItem[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [notes, setNotes] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftTemplate, setDraftTemplate] = useState<string>('');

  const refreshAll = async () => {
    const [{ lead: ld }, { reports }, { items }, { templates: tpls }] = await Promise.all([
      send('LEAD_GET', { id: leadId }),
      send('AUDIT_LIST', { leadId }),
      send('OUTREACH_LIST'),
      send('TEMPLATE_LIST'),
    ]);
    setLead(ld);
    setAudits(reports);
    setOutreach(items.filter((i) => i.leadId === leadId));
    setTemplates(tpls);
    setNotes(ld?.notes ?? '');
    if (!draftTemplate && tpls.length) setDraftTemplate(tpls[0].id);
  };

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  const tags = useMemo(() => lead?.tags ?? [], [lead]);

  if (!lead) {
    return (
      <Wrapper variant={variant} onClose={onClose}>
        <div className="p-6 text-xs text-muted">Loading…</div>
      </Wrapper>
    );
  }

  const status = (lead.status ?? 'new') as LeadStatus;

  const setStatus = async (s: LeadStatus) => {
    await updateLead(lead.id, { status: s });
    void refreshAll();
  };

  const saveNotes = async () => {
    if (notes === (lead.notes ?? '')) return;
    await updateLead(lead.id, { notes });
    void refreshAll();
  };

  const addTag = async () => {
    const t = tagInput.trim();
    if (!t) return;
    const next = Array.from(new Set([...(lead.tags ?? []), t]));
    await updateLead(lead.id, { tags: next });
    setTagInput('');
    void refreshAll();
  };

  const removeTag = async (t: string) => {
    const next = (lead.tags ?? []).filter((x) => x !== t);
    await updateLead(lead.id, { tags: next });
    void refreshAll();
  };

  const onAudit = async () => {
    setBusy('audit');
    setError(null);
    const report = await runAudit(lead.id, true);
    if (!report?.ok) setError(report?.error ?? 'audit failed');
    setBusy(null);
    void refreshAll();
  };

  const onDraft = async () => {
    if (!draftTemplate) {
      setError('pick a template');
      return;
    }
    setBusy('draft');
    setError(null);
    const r = await draftOutreach(lead.id, draftTemplate);
    if (!r.ok) setError(r.error ?? 'draft failed');
    void refreshOutreach();
    void refreshAll();
    setBusy(null);
  };

  const copy = (s: string) => navigator.clipboard.writeText(s).catch(() => {});

  return (
    <Wrapper variant={variant} onClose={onClose}>
      <div className="flex items-start gap-2 p-3 border-b border-line">
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold truncate">{lead.name}</div>
          <div className="text-xs text-muted truncate">
            {lead.category ?? '—'}
            {lead.rating != null && (
              <>
                {' · '}⭐ {lead.rating} ({lead.reviewCount ?? 0})
              </>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-muted hover:text-text text-lg leading-none px-2"
          title="Close"
        >
          ×
        </button>
      </div>

      <div className="p-3 space-y-3">
        <Section title="Pipeline">
          <div className="grid grid-cols-4 gap-1">
            {LEAD_STATUS_ORDER.map((s) => (
              <button
                key={s}
                onClick={() => void setStatus(s)}
                className={`text-[10px] uppercase tracking-wider rounded px-1.5 py-1 border ${
                  status === s
                    ? `bg-${statusColor(s)}/30 border-${statusColor(s)}/60 text-${statusColor(s)}`
                    : 'border-line text-muted hover:text-text'
                }`}
                style={
                  status === s
                    ? {
                        background: `${statusHex(s)}33`,
                        borderColor: statusHex(s),
                        color: statusHex(s),
                      }
                    : undefined
                }
              >
                {LEAD_STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Contact">
          <Row label="Address" value={lead.address || '—'} onCopy={lead.address ? () => copy(lead.address) : undefined} />
          <Row label="Phone" value={lead.phone ?? '—'} onCopy={lead.phone ? () => copy(lead.phone!) : undefined} />
          <Row
            label="Website"
            value={lead.website ?? '—'}
            link={lead.website ?? undefined}
            onCopy={lead.website ? () => copy(lead.website!) : undefined}
          />
          <Row label="Maps" value="open" link={lead.placeUrl} />
        </Section>

        <Section title="Tags">
          <div className="flex flex-wrap gap-1 mb-2">
            {tags.map((t) => (
              <span key={t} className="text-[11px] bg-panel2 border border-line rounded px-1.5 py-0.5 flex items-center gap-1">
                {t}
                <button onClick={() => void removeTag(t)} className="text-bad hover:text-bad text-[10px]">
                  ×
                </button>
              </span>
            ))}
            {tags.length === 0 && <span className="text-xs text-muted">no tags</span>}
          </div>
          <div className="flex gap-2">
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addTag();
              }}
              placeholder="add tag…"
              className="flex-1 bg-panel2 border border-line rounded px-2 py-1 text-xs"
            />
            <button
              onClick={() => void addTag()}
              className="text-xs px-2 py-1 border border-line rounded hover:border-accent hover:text-accent"
            >
              Add
            </button>
          </div>
        </Section>

        <Section title="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => void saveNotes()}
            rows={4}
            placeholder="private notes — saved on blur"
            className="w-full bg-panel2 border border-line rounded px-2 py-1 text-xs"
          />
        </Section>

        <Section title="Audits">
          <div className="flex gap-2 mb-2">
            <button
              disabled={!lead.website || busy === 'audit'}
              onClick={() => void onAudit()}
              className="flex-1 text-xs px-2 py-1.5 bg-accent/20 border border-accent/60 text-accent rounded hover:bg-accent/30 disabled:opacity-30"
            >
              {busy === 'audit' ? 'Running…' : 'Run audit'}
            </button>
          </div>
          {audits.length === 0 && (
            <div className="text-xs text-muted">No audits yet.</div>
          )}
          {audits.slice(0, 5).map((a) => (
            <AuditMini key={a.id} audit={a} />
          ))}
        </Section>

        <Section title="Outreach">
          <div className="flex gap-2 mb-2">
            <select
              value={draftTemplate}
              onChange={(e) => setDraftTemplate(e.target.value)}
              className="flex-1 bg-panel2 border border-line rounded px-2 py-1 text-xs"
            >
              {templates.length === 0 && <option value="">no templates</option>}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              disabled={busy === 'draft' || !draftTemplate}
              onClick={() => void onDraft()}
              className="text-xs px-2 py-1.5 bg-accent/20 border border-accent/60 text-accent rounded hover:bg-accent/30 disabled:opacity-30"
            >
              {busy === 'draft' ? 'Drafting…' : 'Draft'}
            </button>
          </div>
          {outreach.length === 0 && (
            <div className="text-xs text-muted">No outreach yet.</div>
          )}
          {outreach.slice(0, 5).map((o) => (
            <OutreachMini key={o.id} item={o} />
          ))}
        </Section>

        {error && (
          <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded p-2">{error}</div>
        )}
      </div>
    </Wrapper>
  );
}

function Wrapper({
  children,
  variant,
  onClose,
}: {
  children: React.ReactNode;
  variant: 'modal' | 'pane';
  onClose: () => void;
}) {
  if (variant === 'pane') {
    return <div className="flex flex-col h-full bg-bg overflow-auto">{children}</div>;
  }
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg overflow-auto" onClick={(e) => e.stopPropagation()}>
      <button onClick={onClose} className="sr-only">Close</button>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-panel border border-line rounded p-2 space-y-2">
      <h4 className="text-[10px] uppercase tracking-wider text-muted">{title}</h4>
      <div>{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  link,
  onCopy,
}: {
  label: string;
  value: string;
  link?: string;
  onCopy?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 text-xs py-0.5">
      <span className="w-16 shrink-0 text-muted">{label}</span>
      <span className="flex-1 break-words">
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </span>
      {onCopy && (
        <button onClick={onCopy} className="text-[10px] text-muted hover:text-text">
          copy
        </button>
      )}
    </div>
  );
}

function AuditMini({ audit }: { audit: AuditReport }) {
  const counts = audit.findings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    },
    { critical: 0, warning: 0, suggestion: 0 } as Record<string, number>
  );
  return (
    <div className="text-xs border border-line rounded p-2 space-y-1 mb-1">
      <div className="flex items-center justify-between">
        <span className="text-muted">{new Date(audit.ranAt).toLocaleString()}</span>
        <span className="flex gap-1">
          {counts.critical > 0 && (
            <span className="px-1 rounded bg-bad/20 text-bad border border-bad/40">
              {counts.critical}
            </span>
          )}
          {counts.warning > 0 && (
            <span className="px-1 rounded bg-warn/20 text-warn border border-warn/40">
              {counts.warning}
            </span>
          )}
          {counts.suggestion > 0 && (
            <span className="px-1 rounded bg-accent/20 text-accent border border-accent/40">
              {counts.suggestion}
            </span>
          )}
        </span>
      </div>
      {!audit.ok && audit.error && <div className="text-bad text-[11px]">{audit.error}</div>}
    </div>
  );
}

function OutreachMini({ item }: { item: OutreachItem }) {
  const colorMap: Record<string, string> = {
    sent: 'ok',
    queued: 'accent',
    failed: 'bad',
    'opted-out': 'warn',
    draft: 'muted',
  };
  const c = colorMap[item.status] ?? 'muted';
  return (
    <div className="text-xs border border-line rounded p-2 mb-1">
      <div className="flex items-center gap-2">
        <span
          className="px-1 rounded text-[10px] uppercase tracking-wider border"
          style={{ borderColor: hexFor(c), color: hexFor(c), background: `${hexFor(c)}20` }}
        >
          {item.status}
        </span>
        <span className="truncate flex-1">{item.subject}</span>
      </div>
      <div className="text-[11px] text-muted truncate">→ {item.to}</div>
    </div>
  );
}

function statusColor(s: LeadStatus): string {
  const m: Record<LeadStatus, string> = {
    new: 'muted',
    contacted: 'accent',
    replied: 'ok',
    qualified: 'ok',
    won: 'warn',
    lost: 'bad',
    archived: 'muted',
  };
  return m[s];
}

export function statusHex(s: LeadStatus): string {
  const m: Record<LeadStatus, string> = {
    new: '#8b94a3',
    contacted: '#5b9bff',
    replied: '#4ade80',
    qualified: '#34d399',
    won: '#fbbf24',
    lost: '#f87171',
    archived: '#4b5563',
  };
  return m[s];
}

function hexFor(name: string): string {
  const m: Record<string, string> = {
    ok: '#4ade80',
    accent: '#5b9bff',
    bad: '#f87171',
    warn: '#fbbf24',
    muted: '#8b94a3',
  };
  return m[name] ?? '#8b94a3';
}
