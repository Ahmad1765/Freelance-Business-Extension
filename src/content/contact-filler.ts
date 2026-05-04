// Injected via chrome.scripting.executeScript on demand.
// Fills common contact-form fields. Does NOT auto-submit.

interface FillRequest {
  kind: 'FILL_CONTACT';
  payload: {
    senderName: string;
    senderEmail: string;
    message: string;
    phone?: string;
    company?: string;
  };
}

chrome.runtime.onMessage.addListener((msg: FillRequest, _sender, reply) => {
  if (msg.kind !== 'FILL_CONTACT') return;
  const { senderName, senderEmail, message, phone, company } = msg.payload;
  const filled: string[] = [];
  if (fillByLabel(/^|\s(name|full[- ]?name)\s|$/i, senderName)) filled.push('name');
  if (fillByLabel(/email|e-mail/i, senderEmail)) filled.push('email');
  if (phone && fillByLabel(/phone|tel|mobile/i, phone)) filled.push('phone');
  if (company && fillByLabel(/company|business|organi[sz]ation/i, company)) filled.push('company');
  if (
    fillByLabel(
      /message|comment|inquiry|details|question|how can we help|tell us/i,
      message,
      /textarea/i
    )
  ) {
    filled.push('message');
  }
  reply({ ok: true, filled });
});

function fillByLabel(rx: RegExp, val: string, prefer?: RegExp): boolean {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea'
    )
  );
  const score = (el: HTMLInputElement | HTMLTextAreaElement): number => {
    const candidates = [
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('name') || '',
      el.getAttribute('id') || '',
      labelOf(el),
    ];
    const text = candidates.join(' ');
    let s = rx.test(text) ? 10 : 0;
    if (prefer && prefer.test(el.tagName)) s += 5;
    if (el.offsetParent === null) s -= 50;
    return s;
  };
  inputs.sort((a, b) => score(b) - score(a));
  const target = inputs[0];
  if (!target || score(target) <= 0) return false;
  setNativeValue(target, val);
  return true;
}

function labelOf(el: HTMLInputElement | HTMLTextAreaElement): string {
  if (el.id) {
    const lbl = document.querySelector(`label[for="${el.id}"]`);
    if (lbl?.textContent) return lbl.textContent;
  }
  const parent = el.closest('label');
  return parent?.textContent ?? '';
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, val: string) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, val);
  else el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
