import { useEffect } from 'react';
import { useApp } from '../state';
import type { Lead, LeadStatus } from '../../shared/types';
import { LeadDetail, statusHex } from '../components/LeadDetail';
import { LEAD_STATUS_LABELS } from '../../shared/types';

const FILTERS: { id: 'all' | 'present' | 'missing' | 'dead'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'missing', label: 'No site' },
  { id: 'present', label: 'Has site' },
  { id: 'dead', label: 'Dead' },
];

export function LeadsTab() {
  const leads = useApp((s) => s.leads);
  const refresh = useApp((s) => s.refreshLeads);
  const refreshSessions = useApp((s) => s.refreshSessions);
  const filter = useApp((s) => s.leadFilter);
  const setFilter = useApp((s) => s.setLeadFilter);
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);
  const sessions = useApp((s) => s.sessions);
  const sessionFilter = useApp((s) => s.sessionFilter);
  const setSessionFilter = useApp((s) => s.setSessionFilter);
  const selected = useApp((s) => s.selected);
  const toggle = useApp((s) => s.toggleSelect);
  const selectAll = useApp((s) => s.selectAll);
  const clearSelect = useApp((s) => s.clearSelect);
  const del = useApp((s) => s.deleteSelected);
  const exportCsv = useApp((s) => s.exportSelectedCsv);
  const runAudit = useApp((s) => s.runAudit);
  const setTab = useApp((s) => s.setTab);
  const detailLeadId = useApp((s) => s.detailLeadId);
  const openDetail = useApp((s) => s.openDetail);
  const isSidePanel = useApp((s) => s.isSidePanel);

  useEffect(() => {
    void refreshSessions();
    void refresh();
  }, [refresh, refreshSessions]);

  const counts = {
    all: leads.length,
    missing: leads.filter((l) => l.websiteStatus === 'missing').length,
    present: leads.filter((l) => l.websiteStatus === 'present').length,
    dead: leads.filter((l) => l.websiteStatus === 'dead').length,
  };

  return (
    <div className="relative flex flex-col h-full">
      <div className="border-b border-line p-2 space-y-2 bg-panel">
        <select
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value)}
          className="w-full bg-panel2 border border-line rounded px-2 py-1 text-sm"
        >
          <option value="current">Current session</option>
          <option value="all">All sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {(s.query || '(no query)').slice(0, 60)} · {s.leadCount}
            </option>
          ))}
        </select>
        <input
          placeholder="search name, address, category…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-panel2 border border-line rounded px-2 py-1 text-sm"
        />
        <div className="flex gap-1 text-xs">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2 py-1 rounded border ${
                filter === f.id
                  ? 'bg-accent/20 border-accent text-text'
                  : 'border-line text-muted hover:text-text'
              }`}
            >
              {f.label} <span className="opacity-60">({counts[f.id as keyof typeof counts] ?? 0})</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2 text-xs">
          <button
            onClick={selectAll}
            className="px-2 py-1 border border-line rounded text-muted hover:text-text"
          >
            Select all
          </button>
          <button
            onClick={clearSelect}
            className="px-2 py-1 border border-line rounded text-muted hover:text-text"
          >
            Clear ({selected.size})
          </button>
          <button
            onClick={() => void exportCsv()}
            className="px-2 py-1 border border-line rounded text-muted hover:text-text"
          >
            Export CSV
          </button>
          <button
            onClick={() => void del()}
            disabled={!selected.size}
            className="px-2 py-1 border border-line rounded text-bad hover:text-bad disabled:opacity-30"
          >
            Delete
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto divide-y divide-line">
        {leads.length === 0 && (
          <div className="p-6 text-center text-muted text-xs">No leads yet. Run a scrape.</div>
        )}
        {leads.map((l) => (
          <LeadRow
            key={l.id}
            lead={l}
            selected={selected.has(l.id)}
            onToggle={() => toggle(l.id)}
            onOpen={() => openDetail(l.id)}
            onAudit={async () => {
              await runAudit(l.id);
              setTab('audits');
            }}
          />
        ))}
      </div>

      {detailLeadId && !isSidePanel && (
        <LeadDetail
          leadId={detailLeadId}
          variant="modal"
          onClose={() => openDetail(null)}
        />
      )}
    </div>
  );
}

function LeadRow({
  lead,
  selected,
  onToggle,
  onOpen,
  onAudit,
}: {
  lead: Lead;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onAudit: () => void;
}) {
  const ws = lead.websiteStatus;
  const dot =
    ws === 'present' ? 'bg-ok' : ws === 'missing' ? 'bg-warn' : ws === 'dead' ? 'bg-bad' : 'bg-muted';
  const pipeline = (lead.status ?? 'new') as LeadStatus;
  return (
    <div
      onClick={onOpen}
      className={`p-3 hover:bg-panel/60 cursor-pointer ${selected ? 'bg-panel' : ''}`}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${dot}`} />
            <div className="text-sm font-medium truncate flex-1">{lead.name}</div>
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap"
              style={{
                color: statusHex(pipeline),
                borderColor: statusHex(pipeline) + '80',
                background: statusHex(pipeline) + '20',
              }}
            >
              {LEAD_STATUS_LABELS[pipeline]}
            </span>
          </div>
          <div className="text-xs text-muted truncate">{lead.category} · {lead.address}</div>
          <div className="text-xs text-muted truncate">
            {lead.phone ?? '—'}
            {' · '}
            {lead.website ? (
              <a
                href={lead.website}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-accent hover:underline"
              >
                {hostname(lead.website)}
              </a>
            ) : (
              <span>no website</span>
            )}
            {lead.rating != null && (
              <>
                {' · '}
                ⭐ {lead.rating} ({lead.reviewCount ?? 0})
              </>
            )}
          </div>
        </div>
        {lead.website && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAudit();
            }}
            className="text-xs px-2 py-1 border border-line rounded hover:border-accent hover:text-accent shrink-0"
          >
            Audit
          </button>
        )}
      </div>
    </div>
  );
}

function hostname(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}
