import { useEffect, useState } from 'react';
import { useApp } from '../state';
import { send } from '../../shared/messages';

export function SettingsTab() {
  const settings = useApp((s) => s.settings);
  const save = useApp((s) => s.saveSettings);
  const refresh = useApp((s) => s.refreshSettings);
  const gmail = useApp((s) => s.gmail);
  const refreshGmail = useApp((s) => s.refreshGmail);
  const connectGmail = useApp((s) => s.connectGmail);
  const disconnectGmail = useApp((s) => s.disconnectGmail);

  const [local, setLocal] = useState(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void refresh();
    void refreshGmail();
  }, [refresh, refreshGmail]);
  useEffect(() => setLocal(settings), [settings]);

  const onSave = async () => {
    await save(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="p-3 space-y-3">
      <Card title="Sender identity">
        <Field label="Your name">
          <input
            value={local.senderName}
            onChange={(e) => setLocal({ ...local, senderName: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Your email (informational)">
          <input
            value={local.senderEmail}
            onChange={(e) => setLocal({ ...local, senderEmail: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Postal address (required by CAN-SPAM)">
          <textarea
            rows={2}
            value={local.senderAddress}
            onChange={(e) => setLocal({ ...local, senderAddress: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Default opt-out link">
          <input
            value={local.defaultOptOutBaseUrl}
            onChange={(e) => setLocal({ ...local, defaultOptOutBaseUrl: e.target.value })}
            className={inputCls}
          />
        </Field>
      </Card>

      <Card title="Gmail">
        {gmail.connected ? (
          <div className="flex items-center justify-between">
            <div className="text-xs">
              Connected as <span className="text-ok">{gmail.email ?? 'unknown'}</span>
            </div>
            <button
              onClick={() => void disconnectGmail()}
              className="text-xs px-2 py-1 border border-line rounded hover:border-bad hover:text-bad"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={() => void connectGmail()}
            className="w-full bg-accent hover:brightness-110 text-white rounded py-2 text-sm font-medium"
          >
            Connect Gmail
          </button>
        )}
        <p className="text-[11px] text-muted">
          Required to send outreach. Uses your Gmail account directly via OAuth — your sender reputation, your sends.
        </p>
      </Card>

      <Card title="Outreach throttle">
        <Field label="Max sends per day">
          <input
            type="number"
            min={1}
            max={500}
            value={local.outreachDailyCap}
            onChange={(e) => setLocal({ ...local, outreachDailyCap: parseInt(e.target.value, 10) || 0 })}
            className={inputCls}
          />
        </Field>
        <Field label="Max sends per domain per day">
          <input
            type="number"
            min={1}
            max={20}
            value={local.outreachPerDomainCap}
            onChange={(e) =>
              setLocal({ ...local, outreachPerDomainCap: parseInt(e.target.value, 10) || 0 })
            }
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Min jitter (s)">
            <input
              type="number"
              min={5}
              value={local.outreachJitterMinSeconds}
              onChange={(e) =>
                setLocal({ ...local, outreachJitterMinSeconds: parseInt(e.target.value, 10) || 0 })
              }
              className={inputCls}
            />
          </Field>
          <Field label="Max jitter (s)">
            <input
              type="number"
              min={5}
              value={local.outreachJitterMaxSeconds}
              onChange={(e) =>
                setLocal({ ...local, outreachJitterMaxSeconds: parseInt(e.target.value, 10) || 0 })
              }
              className={inputCls}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={local.geoStrictMode}
            onChange={(e) => setLocal({ ...local, geoStrictMode: e.target.checked })}
          />
          Strict geo mode (block CASL/GDPR-restricted prospects)
        </label>
      </Card>

      <Card title="Audit">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max links to check">
            <input
              type="number"
              min={1}
              max={200}
              value={local.auditMaxLinks}
              onChange={(e) =>
                setLocal({ ...local, auditMaxLinks: parseInt(e.target.value, 10) || 0 })
              }
              className={inputCls}
            />
          </Field>
          <Field label="Timeout (ms)">
            <input
              type="number"
              min={1000}
              max={120000}
              step={1000}
              value={local.auditTimeoutMs}
              onChange={(e) =>
                setLocal({ ...local, auditTimeoutMs: parseInt(e.target.value, 10) || 0 })
              }
              className={inputCls}
            />
          </Field>
        </div>
      </Card>

      <Card title="AI Analysis">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={local.aiEnabled}
            onChange={(e) => setLocal({ ...local, aiEnabled: e.target.checked })}
          />
          Enable AI-powered recommendations after each audit
        </label>
        <Field label="Provider">
          <select
            value={local.aiProvider}
            disabled={!local.aiEnabled}
            onChange={(e) => {
              const provider = e.target.value as 'openrouter' | 'nvidia';
              const model = provider === 'nvidia'
                ? 'meta/llama-3.1-8b-instruct'
                : 'meta-llama/llama-3.1-8b-instruct:free';
              setLocal({ ...local, aiProvider: provider, aiModel: model });
            }}
            className={inputCls}
          >
            <option value="openrouter">OpenRouter (free models)</option>
            <option value="nvidia">NVIDIA NIM (free credits)</option>
          </select>
        </Field>
        <Field label="Model">
          <input
            value={local.aiModel}
            disabled={!local.aiEnabled}
            onChange={(e) => setLocal({ ...local, aiModel: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="API Key">
          <input
            type="password"
            value={local.aiApiKey ?? ''}
            disabled={!local.aiEnabled}
            onChange={(e) => setLocal({ ...local, aiApiKey: e.target.value || undefined })}
            className={inputCls}
            placeholder="paste key here"
          />
        </Field>
        <p className="text-[10px] text-muted">
          OpenRouter: free key at <span className="text-accent">openrouter.ai</span> · NVIDIA: <span className="text-accent">integrate.nvidia.com</span>
        </p>
        {local.aiEnabled && local.aiApiKey && (
          <AiTestButton provider={local.aiProvider} apiKey={local.aiApiKey} />
        )}
      </Card>

      <Card title="Scrape defaults">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Default max results">
            <input
              type="number"
              value={local.scrapeMaxResults}
              onChange={(e) =>
                setLocal({ ...local, scrapeMaxResults: parseInt(e.target.value, 10) || 0 })
              }
              className={inputCls}
            />
          </Field>
          <Field label="Default speed">
            <select
              value={local.scrapeSpeed}
              onChange={(e) => setLocal({ ...local, scrapeSpeed: e.target.value as any })}
              className={inputCls}
            >
              <option value="slow">slow</option>
              <option value="medium">medium</option>
              <option value="fast">fast</option>
            </select>
          </Field>
        </div>
      </Card>

      <div className="flex items-center gap-2">
        <button
          onClick={() => void onSave()}
          className="flex-1 bg-accent hover:brightness-110 text-white rounded py-2 text-sm font-medium"
        >
          {saved ? 'Saved' : 'Save settings'}
        </button>
        <button
          onClick={() => void chrome.runtime.openOptionsPage()}
          className="text-xs px-3 py-2 border border-line rounded hover:border-accent hover:text-accent"
        >
          Templates / Opt-outs →
        </button>
      </div>
    </div>
  );
}

const inputCls = 'w-full bg-panel2 border border-line rounded px-2 py-1 text-sm';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-panel border border-line rounded-lg p-3 space-y-2">
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

function AiTestButton({ provider, apiKey }: { provider: string; apiKey: string }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [msg, setMsg] = useState('');

  const test = async () => {
    setStatus('testing');
    setMsg('');
    try {
      const r = await send('AI_TEST', { provider, apiKey });
      if (r.ok) {
        setStatus('ok');
        setMsg(r.model ?? 'connected');
      } else {
        setStatus('fail');
        setMsg(r.error ?? 'unknown error');
      }
    } catch (e) {
      setStatus('fail');
      setMsg(String(e));
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => void test()}
        disabled={status === 'testing'}
        className="text-xs px-2 py-1 border border-line rounded hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {status === 'testing' ? 'Testing…' : 'Test connection'}
      </button>
      {status === 'ok' && (
        <span className="text-xs text-ok">Connected: {msg}</span>
      )}
      {status === 'fail' && (
        <span className="text-xs text-bad truncate max-w-[180px]" title={msg}>Failed: {msg}</span>
      )}
    </div>
  );
}
