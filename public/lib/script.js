// Turns a profile into the bash scripts mymac hands out.
//
// apply   sets the Mac up, saving what it changes to ~/.mymac/restore.sh first
// capture reads a Mac's settings (changing nothing) and prints/opens its share link
// restore runs ~/.mymac/restore.sh if there is one
//
// Everything is bash 3.2 (what macOS ships) and wrapped in main() so a `curl | bash` that is
// cut off half way runs nothing at all.

import { SETTINGS, MANUAL_CHECKS, isResettable } from './catalogue.js';
import { encode } from './code.js';
import { solidPngBase64 } from './png.js';

export const VERSION = '0.2.0';

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function opLine(op) {
  const [kind, ...a] = op;
  switch (kind) {
    case 'w': {
      const [host, domain, key, type, value] = a;
      const v = type === 'bool' ? (value ? 'true' : 'false') : String(value);
      return `w ${host} ${sq(domain)} ${sq(key)} ${type} ${sq(v)}`;
    }
    case 'rw': {
      const [host, domain, key, type, value] = a;
      const v = type === 'bool' ? (value ? 'true' : 'false') : String(value);
      return `rw ${host} ${sq(domain)} ${sq(key)} ${type} ${sq(v)}`;
    }
    case 'd':
      return `d ${a[0]} ${sq(a[1])} ${sq(a[2])}`;
    case 'wif': {
      const [host, domain, key, type, value, was] = a;
      const absent = a[6] != null ? ` ${sq(String(a[6]))}` : '';
      return `wif ${host} ${sq(domain)} ${sq(key)} ${type} ${sq(String(value))} ${sq(String(was))}${absent}`;
    }
    case 'wall':
      return `wall ${a[0]} ${sq(solidPngBase64(a[0]))}`;
    case 'dark':
      return `appearance ${a[0]}`;
    case 'menubar':
      return `menubar ${a[0]}`;
    case 'alert':
      return `alertvol ${a[0]}`;
    case 'awake':
      return 'awake';
    case 'showmode':
      return 'showmode';
    default:
      throw new Error(`unknown op ${kind}`);
  }
}

// The per-setting blocks: begin, its operations, end.
function blocks(profile) {
  const out = [];
  for (const s of SETTINGS) {
    let ops;
    let label = s.label;
    if (profile[s.code] != null) {
      ops = s.apply(profile[s.code]);
    } else if (profile.rs === '1' && isResettable(s)) {
      // An unset key already is the macOS default, so a reset only rewrites keys that hold
      // a value; 'rw' skips the rest.
      ops = s.reset === 'delete'
        ? s.resetOps()
        : s.apply(s.def).map((op) => (op[0] === 'w' ? ['rw', ...op.slice(1)] : op));
      label = `${s.label} (macOS default)`;
    } else {
      continue;
    }
    if (!ops.length) continue;
    out.push(`  begin ${sq(label)} ${sq(s.refresh.join(' '))} ${sq(s.failHint || '')}`);
    for (const op of ops) out.push(`  ${opLine(op)}`);
    out.push('  end');
  }
  return out;
}

// activateSettings is found through PATH (system folder appended) so tests can stand in for it.
const ACTIVATE_DIR = '/System/Library/PrivateFrameworks/SystemAdministration.framework/Resources';

// Shell shared by apply.sh and the restore.sh it writes: the refresh step.
const REFRESH_FN = String.raw`
refresh() {
  for k in "$@"; do
    case "$k" in
      hid) PATH="$PATH:${ACTIVATE_DIR}" activateSettings -u >/dev/null 2>&1 || echo "  (trackpad and keyboard changes finish at next login)" ;;
      dock) killall Dock >/dev/null 2>&1 ;;
      finder) killall Finder >/dev/null 2>&1 ;;
      wm) killall WindowManager >/dev/null 2>&1 ;;
      cc) killall ControlCenter >/dev/null 2>&1 ;;
    esac
  done
}`;

