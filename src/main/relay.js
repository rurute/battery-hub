// Reports for people without a GitHub account. The app sends the report to the project's relay
// (relay/worker.mjs), which opens the issue and hands back a reply key. The app keeps each report's
// number and key, reads the replies straight from GitHub (issues are public), and can answer through
// the relay with the key. Until RELAY_URL is set, none of this shows in the app.
const RELAY_URL = '';
const REPO = 'battery-hub/battery-hub';
const TIMEOUT_MS = 15000;
const KEEP_DAYS = 120; // a report this old leaves the list
const OWN_REPLY = /^\*\*From the person who sent this report\*\*/;
const RELAY_APP = 'battery-hub-relay';

const available = () => !!RELAY_URL;

async function post(path, body) {
  const response = await fetch(`${RELAY_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `the relay answered ${response.status}`);
  return data;
}

function create(store) {
  const reports = () => (store.getSetting('sentReports') || [])
    .filter((r) => Date.now() - r.at < KEEP_DAYS * 86400000);
  const save = (list) => store.setSettings({ sentReports: list });

  // form: { template, fields } as diagnostics builds it for the GitHub link.
  async function send(form, hardware) {
    if (!available()) throw new Error('Sending without an account isn\'t available in this version');
    const template = String(form.template || '').replace(/\.yml$/, '');
    const result = await post('/report', { template, fields: form.fields });
    const entry = { number: result.number, url: result.url, key: result.key, title: form.fields.title || template, at: Date.now(), seen: 0, hardware: hardware || null };
    save([entry, ...reports().filter((r) => r.number !== entry.number)]);
    return { number: entry.number, url: entry.url };
  }

  async function reply(number, text) {
    const entry = reports().find((r) => r.number === number);
    if (!entry) throw new Error('This report isn\'t one this PC sent');
    await post('/comment', { number, key: entry.key, text });
  }

  // The replies on one report, oldest first: who wrote and what, and whether it was this person.
  async function comments(number) {
    const response = await fetch(`https://api.github.com/repos/${REPO}/issues/${number}/comments?per_page=100`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'battery-hub' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return (await response.json()).map((c) => {
      // Anyone can write that prefix in a public comment: only the relay's own GitHub App speaks for them.
      const mine = OWN_REPLY.test(c.body) && !!c.performed_via_github_app && c.performed_via_github_app.slug === RELAY_APP;
      return {
        author: mine ? 'You' : (c.user && c.user.login) || 'GitHub',
        mine,
        body: mine ? String(c.body || '').replace(OWN_REPLY, '').trim() : String(c.body || '').trim(),
        at: c.created_at,
      };
    });
  }

  // Every report with its replies, for the Your reports list. Opening it marks them read.
  async function list() {
    const all = reports();
    const out = [];
    for (const r of all) {
      const replies = await comments(r.number).catch(() => null);
      out.push({ number: r.number, url: r.url, title: r.title, at: r.at, replies });
      if (replies) r.seen = replies.filter((c) => !c.mine).length;
    }
    save(all);
    return out;
  }

  // How many reports have replies not seen yet; notify(number) is called once per new reply batch.
  async function checkReplies(notify) {
    const all = reports();
    let changed = false;
    for (const r of all) {
      const replies = await comments(r.number).catch(() => null);
      if (!replies) continue;
      const theirs = replies.filter((c) => !c.mine).length;
      if (theirs > (r.notified ?? r.seen ?? 0)) {
        r.notified = theirs;
        changed = true;
        notify(r);
      }
    }
    if (changed) save(all);
  }

  return { available, send, reply, list, checkReplies };
}

module.exports = { create, available, RELAY_URL };
