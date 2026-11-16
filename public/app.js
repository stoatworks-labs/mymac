import { GROUPS, SETTINGS, HOT_CORNER_ACTIONS, CORNERS, SHOW_SAFE, isResettable } from './lib/catalogue.js';
import { decode, encode } from './lib/code.js';
import { applyScript } from './lib/script.js';

const FALLBACK_ORIGIN = 'https://mymac.stoatworks-labs.com';
const served = location.protocol === 'http:' || location.protocol === 'https:';
const ORIGIN = served ? location.origin : FALLBACK_ORIGIN;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
};

// ── State ────────────────────────────────────────────────────────────────────────────
const initial = decode(served ? location.pathname : '');
let profile = initial.profile;
const controls = {}; // code -> { row, sync() }

function setValue(code, value) {
  if (value == null) delete profile[code];
  else profile[code] = value;
  render();
}

// ── Building the rows ────────────────────────────────────────────────────────────────
const defLabel = (s) => {
  if (s.def == null) return s.reset === 'delete' ? 'macOS default: depends on the Mac' : '';
  if (s.kind === 'bool') return `macOS default: ${s.def === '1' ? 'on' : 'off'}`;
  if (s.kind === 'choice') return `macOS default: ${s.options.find((o) => o.v === s.def)?.label ?? s.def}`;
  if (s.kind === 'range') return `macOS default: ${s.range.unit(Number(s.def))}`;
  return '';
};

let uid = 0;
function boolControl(s) {
  const name = `seg-${uid++}`;
  const opts = [['', 'Leave'], ['1', 'On'], ['0', 'Off']];
  const inputs = [];
  const seg = el('div', { className: 'seg', role: 'radiogroup' });
  seg.setAttribute('aria-label', s.label);
  for (const [v, text] of opts) {
    const input = el('input', { type: 'radio', name, value: v });
    input.addEventListener('change', () => setValue(s.code, v || null));
    inputs.push(input);
    seg.append(el('label', {}, input, el('span', { textContent: text })));
  }
  return { node: seg, sync: () => { for (const i of inputs) i.checked = i.value === (profile[s.code] ?? ''); } };
}

function choiceControl(s) {
  const sel = el('select');
  sel.setAttribute('aria-label', s.label);
  sel.append(el('option', { value: '', textContent: 'Leave as it is' }));
  for (const o of s.options) {
    sel.append(el('option', { value: o.v, textContent: o.v === s.def ? `${o.label} (default)` : o.label }));
  }
  sel.addEventListener('change', () => setValue(s.code, sel.value || null));
  return { node: sel, sync: () => { sel.value = profile[s.code] ?? ''; sel.classList.toggle('isset', profile[s.code] != null); } };
}

function rangeControl(s) {
  const { min, max, step, unit } = s.range;
  const start = s.def ?? String(Math.round((min + max) / 2 / step) * step);
  const check = el('input', { type: 'checkbox' });
  const slider = el('input', { type: 'range', min, max, step, value: start });
  const out = el('output');
  check.setAttribute('aria-label', `Set ${s.label}`);
  slider.setAttribute('aria-label', s.label);
  check.addEventListener('change', () => setValue(s.code, check.checked ? slider.value : null));
  slider.addEventListener('input', () => { out.textContent = unit(Number(slider.value)); if (check.checked) setValue(s.code, slider.value); });
  const node = el('div', { className: 'range' }, el('label', { className: 'check' }, check, 'Set'), slider, out);
  return {
    node,
    sync: () => {
      const v = profile[s.code];
      check.checked = v != null;
      slider.disabled = v == null;
      if (v != null) slider.value = v;
      out.textContent = unit(Number(slider.value));
    },
  };
}

function flagControl(s) {
  const check = el('input', { type: 'checkbox' });
  check.setAttribute('aria-label', s.label);
  check.addEventListener('change', () => setValue(s.code, check.checked ? '1' : null));
  return { node: el('label', { className: 'check' }, check, 'Do it'), sync: () => { check.checked = profile[s.code] === '1'; } };
}

function colourControl(s) {
  const check = el('input', { type: 'checkbox' });
  const picker = el('input', { type: 'color', value: '#000000' });
  check.setAttribute('aria-label', `Set ${s.label}`);
  picker.setAttribute('aria-label', s.label);
  const pick = (hex) => { picker.value = `#${hex}`; setValue(s.code, hex); };
  check.addEventListener('change', () => setValue(s.code, check.checked ? picker.value.slice(1) : null));
  picker.addEventListener('input', () => setValue(s.code, picker.value.slice(1)));
  const swatches = [['000000', 'Black'], ['3a3a3c', 'Graphite'], ['0e2942', 'Navy'], ['00b140', 'Chroma green']].map(([hex, name]) => {
    const b = el('button', { type: 'button', className: 'swatch', title: name });
    b.style.background = `#${hex}`;
    b.setAttribute('aria-label', `${name} wallpaper`);
    b.addEventListener('click', () => pick(hex));
    return b;
  });
  return {
    node: el('div', { className: 'colour' }, el('label', { className: 'check' }, check, 'Set'), picker, ...swatches),
    sync: () => {
      const v = profile[s.code];
      check.checked = v != null;
      if (v != null) picker.value = `#${v}`;
    },
  };
}

