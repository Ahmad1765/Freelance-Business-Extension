import { useEffect, useState } from 'react';
import { send } from '../shared/messages';
import type { Template, Settings } from '../shared/types';
import { newTemplate } from '../shared/templates';
import { encrypt, decrypt } from '../shared/crypto';

export default function Options() {
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <header className="flex items-center gap-3">
        <div className="h-8 w-8 rounded bg-accent/20 grid place-items-center text-accent text-sm font-bold">L</div>
        <h1 className="text-xl font-semibold">Local Business Engine — Settings</h1>
      </header>

      <LegalAck />
      <ApiKeysCard />
      <TemplatesCard />
      <OptOutsCard />

      <footer className="text-xs text-muted pt-8 border-t border-line">
        Run a scrape from the popup. Outreach respects daily caps + per-domain caps. All data stays local unless you wire your own backend.
      </footer>
    </div>
  );
}

function LegalAck() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void send('SETTINGS_GET').then(setSettings);
  }, []);
  if (!settings) return null;
  if (settings.acknowledgedLegal) return null;
  return (
    <section className="bg-warn/10 border border-warn/40 rounded-lg p-4 text-sm space-y-2">
      <h2 className="font-semibold text-warn">Read this before sending anything</h2>
      <ul className="list-disc pl-5 text-muted space-y-1 text-xs">
        <li>You are responsible for compliance with anti-spam laws (CAN-SPAM, GDPR, CASL, e-Privacy).</li>
        <li>Templates must include a postal address and one-click unsubscribe link.</li>
        <li>Honor opt-outs within 10 days. The extension auto-suppresses on click.</li>
        <li>Google Maps Terms of Service prohibit automated scraping. Use this as a personal tool only.</li>
        <li>This software comes with no warranty.</li>
      </ul>
      <button
        onClick={async () => {
          await send('SETTINGS_SET', { acknowledgedLegal: true });
          setSettings({ ...settings, acknowledgedLegal: true });
        }}
        className="text-xs px-3 py-1.5 bg-warn/30 border border-warn/60 rounded hover:bg-warn/40"
      >
        I understand and accept responsibility
      </button>
    </section>
  );
}

function ApiKeysCard() {
  const [hunter, setHunter] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await send('SETTINGS_GET');
      if (s.hunterApiKey) {
        try {
          setHunter(await decrypt(s.hunterApiKey));
        } catch {}
      }
    })();
  }, []);

  const onSave = async () => {
    const enc = hunter ? await encrypt(hunter) : '';
    await send('SETTINGS_SET', { hunterApiKey: enc });
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  };

  return (
    <Card title="API keys">
      <p className="text-xs text-muted">
        Optional. Hunter.io is used to find email addresses by domain. Stored encrypted (AES-GCM) at rest.
      </p>
      <Field label="Hunter.io API key">
        <div className="flex gap-2">
          <input
            type={revealed ? 'text' : 'password'}
            value={hunter}
            onChange={(e) => setHunter(e.target.value)}
            placeholder="hunter_xxx"
            className={inputCls}
          />
          <button
            onClick={() => setRevealed((r) => !r)}
            className="text-xs px-3 border border-line rounded hover:border-accent hover:text-accent"
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        </div>
      </Field>
      <button
        onClick={() => void onSave()}
        className="bg-accent hover:brightness-110 text-white rounded px-4 py-2 text-sm font-medium"
      >
        {savedFlash ? 'Saved' : 'Save key'}
      </button>
    </Card>
  );
}

