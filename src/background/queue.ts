import { outreachStore, optoutStore, settingsStore } from './storage';
import { sendEmail } from './gmail';

const ALARM_NAME = 'outreach-tick';

export function installQueueAlarm() {
  chrome.alarms.get(ALARM_NAME, (a) => {
    if (!a) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_NAME) tickQueue().catch(() => {});
});

export async function tickQueue() {
  const settings = await settingsStore.get();
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = await outreachStore.countSentOn(today);
  const remaining = Math.max(0, settings.outreachDailyCap - sentToday);
  if (remaining === 0) return;

  const queued = await outreachStore.list({ status: 'queued' });
  const due = queued
    .filter((i) => !i.scheduledAt || i.scheduledAt <= Date.now())
    .slice(0, remaining);

  for (const item of due) {
    if (await optoutStore.has(item.to)) {
      await outreachStore.update(item.id, { status: 'opted-out' });
      continue;
    }
    const dom = item.to.split('@')[1]?.toLowerCase() ?? '';
    if (settings.outreachPerDomainCap > 0 && dom && (await outreachStore.sentToDomainToday(dom))) {
      // defer; pick up next tick
      continue;
    }
    try {
      const r = await sendEmail({
        to: item.to,
        subject: item.subject,
        bodyText: item.body,
        bodyHtml: item.bodyHtml ?? item.body,
        fromName: settings.senderName,
        fromEmail: settings.senderEmail,
      });
      await outreachStore.update(item.id, {
        status: 'sent',
        sentAt: Date.now(),
        threadId: r.threadId,
        messageId: r.id,
        attempts: (item.attempts ?? 0) + 1,
      });
    } catch (e) {
      const attempts = (item.attempts ?? 0) + 1;
      await outreachStore.update(item.id, {
        status: attempts >= 3 ? 'failed' : 'queued',
        attempts,
        error: String(e).slice(0, 500),
      });
    }
    const min = settings.outreachJitterMinSeconds;
    const max = settings.outreachJitterMaxSeconds;
    const wait = (min + Math.random() * Math.max(0, max - min)) * 1000;
    await sleep(wait);
  }
}

export async function sendNow(id: string): Promise<{ ok: boolean; error?: string }> {
  const item = await outreachStore.get(id);
  if (!item) return { ok: false, error: 'not found' };
  if (await optoutStore.has(item.to)) {
    await outreachStore.update(id, { status: 'opted-out' });
    return { ok: false, error: 'recipient on opt-out list' };
  }
  const settings = await settingsStore.get();
  try {
    const r = await sendEmail({
      to: item.to,
      subject: item.subject,
      bodyText: item.body,
      bodyHtml: item.bodyHtml ?? item.body,
      fromName: settings.senderName,
      fromEmail: settings.senderEmail,
    });
    await outreachStore.update(id, {
      status: 'sent',
      sentAt: Date.now(),
      threadId: r.threadId,
      messageId: r.id,
      attempts: (item.attempts ?? 0) + 1,
    });
    return { ok: true };
  } catch (e) {
    await outreachStore.update(id, {
      status: 'failed',
      attempts: (item.attempts ?? 0) + 1,
      error: String(e).slice(0, 500),
    });
    return { ok: false, error: String(e) };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
