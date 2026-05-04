import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

const manifest = {
  manifest_version: 3,
  name: 'Local Business Engine',
  version: pkg.version,
  description: 'Scrape Google Maps leads, classify by website, audit sites, queue outreach.',
  icons: {
    16: 'public/icons/icon-16.png',
    32: 'public/icons/icon-32.png',
    48: 'public/icons/icon-48.png',
    128: 'public/icons/icon-128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'public/icons/icon-16.png',
      32: 'public/icons/icon-32.png',
    },
  },
  options_page: 'src/options/index.html',
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module' as const,
  },
  permissions: ['storage', 'activeTab', 'scripting', 'identity', 'alarms', 'tabs', 'sidePanel'],
  host_permissions: ['https://www.google.com/maps/*', 'https://gmail.googleapis.com/*'],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  content_scripts: [
    {
      matches: ['https://www.google.com/maps/*'],
      js: ['src/content/maps-scraper.ts', 'src/content/maps-overlay.ts'],
      run_at: 'document_idle' as const,
    },
  ],
  oauth2: {
    client_id: '__REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID__.apps.googleusercontent.com',
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'openid',
      'email',
      'profile',
    ],
  },
  web_accessible_resources: [
    { resources: ['public/icons/*'], matches: ['<all_urls>'] },
  ],
};

export default defineManifest(manifest as Parameters<typeof defineManifest>[0]);
