// The issue bot (see .github/workflows/triage.yml). On every new device report it:
//   - labels it: good report (the scan's bytes and the real level are given), no data,
//     or old version
//   - closes it if the same hardware was already reported, pointing to that report
//   - keeps the "Most requested devices" issue up to date, so the most wanted devices are clear
// The pure parts are exported for test/triage.test.js; run() is what the workflow calls.

const BOARD_TITLE = 'Most requested devices';
const BOARD_LABEL = 'device-list';
const LABELS = {
  good: { name: 'good report', color: '0e8a16', description: 'Has scan data and the real battery level' },
  noData: { name: 'no data', color: 'cccccc', description: 'The scan caught nothing from the device' },
  old: { name: 'old version', color: 'fbca04', description: 'Sent from an older Battery Hub' },
  duplicate: { name: 'duplicate', color: 'cfd3d7', description: 'This device was already reported' },
  cant: { name: "can't support", color: 'b60205', description: "The device doesn't share its battery level, so it can't be read" },
  works: { name: 'works', color: '0e8a16', description: 'Someone confirmed Battery Hub reads this device' },
  supported: { name: 'supported', color: '1d76db', description: 'Battery Hub reads this device now; waiting for someone to confirm' },
  board: { name: BOARD_LABEL, color: '5319e7', description: 'The list of requested devices' },
};
const NO_ANSWER = /^_?no response_?$|^(unknown|n\/a|none|-|\?+|no se|不知道)$/i;
// 'don't know' typed any way: dont't, don`t, idk, not sure.
const NO_IDEA = (t) => /^(i?don?t*know|idk|notsure|nose)$/.test(t.toLowerCase().replace(/[^a-z]/g, ''));

const isWorksReport = (issue) => /^\[Works\]/i.test(issue.title || '') || (issue.labels || []).some((l) => (l.name || l) === 'works');
const isDeviceReport = (issue) => /^\[Device\]/i.test(issue.title || '') || (issue.labels || []).some((l) => (l.name || l) === 'device-support');

