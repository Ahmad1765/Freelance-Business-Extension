import { useEffect } from 'react';
import { useApp } from './state';
import { ScrapeTab } from './tabs/ScrapeTab';
import { LeadsTab } from './tabs/LeadsTab';
import { AuditsTab } from './tabs/AuditsTab';
import { OutreachTab } from './tabs/OutreachTab';
import { SettingsTab } from './tabs/SettingsTab';

const TABS: { id: 'scrape' | 'leads' | 'audits' | 'outreach' | 'settings'; label: string }[] = [
  { id: 'scrape', label: 'Scrape' },
  { id: 'leads', label: 'Leads' },
  { id: 'audits', label: 'Audits' },
  { id: 'outreach', label: 'Outreach' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const refreshProgress = useApp((s) => s.refreshProgress);
  const refreshLeads = useApp((s) => s.refreshLeads);
  const refreshSettings = useApp((s) => s.refreshSettings);

  useEffect(() => {
    void refreshSettings();
    void refreshProgress();
    void refreshLeads();
    const t = setInterval(() => void refreshProgress(), 2000);
    return () => clearInterval(t);
  }, [refreshProgress, refreshLeads, refreshSettings]);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="border-b border-line px-3 py-2 flex items-center gap-2">
        <div className="h-6 w-6 rounded bg-accent/20 grid place-items-center text-accent text-xs font-bold">L</div>
        <div className="text-sm font-semibold tracking-wide">Local Business Engine</div>
        <button
          onClick={async () => {
            try {
              const win = await chrome.windows.getCurrent();
              if (win.id != null) {
                await chrome.sidePanel.open({ windowId: win.id });
                window.close();
              }
            } catch (e) {
              console.warn('side panel open failed', e);
            }
          }}
          className="ml-auto text-[10px] uppercase tracking-wider px-2 py-1 border border-line rounded hover:border-accent hover:text-accent"
          title="Open in side panel"
        >
          Side panel
        </button>
        <div className="text-xs text-muted">v0.1</div>
      </header>
      <nav className="flex border-b border-line bg-panel">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-2 py-2 text-xs uppercase tracking-wider border-b-2 transition ${
              tab === t.id
                ? 'border-accent text-text'
                : 'border-transparent text-muted hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="flex-1 overflow-auto">
        {tab === 'scrape' && <ScrapeTab />}
        {tab === 'leads' && <LeadsTab />}
        {tab === 'audits' && <AuditsTab />}
        {tab === 'outreach' && <OutreachTab />}
        {tab === 'settings' && <SettingsTab />}
      </main>
    </div>
  );
}