const APPLY_BODY = String.raw`
say() { printf '%s\n' "$*"; }
H() { [ "$1" = 1 ] && printf '%s' -currentHost; }
cur() { defaults $(H "$1") read "$2" "$3" 2>/dev/null || printf '%s\n' '(unset)'; }
seen() { grep -qxF "$1" "$D/seen" 2>/dev/null; }
mark() { printf '%s\n' "$1" >> "$D/seen"; }
addkinds() { for k in $1; do case " $DIRTY " in *" $k "*) ;; *) DIRTY="$DIRTY $k" ;; esac; done; }

same() { # same <type> <current> <new>
  case "$1" in
    bool) case "$3" in true) [ "$2" = 1 ] ;; *) [ "$2" = 0 ] ;; esac ;;
    float) [ "$2" != '(unset)' ] && awk -v a="$2" -v b="$3" 'BEGIN { exit !(a + 0 == b + 0) }' ;;
    *) [ "$2" = "$3" ] ;;
  esac
}

# Records how a key is now, once per key, as a line restore.sh can run.
# Returns 1 for a key holding a list or dictionary: mymac leaves those alone.
snap() { # snap <host> <domain> <key> [file to append to, default body.sh]
  local id="$1|$2|$3" t v hf="" out="$4"
  [ -n "$out" ] || out="$D/body.sh"
  seen "$id" && return 0
  [ "$1" = 1 ] && hf="-currentHost "
  if t=$(defaults $(H "$1") read-type "$2" "$3" 2>/dev/null); then
    v=$(defaults $(H "$1") read "$2" "$3" 2>/dev/null)
    case "$t" in
      *boolean*) [ "$v" = 1 ] && v=true || v=false
                 printf 'defaults %swrite %s %s -bool %s\n' "$hf" "$2" "$3" "$v" ;;
      *integer*) printf 'defaults %swrite %s %s -int %s\n' "$hf" "$2" "$3" "$v" ;;
      *float*)   printf 'defaults %swrite %s %s -float %s\n' "$hf" "$2" "$3" "$v" ;;
      *string*)  printf 'defaults %swrite %s %s -string %q\n' "$hf" "$2" "$3" "$v" ;;
      *) return 1 ;;
    esac >> "$out"
  else
    printf 'defaults %sdelete %s %s 2>/dev/null\n' "$hf" "$2" "$3" >> "$out"
  fi
  mark "$id"
}

begin() { S="$1"; K="$2"; HINT="$3"; SC=0; SF=0; SD=""; }
changed() { SC=$((SC + 1)); }
failed() { SF=$((SF + 1)); }
end() {
  if [ "$DRY" = 1 ]; then
    if [ -n "$SD" ]; then say "  $S"; printf '%s' "$SD"; fi
    return 0
  fi
  if [ "$SF" -gt 0 ]; then
    if [ -n "$HINT" ]; then say "  ✗ $S — $HINT"; else say "  ✗ $S"; fi
    NFAIL=$((NFAIL + 1))
  elif [ "$SC" -gt 0 ]; then
    say "  ✓ $S"; NSET=$((NSET + 1)); addkinds "$K"
    for k in $K; do grep -qxF "$k" "$D/kinds" || printf '%s\n' "$k" >> "$D/kinds"; done
    case " $K " in *" logout "*) LOGOUT="$LOGOUT, $S" ;; esac
    case " $K " in *" relaunch "*) RELAUNCH="$RELAUNCH, $S" ;; esac
  else
    NSAME=$((NSAME + 1))
  fi
  # Rebuilt after every setting, so a run that stops part way (a prompt, Ctrl-C, a lost
  # connection) still leaves a restore.sh for what it did change.
  assemble
}
dry() { SD="$SD    $1
"; }

w() { # w <host> <domain> <key> <type> <value>
  local now; now=$(cur "$1" "$2" "$3")
  same "$4" "$now" "$5" && return 0
  if [ "$DRY" = 1 ]; then
    [ "$4" = bool ] && case "$now" in 1) now=true ;; 0) now=false ;; esac
    dry "$([ "$1" = 1 ] && printf '%s' '-currentHost ')$2 $3: $now -> $5"; return 0
  fi
  snap "$1" "$2" "$3" || { say "    (left $2 $3 alone: it holds a list)"; return 0; }
  if defaults $(H "$1") write "$2" "$3" "-$4" "$5" 2>/dev/null; then changed; else failed; fi
}

rw() { # rw <host> <domain> <key> <type> <value>   (only where the key is set)
  defaults $(H "$1") read "$2" "$3" >/dev/null 2>&1 || return 0
  w "$@"
}

wif() { # wif <host> <domain> <key> <type> <value> <only-if-currently> [value when unset]
  local now; now=$(cur "$1" "$2" "$3")
  [ "$now" = '(unset)' ] && now="$7"
  [ "$now" = "$6" ] || return 0
  w "$1" "$2" "$3" "$4" "$5"
}

d() { # d <host> <domain> <key>   (back to the macOS built-in value)
  defaults $(H "$1") read "$2" "$3" >/dev/null 2>&1 || return 0
  if [ "$DRY" = 1 ]; then dry "$2 $3: $(cur "$1" "$2" "$3") -> (macOS default)"; return 0; fi
  snap "$1" "$2" "$3" || return 0
  if defaults $(H "$1") delete "$2" "$3" 2>/dev/null; then changed; else failed; fi
}

wall() { # wall <rrggbb> <png base64>
  local png="$D/wallpaper-$1.png"
  local store="$HOME/Library/Application Support/com.apple.wallpaper/Store/Index.plist"
  if [ "$DRY" = 1 ]; then dry "wallpaper -> #$1 on every screen"; return 0; fi
  printf '%s' "$2" | base64 -D > "$png" 2>/dev/null || { failed; return 0; }
  if ! seen wallpaper; then
    [ -f "$store" ] && cp "$store" "$D/wallpaper-store.plist"
    screens_get > "$D/wallpaper-screens.txt" 2>/dev/null
    cat >> "$D/tail.sh" <<'EOS'
store="$HOME/Library/Application Support/com.apple.wallpaper/Store/Index.plist"
if [ -f "$D/wallpaper-store.plist" ] && cp "$D/wallpaper-store.plist" "$store"; then
  killall WallpaperAgent >/dev/null 2>&1
elif [ -s "$D/wallpaper-screens.txt" ]; then
  while IFS=$'\t' read -r i p; do screen_set "$i" "$p" >/dev/null 2>&1; done < "$D/wallpaper-screens.txt"
fi
EOS
    mark wallpaper
  fi
  if screens_fill "$png" "$1" >/dev/null 2>&1; then changed; else failed; fi
}

appearance() { # appearance 0|1
  local want=false now=false
  [ "$1" = 1 ] && want=true
  [ "$(defaults read -g AppleInterfaceStyle 2>/dev/null)" = Dark ] && now=true
  [ "$now" = "$want" ] && return 0
  if [ "$DRY" = 1 ]; then dry "dark mode: $now -> $want"; return 0; fi
  # Saved before the change: the live switch back, then the key exactly as it was.
  if ! seen appearance; then
    say "osascript -e 'tell application \"System Events\" to tell appearance preferences to set dark mode to $now' >/dev/null 2>&1" >> "$D/tail.sh"
    mark appearance
    snap 0 NSGlobalDomain AppleInterfaceStyle "$D/tail.sh"
  fi
  if osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $want" >/dev/null 2>&1; then changed; else failed; fi
}

menubar() { # menubar 0|1
  local want=false now=false
  [ "$1" = 1 ] && want=true
  [ "$(defaults read -g _HIHideMenuBar 2>/dev/null)" = 1 ] && now=true
  [ "$now" = "$want" ] && return 0
  if [ "$DRY" = 1 ]; then dry "hide menu bar: $now -> $want"; return 0; fi
  # Saved before the change: the live switch back, then the key exactly as it was.
  if ! seen menubar; then
    say "osascript -e 'tell application \"System Events\" to tell dock preferences to set autohide menu bar to $now' >/dev/null 2>&1" >> "$D/tail.sh"
    mark menubar
    snap 0 NSGlobalDomain _HIHideMenuBar "$D/tail.sh"
  fi
  if osascript -e "tell application \"System Events\" to tell dock preferences to set autohide menu bar to $want" >/dev/null 2>&1; then changed; else failed; fi
}

alertvol() { # alertvol 0-100
  local now; now=$(osascript -e 'alert volume of (get volume settings)' 2>/dev/null)
  case "$now" in ''|*[!0-9]*) return 0 ;; esac
  [ "$now" = "$1" ] && return 0
  if [ "$DRY" = 1 ]; then dry "alert volume: $now -> $1"; return 0; fi
  seen alert || { say "osascript -e 'set volume alert volume $now' >/dev/null 2>&1" >> "$D/tail.sh"; mark alert; }
  if osascript -e "set volume alert volume $1" >/dev/null 2>&1; then changed; else failed; fi
}

awake() {
  if [ -f "$D/caffeinate.pid" ] && kill -0 "$(cat "$D/caffeinate.pid")" 2>/dev/null; then return 0; fi
  if [ "$DRY" = 1 ]; then dry "start caffeinate (display and system stay awake until restore)"; return 0; fi
  nohup caffeinate -dims </dev/null >/dev/null 2>&1 &
  printf '%s\n' "$!" > "$D/caffeinate.pid"
  seen awake || { say 'kill "$(cat "$D/caffeinate.pid" 2>/dev/null)" >/dev/null 2>&1' >> "$D/tail.sh"; mark awake; }
  changed
}

# ── Show Mode ───────────────────────────────────────────────────────────────────────────
# Installed only where it isn't already, and only once its signature checks out. Restore quits
# it first, so it puts back what it changed before mymac puts back what mymac changed.
SM_ID=com.stoatworks.showmode
SM_TEAM=3G7USP8N73
SM_SYS=/Applications
SM_API=https://api.github.com/repos/stoatworks-labs/showmode/releases/latest

sm_find() { # prints where Show Mode is installed, if it is
  local p
  for p in "$SM_SYS/Show Mode.app" "$HOME/Applications/Show Mode.app"; do
    if [ -d "$p" ]; then printf '%s\n' "$p"; return 0; fi
  done
  return 1
}

sm_trusted() { # sm_trusted <app>: Show Mode, intact, signed by Stoatworks and accepted by Gatekeeper
  local info
  [ -d "$1" ] || return 1
  codesign --verify --deep --strict "$1" >/dev/null 2>&1 || return 1
  info=$(codesign -dv "$1" 2>&1)
  printf '%s\n' "$info" | grep -qx "Identifier=$SM_ID" || return 1
  printf '%s\n' "$info" | grep -qx "TeamIdentifier=$SM_TEAM" || return 1
  spctl --assess --type execute "$1" >/dev/null 2>&1
}

sm_asset() { # sm_asset <release.json>: the universal disk image's URL, then its sha256
  osascript -l JavaScript - "$1" <<'JS'
function run(argv) {
  ObjC.import('Foundation');
  var text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  var a = (JSON.parse(text.js).assets || []).filter(function (x) { return /-macos-universal\.dmg$/.test(x.name); })[0];
  if (!a) throw new Error('no disk image in the latest release');
  return a.browser_download_url + '\n' + String(a.digest || '').replace(/^sha256:/, '');
}
JS
}

sm_download() { # sm_download <dir>: the latest disk image to <dir>/showmode.dmg; 2 = wrong checksum
  local info url sum
  curl -fsSL --max-time 20 -H 'Accept: application/vnd.github+json' -o "$1/release.json" "$SM_API" 2>/dev/null || return 1
  info=$(sm_asset "$1/release.json" 2>/dev/null) || return 1
  url=$(printf '%s\n' "$info" | sed -n 1p)
  sum=$(printf '%s\n' "$info" | sed -n 2p)
  case "$url" in https://github.com/stoatworks-labs/showmode/releases/download/*) ;; *) return 1 ;; esac
  curl -fsSL --max-time 600 -o "$1/showmode.dmg" "$url" 2>/dev/null || return 1
  if [ -n "$sum" ] && [ "$(shasum -a 256 "$1/showmode.dmg" | cut -d ' ' -f 1)" != "$sum" ]; then return 2; fi
}

sm_open() { # sm_open <app>: opens it without waiting on any prompt, then waits up to 10 s for it to run
  local n=0
  open "$1" </dev/null >/dev/null 2>&1 &
  while [ "$n" -lt 20 ]; do
    pgrep -x ShowMode >/dev/null 2>&1 && return 0
    sleep 0.5; n=$((n + 1))
  done
  return 1
}

sm_unmount() { # sm_unmount <dir>: detaches <dir>/mnt, then removes only what mymac put in <dir>
  hdiutil detach -quiet "$1/mnt" >/dev/null 2>&1 || hdiutil detach -quiet -force "$1/mnt" >/dev/null 2>&1
  rmdir "$1/mnt" 2>/dev/null
  rm -f "$1/showmode.dmg" "$1/release.json"
  rmdir "$1" 2>/dev/null
}

showmode() {
  local have dest dmg f t
  pgrep -x ShowMode >/dev/null 2>&1 && return 0
  if have=$(sm_find); then
    S="Open Show Mode (already in $(dirname "$have"))"
    if [ "$DRY" = 1 ]; then dry "open $have"; return 0; fi
    if ! seen showmode; then
      printf 'showmode_back %q 0 || exit 1\n' "$have" >> "$D/head.sh"
      shortcuts list 2>/dev/null | grep -q '^Show Mode Focus O' || printf '%s\n' sm_shortcuts_note >> "$D/head.sh"
      mark showmode
    fi
    if sm_open "$have"; then changed; else HINT="it didn't start: open it from $(dirname "$have")"; failed; fi
    return 0
  fi

  dmg=""
  if [ -f "$SELF" ]; then
    for f in "$(dirname "$SELF")"/showmode-*-macos-universal.dmg; do [ -f "$f" ] && dmg="$f"; done
  fi
  if [ -w "$SM_SYS" ]; then dest="$SM_SYS"; else dest="$HOME/Applications"; fi
  if [ "$DRY" = 1 ]; then
    if [ -n "$dmg" ]; then dry "install Show Mode from $dmg into $dest, then open it"
    else dry "download the latest Show Mode from GitHub, install it into $dest, then open it"; fi
    return 0
  fi

  t=$(mktemp -d -t mymac-showmode) || { failed; return 0; }
  if [ -z "$dmg" ]; then
    sm_download "$t"
    case $? in
      0) dmg="$t/showmode.dmg" ;;
      2) HINT="the download didn't match GitHub's checksum, so it wasn't installed"; failed; rm -rf "$t"; return 0 ;;
      *) HINT="GitHub couldn't be reached and there's no showmode-*-macos-universal.dmg beside mymac.sh"; failed; rm -rf "$t"; return 0 ;;
    esac
  fi
  mkdir "$t/mnt"
  if ! hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$t/mnt" "$dmg" >/dev/null 2>&1; then
    HINT="couldn't open $dmg"; failed; rm -rf "$t"; return 0
  fi
  if ! sm_trusted "$t/mnt/Show Mode.app"; then
    sm_unmount "$t"
    HINT="the app in $(basename "$dmg") isn't Show Mode signed by Stoatworks, so it wasn't installed"; failed; return 0
  fi

  # Saved before the change: restore quits it, then removes only what wasn't here before.
  {
    printf 'showmode_back %q 1 || exit 1\n' "$dest/Show Mode.app"
    for f in "$HOME/Library/Application Support/ShowMode" "$HOME/Library/Logs/ShowMode.log" \
      "$HOME/Library/Caches/$SM_ID" "$HOME/Library/HTTPStorages/$SM_ID" \
      "$HOME/Library/Saved Application State/$SM_ID.savedState"; do
      [ -e "$f" ] || printf 'rm -rf %q\n' "$f"
    done
    defaults read "$SM_ID" >/dev/null 2>&1 || printf 'defaults delete %s 2>/dev/null\n' "$SM_ID"
    [ -d "$dest" ] || printf 'rmdir %q 2>/dev/null\n' "$dest"
    shortcuts list 2>/dev/null | grep -q '^Show Mode Focus O' || printf '%s\n' sm_shortcuts_note
  } >> "$D/head.sh"
  mark showmode

  mkdir -p "$dest" 2>/dev/null
  if ditto "$t/mnt/Show Mode.app" "$dest/Show Mode.app" 2>/dev/null; then
    sm_unmount "$t"
    # A disk image saved by a browser marks everything in it as downloaded. The copy has just
    # passed the checks Gatekeeper would make (signature, Stoatworks' team, notarisation), and
    # the mark would only make macOS ask again and run it from a random translocated path,
    # where restore couldn't find it to quit it.
    xattr -dr com.apple.quarantine "$dest/Show Mode.app" 2>/dev/null
    S="Install and open Show Mode (in $dest)"
    if sm_open "$dest/Show Mode.app"; then changed; else HINT="it didn't start: open it from $dest"; failed; fi
  else
    sm_unmount "$t"
    rm -rf "$dest/Show Mode.app"
    HINT="couldn't copy it into $dest"; failed
  fi
}

# JXA through NSWorkspace: no Automation permission needed, unlike System Events.
screens_get() {
  osascript -l JavaScript - <<'JS'
function run() {
  ObjC.import('AppKit');
  var ws = $.NSWorkspace.sharedWorkspace, s = $.NSScreen.screens, out = [];
  for (var i = 0; i < s.count; i++) {
    var u = ws.desktopImageURLForScreen(s.objectAtIndex(i));
    if (!u.isNil()) out.push(i + '\t' + u.path.js);
  }
  return out.join('\n');
}
JS
}

screens_fill() { # screens_fill <png> <rrggbb>
  osascript -l JavaScript - "$1" "$2" <<'JS'
function run(argv) {
  ObjC.import('AppKit');
  var url = $.NSURL.fileURLWithPath(argv[0]), hex = argv[1];
  var c = function (i) { return parseInt(hex.substr(i, 2), 16) / 255; };
  var opts = $.NSMutableDictionary.dictionary;
  opts.setObjectForKey($.NSNumber.numberWithInt(1), $.NSWorkspaceDesktopImageScalingKey);
  opts.setObjectForKey($.NSNumber.numberWithBool(true), $.NSWorkspaceDesktopImageAllowClippingKey);
  opts.setObjectForKey($.NSColor.colorWithSRGBRedGreenBlueAlpha(c(0), c(2), c(4), 1), $.NSWorkspaceDesktopImageFillColorKey);
  var ws = $.NSWorkspace.sharedWorkspace, s = $.NSScreen.screens, ok = 0;
  for (var i = 0; i < s.count; i++) {
    if (ws.setDesktopImageURLForScreenOptionsError(url, s.objectAtIndex(i), opts, null)) ok++;
  }
  if (ok === 0) throw new Error('no screen took the wallpaper');
  return ok + ' of ' + s.count;
}
JS
}
`;

