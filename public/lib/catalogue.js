// The settings mymac knows about, as data.
//
// Each setting has a two-letter `code`; a profile is a set of `code -> value` pairs, and the
// share code is those pairs joined with dots (see code.js). Values are short strings drawn from
// [0-9a-zA-Z], so a whole profile can be typed into Terminal without quoting.
//
// `apply(v)` returns the operations that set the Mac to value v. The script generator turns each
// operation into a shell call that first records the current value (so restore.sh can put it
// back) and then writes the new one:
//
//   ['w', host, domain, key, type, value]          defaults write (host 1 = -currentHost)
//   ['d', host, domain, key]                       defaults delete
//   ['wif', host, domain, key, type, value, was]   write only where the current value is `was`
//   ['wall', hex]                                  solid-colour wallpaper on every screen
//   ['dark', 0|1]                                  appearance, through System Events
//   ['menubar', 0|1]                               menu bar auto-hide, through System Events
//   ['alert', n]                                   alert volume 0-100 (AppleScript, live)
//   ['awake']                                      caffeinate until restore runs
//
// `refresh` names what has to restart or reread for the change to show:
//   hid      activateSettings -u (trackpad, mouse, keyboard driver preferences)
//   dock     killall Dock          finder   killall Finder
//   wm       killall WindowManager cc       killall ControlCenter (menu bar clock)
//   relaunch apps pick it up as they reopen
//   logout   only takes full effect after logging out and back in
//
// `def` is the macOS default as a code value. A setting with a default can be put back to it by
// the "everything else to macOS defaults" switch; one with `reset: 'delete'` is reset by deleting
// its keys so macOS falls back to its own built-in value; `reset: false` is never reset.
//
// `read` / `captureSh` let capture.sh read a Mac's current value without changing anything.

const AMT = 'com.apple.AppleMultitouchTrackpad';
const BT = 'com.apple.driver.AppleBluetoothMultitouch.trackpad';
const MOUSE_AMT = 'com.apple.AppleMultitouchMouse';
const MOUSE_BT = 'com.apple.driver.AppleBluetoothMultitouch.mouse';
const G = 'NSGlobalDomain';
const DOCK = 'com.apple.dock';
const FINDER = 'com.apple.finder';
const WM = 'com.apple.WindowManager';

const on = (v) => v === '1';
const SYSTEM_EVENTS_HINT = 'allow Terminal to control System Events (System Settings > Privacy & Security > Automation) and run again';

// Built-in and Bluetooth trackpad domains: the driver reads both.
const tp = (key, type, value) => [
  ['w', 0, AMT, key, type, value],
  ['w', 0, BT, key, type, value],
];
// The current-host mirrors in the global domain, which System Settings displays.
const mirror = (key, type, value) => [['w', 1, G, `com.apple.trackpad.${key}`, type, value]];
// Write only where the gesture is currently `was`; an unset key counts as macOS's default, 2.
const tpIf = (key, value, was) => [
  ['wif', 0, AMT, key, 'int', value, was, 2],
  ['wif', 0, BT, key, 'int', value, was, 2],
];
const mirrorIf = (key, value, was) => [['wif', 1, G, `com.apple.trackpad.${key}`, 'int', value, was, 2]];

export const GROUPS = [
  { id: 'trackpad', title: 'Trackpad & mouse' },
  { id: 'pointer', title: 'Pointer' },
  { id: 'dock', title: 'Dock' },
  { id: 'menubar', title: 'Menu bar' },
  { id: 'look', title: 'Wallpaper & appearance' },
  { id: 'keyboard', title: 'Keyboard & typing' },
  { id: 'finder', title: 'Finder & desktop' },
  { id: 'windows', title: 'Windows, Spaces & gestures' },
  { id: 'show', title: 'Show safety' },
];

export const HOT_CORNER_ACTIONS = [
  { v: 0, label: 'Nothing' },
  { v: 2, label: 'Mission Control' },
  { v: 3, label: 'Application windows' },
  { v: 4, label: 'Desktop' },
  { v: 12, label: 'Notification Centre' },
  { v: 11, label: 'Launchpad / Apps' },
  { v: 14, label: 'Quick Note' },
  { v: 5, label: 'Start screen saver' },
  { v: 6, label: 'Disable screen saver' },
  { v: 10, label: 'Put display to sleep' },
  { v: 13, label: 'Lock screen' },
];
export const CORNERS = ['tl', 'tr', 'bl', 'br'];

const speedRange = { min: 0, max: 300, step: 5, unit: (v) => (v / 100).toFixed(2) };

