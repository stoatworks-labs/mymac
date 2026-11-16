// Runs the generated scripts for real, against a sandbox: test doubles for defaults, osascript,
// killall, activateSettings and caffeinate (test/shims) that act on copies of the preference
// files. Nothing on the Mac running the tests is written; seeding only exports (reads) domains.
//
// Show Mode is a stand-in app in the sandbox (a bash loop with a fake signature), "downloaded"
// by a curl double from a fake GitHub release and "mounted" by an hdiutil double; open and pgrep
// doubles start and see only that stand-in, so a real Show Mode on this Mac is never touched.
// The script's one system path, SM_SYS=/Applications, is pointed into the sandbox.
//
// macOS only (it needs /usr/bin/defaults and plutil).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

const SM_DMG = 'showmode-0.6.0-macos-universal.dmg';
const SM_SIGNED = 'Identifier=com.stoatworks.showmode\nTeamIdentifier=3G7USP8N73\n';

// The stand-in Show Mode: makes the files the real one makes, and on SIGTERM "restores" (or,
// with state/showmode-stuck, leaves its journal behind as a restore that could not finish does).
const FAKE_SHOWMODE = `#!/bin/bash
trap 'echo "ShowMode TERM" >> "$MYMAC_SB/log"
  [ -f "$MYMAC_SB/state/showmode-stuck" ] && echo stuck > "$HOME/Library/Application Support/ShowMode/journal.plist"
  exit 0' TERM
mkdir -p "$HOME/Library/Application Support/ShowMode" "$HOME/Library/Logs"
echo launched >> "$HOME/Library/Logs/ShowMode.log"
defaults write com.stoatworks.showmode launched -bool true
while :; do sleep 0.1; done
`;

// A Show Mode app in <dir>, signed (in the doubles' terms) by `signature`.
function makeShowMode(dir, signature = SM_SIGNED) {
  const app = join(dir, 'Show Mode.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents/MacOS/ShowMode'), FAKE_SHOWMODE);
  chmodSync(join(app, 'Contents/MacOS/ShowMode'), 0o755);
  writeFileSync(join(app, 'Contents/_FakeSignature'), signature);
  return app;
}

// The fake GitHub release: its API answer and the "disk image" (a file naming the folder that
// hdiutil's double mounts).
function makeRelease(sb, { digest } = {}) {
  makeShowMode(join(sb, 'image'));
  const dmg = `${join(sb, 'image')}\n`;
  writeFileSync(join(sb, 'gh', SM_DMG), dmg);
  const sum = digest ?? createHash('sha256').update(dmg).digest('hex');
  writeFileSync(join(sb, 'gh/release.json'), JSON.stringify({
    tag_name: 'v0.6.0', body: null,
    assets: [
      { name: 'notes.txt', browser_download_url: 'https://github.com/stoatworks-labs/showmode/releases/download/v0.6.0/notes.txt', digest: null },
      { name: SM_DMG, label: null, digest: `sha256:${sum}`, browser_download_url: `https://github.com/stoatworks-labs/showmode/releases/download/v0.6.0/${SM_DMG}` },
    ],
  }));
}

function makeSandbox(seed) {
  const sb = mkdtempSync(join(tmpdir(), 'mymac-test-'));
  for (const p of ['prefs/ByHost', 'state', 'gh', 'Applications', 'home/Library/Application Support/com.apple.wallpaper/Store']) {
    mkdirSync(join(sb, p), { recursive: true });
  }
  makeRelease(sb);
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

function sh(sb, script, args = [], file = join(sb, `run-${Math.random().toString(36).slice(2)}.sh`), timeout = 240_000) {
  writeFileSync(file, script.replace(/^SM_SYS=\/Applications$/m, `SM_SYS='${sb}/Applications'`));
  const r = spawnSync('/bin/bash', [file, ...args], {
    env: { PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: join(sb, 'home'), MYMAC_SB: sb, LANG: 'en_GB.UTF-8' },
    encoding: 'utf8',
    timeout,
  });
  return r;
}

// Stops any stand-in Show Mode still running, then removes the sandbox.
function cleanup(sb) {
  const procs = join(sb, 'state/procs');
  if (existsSync(procs)) {
    for (const line of readFileSync(procs, 'utf8').split('\n').filter(Boolean)) {
      try { process.kill(Number(line.split('\t')[0]), 'SIGKILL'); } catch { /* gone */ }
    }
  }
  rmSync(sb, { recursive: true, force: true });
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
  'sw0', 'mc0', 'nc0', 'lp0', 'bk0', 'hc2a4e', 'ss0', 'ka1', 'as1', 'ar0', 'cn1', 'sh1',
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
    cleanup(sb);
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
      cleanup(sb);
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
    cleanup(sb);
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
    cleanup(sb);
  }
});


