import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state';
import type { AuditReport, SecurityHeaders } from '../../shared/types';

export function AuditsTab() {
  const audits = useApp((s) => s.audits);
  const refresh = useApp((s) => s.refreshAudits);
  const runAudit = useApp((s) => s.runAudit);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grouped = useMemo(() => {
    const seen = new Set<string>();
    return audits.filter((a) => {
      if (seen.has(a.leadId)) return false;
      seen.add(a.leadId);
      return true;
    });
  }, [audits]);

  if (!audits.length) {
    return (
      <div className="p-6 text-center text-muted text-xs">
        No audits yet. Open the Leads tab and click <span className="text-accent">Audit</span> on a lead with a website.
      </div>
    );
  }

  return (
    <div className="divide-y divide-line">
      {grouped.map((a) => (
        <AuditRow
          key={a.id}
          audit={a}
          open={openId === a.id}
          onToggle={() => setOpenId(openId === a.id ? null : a.id)}
          onRerun={() => void runAudit(a.leadId, true)}
        />
      ))}
    </div>
  );
}

function AuditRow({
  audit,
  open,
  onToggle,
  onRerun,
}: {
  audit: AuditReport;
  open: boolean;
  onToggle: () => void;
  onRerun: () => void;
}) {
  const counts = audit.findings.reduce(
    (acc, f) => {
      acc[f.severity] += 1;
      return acc;
    },
    { critical: 0, warning: 0, suggestion: 0 } as Record<string, number>
  );

  const score = audit.score ?? null;
  const summary = audit.summary ?? [];

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full text-left p-3 hover:bg-panel/60 flex items-start gap-3"
      >
        {score !== null && audit.ok && (
          <div
            className={`flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold border ${scoreClass(score)}`}
            title="Audit score (0-100)"
          >
            {score}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-sm font-medium truncate">{audit.url}</div>
            {audit.aiEnhanced && (
              <span className="flex-shrink-0 text-[9px] px-1 rounded bg-accent/20 text-accent border border-accent/30">AI</span>
            )}
          </div>
          {audit.ok && summary.length > 0 && (
            <div className="text-xs text-text/80 mt-0.5 truncate">
              Top issue: {summary[0]}
            </div>
          )}
          <div className="text-xs text-muted mt-0.5">
            {new Date(audit.ranAt).toLocaleString()} · {audit.durationMs}ms · {audit.stats.linksChecked} links checked
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 text-xs">
          {counts.critical > 0 && (
            <span className="px-1.5 rounded bg-bad/20 text-bad border border-bad/40">
              {counts.critical} crit
            </span>
          )}
          {counts.warning > 0 && (
            <span className="px-1.5 rounded bg-warn/20 text-warn border border-warn/40">
              {counts.warning} warn
            </span>
          )}
          {counts.suggestion > 0 && (
            <span className="px-1.5 rounded bg-accent/20 text-accent border border-accent/40">
              {counts.suggestion} sugg
            </span>
          )}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {!audit.ok && (
            <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded p-2 whitespace-pre-wrap">
              Audit error: {audit.error}
            </div>
          )}

          {audit.aiSummary && (
            <div className="text-xs bg-accent/10 border border-accent/30 rounded p-2">
              <div className="text-[10px] uppercase tracking-wider text-muted mb-1">AI Analysis</div>
              <p className="text-text/90 leading-relaxed">{audit.aiSummary}</p>
            </div>
          )}

          {audit.aiRecommendations && audit.aiRecommendations.length > 0 && (
            <div className="bg-panel border border-line rounded p-2 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted">Prioritized Actions</div>
              {audit.aiRecommendations.map((rec, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className={`flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold
                    ${rec.priority === 1 ? 'bg-bad/30 text-bad' : rec.priority === 2 ? 'bg-warn/30 text-warn' : 'bg-accent/30 text-accent'}`}>
                    {rec.priority}
                  </span>
                  <div>
                    <div className="font-medium">{rec.title}</div>
                    <div className="text-text/70">{rec.action}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {audit.ok && summary.length > 0 && (
            <div className="text-xs bg-panel border border-line rounded p-2">
              <div className="font-medium text-text mb-1">What to tell the owner</div>
              <ul className="list-disc pl-4 space-y-0.5 text-text/90">
                {summary.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {audit.securityHeaders && (
            <SecurityHeadersPanel headers={audit.securityHeaders} />
          )}

          {audit.findings.length === 0 && audit.ok && (
            <div className="text-xs text-ok bg-ok/10 border border-ok/30 rounded p-2">
              No issues detected. Site looks healthy.
            </div>
          )}
          {audit.findings.map((f) => (
            <div
              key={f.id}
              className={`rounded border p-2 text-xs ${sevClass(f.severity)}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="uppercase tracking-wider opacity-70 text-[10px]">
                  {f.category} · {f.severity}
                  {f.impact ? ` · ${f.impact}` : ''}
                </span>
              </div>
              <div className="font-medium">{f.title}</div>
              <div className="opacity-80 mt-0.5">{f.detail}</div>
              {f.recommendation && (
                <div className="mt-1.5 pt-1.5 border-t border-current/20 opacity-90">
                  <span className="opacity-60 text-[10px] uppercase tracking-wider mr-1">Fix:</span>
                  {f.recommendation}
                </div>
              )}
            </div>
          ))}
          <button
            onClick={onRerun}
            className="text-xs px-2 py-1 border border-line rounded hover:border-accent hover:text-accent"
          >
            Re-run audit
          </button>
        </div>
      )}
    </div>
  );
}

function scoreClass(score: number): string {
  if (score >= 80) return 'bg-ok/15 border-ok/50 text-ok';
  if (score >= 50) return 'bg-warn/15 border-warn/50 text-warn';
  return 'bg-bad/15 border-bad/50 text-bad';
}

function sevClass(s: 'critical' | 'warning' | 'suggestion'): string {
  if (s === 'critical') return 'bg-bad/10 border-bad/40 text-bad';
  if (s === 'warning') return 'bg-warn/10 border-warn/40 text-warn';
  return 'bg-accent/10 border-accent/40 text-accent';
}

function SecurityHeadersPanel({ headers }: { headers: SecurityHeaders }) {
  const items: { label: string; present: boolean }[] = [
    { label: 'CSP',                  present: headers.csp },
    { label: 'HSTS',                 present: headers.hsts },
    { label: 'X-Frame-Options',      present: headers.xFrameOptions },
    { label: 'X-Content-Type-Opts',  present: headers.xContentTypeOpts },
    { label: 'Referrer-Policy',      present: headers.referrerPolicy },
    { label: 'Permissions-Policy',   present: headers.permissionsPolicy },
  ];
  return (
    <div className="text-xs border border-line rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1.5">Security Headers</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-1">
            <span className={item.present ? 'text-ok' : 'text-bad'}>{item.present ? '✓' : '✗'}</span>
            <span className={item.present ? 'text-text/80' : 'text-text/50'}>{item.label}</span>
          </div>
        ))}
      </div>
      {headers.serverLeaks && (
        <div className="mt-1.5 text-[10px] text-warn">Server leaks: {headers.serverLeaks}</div>
      )}
    </div>
  );
}