// Written into restore.sh, which needs the single-screen setter for its fallback.
const SCREEN_SET_FN = String.raw`
screen_set() { # screen_set <index> <path>
  osascript -l JavaScript - "$1" "$2" <<'JS'
function run(argv) {
  ObjC.import('AppKit');
  var s = $.NSScreen.screens, i = Number(argv[0]);
  if (i >= s.count) return 'gone';
  $.NSWorkspace.sharedWorkspace.setDesktopImageURLForScreenOptionsError(
    $.NSURL.fileURLWithPath(argv[1]), s.objectAtIndex(i), $.NSDictionary.dictionary, null);
  return 'ok';
}
JS
}`;

// Written into restore.sh: quitting Show Mode, which puts back what it changed.
const SHOWMODE_BACK_FN = String.raw`
showmode_back() { # showmode_back <app> <1 if mymac installed it>
  local pid n=0
  pid=$(pgrep -x ShowMode 2>/dev/null)
  if [ -n "$pid" ]; then
    echo "  Quitting Show Mode, which puts back what it changed..."
    kill -TERM $pid 2>/dev/null
    while [ "$n" -lt 60 ] && kill -0 $pid 2>/dev/null; do sleep 0.5; n=$((n + 1)); done
    if kill -0 $pid 2>/dev/null; then
      echo "mymac: Show Mode is still running. End the show from its menu and quit it, then run bash ~/.mymac/restore.sh again. Nothing has been put back yet." >&2
      return 1
    fi
  fi
  if [ -f "$HOME/Library/Application Support/ShowMode/journal.plist" ]; then
    echo "mymac: Show Mode couldn't put everything back. Open it, choose Finish Restoring and quit it, then run bash ~/.mymac/restore.sh again. Nothing else has been put back yet." >&2
    return 1
  fi
  if [ "$2" = 1 ]; then
    rm -rf "$1" && echo "  ✓ Show Mode quit and removed"
  elif [ -n "$pid" ]; then
    echo "  ✓ Show Mode quit"
  fi
  return 0
}

sm_shortcuts_note() { # restore can't delete shortcuts, so it says so
  shortcuts list 2>/dev/null | grep -q '^Show Mode Focus O' &&
    echo "  · Show Mode's Do Not Disturb shortcuts are still in Shortcuts. Delete Show Mode Focus On and Show Mode Focus Off there."
  return 0
}`;