function TemplatesCard() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => setTemplates((await send('TEMPLATE_LIST')).templates);
  useEffect(() => {
    void refresh();
  }, []);

  const onSave = async () => {
    if (!editing) return;
    setError(null);
    try {
      await send('TEMPLATE_UPSERT', editing);
      setEditing(null);
      void refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm('Delete template?')) return;
    await send('TEMPLATE_DELETE', { id });
    void refresh();
  };

  return (
    <Card title="Email templates">
      <p className="text-xs text-muted">
        Use <code className="text-accent">{'{{BUSINESS_NAME}}'}</code>, <code className="text-accent">{'{{BUSINESS_ADDRESS}}'}</code>, <code className="text-accent">{'{{SENDER_NAME}}'}</code>, <code className="text-accent">{'{{SENDER_ADDRESS}}'}</code>, <code className="text-accent">{'{{OPTOUT_LINK}}'}</code>. The last two are required.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {templates.map((t) => (
          <div key={t.id} className="bg-panel border border-line rounded p-3 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-panel2 border border-line">
                {t.forCohort}
              </span>
              <div className="font-medium text-sm flex-1 truncate">{t.name}</div>
            </div>
            <div className="text-xs text-muted truncate">{t.subject}</div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setEditing(t)}
                className="text-xs px-2 py-1 border border-line rounded hover:border-accent hover:text-accent"
              >
                Edit
              </button>
              <button
                onClick={() => void onDelete(t.id)}
                className="text-xs px-2 py-1 border border-line rounded text-bad hover:text-bad"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        <button
          onClick={() => setEditing(newTemplate())}
          className="bg-panel/50 border border-dashed border-line rounded p-3 text-sm text-muted hover:text-text hover:border-accent"
        >
          + New template
        </button>
      </div>

      {editing && (
        <div className="mt-4 bg-panel border border-line rounded p-4 space-y-3">
          <Field label="Name">
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Cohort">
            <select
              value={editing.forCohort}
              onChange={(e) => setEditing({ ...editing, forCohort: e.target.value as any })}
              className={inputCls}
            >
              <option value="any">any</option>
              <option value="no-website">no-website</option>
              <option value="has-website">has-website</option>
            </select>
          </Field>
          <Field label="Subject">
            <input
              value={editing.subject}
              onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Plain text body">
            <textarea
              rows={10}
              value={editing.bodyText}
              onChange={(e) => setEditing({ ...editing, bodyText: e.target.value })}
              className={inputCls + ' font-mono text-xs'}
            />
          </Field>
          <Field label="HTML body">
            <textarea
              rows={10}
              value={editing.bodyHtml}
              onChange={(e) => setEditing({ ...editing, bodyHtml: e.target.value })}
              className={inputCls + ' font-mono text-xs'}
            />
          </Field>
          {error && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded p-2">{error}</div>}
          <div className="flex gap-2">
            <button
              onClick={() => void onSave()}
              className="bg-accent hover:brightness-110 text-white rounded px-4 py-2 text-sm font-medium"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(null)}
              className="text-xs px-3 py-2 border border-line rounded hover:border-accent hover:text-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function OptOutsCard() {
  const [emails, setEmails] = useState<string[]>([]);
  const [add, setAdd] = useState('');

  const refresh = async () => setEmails((await send('OPTOUT_LIST')).emails);
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <Card title="Opt-out list">
      <p className="text-xs text-muted">
        Recipients on this list are skipped automatically. Add manually if someone replies asking to unsubscribe.
      </p>
      <div className="flex gap-2">
        <input
          value={add}
          onChange={(e) => setAdd(e.target.value)}
          placeholder="email@example.com"
          className={inputCls}
        />
        <button
          onClick={async () => {
            if (!add) return;
            await send('OPTOUT_ADD', { email: add });
            setAdd('');
            void refresh();
          }}
          className="bg-accent hover:brightness-110 text-white rounded px-3 text-sm"
        >
          Add
        </button>
      </div>
      <div className="max-h-48 overflow-auto border border-line rounded divide-y divide-line">
        {emails.length === 0 && (
          <div className="p-3 text-xs text-muted text-center">No opt-outs yet.</div>
        )}
        {emails.map((e) => (
          <div key={e} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <span className="flex-1 truncate">{e}</span>
            <button
              onClick={async () => {
                await send('OPTOUT_REMOVE', { email: e });
                void refresh();
              }}
              className="text-bad hover:underline"
            >
              remove
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}

const inputCls = 'w-full bg-panel2 border border-line rounded px-2 py-1.5 text-sm';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-panel border border-line rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
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