// ── Show Mode ───────────────────────────────────────────────────────────────────────────────

const smApp = (sb, where) => join(sb, where, 'Show Mode.app');
const smRunning = (sb) => (existsSync(join(sb, 'state/procs'))
  ? readFileSync(join(sb, 'state/procs'), 'utf8').split('\n').filter(Boolean)
    .map((l) => Number(l.split('\t')[0])).filter(pidAlive)
  : []);
const logOf = (sb) => readFileSync(join(sb, 'log'), 'utf8');
const restore = (sb) => sh(sb, readFileSync(join(sb, 'home/.mymac/restore.sh'), 'utf8'));
// The stand-in has started (as a real Show Mode has, long before anyone runs restore).
const waitUp = (sb) => { for (let i = 0; i < 50 && !smFiles(sb).prefs; i++) spawnSync('sleep', ['0.1']); };
const smFiles = (sb) => ({
  log: existsSync(join(sb, 'home/Library/Logs/ShowMode.log')),
  support: existsSync(join(sb, 'home/Library/Application Support/ShowMode')),
  prefs: read(sb, false, 'com.stoatworks.showmode', 'launched') != null,
});

test('Show Mode: downloaded, checked, installed and opened; restore quits it, then removes it', { skip, timeout: 120_000 }, () => {
  const sb = makeSandbox();
  try {
    const r = sh(sb, applyScript(decode('tc1.sh1').profile));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /✓ Install and open Show Mode \(in .*\/Applications\)/);
    assert.ok(existsSync(smApp(sb, 'Applications')), 'installed into Applications');
    const log = logOf(sb);
    for (const k of ['curl -fsSL --max-time 20 -H Accept: application/vnd.github+json', `releases/download/v0.6.0/${SM_DMG}`,
      'hdiutil attach', 'codesign --verify --deep --strict', 'spctl --assess --type execute', 'hdiutil detach', 'open ']) {
      assert.ok(log.includes(k), `apply should run ${k}`);
    }
    assert.equal(smRunning(sb).length, 1, 'Show Mode is open');
    waitUp(sb);
    assert.deepEqual(smFiles(sb), { log: true, support: true, prefs: true });

    // Restore quits it before anything else, then removes it and only what it brought.
    const head = readFileSync(join(sb, 'home/.mymac/head.sh'), 'utf8');
    assert.match(head, /^showmode_back .*Show\\ Mode\.app 1 \|\| exit 1$/m);
    assert.match(head, /^defaults delete com\.stoatworks\.showmode 2>\/dev\/null$/m);
    assert.match(head, /^sm_shortcuts_note$/m);
    const restoreSh = readFileSync(join(sb, 'home/.mymac/restore.sh'), 'utf8');
    const quits = restoreSh.search(/^showmode_back \S.* 1 \|\| exit 1$/m);
    const putsBack = restoreSh.search(/^defaults \S+ com\.apple\.AppleMultitouchTrackpad Clicking/m);
    assert.ok(quits > 0 && putsBack > 0 && quits < putsBack, 'Show Mode quits before mymac puts its own keys back');

    writeFileSync(join(sb, 'state/shortcuts'), 'Show Mode Focus On\nShow Mode Focus Off\n'); // added during the show
    const rr = restore(sb);
    assert.equal(rr.status, 0, rr.stderr + rr.stdout);
    assert.match(rr.stdout, /✓ Show Mode quit and removed/);
    assert.match(rr.stdout, /Delete Show Mode Focus On and Show Mode Focus Off/);
    assert.ok(logOf(sb).includes('ShowMode TERM'), 'Show Mode got SIGTERM, which makes it restore');
    assert.equal(smRunning(sb).length, 0);
    assert.equal(existsSync(smApp(sb, 'Applications')), false);
    assert.deepEqual(smFiles(sb), { log: false, support: false, prefs: false });
    assert.equal(existsSync(join(sb, 'home/.mymac')), false);
  } finally {
    cleanup(sb);
  }
});