// Builds restore.sh from the pieces apply has collected. Runs at the end of every apply, so a
// second apply adds its new keys while keeping the values from before the first.
const ASSEMBLE_FN = String.raw`
assemble() {
  {
    printf '%s\n' '#!/bin/bash' \
      "# mymac restore: puts back what mymac changed on this Mac (first run $(cat "$D/started"))." \
      '# Run it with:  bash ~/.mymac/restore.sh' \
      'main() {' \
      'if [ "$(id -u)" = 0 ]; then echo "mymac: run restore as the logged-in user, not with sudo." >&2; exit 1; fi' \
      'D="$HOME/.mymac"' \
      'echo "mymac: putting this Mac back the way it was..."'
    declare -f screen_set refresh showmode_back sm_shortcuts_note
    cat "$D/head.sh" 2>/dev/null
    cat "$D/body.sh" 2>/dev/null
    cat "$D/tail.sh" 2>/dev/null
    printf '%s\n' \
      'refresh $(cat "$D/kinds" 2>/dev/null)' \
      'n=$(grep -c . "$D/seen" 2>/dev/null || echo 0)' \
      'logout_needed=$(sed "s/^, //" "$D/logout" 2>/dev/null)' \
      'rm -rf "$D"' \
      'echo "mymac: put back $n settings and removed ~/.mymac."' \
      'if [ -n "$logout_needed" ]; then echo "Log out and back in to finish: $logout_needed"; fi' \
      '}' \
      'main "$@"'
  } > "$D/restore.sh"
  chmod +x "$D/restore.sh"
}`;

