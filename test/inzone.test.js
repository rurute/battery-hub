// SONY INZONE Buds over its USB dongle, checked against the reply captured on real hardware in
// fork Issue #3.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-hid') return {};
  return load.call(this, request, ...rest);
};
const inzone = require('../src/main/hid/drivers/inzone');
Module._load = load;

// Ears in, TID 1: left 99, right 99, case 96.
const REPLY = [0x02, 0x12, 0x04, 0xff, 0x0f, 0x00, 0x96, 0xc3, 0x14, 0x04, 0x10, 0x01, 0x00, 0x00, 0x63, 0x00, 0x63, 0xff, 0x60, 0xa7];
const withSum = (f) => { const g = f.slice(); g[19] = g.slice(5, 19).reduce((a, b) => a + b, 0) & 0xff; return g; };

test('inzone: the battery request for TID 1 matches the capture', () => {
  const r = inzone.request(1);
  assert.equal(r.length, 64);
  assert.deepEqual(r.slice(0, 14), [0x02, 0x0c, 0x01, 0x00, 0xfc, 0x08, 0x96, 0xc3, 0x41, 0x04, 0x01, 0x01, 0x00, 0xa0]);
  assert.ok(r.slice(14).every((b) => b === 0));
});

test('inzone: the TID goes in little-endian and changes the checksum', () => {
  const r = inzone.request(0x4001);
  assert.deepEqual(r.slice(11, 14), [0x01, 0x40, (0x96 + 0xc3 + 0x41 + 0x04 + 0x01 + 0x01 + 0x40) & 0xff]);
});

test('inzone: the captured reply reads left 99, right 99, case 96', () => {
  assert.deepEqual(inzone.parseReply(REPLY, 1), { left: 99, right: 99, case: 96 });
});

test('inzone: an unreported part is null', () => {
  const f = REPLY.slice(); f[16] = 0xff;
  assert.deepEqual(inzone.parseReply(withSum(f), 1), { left: 99, right: null, case: 96 });
});

test('inzone: a level above 100 that is not 0xFF counts as unreported', () => {
  const f = REPLY.slice(); f[14] = 0x65;
  assert.equal(inzone.parseReply(withSum(f), 1).left, null);
});

test('inzone: frames that are not our battery reply are skipped', () => {
  assert.equal(inzone.parseReply(REPLY, 2), null, 'other TID');
  const ev = REPLY.slice(); ev[9] = 0x01; assert.equal(inzone.parseReply(withSum(ev), 1), null, 'other event');
  const ty = REPLY.slice(); ty[10] = 0x20; assert.equal(inzone.parseReply(withSum(ty), 1), null, 'notification type');
  const bad = REPLY.slice(); bad[19] = 0x00; assert.equal(inzone.parseReply(bad, 1), null, 'bad checksum');
  assert.equal(inzone.parseReply(REPLY.slice(0, 19), 1), null, 'short frame');
  const id = REPLY.slice(); id[0] = 0x07; assert.equal(inzone.parseReply(id, 1), null, 'other report id');
});

test('inzone: TIDs count up from 0x4000 and wrap from 0xFFFF to 1', () => {
  inzone._resetTid();
  assert.equal(inzone.nextTid(), 0x4000);
  assert.equal(inzone.nextTid(), 0x4001);
  inzone._resetTid(0xffff);
  assert.equal(inzone.nextTid(), 0xffff);
  assert.equal(inzone.nextTid(), 1);
});