// The section under a "### Heading" of an issue form.
function section(body, heading) {
  const m = String(body || '').replace(/\r\n/g, '\n').match(new RegExp(`### ${heading}\\s*\\n([\\s\\S]*?)(?=\\n### |$)`, 'i'));
  return m ? m[1].replace(/```[a-z]*\n?/g, '').trim() : '';
}

// Hardware as 'VVVV:PPPP', from 'VID_046D / PID_C54D', 'VID_046D&PID_C54D' or '046d:c54d'.
function hardwareOf(body) {
  const text = String(body || '');
  const m = text.match(/VID_?([0-9A-F]{4})[\s\S]{0,12}?PID_?([0-9A-F]{4})/i) || text.match(/\b([0-9A-F]{4}):([0-9A-F]{4})\b/i);
  // 0000 is what a device with no real id shows; those can't be told apart, so they never match.
  return m && m[1] !== "0000" ? `${m[1]}:${m[2]}`.toUpperCase() : null;
}

function parseReport(issue) {
  const body = issue.body || '';
  const scan = section(body, 'Calibration scan output');
  const actual = section(body, 'Actual battery level during the scan');
  const version = (section(body, 'Battery Hub version').match(/\d+\.\d+\.\d+/) || [])[0] || null;
  const captured = /^Scan \d+: \d+ messages?$/m.test(scan) || /^Feature reports:/m.test(scan) || /report \d+, seen \d+x/.test(scan);
  // The bytes a battery is decoded from. Before 2.0.5 reports often held only message counts.
  const bytes = /report \d+, seen \d+x: [0-9a-fx]{2,}/i.test(scan);
  return {
    hardware: hardwareOf(section(body, 'Vendor / Product ID') || body),
    name: section(body, 'Device').split('\n')[0].trim() || String(issue.title || '').replace(/^\[Device\]\s*/i, ''),
    version,
    captured,
    bytes,
    hasLevel: !!actual && !NO_ANSWER.test(actual.trim()) && !NO_IDEA(actual),
  };
}

function isOlder(version, latest) {
  if (!version || !latest) return false;
  const a = version.split('.').map(Number);
  const b = latest.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return false;
}

// What to do with one new report, given the other device reports. Returns labels to add, an
// optional comment and whether to close it.
function decide(report, others, latest) {
  const labels = [];
  // The report to send people to: an open one, else the oldest that isn't itself a closed copy.
  const same = report.hardware ? others.filter((o) => o.hardware === report.hardware).sort((a, b) => a.number - b.number) : [];
  const first = same.find((o) => o.state === 'open' && !o.duplicate) || same.find((o) => !o.duplicate) || same[0];
  const cant = same.find((o) => o.cantSupport);
  if (cant) {
    return { labels: [LABELS.duplicate.name, LABELS.cant.name], close: true, comment: `Thanks! This device (${report.hardware}) was already looked at in #${cant.number}: it doesn't share its battery level, so Battery Hub can't read it. Sorry! If it also has Bluetooth, try connecting that way.` };
  }
  const supported = same.find((o) => o.supported);
  if (supported) {
    return { labels: [LABELS.duplicate.name], close: true, comment: `Thanks! Battery Hub already reads this device (${report.hardware}): see #${supported.number}. Please update to the latest version (Settings → Check for updates) and add it from Add device. If it still doesn't read, tell us in #${supported.number} what its card says.` };
  }
  if (first) {
    const answered = first.state === 'open'
      ? `Let's continue in #${first.number}: please add a 👍 there, and anything new as a comment.`
      : `#${first.number} has the answer for it.`;
    return { labels: [LABELS.duplicate.name], close: true, comment: `Thanks! This device (${report.hardware}) was already reported, so I'm closing this copy. ${answered}` };
  }
  if (isOlder(report.version, latest)) {
    labels.push(LABELS.old.name, 'needs info');
    return { labels, close: false, comment: `Thanks! This was sent from Battery Hub ${report.version}, and the latest is ${latest.replace(/^v/, '')}. Please update (Settings → Check for updates), run the scan again and post the new result here: it may already be fixed.` };
  }
  if (report.bytes && report.hasLevel) labels.push(LABELS.good.name);
  else if (!report.captured) {
    labels.push(LABELS.noData.name, 'needs info');
    return { labels, close: false, comment: "Thanks! The scan didn't catch anything from this device yet. Please make sure it's on and awake, turn it off and on while the scan runs, and post the new result. If it also has Bluetooth, try connecting that way: Battery Hub reads Bluetooth batteries. If you know an app that shows its battery, tell me which." };
  }
  return { labels, close: false, comment: null };
}

// The "Most requested devices" issue. Requests count each person who asked and each 👍, and each
// device links only to its main report: closed copies just send people there. The most requested
// devices come first; the rest, the ones Battery Hub already reads, the ones people confirmed and
// the ones that can't be read are folded away below.