export function applyScript(profile, { origin = '' } = {}) {
  const code = encode(profile);
  const lines = blocks(profile);
  const checks = MANUAL_CHECKS.map((c) => `  say ${sq(`  · ${c}`)}`).join('\n');
  return `#!/bin/bash
# mymac ${VERSION}: makes this Mac behave the way you like, and saves how it was first.
#
# Profile:  ${code || '(empty)'}
# Builder:  ${origin}/${code}
#
#   bash mymac.sh             apply
#   bash mymac.sh --dry-run   show what would change, change nothing
#   bash ~/.mymac/restore.sh  put everything back (do this before you leave)
#
# Nothing here needs admin rights. Every key is read and saved before it is written.

main() {
  if [ "$(uname -s)" != Darwin ]; then echo "mymac: this script is for macOS." >&2; exit 1; fi
  if [ "$(id -u)" = 0 ]; then
    echo "mymac: run this as the logged-in user, not with sudo (sudo would change root's settings)." >&2
    exit 1
  fi
  DRY=0
  for a in "$@"; do case "$a" in -n|--dry-run) DRY=1 ;; esac; done
  D="$HOME/.mymac"
  SELF=$BASH_SOURCE # this file, when it is run from one (a USB stick), for what sits beside it
  NSET=0; NSAME=0; NFAIL=0; DIRTY=""; LOGOUT=""; RELAUNCH=""
${APPLY_BODY}
${REFRESH_FN}
${SCREEN_SET_FN}
${SHOWMODE_BACK_FN}
${ASSEMBLE_FN}

  if [ "$DRY" = 1 ]; then
    say "mymac dry run: nothing will change. Would set:"
  else
    mkdir -p "$D" || { echo "mymac: cannot write $D" >&2; exit 1; }
    [ -f "$D/started" ] || date '+%Y-%m-%d %H:%M' > "$D/started"
    touch "$D/seen" "$D/head.sh" "$D/body.sh" "$D/tail.sh" "$D/kinds"
    if [ -s "$D/seen" ]; then
      say "mymac: keeping the snapshot from $(cat "$D/started"), so restore still goes back to before mymac."
    fi
    say "mymac: setting this Mac up..."
  fi

${lines.join('\n')}

  if [ "$DRY" = 1 ]; then
    say "(dry run: nothing was changed)"
    exit 0
  fi

  for k in $DIRTY; do grep -qxF "$k" "$D/kinds" || printf '%s\n' "$k" >> "$D/kinds"; done
  if [ -n "$LOGOUT" ]; then
    printf '%s' "$(cat "$D/logout" 2>/dev/null)$LOGOUT" > "$D/logout"
  fi
  assemble
  refresh $DIRTY

  say ""
  say "Changed $NSET, already right $NSAME, could not change $NFAIL."
  [ -n "$LOGOUT" ] && say "Log out and back in to finish: \${LOGOUT#, }"
  [ -n "$RELAUNCH" ] && say "Apps pick these up as they reopen: \${RELAUNCH#, }"
  say "Worth checking by hand:"
${checks}
  say ""
  say "When you leave:  bash ~/.mymac/restore.sh"
}

main "$@"
`;
}

