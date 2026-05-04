import { useEffect } from 'react';
import { useApp } from '../popup/state';
import { ScrapeTab } from '../popup/tabs/ScrapeTab';
import { LeadsTab } from '../popup/tabs/LeadsTab';
import { AuditsTab } from '../popup/tabs/AuditsTab';
import { OutreachTab } from '../popup/tabs/OutreachTab';
import { SettingsTab } from '../popup/tabs/SettingsTab';
import { LeadDetail } from '../popup/components/LeadDetail';

const TABS: { id: 'scrape' | 'leads' | 'audits' | 'outreach' | 'settings'; label: string }[] = [
  { id: 'scrape', label: 'Scrape' },
  { id: 'leads', label: 'Leads' },
  { id: 'audits', label: 'Audits' },
  { id: 'outreach', label: 'Outreach' },
  { id: 'settings', label: 'Settings' },
];

export default function SidePanelApp() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const setSidePanel = useApp((s) => s.setSidePanel);
  const refreshProgress = useApp((s) => s.refreshProgress);
  const refreshLeads = useApp((s) => s.refreshLeads);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const detailLeadId = useApp((s) => s.detailLeadId);
  const openDetail = useApp((s) => s.openDetail);

  useEffect(() => {
    setSidePanel(true);
    void refreshSettings();
    void refreshProgress();
    void refreshLeads();
    const t = setInterval(() => void refreshProgress(), 2000);
    return () => {
      clearInterval(t);
      setSidePanel(false);
    };
  }, [refreshProgress, refreshLeads, refreshSettings, setSidePanel]);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="border-b border-line px-3 py-2 flex items-center gap-2">
        <div className="h-6 w-6 rounded bg-accent/20 grid place-items-center text-accent text-xs font-bold">
          L
        </div>
        <div className="text-sm font-semibold tracking-wide">Local Business Engine</div>
        <div className="ml-auto text-xs text-muted">side panel</div>
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
      <main className="flex-1 min-h-0 flex">
        <div
          className={`flex-1 min-w-0 overflow-auto ${
            detailLeadId && tab === 'leads' ? 'border-r border-line' : ''
          }`}
        >
          {tab === 'scrape' && <ScrapeTab />}
          {tab === 'leads' && <LeadsTab />}
          {tab === 'audits' && <AuditsTab />}
          {tab === 'outreach' && <OutreachTab />}
          {tab === 'settings' && <SettingsTab />}
        </div>
        {detailLeadId && tab === 'leads' && (
          <aside className="w-[420px] shrink-0 overflow-auto bg-bg">
            <LeadDetail leadId={detailLeadId} variant="pane" onClose={() => openDetail(null)} />
          </aside>
        )}
      </main>
    </div>
  );
}