// A short, readable device name: no "(Standard system devices)" in any language, no company
// suffixes, no maker said twice ("MCHOSE MCHOSE K99"), and nothing longer than a table cell.
function cleanName(name) {
  let n = String(name || '').replace(/_+/g, ' ').replace(/[\u0000-\u001f\u0300-\u036f]/g, '')
    // A word of Latin letters run into Cyrillic or CJK is a garbled USB string: keep the Latin part.
    .replace(/\b([A-Za-z0-9]+)[\u0400-\u04ff\u3400-\u9fff]\S*/g, '$1')
    .replace(/\([^)]*(system|systém|sistem|систем|系统|系統)[^)]*\)/gi, ' ')
    .replace(/\b(Technology|Electronics|Semiconductor|Corporation|Corp\.?|Co\.,?|Ltd\.?|Inc\.?|INT'L|Computer|Semi\.)(?=\s|,|$)/gi, ' ')
    .replace(/^HP,\s*/i, '')
    .replace(/\s*,\s*(?=\s|$)/g, ' ')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ').trim();
  n = n.replace(/^(\S+)\s+(?=\1\b)/i, '');           // "Razer Razer Viper" -> "Razer Viper"
  if (n.length > 45) n = n.split(/(?<=\S{3}),\s|\.\s|\s\(/)[0];  // "Fuxi-H6 (headset), dongle ..." -> "Fuxi-H6"
  if (n.length > 45) n = `${n.slice(0, 44).trim()}…`;
  return n || 'Unknown device';
}

function boardBody(reports, works = []) {
  const rows = new Map();
  for (const r of reports) {
    if (!r.hardware) continue;
    const row = rows.get(r.hardware) || { hardware: r.hardware, reports: [], people: new Set(), votes: 0, good: false };
    row.reports.push(r);
    if (r.author) row.people.add(r.author);
    row.votes += r.votes || 0;
    row.good = row.good || r.good;
    row.works = row.works || r.works;
    row.supported = row.supported || r.supported;
    rows.set(r.hardware, row);
  }
  for (const row of rows.values()) {
    const sorted = row.reports.sort((x, y) => x.number - y.number);
    row.main = sorted.find((r) => r.state === 'open' && !r.duplicate) || sorted.find((r) => r.state === 'open')
      || sorted.find((r) => !r.duplicate) || sorted[0];
    // A device marked can't support leaves the ranking even while its report stays open.
    row.cant = sorted.some((r) => r.cantSupport);
    row.open = sorted.some((r) => r.state === 'open') && !row.cant;
  }
  const score = (r) => r.people.size + r.votes;
  const byScore = (x, y) => score(y) - score(x) || x.main.number - y.main.number;
  const newestFirst = (x, y) => y.main.number - x.main.number;
  const line = (r) => `| ${score(r)} | ${cleanName(r.main.name)} | \`${r.hardware}\` | #${r.main.number} |${r.good ? ' ✅' : ''} |`;
  const head = ['| Asked | Device | ID | Report | Scan |', '|---:|---|---|---|:---:|'];
  const all = [...rows.values()].filter((r) => !r.works);
  const supported = all.filter((r) => r.supported && !r.cant).sort(byScore);
  const waiting = all.filter((r) => r.open && !r.supported);
  const top = waiting.filter((r) => score(r) >= 2).sort(byScore);
  const once = waiting.filter((r) => score(r) < 2).sort(newestFirst);
  const closed = all.filter((r) => !r.open && !r.supported).sort(byScore);

  // Works with: one row per hardware a person confirmed, with how many people did.
  const confirmed = new Map();
  for (const w of [...works].sort((x, y) => x.number - y.number)) {
    if (!w.hardware) continue;
    const row = confirmed.get(w.hardware) || { hardware: w.hardware, name: w.name, number: w.number, people: new Set() };
    row.people.add(w.author || w.number);
    confirmed.set(w.hardware, row);
  }
  const worksRows = [...confirmed.values()].sort((x, y) => y.people.size - x.people.size || x.number - y.number)
    .map((r) => `| ${r.people.size} | ${cleanName(r.name)} | \`${r.hardware}\` | #${r.number} |`);

  const folded = (summary, header, lines) => (lines.length ? [
    `<details><summary>${summary} (${lines.length})</summary>`, '', ...header, ...lines, '', '</details>', '',
  ] : []);
  return [
    'Devices people asked Battery Hub to read. A bot keeps this list up to date.',
    '',
    '**Have one of these?** Add a 👍 to its report instead of opening a new one: the most asked-for devices are looked at first. **Asked** counts each person and each 👍. ✅ means the report has a scan and the real battery level, which is what a fix is built from.',
    '',
    '### Most requested',
    '',
    ...(top.length ? [...head, ...top.map(line)] : ['Nothing yet.']),
    '',
    ...folded('Asked once, newest first', head, once.map(line)),
    ...folded('Supported now: update Battery Hub and tell us if yours works', head, supported.map(line)),
    ...folded('Works: people confirmed Battery Hub reads these', ['| People | Device | ID | Report |', '|---:|---|---|---|'], worksRows),
    ...folded("Can't be read: closed, or the device doesn't share its battery level", head, closed.map(line)),
  ].join('\n').trimEnd();
}

async function allIssues(github, owner, repo) {
  const issues = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  return issues.filter((i) => !i.pull_request);
}
const allDeviceIssues = async (...a) => (await allIssues(...a)).filter(isDeviceReport);
// "It works" reports a person sent, except ones closed as not planned (a mistake or a fake).
const allWorks = async (...a) => (await allIssues(...a))
  .filter((i) => isWorksReport(i) && i.state_reason !== 'not_planned')
  .map((i) => ({ ...parseReport(i), number: i.number, author: i.user && i.user.login }));

async function ensureLabels(github, owner, repo) {
  for (const l of Object.values(LABELS)) {
    await github.rest.issues.createLabel({ owner, repo, ...l }).catch(() => {}); // already there
  }
}

async function updateBoard(github, owner, repo, issues) {
  const reports = issues.map((i) => ({
    ...parseReport(i),
    number: i.number,
    state: i.state,
    author: i.user && i.user.login,
    votes: (i.reactions && i.reactions['+1']) || 0,
    good: (i.labels || []).some((l) => l.name === LABELS.good.name),
    duplicate: (i.labels || []).some((l) => l.name === LABELS.duplicate.name) || i.state_reason === 'duplicate',
    cantSupport: (i.labels || []).some((l) => l.name === LABELS.cant.name),
    works: (i.labels || []).some((l) => l.name === LABELS.works.name),
    supported: (i.labels || []).some((l) => l.name === LABELS.supported.name),
  }));
  const body = boardBody(reports, await allWorks(github, owner, repo));
  const boards = await github.paginate(github.rest.issues.listForRepo, { owner, repo, labels: BOARD_LABEL, state: 'all', per_page: 100 });
  const board = boards.find((i) => i.title === BOARD_TITLE);
  if (board) {
    if (board.body !== body) await github.rest.issues.update({ owner, repo, issue_number: board.number, body, state: 'open' });
  } else {
    await github.rest.issues.create({ owner, repo, title: BOARD_TITLE, body, labels: [BOARD_LABEL] });
  }
}

async function run({ github, context }) {
  const { owner, repo } = context.repo;
  await ensureLabels(github, owner, repo);
  const issues = await allDeviceIssues(github, owner, repo);
  const issue = context.payload.issue;

  if (context.eventName === 'issues' && context.payload.action === 'opened' && issue && isDeviceReport(issue)) {
    const latest = await github.rest.repos.getLatestRelease({ owner, repo }).then((r) => r.data.tag_name, () => null);
    const others = issues.filter((i) => i.number < issue.number).map((i) => ({
      ...parseReport(i), number: i.number, state: i.state,
      duplicate: (i.labels || []).some((l) => l.name === LABELS.duplicate.name) || i.state_reason === 'duplicate',
      cantSupport: (i.labels || []).some((l) => l.name === LABELS.cant.name),
      supported: (i.labels || []).some((l) => l.name === LABELS.supported.name),
    }));
    const action = decide(parseReport(issue), others, latest);
    const n = { owner, repo, issue_number: issue.number };
    if (action.labels.length) await github.rest.issues.addLabels({ ...n, labels: action.labels });
    if (action.comment) await github.rest.issues.createComment({ ...n, body: action.comment });
    if (action.close) await github.rest.issues.update({ ...n, state: 'closed', state_reason: 'not_planned' });
    const fresh = await allDeviceIssues(github, owner, repo);
    await updateBoard(github, owner, repo, fresh);
    return;
  }
  await updateBoard(github, owner, repo, issues);
}

module.exports = { run, parseReport, hardwareOf, decide, boardBody, cleanName, isOlder, isDeviceReport, isWorksReport };
