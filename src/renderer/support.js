// Runs the check and sends reports: the Help panel in Settings, and the Send device report button
// that appears when a device keeps failing.
// Text from the check goes through textContent like everywhere else.
const supportRun = document.getElementById('support-run-btn');
const supportResults = document.getElementById('support-results');
const CHECK_ICONS = { ok: 'checkOk', warn: 'checkWarn', fail: 'checkFail' };
const SCANS_BEFORE_REPORT = 2;
const FRAMES_TO_KEEP = 40;
const PRIVACY_NOTE = 'You need a free GitHub account. Issues are public, so your user name, device serials and Bluetooth details are left out.';
const SEND_NOTE = `Opens GitHub with the report filled in. Nothing is posted until you submit it there. ${PRIVACY_NOTE}`;
const SENT_NOTE = `Your browser opened with the report filled in. Nothing is posted until you submit it there. ${PRIVACY_NOTE}`;
const LONG_NOTE = ' This report is too long for a link, so the full version is also copied for you to paste in.';
const plainError = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const scanHistory = new Map(); // device id -> { scans, frames }, for this run of the app

// keepEnglish marks text that must read exactly as it is sent (the report): the translator skips it.
function supportText(tag, className, text, keepEnglish) {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  if (keepEnglish) el.dataset.noTranslate = '';
  return el;
}

function renderCheck(item) {
  const row = document.createElement('div');
  row.className = 'check-row';
  row.dataset.status = item.status;
  const icon = document.createElement('span');
  icon.className = 'check-icon';
  icon.innerHTML = iconSvg(CHECK_ICONS[item.status], 18);
  const body = document.createElement('div');
  body.className = 'check-body';
  body.append(supportText('div', 'check-title', item.title), supportText('div', 'check-detail', item.detail));
  if (item.fix) body.append(supportText('div', 'check-fix', item.fix));
  row.append(icon, body);
  return row;
}

function copyButton(report) {
  const copy = document.createElement('button');
  copy.className = 'btn btn-ghost';
  copy.textContent = 'Copy report';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(report);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy report'; }, 1500);
  });
  return copy;
}

async function openReport(result, note) {
  try {
    if (!result.complete) await navigator.clipboard.writeText(result.report);
    await window.batteryHub.openExternal(result.url);
  } catch (_) {
    note.textContent = 'Your browser didn\'t open. Use Copy report and paste it into a new issue on GitHub.';
  }
}

// Sending without a GitHub account goes through the project's relay (main/relay.js). The button
// only shows when this version has one.
const relayReady = window.batteryHub.relayAvailable().catch(() => false);
const DIRECT_NOTE = 'No GitHub account? Send it from here instead: the replies show up in Settings → Help → Your reports, and you can answer them there.';

// A "Send without a GitHub account" button for a report. extra() adds fields at send time (the
// support request's description). onSent(number) runs after it went through.
function directButton(result, note, onSent, extra = () => ({})) {
  const direct = document.createElement('button');
  direct.className = 'btn btn-ghost';
  direct.textContent = 'Send without a GitHub account';
  direct.hidden = true;
  relayReady.then((ready) => { direct.hidden = !ready || !result.form; });
  direct.addEventListener('click', async () => {
    direct.disabled = true;
    direct.textContent = 'Sending…';
    try {
      const form = { ...result.form, fields: { ...result.form.fields, ...extra() } };
      const sent = await window.batteryHub.sendDirect(form, result.hardware || null);
      direct.textContent = 'Sent';
      note.textContent = `Sent as report #${sent.number}. Replies show up in Settings → Help → Your reports, and you'll get a notification.`;
      showMyReportsRow();
      if (onSent) onSent(sent.number);
    } catch (e) {
      direct.disabled = false;
      direct.textContent = 'Send without a GitHub account';
      note.textContent = `It couldn't be sent: ${plainError(e)}`;
    }
  });
  return direct;
}

function checkActions(...buttons) {
  const actions = document.createElement('div');
  actions.className = 'check-actions';
  actions.append(...buttons);
  return actions;
}

