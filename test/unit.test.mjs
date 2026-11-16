import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETTINGS, GROUPS, SHOW_SAFE, BY_CODE, isResettable } from '../public/lib/catalogue.js';
import { encode, decode, normalise, CODE_RE } from '../public/lib/code.js';
import { solidPng, solidPngBase64 } from '../public/lib/png.js';
import { applyScript, captureScript, restoreRunner } from '../public/lib/script.js';
import worker, { wantsScript } from '../src/worker.js';

const OPS = new Set(['w', 'd', 'wif', 'wall', 'dark', 'menubar', 'alert', 'awake']);

function valuesOf(s) {
  switch (s.kind) {
    case 'bool': return ['0', '1'];
    case 'flag': return ['1'];
    case 'choice': return s.options.map((o) => o.v);
    case 'range': return [String(s.range.min), String(s.range.max), String(s.range.min + s.range.step)];
    case 'color': return ['000000', 'a1b2c3'];
    case 'corners': return ['0000', '2345', 'abce'];
    default: return [];
  }
}

// Deterministic pseudo-random profiles.
function* profiles(n) {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < n; i++) {
    const p = rnd() < 0.5 ? { rs: '1' } : {};
    for (const s of SETTINGS) if (rnd() < 0.5) { const v = valuesOf(s); p[s.code] = v[Math.floor(rnd() * v.length)]; }
    yield p;
  }
}

test('catalogue: codes are unique two-letter keys and groups exist', () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  const seen = new Set();
  for (const s of SETTINGS) {
    assert.match(s.code, /^[a-z]{2}$/, s.code);
    assert.notEqual(s.code, 'rs');
    assert.ok(!seen.has(s.code), `duplicate ${s.code}`);
    seen.add(s.code);
    assert.ok(groups.has(s.group), `${s.code} has unknown group ${s.group}`);
    assert.ok(Array.isArray(s.refresh), `${s.code} refresh`);
    if (s.reset === 'delete') assert.equal(typeof s.resetOps, 'function', `${s.code} resetOps`);
    if (s.def != null) assert.equal(normalise(s, s.def), s.def, `${s.code} default is a valid value`);
  }
});

test('catalogue: every value of every setting yields known operations', () => {
  for (const s of SETTINGS) {
    for (const v of valuesOf(s)) {
      assert.equal(normalise(s, v), v, `${s.code}=${v} normalises to itself`);
      for (const op of s.apply(v)) {
        assert.ok(OPS.has(op[0]), `${s.code}: op ${op[0]}`);
        if (op[0] === 'w' || op[0] === 'wif') {
          assert.ok(['bool', 'int', 'float', 'string'].includes(op[4]), `${s.code}: type ${op[4]}`);
          assert.match(op[2], /^[A-Za-z0-9._-]+$/, 'domain');
          assert.match(op[3], /^[A-Za-z0-9._-]+$/, 'key');
          if (op[4] === 'float' || op[4] === 'int') assert.ok(Number.isFinite(Number(op[5])), `${s.code} ${op[3]} numeric`);
        }
      }
    }
  }
});

test('catalogue: show-safety settings are never reset; the show-safe pack is valid', () => {
  for (const s of SETTINGS.filter((x) => x.group === 'show')) assert.equal(isResettable(s), false, s.code);
  for (const [k, v] of Object.entries(SHOW_SAFE)) assert.equal(normalise(BY_CODE[k], v), v, `SHOW_SAFE.${k}`);
});

test('code: encode/decode round-trips and never needs quoting', () => {
  for (const p of profiles(200)) {
    const code = encode(p);
    if (code) assert.match(code, CODE_RE);
    assert.match(code, /^[A-Za-z0-9.]*$/);
    const back = decode(code);
    assert.deepEqual(back.problems, []);
    assert.equal(encode(back.profile), code);
  }
});

