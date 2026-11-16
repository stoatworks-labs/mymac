// Runs the generated scripts for real, against a sandbox: test doubles for defaults, osascript,
// killall, activateSettings and caffeinate (test/shims) that act on copies of the preference
// files. Nothing on the Mac running the tests is written; seeding only exports (reads) domains.
//
// macOS only (it needs /usr/bin/defaults and plutil).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../public/lib/catalogue.js';
import { decode, encode } from '../public/lib/code.js';
import { applyScript, captureScript } from '../public/lib/script.js';

const here = dirname(fileURLToPath(import.meta.url));
const shims = join(here, 'shims');
const skip = process.platform !== 'darwin' && 'needs macOS';

// Every value a setting can take, for collecting the domains it touches.
function values(s) {
  switch (s.kind) {
    case 'bool': return ['0', '1'];
    case 'flag': return ['1'];
    case 'choice': return s.options.map((o) => o.v);
    case 'range': return [String(s.range.min), String(s.range.max)];
    case 'color': return ['000000'];
    case 'corners': return ['0000'];
    default: return [];
  }
}

function domains() {
  const set = new Set();
  for (const s of SETTINGS) {
    for (const v of values(s)) {
      for (const op of s.apply(v)) if (['w', 'd', 'wif'].includes(op[0])) set.add(`${op[1]}|${op[2]}`);
    }
    if (s.resetOps) for (const op of s.resetOps()) set.add(`${op[1]}|${op[2]}`);
  }
  set.add('0|NSGlobalDomain'); // appearance and menu bar read it
  return [...set].map((x) => { const [h, d] = x.split('|'); return { host: h === '1', domain: d }; });
}

const prefFile = (sb, { host, domain }) => join(sb, 'prefs', ...(host ? ['ByHost'] : []), `${domain}.plist`);

function makeSandbox(seed) {
  const sb = mkdtempSync(join(tmpdir(), 'mymac-test-'));
  for (const p of ['prefs/ByHost', 'state', 'home/Library/Application Support/com.apple.wallpaper/Store']) {
    mkdirSync(join(sb, p), { recursive: true });
  }
  writeFileSync(join(sb, 'log'), '');
  writeFileSync(join(sb, 'state', 'alert'), '75\n');
  writeFileSync(join(sb, 'state', 'wallpaper'), '/System/Library/Desktop Pictures/Original.heic\n');
  writeFileSync(join(sb, 'home/Library/Application Support/com.apple.wallpaper/Store/Index.plist'), 'ORIGINAL\n');
  if (seed === 'real') {
    for (const d of domains()) {
      const args = [...(d.host ? ['-currentHost'] : []), 'export', d.domain, prefFile(sb, d)];
      spawnSync('/usr/bin/defaults', args, { stdio: 'ignore' }); // read-only on this Mac
    }
  } else if (typeof seed === 'function') {
    seed(sb);
  }
  return sb;
}