function renderResults(result, target = supportResults, sendLabel = 'Send support request') {
  const verdict = document.createElement('div');
  verdict.className = 'check-verdict';
  verdict.dataset.tone = result.verdict.tone;
  verdict.append(supportText('div', 'check-verdict-title', result.verdict.title), supportText('div', 'check-detail', result.verdict.detail));

  const list = document.createElement('div');
  list.className = 'check-list';
  list.append(...result.checks.map(renderCheck));

  const preview = document.createElement('details');
  preview.className = 'check-report';
  preview.append(
    supportText('summary', '', 'See exactly what the report contains'),
    supportText('pre', '', result.report, true),
  );

  const note = supportText('div', 'check-note', result.complete ? SEND_NOTE : SEND_NOTE + LONG_NOTE);
  const send = document.createElement('button');
  send.className = 'btn btn-primary';
  send.textContent = sendLabel;
  send.addEventListener('click', () => openReport(result, note));
  // A support request sent from here has no GitHub form to describe the problem in, so it's asked here.
  const problem = document.createElement('textarea');
  problem.className = 'report-problem';
  problem.placeholder = 'What went wrong? (for sending without an account)';
  problem.hidden = true;
  relayReady.then((ready) => { problem.hidden = !ready || !result.form || result.form.template !== 'support-request.yml'; });
  const direct = directButton(result, note, null, () => (problem.value.trim() ? { problem: problem.value.trim() } : {}));
  const directNote = supportText('div', 'check-note', DIRECT_NOTE);
  directNote.hidden = true;
  relayReady.then((ready) => { directNote.hidden = !ready || !result.form; });

  target.replaceChildren(verdict, list, preview, problem, checkActions(copyButton(result.report), send, direct), note, directNote);
  target.hidden = false;
}

// Shown instead of sending when a new report wouldn't help. Each says what to do instead.
function renderGate(gate, result, request, button, target) {
  const parts = [];
  if (gate.kind === 'outdated') {
    const update = document.createElement('button');
    update.className = 'btn btn-primary';
    update.textContent = 'Check for updates';
    update.addEventListener('click', () => window.batteryHub.checkForUpdates());
    parts.push(
      supportText('div', 'step-title', 'Update first'),
      supportText('div', 'check-detail', `${gate.detail} This problem may already be fixed. Update, then scan again.`),
      checkActions(update),
    );
  } else if (gate.kind === 'known') {
    const open = document.createElement('button');
    open.className = 'btn btn-primary';
    open.textContent = `Open report #${gate.number}`;
    const note = supportText('div', 'check-note', 'Your report is copied. Paste it there as a comment, and add a 👍 to the issue: that helps more than a new report.');
    open.addEventListener('click', async () => {
      await navigator.clipboard.writeText(result.report).catch(() => {});
      await window.batteryHub.openExternal(gate.url).catch(() => {});
      if (result.hardware) window.batteryHub.markReported(result.hardware);
    });
    parts.push(
      supportText('div', 'step-title', 'This device was already reported'),
      supportText('div', 'check-detail', gate.state === 'open'
        ? `Someone with the same device opened report #${gate.number}. Add yours to it instead of starting a new one.`
        : `This device was looked at in report #${gate.number}, which has the answer. Add yours there if something changed.`),
      checkActions(open, copyButton(result.report)),
      note,
    );
  } else if (gate.kind === 'sent') {
    const find = document.createElement('button');
    find.className = 'btn btn-primary';
    find.textContent = 'Find my report';
    find.addEventListener('click', () => window.batteryHub.openExternal(gate.url).catch(() => {}));
    const notSent = document.createElement('button');
    notSent.className = 'btn btn-ghost';
    notSent.textContent = "I didn't send it";
    notSent.addEventListener('click', () => sendDeviceReport(button, { ...request, notSent: true }, target));
    parts.push(
      supportText('div', 'step-title', 'You already reported this device'),
      supportText('div', 'check-detail', `Battery Hub opened a report on it ${new Date(gate.sentAt).toLocaleDateString()}. Add anything new as a comment there.`),
      checkActions(find, notSent),
    );
  }
  target.replaceChildren(...parts);
}

async function sendDeviceReport(button, request, target) {
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const result = await window.batteryHub.deviceReport(request);
    if (result.gate) {
      renderGate(result.gate, result, request, button, target);
    } else if (result.verdict.tone === 'bad') {
      // The fault looks to be on their end, so show them the fix before anything else.
      renderResults(result, target, 'Send anyway');
    } else if (await relayReady) {
      // Two ways to send: on GitHub, or from here for someone without an account.
      const note = supportText('div', 'check-note', result.complete ? SEND_NOTE : SEND_NOTE + LONG_NOTE);
      const onGitHub = document.createElement('button');
      onGitHub.className = 'btn btn-primary';
      onGitHub.textContent = 'Send on GitHub';
      onGitHub.addEventListener('click', async () => {
        await openReport(result, note);
        if (result.hardware) window.batteryHub.markReported(result.hardware);
      });
      const direct = directButton(result, note, () => { if (result.hardware) window.batteryHub.markReported(result.hardware); });
      target.replaceChildren(checkActions(onGitHub, direct, copyButton(result.report)), note, supportText('div', 'check-note', DIRECT_NOTE));
    } else {
      const note = supportText('div', 'check-note', result.complete ? SENT_NOTE : SENT_NOTE + LONG_NOTE);
      target.replaceChildren(note, checkActions(copyButton(result.report)));
      await openReport(result, note);
      if (result.hardware) window.batteryHub.markReported(result.hardware);
    }
  } catch (e) {
    target.replaceChildren(supportText('div', 'check-detail', `The report couldn't be made: ${plainError(e)}`));
  } finally {
    button.textContent = 'Send device report';
    button.disabled = !button.dataset.ready;
    target.scrollIntoView({ block: 'nearest' });
  }
}