test('code: normalising captured and hand-typed values', () => {
  assert.equal(normalise(BY_CODE.ts, '153'), '155');
  assert.equal(normalise(BY_CODE.ts, '999'), '300');
  assert.equal(normalise(BY_CODE.kr, '5'), '6');
  assert.equal(normalise(BY_CODE.kd, '200'), '120');
  assert.equal(normalise(BY_CODE.hc, '1111'), '0000');
  assert.equal(normalise(BY_CODE.hc, '0f00'), null);
  assert.equal(normalise(BY_CODE.wp, 'ABCDEF'), 'abcdef');
  assert.equal(normalise(BY_CODE.tc, '2'), null);
  const d = decode('/rs1.zz1.tc9.dpl.sh');
  assert.equal(d.profile.dp, 'l');
  assert.equal(d.profile.rs, '1');
  assert.equal(d.problems.length, 2);
});

test('png: a valid 16×16 image of the colour asked for', () => {
  const png = solidPng('112233');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer);
  assert.equal(view.getUint32(16), 16);
  assert.equal(view.getUint32(20), 16);
  const idatLen = view.getUint32(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, 16 * (1 + 48));
  assert.deepEqual([...raw.subarray(1, 4)], [0x11, 0x22, 0x33]);
  assert.match(solidPngBase64('000000'), /^[A-Za-z0-9+/]+=*$/);
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'mymac-png-'));
    try {
      writeFileSync(join(dir, 'x.png'), png);
      const r = spawnSync('sips', ['-g', 'pixelWidth', join(dir, 'x.png')], { encoding: 'utf8' });
      assert.match(r.stdout, /pixelWidth: 16/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function bashSyntax(text) {
  const dir = mkdtempSync(join(tmpdir(), 'mymac-sh-'));
  try {
    writeFileSync(join(dir, 's.sh'), text);
    return spawnSync('/bin/bash', ['-n', join(dir, 's.sh')], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scripts: every generated script is valid bash 3.2', () => {
  for (const p of profiles(40)) {
    const r = bashSyntax(applyScript(p, { origin: 'https://x.test' }));
    assert.equal(r.status, 0, r.stderr);
  }
  for (const s of [captureScript({ origin: 'https://x.test' }), restoreRunner()]) {
    const r = bashSyntax(s);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('scripts: refuse root and wrap everything in main', () => {
  const s = applyScript({ tc: '1' });
  assert.match(s, /if \[ "\$\(id -u\)" = 0 \]; then/);
  assert.match(s.trimEnd(), /\nmain "\$@"$/);
  assert.match(captureScript().trimEnd(), /\nmain "\$@"$/);
});

// ── Worker ───────────────────────────────────────────────────────────────────────────
const assets = { fetch: async (req) => new Response(`ASSET ${new URL(req.url).pathname}`) };
const get = (path, headers = {}) => worker.fetch(new Request(`https://mymac.test${path}`, { headers }), { ASSETS: assets });
const CURL = { 'user-agent': 'curl/8.7.1', accept: '*/*' };
const BROWSER = { 'user-agent': 'Mozilla/5.0', accept: 'text/html,application/xhtml+xml' };

test('worker: curl gets scripts, browsers get the builder', async () => {
  let r = await get('/rs1.tc1.dpl', CURL);
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.match(await r.text(), /^#!\/bin\/bash\n# mymac/);
  r = await get('/rs1.tc1.dpl', BROWSER);
  assert.equal(await r.text(), 'ASSET /');
  r = await get('/tc1.sh', BROWSER);
  assert.match(await r.text(), /^#!\/bin\/bash/);
  r = await get('/capture', CURL);
  assert.match(await r.text(), /capture: reads this Mac/);
  r = await get('/restore', CURL);
  assert.match(await r.text(), /restore\.sh/);
  r = await get('/style.css', BROWSER);
  assert.equal(await r.text(), 'ASSET /style.css');
  assert.equal(wantsScript(new Request('https://x/a', { headers: { 'user-agent': 'Wget/1.21' } }), 'a'), true);
});

test('worker: errors reach a curl user as a message, and a path cannot inject commands', async () => {
  let r = await get('/tc9', CURL);
  let body = await r.text();
  assert.match(body, /bad value "9" for Tap to click/);
  r = await get('/nothing$(touch%20pwned)here', CURL);
  body = await r.text();
  const run = spawnSync('/bin/bash', ['-c', body], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /nothing at \/nothing\$\(touch%20pwned\)here/);
  r = await worker.fetch(new Request('https://mymac.test/tc1', { method: 'POST' }), { ASSETS: assets });
  assert.equal(r.status, 405);
});
