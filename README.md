# Local Business Engine

Manifest V3 browser extension. Scrapes Google Maps results, classifies businesses by website presence, audits existing sites, and runs a throttled outreach queue through Gmail.

Personal-use tool. Not intended for the Chrome Web Store.

## Stack

- TypeScript + React (popup, options)
- Vite + `@crxjs/vite-plugin` (bundling)
- Tailwind (styling)
- Dexie / IndexedDB (lead/audit/outreach storage)
- Zustand (popup state)
- Gmail REST API (outreach send via `chrome.identity` OAuth)

No backend. Everything runs in the extension.

## First-time setup

```bash
npm install
npm run build
```

Then load it as an unpacked extension:

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` folder in this repo
5. Pin the extension icon to the toolbar

### Gmail OAuth (only needed if you want to send email)

The manifest ships with `__REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID__.apps.googleusercontent.com`. Until you replace it, "Connect Gmail" will fail. Steps:

1. Open <https://console.cloud.google.com> and create a project
2. APIs & Services → **Enable Gmail API**
3. APIs & Services → **OAuth consent screen** → External, fill required fields, add yourself as a test user
4. APIs & Services → **Credentials** → **Create credentials → OAuth client ID** → **Chrome extension**
5. Application ID = your unpacked extension's ID (visible on `chrome://extensions`)
6. Copy the new client ID
7. Edit `manifest.config.ts` → replace the placeholder `client_id`
8. `npm run build`
9. Reload the unpacked extension

You can use the rest of the extension (scrape, audit, drafts) without Gmail.

## Running it

### Scrape

1. Open Google Maps
2. Search a query — e.g. `plumbers in austin tx`
3. Wait for the left-hand result list to render
4. Click the extension icon → **Scrape** tab → **Start scraping**
5. Watch the counter; leads land in the **Leads** tab as they come in
6. Click **Stop** any time

### Classify

The **Leads** tab has filters: `All`, `No site`, `Has site`, `Dead`.
Each lead with a website is HEAD-probed. The first time you scrape, the extension will ask for permission to access arbitrary domains — that's the audit/probe permission. Approve to enable site checks.

### Audit

In **Leads**, click **Audit** on a row. The extension fetches the homepage and runs:
- Title / description / viewport / canonical / og:image
- HTTPS, HSTS, X-Content-Type-Options, CSP, Referrer-Policy
- H1 count, image alt coverage, structured data
- Visible contact info (phone/email)
- Internal link crawl (broken-link check) — capped by `auditMaxLinks` setting

Findings appear in the **Audits** tab grouped by severity. Re-runs are skipped if a recent (≤7 days) cached result exists; click **Re-run** to force.

### Outreach

1. **Settings** tab → fill `senderName`, `senderEmail`, `senderAddress`. The address is required by CAN-SPAM. Click **Save**.
2. Click **Connect Gmail** (requires the OAuth client ID step above).
3. **Outreach** tab → pick a lead + template → **Draft**.
4. Each draft has **Queue** (sends on the 5-minute alarm with jitter + caps) or **Send now**.
5. Templates are editable on the **Options page** (button at the bottom of Settings, or `chrome://extensions` → Details → Extension options).
6. Opt-outs are honored automatically. Add an email manually on the Options page if someone replies asking to unsubscribe.

## Limits and caps

Adjust on the Settings tab:

- `outreachDailyCap` — total sends/day (default 30; warm up gradually)
- `outreachPerDomainCap` — max sends to the same domain in a day (default 1)
- `outreachJitter` — random delay between sends (default 30–120s)
- `geoStrictMode` — block CASL/GDPR-restricted prospects when true
- `auditMaxLinks` — links crawled per audit (default 50)
- `auditTimeoutMs` — per-fetch timeout (default 60000)

## Hunter.io (optional)

If set on the Options page, the extension uses your Hunter API key to find emails by domain. Otherwise it falls back to `info@<domain>`. Stored encrypted in `chrome.storage` (AES-GCM; treat as obfuscation, not security).

## Dev workflow

```bash
npm run dev      # vite dev server with HMR; load /dist as unpacked
npm run build    # production build
npm run typecheck
npm run lint
```

## Where data lives

- IndexedDB database `local-biz-engine` — leads, audits, outreach, templates, opt-outs
- `chrome.storage.local` — settings, salt, scrape progress, encrypted Hunter key

To wipe everything: `chrome://extensions` → remove the extension and reload it.

## CSV export

Leads tab → select rows (or none = all) → **Export CSV**. Saved with UTF-8 BOM so Excel handles diacritics.

## Legal & ethical notes

This is a personal tool. You are responsible for compliance with:

- Google Maps Terms of Service (prohibits automated scraping; scale carefully)
- CAN-SPAM (US): physical address + opt-out required (enforced by template validator)
- GDPR / e-Privacy (EU): cold email to personal addresses needs legitimate-interest basis
- CASL (Canada) / Spam Act (AU): opt-in laws — strict mode blocks these by default

The Options page surfaces a one-time acknowledgement modal.

## Repo hygiene

If you see zero-byte files in the repo root with names like `t.id`, `{,`, `set({`, or `State)`, those are accidental shell-redirect artifacts (a stray `>` in a copy-pasted command), not part of the build. Safe to delete.

## Known limitations

- Google Maps DOM changes can break the scraper. Selectors live in `src/content/maps-scraper.ts`. The extractor probes multiple selector variants but you may need to update them after Google ships a layout change.
- Service workers in MV3 sleep after ~30s of inactivity. The scrape pipeline tolerates this — leads stream in via messages, and the queue runs on a 5-minute `chrome.alarms` tick.
- Gmail's daily send quota is 500/user; warm up new accounts gradually. Daily cap default of 30 is conservative.

## File map

```
src/
  background/        service worker entrypoint, message router
    audit.ts         site audit (meta, links, headers, SEO, contact)
    gmail.ts         OAuth + RFC822 + send
    probe.ts         HEAD probe + permission gating
    queue.ts         throttled outreach tick
    storage.ts       Dexie + chrome.storage facade
    index.ts         dispatcher
  content/
    maps-scraper.ts  Google Maps DOM extractor
    contact-filler.ts contact-form auto-fill (no auto-submit)
    stealth.ts       jitter + sleep helpers
  popup/             toolbar UI (React)
    tabs/            ScrapeTab, LeadsTab, AuditsTab, OutreachTab, SettingsTab
  options/           full-page Options (templates, opt-outs, API keys)
  sidepanel/         Chrome side panel UI (React)
  shared/
    types.ts         Lead, AuditReport, OutreachItem, Template, Settings
    messages.ts      typed runtime messaging
    csv.ts           lead → CSV
    templates.ts     render + geo gate + CAN-SPAM validator
    crypto.ts        AES-GCM at-rest helper
public/icons/        toolbar icons (placeholders; replace as needed)
manifest.config.ts   MV3 manifest source
vite.config.ts
```