// A scan that caught nothing usually means the device was asleep, so say how to get a better one.
const EMPTY_SCAN_TIPS = 'Before sending: make sure the device is on and awake, and turn it off and on while the scan runs. If it also has Bluetooth, try that: Battery Hub reads Bluetooth batteries.';

function deviceReportCard(request) {
  const card = document.createElement('div');
  card.className = 'step-card';
  const button = document.createElement('button');
  button.className = 'btn btn-primary';
  button.textContent = 'Send device report';
  button.disabled = true;
  // The real level is what turns captured bytes into a battery reading, so it's asked for first.
  const level = document.createElement('input');
  level.className = 'text-input';
  level.type = 'text';
  level.maxLength = 40;
  level.placeholder = 'Real battery level, e.g. 62% (or "don\'t know")';
  level.setAttribute('aria-label', 'Real battery level');
  level.addEventListener('input', () => {
    button.dataset.ready = level.value.trim() ? '1' : '';
    button.disabled = !button.dataset.ready;
  });
  const result = document.createElement('div');
  result.className = 'device-report-result';
  button.addEventListener('click', () => sendDeviceReport(button, { ...request, actual: level.value }, result));
  const scans = request.scans || [];
  const empty = scans.length && scans.every((x) => !x.captured);
  card.append(
    supportText('div', 'step-title', 'Still not working?'),
    supportText('div', 'step-desc', 'Send a report on this device and we\'ll take a look. What does the device or its own app say the battery is at?'),
    ...(empty ? [supportText('div', 'check-fix', EMPTY_SCAN_TIPS)] : []),
    level,
    button,
    result,
  );
  return card;
}

function offerScanReport(device) {
  const history = scanHistory.get(device.id);
  if (!history || history.scans.length < SCANS_BEFORE_REPORT) return;
  const { id, product, manufacturer } = device;
  document.getElementById('scan-report').replaceChildren(deviceReportCard({ id, product, manufacturer, ...history }));
}

function noteScan(device, frames, error) {
  const history = scanHistory.get(device.id) || { scans: [], frames: [] };
  history.scans.push({ captured: frames.length, error });
  if (frames.length) history.frames = frames.slice(0, FRAMES_TO_KEEP);
  scanHistory.set(device.id, history);
  offerScanReport(device);
}

// Called on every update of the detail panel, so it only touches the card when the answer changes
// and a report in progress stays on screen.
function offerReadReport(dev) {
  const slot = document.getElementById('detail-report');
  const wanted = dev.failedReads >= READS_BEFORE_REPORT ? dev.id : '';
  if (slot.dataset.device === wanted) return;
  slot.dataset.device = wanted;
  const { id, product, manufacturer, driverId, lastError, failedReads } = dev;
  slot.replaceChildren(...(wanted ? [deviceReportCard({ id, product, manufacturer, driverId, lastError, failedReads })] : []));
}

// A device set up with the scan that reads fine gets a card asking if the level is right. A yes
// opens a filled-in "It works" form: that's how working devices become known, since the app
// sends nothing by itself. Shown once per device.
let confirmedDevices = null;
const isWorking = (dev) => dev.driverId === 'generic' && dev.profile && !dev.failedReads && !isOffline(dev)
  && dev.lastReading && Number.isFinite(dev.lastReading.capacity);

async function offerWorksReport(dev) {
  const slot = document.getElementById('detail-works');
  if (!confirmedDevices) {
    confirmedDevices = (await window.batteryHub.getSettings().catch(() => ({}))).confirmedDevices || {};
  }
  const wanted = isWorking(dev) && !confirmedDevices[dev.id] ? dev.id : '';
  if (slot.dataset.device === wanted) return;
  slot.dataset.device = wanted;
  if (!wanted) { slot.replaceChildren(); return; }
  const card = document.createElement('div');
  card.className = 'step-card';
  const yes = document.createElement('button');
  yes.className = 'btn btn-primary';
  yes.textContent = 'It works! Let the developer know';
  const note = supportText('div', 'check-note', `Opens GitHub with the device filled in, so it can be listed and built in for everyone. Nothing is posted until you submit it there. ${PRIVACY_NOTE}`);
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      const result = await window.batteryHub.worksReport(dev.id);
      confirmedDevices[dev.id] = Date.now();
      await window.batteryHub.openExternal(result.url);
      card.replaceChildren(supportText('div', 'step-title', 'Thank you!'), supportText('div', 'check-note', 'Your browser opened the form. Submit it there to add this device to the list.'));
    } catch (e) {
      yes.disabled = false;
      note.textContent = `The form couldn't be opened: ${plainError(e)}`;
    }
  });
  // Without an account: the same report, sent from here.
  const direct = document.createElement('button');
  direct.className = 'btn btn-ghost';
  direct.textContent = 'Send without a GitHub account';
  direct.hidden = true;
  relayReady.then((ready) => { direct.hidden = !ready; });
  direct.addEventListener('click', async () => {
    direct.disabled = true;
    try {
      const result = await window.batteryHub.worksReport(dev.id);
      confirmedDevices[dev.id] = Date.now();
      const sent = await window.batteryHub.sendDirect(result.form, result.hardware || null);
      showMyReportsRow();
      card.replaceChildren(supportText('div', 'step-title', 'Thank you!'), supportText('div', 'check-note', `Sent as report #${sent.number}. The device will be added to the list.`));
    } catch (e) {
      direct.disabled = false;
      note.textContent = `It couldn't be sent: ${plainError(e)}`;
    }
  });
  card.append(
    supportText('div', 'step-title', 'Is this battery level right?'),
    supportText('div', 'step-desc', 'If it matches what the device or its own app shows, tell us it works.'),
    checkActions(yes, direct),
    note,
  );
  slot.replaceChildren(card);
}

