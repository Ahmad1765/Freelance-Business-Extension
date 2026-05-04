import { useEffect, useState } from 'react';
import { useApp } from '../state';

export function ScrapeTab() {
  const settings = useApp((s) => s.settings);
  const progress = useApp((s) => s.progress);
  const sessions = useApp((s) => s.sessions);
  const start = useApp((s) => s.startScrape);
  const stop = useApp((s) => s.stopScrape);
  const refresh = useApp((s) => s.refreshProgress);
  const refreshSessions = useApp((s) => s.refreshSessions);
  const clearAll = useApp((s) => s.clearAllLeads);

  const [max, setMax] = useState(settings.scrapeMaxResults);
  const [speed, setSpeed] = useState(settings.scrapeSpeed);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    setMax(settings.scrapeMaxResults);
    setSpeed(settings.scrapeSpeed);
  }, [settings.scrapeMaxResults, settings.scrapeSpeed]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const onStart = async () => {
    await start(max, speed);
    void refresh();
  };

  return (
    <div className="p-4 space-y-4">
      <Card title="How it works">
        <ol className="text-xs text-muted space-y-1 list-decimal pl-4">
          <li>Open Google Maps and run a search (e.g. "plumbers in austin").</li>
          <li>Wait for the result list to load on the left.</li>
          <li>Click <span className="text-accent">Start</span> below.</li>
          <li>Leads appear in the <span className="text-accent">Leads</span> tab as they come in.</li>
        </ol>
      </Card>

      <Card title="Run">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Max results">
            <input
              type="number"
              min={5}
              max={500}
              value={max}
              onChange={(e) => setMax(parseInt(e.target.value, 10) || 0)}
              className="w-full bg-panel2 border border-line rounded px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Speed">
            <select
              value={speed}
              onChange={(e) => setSpeed(e.target.value as any)}
              className="w-full bg-panel2 border border-line rounded px-2 py-1 text-sm"
            >
              <option value="slow">Slow (safer)</option>
              <option value="medium">Medium</option>
              <option value="fast">Fast (riskier)</option>
            </select>
          </Field>
        </div>
        <div className="flex gap-2">
          {progress.active ? (
            <button
              onClick={() => void stop()}
              className="flex-1 bg-bad/80 hover:bg-bad text-white rounded py-2 text-sm font-medium"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void onStart()}
              className="flex-1 bg-accent hover:brightness-110 text-white rounded py-2 text-sm font-medium"
            >
              Start scraping
            </button>
          )}
        </div>
      </Card>

      <Card title="Progress">
        <div className="space-y-2">
          <div className="text-xs text-muted">
            {progress.active ? 'Running…' : 'Idle'}
            {progress.query && (
              <>
                {' · query: '}
                <span className="text-accent">{progress.query}</span>
              </>
            )}
          </div>
          <div className="h-2 bg-panel2 rounded overflow-hidden">
            <div
              className="h-full bg-accent transition-all"
              style={{
                width: progress.target
                  ? `${Math.min(100, Math.round((progress.found / progress.target) * 100))}%`
                  : '0%',
              }}
            />
          </div>
          <div className="flex justify-between text-xs">
            <span>{progress.found} leads in current session</span>
            <span className="text-muted">target {progress.target}</span>
          </div>
          {progress.lastError && (
            <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded p-2">
              {progress.lastError}
            </div>
          )}
        </div>
      </Card>

      <Card title="Sessions">
        {sessions.length === 0 ? (
          <div className="text-xs text-muted">No sessions yet.</div>
        ) : (
          <ul className="text-xs space-y-1 max-h-40 overflow-auto">
            {sessions.slice(0, 10).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span className="truncate flex-1" title={s.query}>
                  {s.query || '(no query)'}
                </span>
                <span className="text-muted">{s.leadCount} · {new Date(s.startedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="pt-2 border-t border-line">
          {confirmClear ? (
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const n = await clearAll();
                  setConfirmClear(false);
                  console.log('cleared', n);
                }}
                className="flex-1 bg-bad/80 hover:bg-bad text-white rounded py-1.5 text-xs font-medium"
              >
                Yes, delete all leads
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="px-3 py-1.5 text-xs border border-line rounded hover:border-accent"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="w-full text-xs px-3 py-1.5 border border-line rounded text-bad hover:border-bad"
            >
              Clear all leads
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-panel border border-line rounded-lg p-3 space-y-3">
      <h3 className="text-xs uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
