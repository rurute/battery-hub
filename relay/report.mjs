// What the relay accepts from the app and how it turns it into an issue. No network here, so the
// app's tests check it too (test/relay.test.js).
//
// The body is written exactly as GitHub writes an issue form ("### Label", a blank line, the value),
// so the triage bot reads a report sent through the relay the same as one sent on GitHub.

export const TEMPLATES = {
  'device-support': {
    title: '[Device] ',
    labels: ['device-support'],
    fields: [
      ['device', 'Device'],
      ['connection', 'Connection'],
      ['ids', 'Vendor / Product ID'],
      ['scan', 'Calibration scan output', 'text'],
      ['actual', 'Actual battery level during the scan'],
      ['notes', 'Anything else'],
      ['version', 'Battery Hub version'],
    ],
  },
  works: {
    title: '[Works] ',
    labels: ['works'],
    fields: [
      ['device', 'Device'],
      ['connection', 'Connection'],
      ['ids', 'Vendor / Product ID'],
      ['how', 'How the battery is read', 'text'],
      ['version', 'Battery Hub version'],
    ],
  },
  'support-request': {
    title: 'Support request',
    labels: ['question'],
    fields: [
      ['problem', 'What went wrong?'],
      ['report', 'Check report', 'text'],
    ],
  },
};

export const FROM_APP_LABEL = 'from-app';
export const LIMITS = { title: 120, field: 8000, body: 30000, comment: 4000 };

// No one gets pinged by a report: "@name" becomes "@ name"-looking text that GitHub doesn't link.
const quiet = (text) => String(text).replace(/@(?=[A-Za-z0-9-])/g, '@​');
const clean = (text, max) => quiet(String(text ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')).slice(0, max).trim();

// { title, body, labels } for a report, or throws an Error whose message is safe to show the app.
export function buildIssue(input) {
  if (!input || typeof input !== 'object') throw new Error('bad request');
  const template = TEMPLATES[input.template];
  if (!template) throw new Error('unknown report type');
  const fields = input.fields && typeof input.fields === 'object' ? input.fields : {};
  const title = clean(fields.title || template.title, LIMITS.title);
  if (!title.startsWith(template.title.trim())) throw new Error('bad title');
  const parts = [];
  for (const [id, label, render] of template.fields) {
    const value = clean(fields[id], LIMITS.field);
    // A heading inside a plain field would read as another form section, so it is escaped.
    const shown = !value ? '_No response_' : render ? `\`\`\`${render}\n${value.replace(/```/g, "'''")}\n\`\`\`` : value.replace(/^(\s{0,3})#/gm, '$1\\#');
    parts.push(`### ${label}\n\n${shown}`);
  }
  parts.push('---\n_Sent from the Battery Hub app by someone without a GitHub account. They read the replies here in the app, and can answer from it._');
  const body = parts.join('\n\n');
  if (body.length > LIMITS.body) throw new Error('report too long');
  if (!template.fields.some(([id]) => clean(fields[id], 10))) throw new Error('empty report');
  return { title, body, labels: [...template.labels, FROM_APP_LABEL] };
}

// A follow-up from the person who sent the report.
export function buildComment(text) {
  const value = clean(text, LIMITS.comment);
  if (!value) throw new Error('empty reply');
  return `**From the person who sent this report** (through the app):\n\n${value}`;
}

// The reply key is stored only as a hash, so the stored list can't be used to post as anyone.
export async function hashKey(key) {
  const data = new TextEncoder().encode(String(key));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
