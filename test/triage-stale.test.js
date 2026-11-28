const test = require('node:test');
const assert = require('node:assert');
const { isStale, shouldReopen, boardBody } = require('../.github/scripts/triage');

const DAY = 86400000;
const now = Date.parse('2026-12-10T00:00:00Z');
const issue = (labels, extra = {}) => ({ state: 'open', created_at: '2026-11-20T00:00:00Z', labels: labels.map((name) => ({ name })), ...extra });
const bot = (daysAgo) => ({ user: { type: 'Bot' }, author_association: 'NONE', created_at: new Date(now - daysAgo * DAY).toISOString() });
const owner = (daysAgo) => ({ user: { type: 'User' }, author_association: 'OWNER', created_at: new Date(now - daysAgo * DAY).toISOString() });
const reporter = (daysAgo) => ({ user: { type: 'User' }, author_association: 'NONE', created_at: new Date(now - daysAgo * DAY).toISOString() });

test('an issue waiting a week for its reporter closes; one the reporter answered does not', () => {
  assert.equal(isStale(issue(['needs info', 'no data']), bot(8), now), true);
  assert.equal(isStale(issue(['needs info']), owner(7), now), true);
  assert.equal(isStale(issue(['needs info']), bot(6), now), false);
  assert.equal(isStale(issue(['needs info']), reporter(30), now), false);
  assert.equal(isStale(issue(['device-support']), bot(30), now), false); // not waiting on anyone
  assert.equal(isStale(issue(['needs info', 'supported']), bot(30), now), false);
  assert.equal(isStale(issue(['old version']), undefined, now), true); // no comment at all, created long ago
});

test('a comment from the reporter reopens an issue we closed; ours and bots do not', () => {
  const closed = (labels, reason = 'not_planned') => ({ state: 'closed', state_reason: reason, labels: labels.map((name) => ({ name })) });
  assert.equal(shouldReopen(closed(['stale']), reporter(0)), true);
  assert.equal(shouldReopen(closed(['supported'], 'completed'), reporter(0)), true);
  assert.equal(shouldReopen(closed(['stale']), owner(0)), false);
  assert.equal(shouldReopen(closed(['stale']), bot(0)), false);
  assert.equal(shouldReopen(closed(['duplicate']), reporter(0)), false); // copies stay closed
  assert.equal(shouldReopen({ ...closed(['stale']), pull_request: {} }, reporter(0)), false);
  assert.equal(shouldReopen(issue(['stale']), reporter(0)), false); // already open
});

test('a request closed as stale keeps its place in the ranking', () => {
  const body = boardBody([
    { hardware: '1234:5678', name: 'Quiet Mouse', number: 300, state: 'closed', author: 'a', votes: 2, stale: true },
  ]);
  const top = body.split('<details>')[0];
  assert.match(top, /\| 3 \| Quiet Mouse \| `1234:5678` \| #300 \|/);
});
