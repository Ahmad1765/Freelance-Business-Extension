# 🚀 Local Business Engine

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactjs.org/)
[![Vite](https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E)](https://vitejs.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)

> A powerful Manifest V3 browser extension for local lead generation. It scrapes Google Maps results, classifies businesses by website presence, audits existing sites, and runs a throttled outreach queue through Gmail.

---

## ✨ Features

- **🗺️ Google Maps Scraper**: Seamlessly extract business leads directly from Google Maps search results.
- **🔍 Site Classification**: Automatically determine if scraped leads have an active website.
- **📈 Comprehensive Auditing**: Run detailed site checks for SEO metrics (headers, canonicals, H1 count), security (HTTPS, CSP, HSTS), and visible contact info.
- **✉️ Automated Outreach**: A fully customizable, throttled outreach queue integrated with the Gmail REST API to safely send personalized emails.
- **🛡️ Secure Storage**: Localized data storage with Dexie (IndexedDB) and encrypted API keys.
- **🚫 Zero Backend**: Everything runs securely entirely within your browser extension.

---

## 🛠️ Tech Stack

- **Frontend**: TypeScript, React, Tailwind CSS
- **State Management**: Zustand
- **Storage**: Dexie (IndexedDB) / `chrome.storage.local`
- **Build Tool**: Vite + `@crxjs/vite-plugin`
- **Outreach**: Gmail REST API (`chrome.identity` OAuth)

---

## 🚀 Getting Started

### 1. First-time Setup

Clone the repository and install dependencies:

```bash
npm install
npm run build
```

Then, load it as an unpacked extension:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `dist/` folder in this repository.
5. Pin the extension icon to your browser toolbar.

### 2. Gmail OAuth (Optional for Outreach)

To utilize the email outreach functionality, you must configure a Google OAuth Client ID:

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project.
2. Navigate to **APIs & Services** → **Enable Gmail API**.
3. Under **OAuth consent screen** → Select **External**, fill in required fields, and add yourself as a test user.
4. Under **Credentials** → **Create credentials** → **OAuth client ID** → Choose **Chrome extension**.
5. Set the **Application ID** to your unpacked extension's ID (found on `chrome://extensions`).
6. Copy the generated client ID.
7. Open `manifest.config.ts` and replace the placeholder `__REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID__.apps.googleusercontent.com` with your new client ID.
8. Run `npm run build` and reload the extension.

*Note: You can still use the scraper and auditor without setting up Gmail.*

---

## 📖 Usage Guide

### 📍 Scrape
1. Open Google Maps and search for a query (e.g., `plumbers in austin tx`).
2. Wait for the left-hand result list to render.
3. Click the extension icon → navigate to the **Scrape** tab → click **Start scraping**.
4. Leads will populate in the **Leads** tab in real-time. Click **Stop** when finished.

### 🏷️ Classify
Filter leads in the **Leads** tab by `All`, `No site`, `Has site`, or `Dead`. Leads with a website undergo a HEAD-probe. The extension will request permission to access arbitrary domains for these site checks.

### 🔎 Audit
Click **Audit** on any lead row to initiate an audit. This checks:
- Title, description, viewport, canonical, and `og:image`.
- Security headers (HTTPS, HSTS, X-Content-Type-Options, CSP).
- SEO essentials (H1 count, image alt coverage).
- Visible contact info (phone/email).
- Internal broken-link check (capped by `auditMaxLinks`).

Results are grouped by severity in the **Audits** tab. Cached results exist for 7 days.

### 📧 Outreach
1. **Settings tab**: Fill in `senderName`, `senderEmail`, and `senderAddress` (required for CAN-SPAM compliance).
2. **Connect Gmail** (requires OAuth setup).
3. **Outreach tab**: Select a lead, pick a template, and generate a **Draft**.
4. Choose **Queue** (sends on a 5-minute interval with jitter) or **Send now**.
5. Templates are managed on the **Options page**.

---

## ⚙️ Settings & Limitations

Adjust configuration on the **Settings** tab:

| Setting | Description | Default |
|---------|-------------|---------|
| `outreachDailyCap` | Total emails sent per day. | 30 |
| `outreachPerDomainCap` | Max sends to the same domain per day. | 1 |
| `outreachJitter` | Random delay between queued sends. | 30–120s |
| `geoStrictMode` | Block CASL/GDPR-restricted prospects. | true |
| `auditMaxLinks` | Links crawled per audit. | 50 |
| `auditTimeoutMs` | Per-fetch timeout. | 60000ms |

### Optional Integrations
- **Hunter.io**: Add your API key in the Options page to find precise emails by domain. Falls back to `info@<domain>`.

---

## 👨‍💻 Development

Start the development server with HMR:

```bash
npm run dev      # Load /dist as unpacked
npm run build    # Production build
npm run typecheck
npm run lint
```

---

## ⚖️ Legal & Ethical Notes

This tool is designed for **personal use**. Users are responsible for maintaining compliance with:

- **Google Maps ToS**: Prohibits automated scraping; scale usage carefully.
- **CAN-SPAM (US)**: Physical address and opt-out link are strictly required.
- **GDPR / e-Privacy (EU)**: Cold outreach to personal emails requires a legitimate-interest basis.
- **CASL (Canada) / Spam Act (AU)**: Opt-in laws (blocked by default under `geoStrictMode`).

---

## 📌 Known Limitations

- **Google Maps DOM Updates**: Scraper selectors in `src/content/maps-scraper.ts` may need updates if Google changes its layout.
- **Service Worker Sleep**: MV3 service workers sleep after ~30s of inactivity. The queue runs securely on a 5-minute `chrome.alarms` tick to mitigate this.
- **Gmail Quotas**: The daily send limit is 500/user. We recommend keeping the default cap of 30 for new accounts to warm up gradually.

---

> **Note**: If you notice zero-byte files in the repository root (e.g., `t.id`, `{,`, `set({`, `State)`), these are harmless shell-redirect artifacts and can be safely ignored or deleted.