function cornersControl(s) {
  const check = el('input', { type: 'checkbox' });
  check.setAttribute('aria-label', 'Set hot corners');
  const names = { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' };
  const sels = CORNERS.map((c, i) => {
    const sel = el('select');
    sel.setAttribute('aria-label', `${names[c]} hot corner`);
    for (const a of HOT_CORNER_ACTIONS) sel.append(el('option', { value: a.v.toString(36), textContent: a.label }));
    sel.addEventListener('change', () => {
      const cur = (profile.hc ?? '0000').split('');
      cur[i] = sel.value;
      setValue('hc', cur.join(''));
    });
    return el('div', { className: c }, el('label', { className: 'def', textContent: names[c] }), sel);
  });
  check.addEventListener('change', () => setValue('hc', check.checked ? '0000' : null));
  const grid = el('div', { className: 'corners' }, ...sels);
  return {
    node: el('label', { className: 'check' }, check, 'Set'),
    extra: grid,
    sync: () => {
      const v = profile.hc;
      check.checked = v != null;
      grid.hidden = v == null;
      sels.forEach((wrap, i) => { wrap.querySelector('select').value = (v ?? '0000')[i]; });
    },
  };
}

const MAKERS = { bool: boolControl, choice: choiceControl, range: rangeControl, flag: flagControl, color: colourControl, corners: cornersControl };

function build() {
  const root = $('settings');
  for (const g of GROUPS) {
    const count = el('span', { className: 'count' });
    const box = el('section', { className: `group ${g.id}` }, el('h2', {}, el('span', { textContent: g.title }), count));
    box.dataset.group = g.id;
    for (const s of SETTINGS.filter((x) => x.group === g.id)) {
      const ctl = MAKERS[s.kind](s);
      const def = defLabel(s);
      const row = el('div', { className: 'setting' },
        el('div', {}, el('span', { className: 'label', textContent: s.label }), def ? el('span', { className: 'def', textContent: def }) : null),
        ctl.node,
        s.help ? el('p', { className: 'help', textContent: s.help }) : null,
        ctl.extra ?? null);
      controls[s.code] = { row, sync: ctl.sync, setting: s };
      box.append(row);
    }
    controls[`group:${g.id}`] = { count };
    root.append(box);
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────────────
function render() {
  profile.rs = $('rest').checked ? '1' : undefined;
  if (!profile.rs) delete profile.rs;
  const code = encode(profile);
  let nSet = 0;
  let nReset = 0;
  const perGroup = {};
  for (const s of SETTINGS) {
    const c = controls[s.code];
    c.sync();
    const isSet = profile[s.code] != null;
    const isReset = !isSet && profile.rs === '1' && isResettable(s);
    c.row.classList.toggle('set', isSet);
    c.row.classList.toggle('reset', isReset);
    if (isSet) { nSet++; perGroup[s.group] = (perGroup[s.group] ?? 0) + 1; }
    if (isReset) nReset++;
  }
  for (const g of GROUPS) {
    const n = perGroup[g.id] ?? 0;
    controls[`group:${g.id}`].count.textContent = n ? `${n} set` : '';
  }

  const url = `${ORIGIN}/${code}`;
  $('code').textContent = code || '(empty)';
  $('cmd-apply').textContent = code ? `curl -fsSL ${url} | bash` : 'Choose a setting to get your one-liner.';
  $('cmd-dry').textContent = code ? `curl -fsSL ${url} | bash -s -- --dry-run` : '';
  $('summary').textContent = !code
    ? 'Nothing chosen yet. Read your own Mac (step 1) or pick settings below.'
    : [
      `${nSet} setting${nSet === 1 ? '' : 's'} chosen`,
      nReset ? `${nReset} more go back to macOS defaults` : null,
    ].filter(Boolean).join(', ') + '. Each one is saved before it changes.';
  for (const id of ['cmd-apply', 'cmd-dry']) $(id).closest('.cmd').querySelector('.copy').disabled = !code;
  $('download').disabled = !code;
  $('sm-usb').hidden = profile.sh !== '1';
  $('view').disabled = !code;
  if (served) history.replaceState(null, '', `/${code}`);
}

// ── Wiring ───────────────────────────────────────────────────────────────────────────
function copyFrom(id, button) {
  const text = $(id).textContent;
  const done = () => { button.textContent = 'Copied'; button.classList.add('done'); setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('done'); }, 1400); };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => selectText(id));
  else selectText(id);
}
function selectText(id) {
  const r = document.createRange();
  r.selectNodeContents($(id));
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function init() {
  build();
  $('cmd-capture').textContent = `curl -fsSL ${ORIGIN}/capture | bash`;
  $('rest').checked = profile.rs === '1';
  $('rest').addEventListener('change', render);
  document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', () => copyFrom(b.dataset.copy, b)));
  $('preset-show').addEventListener('click', () => { Object.assign(profile, SHOW_SAFE); render(); });
  $('preset-clear').addEventListener('click', () => { profile = {}; $('rest').checked = false; render(); });
  $('download').addEventListener('click', () => {
    const blob = new Blob([applyScript(profile, { origin: ORIGIN })], { type: 'text/x-shellscript' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'mymac.sh' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  $('view').addEventListener('click', () => {
    $('script-text').textContent = applyScript(profile, { origin: ORIGIN });
    $('script-dialog').showModal();
  });
  if (initial.problems.length) {
    $('problems').hidden = false;
    $('problems').textContent = `Skipped part of the link: ${initial.problems.join('; ')}.`;
  }
  render();
}

init();