export const SETTINGS = [
  // ── Trackpad & mouse ────────────────────────────────────────────────────────────────
  {
    code: 'tc', group: 'trackpad', label: 'Tap to click', kind: 'bool', def: '0',
    apply: (v) => [
      ...tp('Clicking', 'int', on(v) ? 1 : 0),
      ['w', 1, G, 'com.apple.mouse.tapBehavior', 'int', on(v) ? 1 : 0],
      ['w', 0, G, 'com.apple.mouse.tapBehavior', 'int', on(v) ? 1 : 0],
    ],
    refresh: ['hid'], read: { domain: AMT, key: 'Clicking', bool: true, absent: '0' },
  },
  {
    code: 'ns', group: 'trackpad', label: 'Natural scrolling',
    help: 'Content follows your fingers. macOS uses one switch for trackpad and mouse.',
    kind: 'bool', def: '1',
    apply: (v) => [['w', 0, G, 'com.apple.swipescrolldirection', 'bool', on(v)]],
    refresh: ['hid'], read: { domain: G, key: 'com.apple.swipescrolldirection', bool: true, absent: '1' },
  },
  {
    code: 'ts', group: 'trackpad', label: 'Trackpad tracking speed', kind: 'range', range: speedRange,
    def: null, reset: 'delete',
    apply: (v) => [['w', 0, G, 'com.apple.trackpad.scaling', 'float', Number(v) / 100]],
    resetOps: () => [['d', 0, G, 'com.apple.trackpad.scaling']],
    refresh: ['hid'], read: { domain: G, key: 'com.apple.trackpad.scaling', scale: 100 },
  },
  {
    code: 'rc', group: 'trackpad', label: 'Secondary (right) click', kind: 'choice', def: 'f',
    options: [
      { v: 'f', label: 'Click with two fingers' },
      { v: 'r', label: 'Click bottom-right corner' },
      { v: 'l', label: 'Click bottom-left corner' },
      { v: 'o', label: 'Off' },
    ],
    apply: (v) => [
      ...tp('TrackpadRightClick', 'bool', v === 'f'),
      ...tp('TrackpadCornerSecondaryClick', 'int', { r: 2, l: 1 }[v] ?? 0),
      ...mirror('enableSecondaryClick', 'bool', v === 'f'),
      ...mirror('trackpadCornerClickBehavior', 'int', v === 'r' || v === 'l' ? 1 : 0),
    ],
    refresh: ['hid'],
    captureSh: () => [
      `if [ "$(rdb 0 ${AMT} TrackpadRightClick 1)" = 1 ]; then echo f; else`,
      `  case "$(rd 0 ${AMT} TrackpadCornerSecondaryClick 0)" in 2) echo r;; 1) echo l;; *) echo o;; esac`,
      'fi',
    ],
  },
  {
    code: 'td', group: 'trackpad', label: 'Three-finger drag',
    help: 'Turning it on moves the three-finger swipes to four fingers, as System Settings does.',
    kind: 'bool', def: '0',
    apply: (v) => on(v)
      ? [
        ...tp('TrackpadThreeFingerDrag', 'bool', true),
        ...mirror('threeFingerDragGesture', 'bool', true),
        ...tp('TrackpadThreeFingerHorizSwipeGesture', 'int', 0),
        ...tp('TrackpadThreeFingerVertSwipeGesture', 'int', 0),
        ...mirror('threeFingerHorizSwipeGesture', 'int', 0),
        ...mirror('threeFingerVertSwipeGesture', 'int', 0),
        ...tp('TrackpadFourFingerHorizSwipeGesture', 'int', 2),
        ...tp('TrackpadFourFingerVertSwipeGesture', 'int', 2),
        ...mirror('fourFingerHorizSwipeGesture', 'int', 2),
        ...mirror('fourFingerVertSwipeGesture', 'int', 2),
      ]
      : [...tp('TrackpadThreeFingerDrag', 'bool', false), ...mirror('threeFingerDragGesture', 'bool', false)],
    refresh: ['hid'], read: { domain: AMT, key: 'TrackpadThreeFingerDrag', bool: true, absent: '0' },
  },
  {
    code: 'fc', group: 'trackpad', label: 'Force Click and haptic feedback', kind: 'bool', def: '1',
    apply: (v) => [
      ['w', 0, AMT, 'ForceSuppressed', 'bool', !on(v)],
      ['w', 0, G, 'com.apple.trackpad.forceClick', 'bool', on(v)],
    ],
    refresh: ['hid'], read: { domain: G, key: 'com.apple.trackpad.forceClick', bool: true, absent: '1' },
  },
  {
    code: 'cp', group: 'trackpad', label: 'Click pressure', kind: 'choice', def: '1',
    options: [{ v: '0', label: 'Light' }, { v: '1', label: 'Medium' }, { v: '2', label: 'Firm' }],
    apply: (v) => [...tp('FirstClickThreshold', 'int', Number(v)), ...tp('SecondClickThreshold', 'int', Number(v))],
    refresh: ['hid'], read: { domain: AMT, key: 'FirstClickThreshold', int: true, absent: '1' },
  },
  {
    code: 'ms', group: 'trackpad', label: 'Mouse tracking speed', kind: 'range', range: speedRange,
    def: null, reset: 'delete',
    apply: (v) => [['w', 0, G, 'com.apple.mouse.scaling', 'float', Number(v) / 100]],
    resetOps: () => [['d', 0, G, 'com.apple.mouse.scaling']],
    refresh: ['hid'], read: { domain: G, key: 'com.apple.mouse.scaling', scale: 100 },
  },

  // ── Pointer ─────────────────────────────────────────────────────────────────────────
  {
    code: 'cs', group: 'pointer', label: 'Pointer size',
    help: 'macOS guards this one: if Terminal is refused, the script says so and you set it in System Settings › Accessibility › Display.',
    kind: 'range', range: { min: 100, max: 400, step: 25, unit: (v) => `${(v / 100).toFixed(2)}×` }, def: '100',
    apply: (v) => [['w', 0, 'com.apple.universalaccess', 'mouseDriverCursorSize', 'float', Number(v) / 100]],
    refresh: ['logout'], read: { domain: 'com.apple.universalaccess', key: 'mouseDriverCursorSize', scale: 100, absent: '1' },
    failHint: 'macOS refused; set it in System Settings > Accessibility > Display > Pointer size',
  },
  {
    code: 'sk', group: 'pointer', label: 'Shake pointer to find it',
    help: 'Off stops the pointer ballooning on the projector when the mouse is jiggled.',
    kind: 'bool', def: '1',
    apply: (v) => [['w', 0, G, 'CGDisableCursorLocationMagnification', 'bool', !on(v)]],
    refresh: ['logout'], read: { domain: G, key: 'CGDisableCursorLocationMagnification', bool: true, invert: true, absent: '0' },
  },

  // ── Dock ────────────────────────────────────────────────────────────────────────────
  {
    code: 'dp', group: 'dock', label: 'Position on screen', kind: 'choice', def: 'b',
    options: [{ v: 'l', label: 'Left' }, { v: 'b', label: 'Bottom' }, { v: 'r', label: 'Right' }],
    apply: (v) => [['w', 0, DOCK, 'orientation', 'string', { l: 'left', b: 'bottom', r: 'right' }[v]]],
    refresh: ['dock'], read: { domain: DOCK, key: 'orientation', map: { left: 'l', bottom: 'b', right: 'r' }, absent: 'bottom' },
  },
  {
    code: 'da', group: 'dock', label: 'Automatically hide and show the Dock', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, DOCK, 'autohide', 'bool', on(v)]],
    refresh: ['dock'], read: { domain: DOCK, key: 'autohide', bool: true, absent: '0' },
  },
  {
    code: 'di', group: 'dock', label: 'Hidden Dock appears instantly', kind: 'bool', def: '0',
    apply: (v) => on(v)
      ? [['w', 0, DOCK, 'autohide-delay', 'float', 0], ['w', 0, DOCK, 'autohide-time-modifier', 'float', 0.25]]
      : [['d', 0, DOCK, 'autohide-delay'], ['d', 0, DOCK, 'autohide-time-modifier']],
    refresh: ['dock'],
    captureSh: () => [`case "$(rd 0 ${DOCK} autohide-delay x)" in 0|0.0) echo 1;; *) echo 0;; esac`],
  },
  {
    code: 'dz', group: 'dock', label: 'Size', kind: 'range', range: { min: 16, max: 128, step: 1, unit: (v) => `${v} pt` },
    def: null, reset: 'delete',
    apply: (v) => [['w', 0, DOCK, 'tilesize', 'float', Number(v)]],
    resetOps: () => [['d', 0, DOCK, 'tilesize']],
    refresh: ['dock'], read: { domain: DOCK, key: 'tilesize', scale: 1 },
  },
  {
    code: 'dm', group: 'dock', label: 'Magnification', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, DOCK, 'magnification', 'bool', on(v)]],
    refresh: ['dock'], read: { domain: DOCK, key: 'magnification', bool: true, absent: '0' },
  },
  {
    code: 'dl', group: 'dock', label: 'Magnified size', kind: 'range', range: { min: 16, max: 128, step: 1, unit: (v) => `${v} pt` },
    def: null, reset: 'delete',
    apply: (v) => [['w', 0, DOCK, 'largesize', 'float', Number(v)]],
    resetOps: () => [['d', 0, DOCK, 'largesize']],
    refresh: ['dock'], read: { domain: DOCK, key: 'largesize', scale: 1 },
  },
  {
    code: 'dr', group: 'dock', label: 'Show suggested and recent apps', kind: 'bool', def: '1',
    apply: (v) => [['w', 0, DOCK, 'show-recents', 'bool', on(v)]],
    refresh: ['dock'], read: { domain: DOCK, key: 'show-recents', bool: true, absent: '1' },
  },
  {
    code: 'de', group: 'dock', label: 'Minimise windows using', kind: 'choice', def: 'g',
    options: [{ v: 'g', label: 'Genie effect' }, { v: 's', label: 'Scale effect' }],
    apply: (v) => [['w', 0, DOCK, 'mineffect', 'string', v === 's' ? 'scale' : 'genie']],
    refresh: ['dock'], read: { domain: DOCK, key: 'mineffect', map: { genie: 'g', scale: 's' }, absent: 'genie' },
  },
  {
    code: 'dw', group: 'dock', label: 'Minimise windows into app icon', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, DOCK, 'minimize-to-application', 'bool', on(v)]],
    refresh: ['dock'], read: { domain: DOCK, key: 'minimize-to-application', bool: true, absent: '0' },
  },
  {
    code: 'dx', group: 'dock', label: 'Show only open apps', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, DOCK, 'static-only', 'bool', on(v)]],
    refresh: ['dock'], read: { domain: DOCK, key: 'static-only', bool: true, absent: '0' },
  },
  {
    code: 'db', group: 'dock', label: 'Animate opening apps', kind: 'bool', def: '1',
    apply: (v) => [['w', 0, DOCK, 'launchanim', 'bool', on(v)]],
    refresh: ['dock'], read: { domain: DOCK, key: 'launchanim', bool: true, absent: '1' },
  },
  {
    code: 'dn', group: 'dock', label: 'Show indicators for open apps', kind: 'bool', def: '1',
    apply: (v) => [['w', 0, DOCK, 'show-process-indicators', 'bool', on(v)]],
    refresh: ['dock'], read: { domain: DOCK, key: 'show-process-indicators', bool: true, absent: '1' },
  },

  // ── Menu bar ────────────────────────────────────────────────────────────────────────
  {
    code: 'mh', group: 'menubar', label: 'Automatically hide the menu bar',
    help: 'Set through System Events, so macOS asks once to let Terminal control it.',
    kind: 'bool', def: '0',
    apply: (v) => [['menubar', on(v) ? 1 : 0]],
    refresh: [], read: { domain: G, key: '_HIHideMenuBar', bool: true, absent: '0' },
    failHint: SYSTEM_EVENTS_HINT,
  },
  {
    code: 'ck', group: 'menubar', label: 'Clock shows seconds', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, 'com.apple.menuextra.clock', 'ShowSeconds', 'bool', on(v)]],
    refresh: ['cc'], read: { domain: 'com.apple.menuextra.clock', key: 'ShowSeconds', bool: true, absent: '0' },
  },
  {
    code: 'hr', group: 'menubar', label: 'Time format', kind: 'choice', def: null, reset: 'delete',
    help: 'Left alone, macOS follows the region set on the Mac.',
    options: [{ v: '1', label: '24-hour' }, { v: '0', label: '12-hour' }],
    apply: (v) => [['w', 0, G, 'AppleICUForce24HourTime', 'bool', on(v)]],
    resetOps: () => [['d', 0, G, 'AppleICUForce24HourTime']],
    refresh: ['cc', 'relaunch'], read: { domain: G, key: 'AppleICUForce24HourTime', bool: true },
  },

  // ── Wallpaper & appearance ──────────────────────────────────────────────────────────
  {
    code: 'wp', group: 'look', label: 'Wallpaper colour',
    help: 'A solid colour on every screen. Black disappears on a projector between cues. The old wallpaper, dynamic and aerial ones included, comes back on restore.',
    kind: 'color', def: null, reset: false,
    apply: (v) => [['wall', v.toLowerCase()]],
    refresh: [],
  },
  {
    code: 'ap', group: 'look', label: 'Appearance',
    help: 'Set through System Events, so macOS asks once to let Terminal control it.',
    kind: 'choice', def: 'l',
    options: [{ v: 'l', label: 'Light' }, { v: 'd', label: 'Dark' }],
    apply: (v) => [
      ['w', 0, G, 'AppleInterfaceStyleSwitchesAutomatically', 'bool', false],
      ['dark', v === 'd' ? 1 : 0],
    ],
    refresh: [], read: { domain: G, key: 'AppleInterfaceStyle', map: { Dark: 'd' }, absent: 'Light', other: 'l' },
    failHint: SYSTEM_EVENTS_HINT,
  },
  {
    code: 'sb', group: 'look', label: 'Show scroll bars', kind: 'choice', def: 'a',
    options: [{ v: 'a', label: 'Automatically' }, { v: 's', label: 'When scrolling' }, { v: 'l', label: 'Always' }],
    apply: (v) => [['w', 0, G, 'AppleShowScrollBars', 'string', { a: 'Automatic', s: 'WhenScrolling', l: 'Always' }[v]]],
    refresh: ['relaunch'], read: { domain: G, key: 'AppleShowScrollBars', map: { Automatic: 'a', WhenScrolling: 's', Always: 'l' }, absent: 'Automatic' },
  },

  // ── Keyboard & typing ───────────────────────────────────────────────────────────────
  {
    code: 'kr', group: 'keyboard', label: 'Key repeat rate', kind: 'choice', def: null, reset: 'delete',
    options: [
      { v: '2', label: 'Fastest' }, { v: '6', label: 'Fast' }, { v: '12', label: 'Medium' },
      { v: '30', label: 'Slow' }, { v: '60', label: 'Slower' }, { v: '120', label: 'Slowest' },
    ],
    apply: (v) => [['w', 0, G, 'KeyRepeat', 'int', Number(v)]],
    resetOps: () => [['d', 0, G, 'KeyRepeat']],
    refresh: ['relaunch'], read: { domain: G, key: 'KeyRepeat', int: true },
  },
  {
    code: 'kd', group: 'keyboard', label: 'Delay until repeat', kind: 'choice', def: null, reset: 'delete',
    options: [
      { v: '15', label: 'Shortest' }, { v: '25', label: 'Short' }, { v: '35', label: 'Medium' },
      { v: '68', label: 'Long' }, { v: '94', label: 'Longer' }, { v: '120', label: 'Longest' },
    ],
    apply: (v) => [['w', 0, G, 'InitialKeyRepeat', 'int', Number(v)]],
    resetOps: () => [['d', 0, G, 'InitialKeyRepeat']],
    refresh: ['relaunch'], read: { domain: G, key: 'InitialKeyRepeat', int: true },
  },
  {
    code: 'ph', group: 'keyboard', label: 'Hold a key for accents (off: hold to repeat)', kind: 'bool', def: '1',
    apply: (v) => [['w', 0, G, 'ApplePressAndHoldEnabled', 'bool', on(v)]],
    refresh: ['relaunch'], read: { domain: G, key: 'ApplePressAndHoldEnabled', bool: true, absent: '1' },
  },
  {
    code: 'fn', group: 'keyboard', label: 'Use F1, F2… as standard function keys', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, G, 'com.apple.keyboard.fnState', 'bool', on(v)]],
    refresh: ['hid'], read: { domain: G, key: 'com.apple.keyboard.fnState', bool: true, absent: '0' },
  },
  {
    code: 'ac', group: 'keyboard', label: 'Correct spelling automatically', kind: 'bool', def: '1',
    apply: (v) => [
      ['w', 0, G, 'NSAutomaticSpellingCorrectionEnabled', 'bool', on(v)],
      ['w', 0, G, 'WebAutomaticSpellingCorrectionEnabled', 'bool', on(v)],
    ],
    refresh: ['relaunch'], read: { domain: G, key: 'NSAutomaticSpellingCorrectionEnabled', bool: true, absent: '1' },
  },
  {
    code: 'ak', group: 'keyboard', label: 'Capitalise words automatically', kind: 'bool', def: '1',
    apply: (v) => [['w', 0, G, 'NSAutomaticCapitalizationEnabled', 'bool', on(v)]],
    refresh: ['relaunch'], read: { domain: G, key: 'NSAutomaticCapitalizationEnabled', bool: true, absent: '1' },
  },
  {
    code: 'sq', group: 'keyboard', label: 'Smart quotes and dashes',
    help: 'Off keeps cue names, file paths and lower-third text exactly as typed.',
    kind: 'bool', def: '1',
    apply: (v) => [
      ['w', 0, G, 'NSAutomaticQuoteSubstitutionEnabled', 'bool', on(v)],
      ['w', 0, G, 'NSAutomaticDashSubstitutionEnabled', 'bool', on(v)],
    ],
    refresh: ['relaunch'], read: { domain: G, key: 'NSAutomaticQuoteSubstitutionEnabled', bool: true, absent: '1' },
  },
  {
    code: 'pd', group: 'keyboard', label: 'Add full stop with double-space', kind: 'bool', def: '1',
    apply: (v) => [['w', 0, G, 'NSAutomaticPeriodSubstitutionEnabled', 'bool', on(v)]],
    refresh: ['relaunch'], read: { domain: G, key: 'NSAutomaticPeriodSubstitutionEnabled', bool: true, absent: '1' },
  },

  // ── Finder & desktop ────────────────────────────────────────────────────────────────
  {
    code: 'dk', group: 'finder', label: 'Show icons on the desktop',
    help: 'Off keeps files and drives off the projector when the desktop shows.',
    kind: 'bool', def: '1',
    apply: (v) => [['w', 0, FINDER, 'CreateDesktop', 'bool', on(v)]],
    refresh: ['finder'], read: { domain: FINDER, key: 'CreateDesktop', bool: true, absent: '1' },
  },
  {
    code: 'ex', group: 'finder', label: 'Show all filename extensions', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, G, 'AppleShowAllExtensions', 'bool', on(v)]],
    refresh: ['finder'], read: { domain: G, key: 'AppleShowAllExtensions', bool: true, absent: '0' },
  },
  {
    code: 'hf', group: 'finder', label: 'Show hidden files', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, FINDER, 'AppleShowAllFiles', 'bool', on(v)]],
    refresh: ['finder'], read: { domain: FINDER, key: 'AppleShowAllFiles', bool: true, absent: '0' },
  },
  {
    code: 'pb', group: 'finder', label: 'Show path bar', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, FINDER, 'ShowPathbar', 'bool', on(v)]],
    refresh: ['finder'], read: { domain: FINDER, key: 'ShowPathbar', bool: true, absent: '0' },
  },
  {
    code: 'su', group: 'finder', label: 'Show status bar', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, FINDER, 'ShowStatusBar', 'bool', on(v)]],
    refresh: ['finder'], read: { domain: FINDER, key: 'ShowStatusBar', bool: true, absent: '0' },
  },
  {
    code: 'fv', group: 'finder', label: 'New Finder windows use', kind: 'choice', def: 'i',
    help: 'Folders that already remember a view keep it.',
    options: [{ v: 'i', label: 'Icons' }, { v: 'n', label: 'List' }, { v: 'c', label: 'Columns' }, { v: 'g', label: 'Gallery' }],
    apply: (v) => [['w', 0, FINDER, 'FXPreferredViewStyle', 'string', { i: 'icnv', n: 'Nlsv', c: 'clmv', g: 'glyv' }[v]]],
    refresh: ['finder'], read: { domain: FINDER, key: 'FXPreferredViewStyle', map: { icnv: 'i', Nlsv: 'n', clmv: 'c', glyv: 'g' }, absent: 'icnv' },
  },

  // ── Windows, Spaces & gestures ──────────────────────────────────────────────────────
  {
    code: 'cw', group: 'windows', label: 'Click wallpaper to reveal desktop', kind: 'choice', def: 'a',
    help: '"Always" is the macOS default that sweeps every window aside when someone clicks the desktop.',
    options: [{ v: 'a', label: 'Always' }, { v: 's', label: 'Only in Stage Manager' }],
    apply: (v) => [['w', 0, WM, 'EnableStandardClickToShowDesktop', 'bool', v === 'a']],
    refresh: ['wm'], read: { domain: WM, key: 'EnableStandardClickToShowDesktop', bool: true, absent: '1', map: { 1: 'a', 0: 's' } },
  },
  {
    code: 'sm', group: 'windows', label: 'Stage Manager', kind: 'bool', def: '0',
    apply: (v) => [['w', 0, WM, 'GloballyEnabled', 'bool', on(v)]],
    refresh: ['wm'], read: { domain: WM, key: 'GloballyEnabled', bool: true, absent: '0' },
  },
  {
    code: 'tg', group: 'windows', label: 'Tile windows by dragging to screen edges', kind: 'bool', def: '1',
    apply: (v) => [
      ['w', 0, WM, 'EnableTilingByEdgeDrag', 'bool', on(v)],
      ['w', 0, WM, 'EnableTopTilingByEdgeDrag', 'bool', on(v)],
    ],
    refresh: ['wm'], read: { domain: WM, key: 'EnableTilingByEdgeDrag', bool: true, absent: '1' },
  },
  {
    code: 'mr', group: 'windows', label: 'Rearrange Spaces by most recent use', kind: 'bool', def: '1',
    apply: (v) => [['w', 0, DOCK, 'mru-spaces', 'bool', on(v)]],
    refresh: ['dock'], read: { domain: DOCK, key: 'mru-spaces', bool: true, absent: '1' },
  },
  {
    code: 'sp', group: 'windows', label: 'Displays have separate Spaces', kind: 'bool', def: '1',
    apply: (v) => [['w', 0, 'com.apple.spaces', 'spans-displays', 'bool', !on(v)]],
    refresh: ['logout'], read: { domain: 'com.apple.spaces', key: 'spans-displays', bool: true, invert: true, absent: '0' },
  },
  {
    code: 'sw', group: 'windows', label: 'Swipe between full-screen apps',
    help: 'Off stops a stray swipe flicking Keynote or PowerPoint off the screen. Swipe between pages is left alone.',
    kind: 'bool', def: '1',
    apply: (v) => on(v)
      ? [...tp('TrackpadFourFingerHorizSwipeGesture', 'int', 2), ...mirror('fourFingerHorizSwipeGesture', 'int', 2)]
      : [
        ...tp('TrackpadFourFingerHorizSwipeGesture', 'int', 0),
        ...mirror('fourFingerHorizSwipeGesture', 'int', 0),
        ...tpIf('TrackpadThreeFingerHorizSwipeGesture', 0, 2),
        ...mirrorIf('threeFingerHorizSwipeGesture', 0, 2),
        ['wif', 0, MOUSE_AMT, 'MouseTwoFingerHorizSwipeGesture', 'int', 0, 2, 2],
        ['wif', 0, MOUSE_BT, 'MouseTwoFingerHorizSwipeGesture', 'int', 0, 2, 2],
      ],
    refresh: ['hid'],
    captureSh: () => [
      `if [ "$(rd 0 ${AMT} TrackpadFourFingerHorizSwipeGesture 2)" = 2 ] || [ "$(rd 0 ${AMT} TrackpadThreeFingerHorizSwipeGesture 2)" = 2 ]; then echo 1; else echo 0; fi`,
    ],
  },
  {
    code: 'mc', group: 'windows', label: 'Swipe up for Mission Control, down for App Exposé', kind: 'bool', def: '1',
    apply: (v) => on(v)
      ? [
        ...tp('TrackpadFourFingerVertSwipeGesture', 'int', 2),
        ...mirror('fourFingerVertSwipeGesture', 'int', 2),
        ['w', 0, DOCK, 'showMissionControlGestureEnabled', 'bool', true],
        ['w', 0, DOCK, 'showAppExposeGestureEnabled', 'bool', true],
      ]
      : [
        ...tp('TrackpadFourFingerVertSwipeGesture', 'int', 0),
        ...mirror('fourFingerVertSwipeGesture', 'int', 0),
        ...tpIf('TrackpadThreeFingerVertSwipeGesture', 0, 2),
        ...mirrorIf('threeFingerVertSwipeGesture', 0, 2),
        ['w', 0, DOCK, 'showMissionControlGestureEnabled', 'bool', false],
        ['w', 0, DOCK, 'showAppExposeGestureEnabled', 'bool', false],
      ],
    refresh: ['hid', 'dock'],
    captureSh: () => [
      `if [ "$(rd 0 ${AMT} TrackpadFourFingerVertSwipeGesture 2)" = 2 ] || [ "$(rd 0 ${AMT} TrackpadThreeFingerVertSwipeGesture 2)" = 2 ]; then echo 1; else echo 0; fi`,
    ],
  },
  {
    code: 'nc', group: 'windows', label: 'Swipe in from the right edge for Notification Centre', kind: 'bool', def: '1',
    apply: (v) => [
      ...tp('TrackpadTwoFingerFromRightEdgeSwipeGesture', 'int', on(v) ? 3 : 0),
      ...mirror('twoFingerFromRightEdgeSwipeGesture', 'int', on(v) ? 3 : 0),
    ],
    refresh: ['hid'],
    captureSh: () => [`case "$(rd 0 ${AMT} TrackpadTwoFingerFromRightEdgeSwipeGesture 3)" in 0) echo 0;; *) echo 1;; esac`],
  },
  {
    code: 'lp', group: 'windows', label: 'Pinch for Apps, spread for desktop', kind: 'bool', def: '1',
    apply: (v) => [
      ...tp('TrackpadFourFingerPinchGesture', 'int', on(v) ? 2 : 0),
      ...tp('TrackpadFiveFingerPinchGesture', 'int', on(v) ? 2 : 0),
      ...mirror('fourFingerPinchSwipeGesture', 'int', on(v) ? 2 : 0),
      ...mirror('fiveFingerPinchSwipeGesture', 'int', on(v) ? 2 : 0),
      ['w', 0, DOCK, 'showLaunchpadGestureEnabled', 'bool', on(v)],
      ['w', 0, DOCK, 'showDesktopGestureEnabled', 'bool', on(v)],
    ],
    refresh: ['hid', 'dock'],
    captureSh: () => [`case "$(rd 0 ${AMT} TrackpadFourFingerPinchGesture 2)" in 0) echo 0;; *) echo 1;; esac`],
  },
  {
    code: 'bk', group: 'windows', label: 'Two-finger swipe for back and forward in browsers',
    help: 'Off stops a web-based graphics page navigating away on a sideways scroll.',
    kind: 'bool', def: '1',
    apply: (v) => [['w', 0, G, 'AppleEnableSwipeNavigateWithScrolls', 'bool', on(v)]],
    refresh: ['relaunch'], read: { domain: G, key: 'AppleEnableSwipeNavigateWithScrolls', bool: true, absent: '1' },
  },

  // ── Show safety ─────────────────────────────────────────────────────────────────────
  {
    code: 'hc', group: 'show', label: 'Hot corners', kind: 'corners', def: null, reset: false,
    help: 'Recent macOS puts Quick Note in the bottom-right corner, which a pointer parked out of shot will find.',
    apply: (v) => CORNERS.flatMap((c, i) => {
      const n = parseInt(v[i], 36) || 1; // 0 (nothing) is written as 1, as System Settings does
      return [['w', 0, DOCK, `wvous-${c}-corner`, 'int', n], ['w', 0, DOCK, `wvous-${c}-modifier`, 'int', 0]];
    }),
    refresh: ['dock'],
    captureSh: () => [
      'hc=""',
      'for c in tl tr bl br; do',
      `  n=$(rd 0 ${DOCK} wvous-$c-corner 1)`,
      '  case "$n" in 0|1) n=0;; 10) n=a;; 11) n=b;; 12) n=c;; 13) n=d;; 14) n=e;; [2-9]) ;; *) n=0;; esac',
      '  hc="$hc$n"',
      'done',
      'echo "$hc"',
    ],
    alwaysCapture: true,
  },
  {
    code: 'ss', group: 'show', label: 'Start screen saver after', kind: 'choice', def: null, reset: false,
    options: [
      { v: '0', label: 'Never' }, { v: '5', label: '5 minutes' }, { v: '10', label: '10 minutes' },
      { v: '20', label: '20 minutes' }, { v: '60', label: '1 hour' },
    ],
    apply: (v) => [['w', 1, 'com.apple.screensaver', 'idleTime', 'int', Number(v) * 60]],
    refresh: [],
  },
  {
    code: 'ka', group: 'show', label: 'Keep the Mac and its displays awake until restore',
    help: 'Runs caffeinate in the background, no admin password needed. It stops at restore, logout or restart.',
    kind: 'flag', def: null, reset: false,
    apply: (v) => (on(v) ? [['awake']] : []),
    refresh: [],
  },
  {
    code: 'as', group: 'show', label: 'Silence alert and interface sounds',
    help: 'Alert beeps go wherever the Mac\'s sound goes, which is often the PA.',
    kind: 'flag', def: null, reset: false,
    apply: (v) => (on(v)
      ? [
        ['alert', 0],
        ['w', 0, G, 'com.apple.sound.uiaudio.enabled', 'int', 0],
        ['w', 0, G, 'com.apple.sound.beep.feedback', 'int', 0],
      ]
      : []),
    refresh: [],
  },
  {
    code: 'ar', group: 'show', label: 'AirPlay Receiver',
    help: 'Off stops another device taking over the screen and frees TCP 5000 and 7000.',
    kind: 'bool', def: null, reset: false,
    apply: (v) => [
      ['w', 1, 'com.apple.controlcenter', 'AirplayReceiverEnabled', 'bool', on(v)],
      ['w', 1, 'com.apple.controlcenter', 'AirplayRecieverEnabled', 'bool', on(v)],
    ],
    refresh: [],
  },
  {
    code: 'cn', group: 'show', label: 'Send crash reports to Notification Centre',
    help: 'On, an app crash posts a notification instead of a window over the show.',
    kind: 'flag', def: null, reset: false,
    apply: (v) => (on(v) ? [['w', 0, 'com.apple.CrashReporter', 'UseUNC', 'bool', true]] : []),
    refresh: [],
  },
];

export const BY_CODE = Object.fromEntries(SETTINGS.map((s) => [s.code, s]));

// What one click of "Show-safe pack" sets.
export const SHOW_SAFE = {
  hc: '0000', cw: 's', sm: '0', sw: '0', mc: '0', nc: '0', lp: '0', bk: '0',
  ss: '0', ka: '1', as: '1', ar: '0', cn: '1', dk: '0', wp: '000000', mr: '0', sk: '0',
};

// Things worth doing on a show machine that a script cannot do for you.
export const MANUAL_CHECKS = [
  'Turn on Do Not Disturb (Control Centre > Focus).',
  'Check display arrangement and mirroring (System Settings > Displays).',
  'Check the sound output device and its volume.',
];

export function isResettable(s) {
  return s.reset !== false && (s.def != null || s.reset === 'delete');
}
