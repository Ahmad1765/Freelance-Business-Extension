import type { Lead } from './types';

const HEADERS = [
  'name',
  'category',
  'address',
  'phone',
  'website',
  'websiteStatus',
  'websiteHttpStatus',
  'rating',
  'reviewCount',
  'lat',
  'lng',
  'placeUrl',
  'scrapedAt',
  'tags',
  'notes',
] as const;

type Header = (typeof HEADERS)[number];

export function leadsToCsv(leads: Lead[]): string {
  const rows = leads.map((l) => HEADERS.map((h) => csvCell(getField(l, h))).join(','));
  return [HEADERS.join(','), ...rows].join('\r\n');
}

function getField(l: Lead, h: Header): unknown {
  switch (h) {
    case 'lat':
      return l.coords?.lat ?? '';
    case 'lng':
      return l.coords?.lng ?? '';
    case 'scrapedAt':
      return new Date(l.scrapedAt).toISOString();
    case 'tags':
      return (l.tags ?? []).join('|');
    default:
      return (l as any)[h] ?? '';
  }
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\r\n]/.test(s) ? `"${s}"` : s;
}

export function csvToBlobUrl(csv: string): string {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  return URL.createObjectURL(blob);
}