test('Show Mode from a USB stick: the disk image beside mymac.sh, no network, no admin', { skip, timeout: 120_000 }, () => {
  const sb = makeSandbox();
  try {
    writeFileSync(join(sb, 'state/offline'), '');
    rmSync(join(sb, 'Applications'), { recursive: true }); // not writable here, so ~/Applications
    const stick = join(sb, 'USB STICK');
    mkdirSync(stick);
    cpSync(join(sb, 'gh', SM_DMG), join(stick, SM_DMG));
    // A browser marks a saved disk image, and everything in it, as downloaded.
    spawnSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0083;6afacb54;Safari;', join(sb, 'image/Show Mode.app')]);
    const r = sh(sb, applyScript(decode('sh1').profile), [], join(stick, 'mymac.sh'));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /✓ Install and open Show Mode \(in .*\/home\/Applications\)/);
    assert.ok(!logOf(sb).includes('curl '), 'no network needed');
    assert.ok(logOf(sb).includes(`hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint`));
    assert.ok(existsSync(smApp(sb, 'home/Applications')));
    const q = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', smApp(sb, 'home/Applications')]);
    assert.notEqual(q.status, 0, 'the checked copy loses the quarantine mark (no second prompt, no translocation)');

    const rr = restore(sb);
    assert.equal(rr.status, 0, rr.stderr + rr.stdout);
    assert.equal(existsSync(join(sb, 'home/Applications')), false, 'restore removes the ~/Applications it made');
  } finally {
    cleanup(sb);
  }
});

test('Show Mode: no network and no disk image is a ✗ with the reason, and the rest still applies', { skip, timeout: 120_000 }, () => {
  const sb = makeSandbox();
  try {
    writeFileSync(join(sb, 'state/offline'), '');
    const r = sh(sb, applyScript(decode('tc1.sh1').profile));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /✗ Install and open Show Mode — GitHub couldn't be reached and there's no showmode-\*-macos-universal\.dmg beside mymac\.sh/);
    assert.match(r.stdout, /✓ Tap to click/);
    assert.equal(readFileSync(join(sb, 'home/.mymac/head.sh'), 'utf8'), '', 'nothing recorded for restore');
    const rr = restore(sb);
    assert.equal(rr.status, 0, rr.stderr + rr.stdout);
  } finally {
    cleanup(sb);
  }
});

test('Show Mode: a copy not signed by Stoatworks, or a download with the wrong checksum, is never installed', { skip, timeout: 120_000 }, () => {
  for (const [why, setup, expect] of [
    ['another signer', (sb) => makeShowMode(join(sb, 'image'), 'Identifier=com.stoatworks.showmode\nTeamIdentifier=ABCDE12345\n'),
      /isn't Show Mode signed by Stoatworks, so it wasn't installed/],
    ['unsigned', (sb) => rmSync(join(sb, 'image/Show Mode.app/Contents/_FakeSignature')),
      /isn't Show Mode signed by Stoatworks/],
    ['wrong checksum', (sb) => makeRelease(sb, { digest: '0'.repeat(64) }), /didn't match GitHub's checksum/],
  ]) {
    const sb = makeSandbox();
    try {
      setup(sb);
      const r = sh(sb, applyScript(decode('sh1').profile));
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, expect, why);
      assert.equal(existsSync(smApp(sb, 'Applications')), false, `${why}: not installed`);
      assert.equal(smRunning(sb).length, 0, `${why}: not opened`);
      if (why !== 'wrong checksum') assert.ok(logOf(sb).includes('hdiutil detach'), `${why}: image detached`);
      else assert.ok(!logOf(sb).includes('hdiutil attach'), 'a bad download is never mounted');
    } finally {
      cleanup(sb);
    }
  }
});

