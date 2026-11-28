// Battery Hub's report relay, a Cloudflare Worker: lets people send a device report or a support
// request from the app without a GitHub account. It opens the issue with the project's token, and
// gives the app a reply key so the same person can answer questions on it later.
//
//   POST /report   { template, fields }        -> { number, url, key }
//   POST /comment  { number, key, text }       -> { ok: true }
//
// Reading the replies needs nothing from here: GitHub's issues are public, so the app reads them
// directly. Setup is in relay/README.md.
import { buildIssue, buildComment, hashKey } from './report.mjs';

const REPO = 'battery-hub/battery-hub';
const PER_HOUR = { report: 5, comment: 20 }; // per network address
const MAX_REQUEST_BYTES = 64 * 1024;

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// Issues are opened as the project's GitHub App ("battery-hub-relay[bot]"), so a report never looks
// like the maintainer wrote it. The app's key signs a short JWT, which GitHub trades for a token that
// lasts an hour. (GITHUB_TOKEN, a plain token, also works, for testing.)
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (text) => b64url(new TextEncoder().encode(text));
let cached = null;

async function appToken(env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (cached && cached.expires > Date.now() + 60000) return cached.token;
  const pem = env.APP_PRIVATE_KEY.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify({ iat: now - 60, exp: now + 540, iss: Number(env.APP_ID) }))}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const response = await fetch(`https://api.github.com/app/installations/${env.INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${unsigned}.${b64url(signature)}`, accept: 'application/vnd.github+json', 'user-agent': 'battery-hub-relay' },
  });
  if (!response.ok) throw new Error(`github ${response.status}`);
  const data = await response.json();
  cached = { token: data.token, expires: Date.parse(data.expires_at) };
  return cached.token;
}

async function github(env, path, body) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await appToken(env)}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'battery-hub-relay',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`github ${response.status}`);
  return response.json();
}

// A rough count per address and hour, kept in KV. Not exact (KV is eventually consistent), but it
// stops a flood, which is what it is for.
async function overLimit(env, request, kind) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = `rate:${kind}:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const count = Number(await env.RELAY.get(key)) || 0;
  if (count >= PER_HOUR[kind]) return true;
  await env.RELAY.put(key, String(count + 1), { expirationTtl: 7200 });
  return false;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) throw new Error('report too long');
  try { return JSON.parse(text); } catch (e) { throw new Error('bad request'); }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method !== 'POST') return json(405, { error: 'POST only' });
    try {
      if (pathname === '/report') {
        const issue = buildIssue(await readJson(request));
        if (await overLimit(env, request, 'report')) return json(429, { error: 'too many reports from this network, try again in an hour' });
        const created = await github(env, '/issues', issue);
        const key = crypto.randomUUID();
        await env.RELAY.put(`key:${created.number}`, await hashKey(key));
        return json(200, { number: created.number, url: created.html_url, key });
      }
      if (pathname === '/comment') {
        const input = await readJson(request);
        const number = Number(input.number);
        const stored = Number.isInteger(number) ? await env.RELAY.get(`key:${number}`) : null;
        if (!stored || stored !== await hashKey(input.key)) return json(403, { error: 'not your report' });
        const body = buildComment(input.text);
        if (await overLimit(env, request, 'comment')) return json(429, { error: 'too many replies from this network, try again in an hour' });
        await github(env, `/issues/${number}/comments`, { body });
        return json(200, { ok: true });
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      const known = /^(bad request|unknown report type|bad title|report too long|empty report|empty reply)$/.test(e.message);
      return json(known ? 400 : 502, { error: known ? e.message : 'could not reach GitHub, try again later' });
    }
  },
};
