import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import type { OutreachItem } from '../../shared/types';

export function OutreachTab() {
  const outreach = useApp((s) => s.outreach);
  const templates = useApp((s) => s.templates);
  const leads = useApp((s) => s.leads);
  const refresh = useApp((s) => s.refreshOutreach);
  const refreshTemplates = useApp((s) => s.refreshTemplates);
  const refreshLeads = useApp((s) => s.refreshLeads);
  const draft = useApp((s) => s.draftOutreach);
  const queue = useApp((s) => s.queueOutreach);
  const sendNow = useApp((s) => s.sendOutreachNow);
  const del = useApp((s) => s.deleteOutreach);

  useEffect(() => {
    void refresh();
    void refreshTemplates();
    void refreshLeads();
  }, [refresh, refreshTemplates, refreshLeads]);

  const [selectedLead, setSelectedLead] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTemplate && templates.length) setSelectedTemplate(templates[0].id);
  }, [templates, selectedTemplate]);

  const grouped = useMemo(() => {
    return [...outreach].sort((a, b) => (b.scheduledAt ?? 0) - (a.scheduledAt ?? 0));
  }, [outreach]);

  const onDraft = async () => {
    setError(null);
    if (!selectedLead || !selectedTemplate) {
      setError('Pick a lead and a template');
      return;
    }
    const r = await draft(selectedLead, selectedTemplate);
    if (!r.ok) setError(r.error ?? 'failed to draft');
  };

  return (
    <div className="p-3 space-y-3">
      <section className="bg-panel border border-line rounded-lg p-3 space-y-2">
        <h3 className="text-xs uppercase tracking-wider text-muted">New draft</h3>
        <select
          value={selectedLead}
          onChange={(e) => setSelectedLead(e.target.value)}
          className="w-full bg-panel2 border border-line rounded px-2 py-1 text-sm"
        >
          <option value="">— select lead —</option>
          {leads.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} · {l.websiteStatus}
            </option>
          ))}
        </select>
        <select
          value={selectedTemplate}
          onChange={(e) => setSelectedTemplate(e.target.value)}
          className="w-full bg-panel2 border border-line rounded px-2 py-1 text-sm"
        >
          <option value="">— select template —</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.forCohort})
            </option>
          ))}
        </select>
        <button
          onClick={() => void onDraft()}
          className="w-full bg-accent hover:brightness-110 text-white rounded py-2 text-sm font-medium"
        >
          Draft
        </button>
        {error && (
          <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded p-2">{error}</div>
        )}
      </section>

      <section className="bg-panel border border-line rounded-lg overflow-hidden">
        <h3 className="text-xs uppercase tracking-wider text-muted px-3 pt-3">Queue</h3>
        {grouped.length === 0 && (
          <div className="p-4 text-center text-muted text-xs">No drafts yet.</div>
        )}
        <div className="divide-y divide-line">
          {grouped.map((o) => (
            <Row
              key={o.id}
              item={o}
              onQueue={() => void queue(o.id)}
              onSend={async () => {
                const r = await sendNow(o.id);
                if (!r.ok) setError(r.error ?? 'send failed');
              }}
              onDelete={() => void del(o.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function Row({
  item,
  onQueue,
  onSend,
  onDelete,
}: {
  item: OutreachItem;
  onQueue: () => void;
  onSend: () => void;
  onDelete: () => void;
}) {
  const badge = badgeFor(item.status);
  return (
    <div className="p-3 space-y-1">
      <div className="flex items-center gap-2">
        <span className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded ${badge}`}>
          {item.status}
        </span>
        <div className="text-sm truncate flex-1">{item.subject}</div>
      </div>
      <div className="text-xs text-muted truncate">→ {item.to}</div>
      {item.error && (
        <div className="text-[11px] text-bad bg-bad/10 border border-bad/30 rounded px-2 py-1">
          {item.error}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        {item.status === 'draft' && (
          <button
            onClick={onQueue}
            className="text-xs px-2 py-1 border border-line rounded hover:border-accent hover:text-accent"
          >
            Queue
          </button>
        )}
        {(item.status === 'draft' || item.status === 'queued' || item.status === 'failed') && (
          <button
            onClick={onSend}
            className="text-xs px-2 py-1 border border-line rounded hover:border-accent hover:text-accent"
          >
            Send now
          </button>
        )}
        <button
          onClick={onDelete}
          className="text-xs px-2 py-1 border border-line rounded text-bad hover:text-bad ml-auto"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function badgeFor(s: OutreachItem['status']): string {
  switch (s) {
    case 'sent':
      return 'bg-ok/20 text-ok border border-ok/40';
    case 'queued':
      return 'bg-accent/20 text-accent border border-accent/40';
    case 'failed':
      return 'bg-bad/20 text-bad border border-bad/40';
    case 'opted-out':
      return 'bg-warn/20 text-warn border border-warn/40';
    default:
      return 'bg-panel2 text-muted border border-line';
  }
}