function sh(sb, script, args = []) {
  const file = join(sb, `run-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, script);
  const r = spawnSync('/bin/bash', [file, ...args], {
    env: { PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: join(sb, 'home'), MYMAC_SB: sb, LANG: 'en_GB.UTF-8' },
    encoding: 'utf8',
    timeout: 240_000,
  });
  return r;
}

function canon(file) {
  return spawnSync('python3', ['-I', join(here, 'plistcanon.py'), file], { encoding: 'utf8' }).stdout.trim();
}

function prefsState(sb) {
  const out = {};
  for (const d of domains()) out[`${d.host ? 'host:' : ''}${d.domain}`] = canon(prefFile(sb, d));
  return out;
}

function read(sb, host, domain, key) {
  const r = spawnSync('/usr/bin/defaults', ['read', prefFile(sb, { host, domain }), key], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A profile that sets every setting to something other than the macOS default where it can.
const FULL = [
  'rs1', 'tc1', 'ns0', 'ts150', 'rcr', 'td1', 'fc0', 'cp2', 'ms50', 'cs150', 'sk0',
  'dpl', 'da1', 'di1', 'dz40', 'dm1', 'dl96', 'dr0', 'des', 'dw1', 'dx1', 'db0', 'dn0',
  'mh1', 'ck1', 'hr1', 'wp112233', 'apd', 'sbl', 'kr2', 'kd15', 'ph0', 'fn1', 'ac0', 'ak0',
  'sq0', 'pd0', 'dk0', 'ex1', 'hf1', 'pb1', 'su1', 'fvn', 'cws', 'sm1', 'tg0', 'mr0', 'sp0',
  'sw0', 'mc0', 'nc0', 'lp0', 'bk0', 'hc2a4e', 'ss0', 'ka1', 'as1', 'ar0', 'cn1',
].join('.');

test('the FULL profile names every setting', () => {
  const { profile, problems } = decode(FULL);
  assert.deepEqual(problems, []);
  for (const s of SETTINGS) assert.ok(profile[s.code] != null, `FULL is missing ${s.code}`);
});

test('apply, apply again, restore: every preference comes back exactly', { skip, timeout: 600_000 }, () => {
  const sb = makeSandbox('real');
  try {
    const before = prefsState(sb);

    const r1 = sh(sb, applyScript(decode(FULL).profile, { origin: 'https://mymac.test' }));
    assert.equal(r1.status, 0, r1.stderr + r1.stdout);
    assert.match(r1.stdout, /When you leave: {2}bash ~\/\.mymac\/restore\.sh/);
    assert.ok(existsSync(join(sb, 'home/.mymac/restore.sh')));

    // A sample of the writes landed, with the types macOS uses.
    assert.equal(read(sb, false, 'com.apple.dock', 'orientation'), 'left');
    assert.equal(read(sb, false, 'com.apple.AppleMultitouchTrackpad', 'Clicking'), '1');
    assert.equal(read(sb, false, 'com.apple.AppleMultitouchTrackpad', 'TrackpadCornerSecondaryClick'), '2');
    assert.equal(read(sb, false, 'NSGlobalDomain', 'com.apple.swipescrolldirection'), '0');
    assert.equal(read(sb, true, 'com.apple.screensaver', 'idleTime'), '0');
    assert.equal(read(sb, false, 'com.apple.dock', 'wvous-tl-corner'), '2');
    assert.equal(read(sb, false, 'com.apple.dock', 'wvous-tr-corner'), '10');
    assert.equal(read(sb, false, 'com.apple.dock', 'wvous-bl-corner'), '4');
    assert.equal(read(sb, false, 'com.apple.dock', 'wvous-br-corner'), '14');
    assert.equal(read(sb, false, 'NSGlobalDomain', 'AppleInterfaceStyle'), 'Dark');
    assert.equal(read(sb, false, 'NSGlobalDomain', '_HIHideMenuBar'), '1');
    assert.equal(readFileSync(join(sb, 'state/alert'), 'utf8').trim(), '0');
    assert.match(readFileSync(join(sb, 'state/wallpaper'), 'utf8'), /wallpaper-112233\.png/);
    const png = readFileSync(join(sb, 'state/wallpaper.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');

    const log1 = readFileSync(join(sb, 'log'), 'utf8');
    for (const k of ['killall Dock', 'killall Finder', 'killall WindowManager', 'killall ControlCenter', 'activateSettings -u']) {
      assert.ok(log1.includes(k), `apply should run ${k}`);
    }
    const pid = Number(readFileSync(join(sb, 'home/.mymac/caffeinate.pid'), 'utf8'));
    assert.ok(pidAlive(pid), 'caffeinate should be running');

    // A second run with different values must not overwrite the original snapshot.
    const r2 = sh(sb, applyScript(decode('dpr.tc0.wpff0000.ka1').profile));
    assert.equal(r2.status, 0, r2.stderr + r2.stdout);
    assert.match(r2.stdout, /keeping the snapshot/);
    assert.equal(read(sb, false, 'com.apple.dock', 'orientation'), 'right');
    assert.equal(Number(readFileSync(join(sb, 'home/.mymac/caffeinate.pid'), 'utf8')), pid, 'no second caffeinate');

    const rr = spawnSync('/bin/bash', [join(sb, 'home/.mymac/restore.sh')], {
      env: { PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: join(sb, 'home'), MYMAC_SB: sb },
      encoding: 'utf8',
    });
    assert.equal(rr.status, 0, rr.stderr + rr.stdout);
    assert.match(rr.stdout, /put back \d+ settings/);

    const after = prefsState(sb);
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} did not come back`);
    assert.equal(existsSync(join(sb, 'home/.mymac')), false, 'restore removes ~/.mymac');
    assert.equal(readFileSync(join(sb, 'state/alert'), 'utf8').trim(), '75');
    assert.equal(readFileSync(join(sb, 'home/Library/Application Support/com.apple.wallpaper/Store/Index.plist'), 'utf8'), 'ORIGINAL\n');
    assert.ok(readFileSync(join(sb, 'log'), 'utf8').includes('killall WallpaperAgent'));
    for (let i = 0; i < 20 && pidAlive(pid); i++) spawnSync('sleep', ['0.1']);
    assert.equal(pidAlive(pid), false, 'restore stops caffeinate');
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

// A show Mac someone has "configured": the case mymac exists for.
function weirdMac(sb) {
  const w = (host, domain, key, type, value) => spawnSync('/usr/bin/defaults',
    ['write', prefFile(sb, { host, domain }), key, `-${type}`, value]);
  w(false, 'NSGlobalDomain', 'com.apple.swipescrolldirection', 'bool', 'false');
  w(false, 'NSGlobalDomain', 'KeyRepeat', 'int', '120');
  w(false, 'NSGlobalDomain', 'com.apple.trackpad.scaling', 'float', '0.125');
  w(false, 'com.apple.dock', 'orientation', 'string', 'right');
  w(false, 'com.apple.dock', 'magnification', 'bool', 'true');
  w(false, 'com.apple.dock', 'tilesize', 'float', '128');
  w(false, 'com.apple.dock', 'wvous-br-corner', 'int', '14');
  w(false, 'com.apple.dock', 'wvous-tl-corner', 'int', '13');
  w(false, 'com.apple.AppleMultitouchTrackpad', 'Clicking', 'int', '0');
  w(false, 'com.apple.WindowManager', 'GloballyEnabled', 'bool', 'true');
  w(false, 'com.apple.finder', 'FXPreferredViewStyle', 'string', 'clmv');
  w(false, 'NSGlobalDomain', 'AppleShowScrollBars', 'string', "It's \"odd\" & spaced");
  w(true, 'com.apple.screensaver', 'idleTime', 'int', '300');
}

test('capture reads back exactly what apply wrote', { skip, timeout: 600_000 }, () => {
  const captured = new Set(SETTINGS.filter((s) => s.read || s.captureSh).map((s) => s.code));
  const profiles = [
    'rs1.tc1.ns0.ts150.rcl.dpl.da1.dz40.apd.kr6.kd25.hc0e00.cws.sw0.mc0.nc0.lp0.bk0.sp0',
    'rs1.td1.fc0.cp0.ms250.cs200.sk0.dpr.di1.dm1.dl100.dr0.des.dw1.dx1.db0.dn0.mh1.ck1.hr0.sbs.hc0000',
    'rs1.ph0.fn1.ac0.ak0.sq0.pd0.dk0.ex1.hf1.pb1.su1.fvc.sm1.tg0.mr0.hc2345',
  ];
  for (const code of profiles) {
    const sb = makeSandbox(weirdMac);
    try {
      const want = decode(code).profile;
      const r = sh(sb, applyScript(want));
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const c = sh(sb, captureScript({ origin: 'https://mymac.test' }), ['--no-open']);
      assert.equal(c.status, 0, c.stderr);
      const got = decode(c.stdout.split('\n')[1].trim());
      assert.deepEqual(got.problems, []);
      const expected = Object.fromEntries(Object.entries(want).filter(([k]) => k === 'rs' || captured.has(k)));
      // A captured value equal to the macOS default is left out of the code.
      for (const s of SETTINGS) if (expected[s.code] === s.def) delete expected[s.code];
      assert.equal(encode(got.profile), encode(expected), `capture after applying ${code}`);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  }
});

test('restore puts back a strangely configured Mac, odd strings included', { skip, timeout: 600_000 }, () => {
  const sb = makeSandbox(weirdMac);
  try {
    const before = prefsState(sb);
    const r = sh(sb, applyScript(decode(FULL).profile));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const rr = sh(sb, readFileSync(join(sb, 'home/.mymac/restore.sh'), 'utf8'));
    assert.equal(rr.status, 0, rr.stderr + rr.stdout);
    const after = prefsState(sb);
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} did not come back`);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('dry run changes nothing', { skip, timeout: 300_000 }, () => {
  const sb = makeSandbox(weirdMac);
  try {
    const before = prefsState(sb);
    const r = sh(sb, applyScript(decode(FULL).profile), ['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing was changed/);
    assert.deepEqual(prefsState(sb), before);
    assert.equal(existsSync(join(sb, 'home/.mymac')), false);
    const writes = readFileSync(join(sb, 'log'), 'utf8').split('\n').filter((l) => / (write|delete) /.test(l));
    assert.deepEqual(writes, []);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