supportRun.addEventListener('click', async () => {
  supportRun.disabled = true;
  supportRun.textContent = 'Checking…';
  try {
    renderResults(await window.batteryHub.runSupportCheck());
  } catch (e) {
    supportResults.replaceChildren(supportText('div', 'check-detail', `The check couldn't finish: ${plainError(e)}`));
    supportResults.hidden = false;
  } finally {
    supportRun.disabled = false;
    supportRun.textContent = 'Run again';
  }
});

// ---------- your reports (sent without a GitHub account) ----------
const myReportsRow = document.getElementById('my-reports-row');
const myReportsBtn = document.getElementById('my-reports-btn');
const myReports = document.getElementById('my-reports');

function showMyReportsRow() { myReportsRow.hidden = false; }
window.batteryHub.getSettings()
  .then((saved) => { if ((saved.sentReports || []).length) relayReady.then((ready) => { if (ready) showMyReportsRow(); }); })
  .catch(() => {});

function replyBox(report) {
  const box = document.createElement('textarea');
  box.className = 'report-problem';
  box.placeholder = 'Answer here';
  const send = document.createElement('button');
  send.className = 'btn btn-primary';
  send.textContent = 'Send answer';
  const note = supportText('div', 'check-note', '');
  send.addEventListener('click', async () => {
    if (!box.value.trim()) return;
    send.disabled = true;
    try {
      await window.batteryHub.replyToReport(report.number, box.value.trim());
      await loadMyReports();
    } catch (e) {
      send.disabled = false;
      note.textContent = `It couldn't be sent: ${plainError(e)}`;
    }
  });
  return [box, checkActions(send), note];
}

function reportView(report) {
  const card = document.createElement('div');
  card.className = 'step-card';
  const open = document.createElement('button');
  open.className = 'btn btn-ghost';
  open.textContent = 'Open on GitHub';
  open.addEventListener('click', () => window.batteryHub.openExternal(report.url).catch(() => {}));
  card.append(supportText('div', 'step-title', `#${report.number} ${report.title}`, true));
  if (!report.replies) card.append(supportText('div', 'check-detail', "The replies couldn't be loaded right now."));
  else if (!report.replies.length) card.append(supportText('div', 'check-detail', 'No replies yet. You will get a notification when there is one.'));
  for (const r of report.replies || []) {
    const reply = document.createElement('div');
    reply.className = 'report-reply';
    reply.append(supportText('div', 'check-verdict-title', r.mine ? 'You' : r.author, !r.mine), supportText('div', 'check-detail', r.body, true));
    card.append(reply);
  }
  card.append(...replyBox(report), checkActions(open));
  return card;
}

async function loadMyReports() {
  myReportsBtn.disabled = true;
  try {
    const list = await window.batteryHub.myReports();
    myReports.replaceChildren(...(list.length ? list.map(reportView) : [supportText('div', 'check-detail', 'No reports sent from here yet.')]));
    myReports.hidden = false;
  } catch (e) {
    myReports.replaceChildren(supportText('div', 'check-detail', `Your reports couldn't be loaded: ${plainError(e)}`));
    myReports.hidden = false;
  } finally {
    myReportsBtn.disabled = false;
    myReportsBtn.textContent = 'Refresh';
  }
}

myReportsBtn.addEventListener('click', loadMyReports);
// The notification for a new reply opens the window here.
window.batteryHub.onShowMyReports(() => {
  showMyReportsRow();
  if (typeof switchView === 'function') switchView('settings');
  loadMyReports().then(() => myReportsRow.scrollIntoView({ block: 'start' }));
});