// ── capture ──────────────────────────────────────────────────────────────────────────────

function captureLines(s) {
  const r = s.read;
  const add = s.alwaysCapture
    ? `add ${s.code} "$v"`
    : s.def != null
      ? `[ "$v" != ${sq(s.def)} ] && add ${s.code} "$v"`
      : `add ${s.code} "$v"`;
  if (s.captureSh) return [`v=$(cap_${s.code})`, `[ -n "$v" ] && ${add}`];
  if (!r) return [];
  const h = r.host ? 1 : 0;
  const loc = `${h} ${sq(r.domain)} ${sq(r.key)}`;
  const absent = r.absent != null ? ` ${sq(r.absent)}` : '';
  const guard = r.absent == null ? `has ${loc} && ` : '';
  let get;
  if (r.bool) {
    get = `v=$(rdb ${loc}${absent})`;
    if (r.invert) get += '; v=$((1 - v))';
    if (r.map) {
      get += `; case "$v" in ${Object.entries(r.map).map(([k, c]) => `${k}) v=${c} ;;`).join(' ')} esac`;
    }
  } else if (r.map) {
    const arms = Object.entries(r.map).map(([k, c]) => `${sq(k)}) v=${c} ;;`).join(' ');
    get = `case "$(rd ${loc}${absent})" in ${arms} *) v=${r.other ? sq(r.other) : "''"} ;; esac`;
  } else if (r.scale) {
    get = `v=$(num "$(rd ${loc}${absent})" ${r.scale})`;
  } else {
    get = `v=$(rd ${loc}${absent})`;
  }
  if (guard) return [`v=""; ${guard}{ ${get}; }`, `[ -n "$v" ] && add ${s.code} "$v"`];
  return [get, `[ -n "$v" ] && ${add}`];
}