test('Show Mode already installed: opened if it is closed, left alone if it is open, never removed', { skip, timeout: 120_000 }, () => {
  const sb = makeSandbox();
  try {
    makeShowMode(join(sb, 'Applications'));
    const r = sh(sb, applyScript(decode('sh1').profile));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /✓ Open Show Mode \(already in .*\/Applications\)/);
    assert.ok(!logOf(sb).includes('curl '), 'nothing downloaded');
    assert.equal(smRunning(sb).length, 1);
    waitUp(sb);
    const rr = restore(sb);
    assert.equal(rr.status, 0, rr.stderr + rr.stdout);
    assert.match(rr.stdout, /✓ Show Mode quit\n/);
    assert.ok(existsSync(smApp(sb, 'Applications')), 'the owner\'s copy stays');

    // Open before mymac runs: nothing to do, and restore doesn't quit it.
    spawnSync(join(shims, 'open'), [smApp(sb, 'Applications')], { env: { ...process.env, MYMAC_SB: sb, HOME: join(sb, 'home') } });
    const r2 = sh(sb, applyScript(decode('sh1').profile));
    assert.equal(r2.status, 0, r2.stderr + r2.stdout);
    assert.match(r2.stdout, /already right 1/);
    assert.equal(readFileSync(join(sb, 'home/.mymac/head.sh'), 'utf8'), '');
    const rr2 = restore(sb);
    assert.equal(rr2.status, 0, rr2.stderr + rr2.stdout);
    assert.equal(smRunning(sb).length, 1, 'still running');
  } finally {
    cleanup(sb);
  }
});

test('restore stops, changing nothing, while Show Mode cannot finish putting things back', { skip, timeout: 120_000 }, () => {
  const sb = makeSandbox();
  try {
    const was = read(sb, false, 'com.apple.AppleMultitouchTrackpad', 'Clicking');
    const r = sh(sb, applyScript(decode('tc1.sh1').profile));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    waitUp(sb);
    writeFileSync(join(sb, 'state/showmode-stuck'), '');

    const rr = restore(sb);
    assert.equal(rr.status, 1, rr.stdout);
    assert.match(rr.stderr, /choose Finish Restoring and quit it, then run bash ~\/\.mymac\/restore\.sh again/);
    assert.equal(read(sb, false, 'com.apple.AppleMultitouchTrackpad', 'Clicking'), '1', 'mymac put nothing back yet');
    assert.ok(existsSync(smApp(sb, 'Applications')), 'Show Mode kept, to finish restoring');
    assert.ok(existsSync(join(sb, 'home/.mymac/restore.sh')), 'restore can run again');

    // Finish Restoring clears the journal; the second restore completes.
    rmSync(join(sb, 'home/Library/Application Support/ShowMode/journal.plist'));
    const rr2 = restore(sb);
    assert.equal(rr2.status, 0, rr2.stderr + rr2.stdout);
    assert.equal(read(sb, false, 'com.apple.AppleMultitouchTrackpad', 'Clicking'), was);
    assert.equal(existsSync(smApp(sb, 'Applications')), false);
  } finally {
    cleanup(sb);
  }
});

test('a run that stops part way still leaves a restore.sh for what it changed', { skip, timeout: 120_000 }, () => {
  const sb = makeSandbox();
  try {
    const was = read(sb, false, 'com.apple.AppleMultitouchTrackpad', 'Clicking');
    writeFileSync(join(sb, 'state/hdiutil-hang'), '');
    const r = sh(sb, applyScript(decode('tc1.sh1').profile), [], undefined, 3000);
    assert.ok(r.error || r.signal, 'the run was stopped');
    assert.equal(read(sb, false, 'com.apple.AppleMultitouchTrackpad', 'Clicking'), '1');
    assert.ok(existsSync(join(sb, 'home/.mymac/restore.sh')), 'restore.sh written as it went');
    const rr = restore(sb);
    assert.equal(rr.status, 0, rr.stderr + rr.stdout);
    assert.equal(read(sb, false, 'com.apple.AppleMultitouchTrackpad', 'Clicking'), was);
  } finally {
    cleanup(sb);
  }
});