export function captureScript({ origin = '' } = {}) {
  const captured = SETTINGS.filter((s) => s.read || s.captureSh);
  // bash 3.2 misparses a case statement inside $( ), so multi-line readers are functions.
  const fns = captured.filter((s) => s.captureSh)
    .map((s) => `cap_${s.code}() {\n${s.captureSh().map((l) => `  ${l}`).join('\n')}\n}`);
  const body = captured.flatMap((s) => [`  # ${s.label}`, ...captureLines(s).map((l) => `  ${l}`)]);
  return `#!/bin/bash
# mymac ${VERSION} capture: reads this Mac's settings and opens the mymac builder with them
# filled in. It only reads; nothing on this Mac changes.
#
#   bash capture.sh            print the link and open it
#   bash capture.sh --no-open  just print it

H() { [ "$1" = 1 ] && printf '%s' -currentHost; }
rd() { defaults $(H "$1") read "$2" "$3" 2>/dev/null || printf '%s\\n' "\${4:-}"; }
rdb() { case "$(rd "$@")" in 1|true|YES) echo 1 ;; *) echo 0 ;; esac; }
has() { defaults $(H "$1") read "$2" "$3" >/dev/null 2>&1; }
num() { case "$1" in ''|*[!0-9.-]*) echo "" ;; *) awk -v x="$1" -v s="$2" 'BEGIN { printf "%d", x * s + 0.5 }' ;; esac; }
add() { [ -n "$2" ] && P="$P.$1$2"; }
${fns.join('\n')}

main() {
  if [ "$(uname -s)" != Darwin ]; then echo "mymac: this script is for macOS." >&2; exit 1; fi
  P="rs1"

${body.join('\n')}

  URL="${origin}/$P"
  echo "Your mymac code:"
  echo "  $P"
  echo ""
  echo "Open the builder to check it, add show settings and get the one-liner:"
  echo "  $URL"
  case "\${1:-}" in --no-open) ;; *) open "$URL" 2>/dev/null ;; esac
}

main "$@"
`;
}

export function restoreRunner() {
  return `#!/bin/bash
# mymac ${VERSION}: runs the restore script an earlier mymac run left on this Mac.
main() {
  if [ -f "$HOME/.mymac/restore.sh" ]; then
    bash "$HOME/.mymac/restore.sh"
  else
    echo "mymac: nothing to put back (no ~/.mymac/restore.sh on this Mac)."
  fi
}
main "$@"
`;
}
