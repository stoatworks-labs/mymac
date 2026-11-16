// Profile <-> share code.
//
// A profile is { code: value } for each setting that should be set, plus `rs: '1'` when every
// other resettable setting should go back to its macOS default. The share code is the tokens
// `<code><value>` joined with dots, in catalogue order, e.g. `rs1.tc1.ns0.dpl.hc000e`.
// Codes are exactly two lowercase letters; values are [0-9a-zA-Z]+. Nothing in it needs quoting
// in a shell or escaping in a URL.

import { SETTINGS, BY_CODE, HOT_CORNER_ACTIONS } from './catalogue.js';

const CORNER_CHARS = new Set(HOT_CORNER_ACTIONS.map((a) => a.v.toString(36)));

// Returns the canonical value, or null if it cannot be made valid.
export function normalise(s, raw) {
  const v = String(raw);
  switch (s.kind) {
    case 'bool':
      return v === '1' || v === '0' ? v : null;
    case 'flag':
      return v === '1' ? '1' : null;
    case 'choice': {
      if (s.options.some((o) => o.v === v)) return v;
      // Numeric options (key repeat): snap a captured value to the nearest stop.
      const n = Number(v);
      if (/^\d+$/.test(v) && s.options.every((o) => /^\d+$/.test(o.v))) {
        return s.options.reduce((a, o) => (Math.abs(Number(o.v) - n) < Math.abs(Number(a.v) - n) ? o : a)).v;
      }
      return null;
    }
    case 'range': {
      if (!/^\d+$/.test(v)) return null;
      const { min, max, step } = s.range;
      const n = Math.min(max, Math.max(min, Math.round((Number(v) - min) / step) * step + min));
      return String(n);
    }
    case 'color':
      return /^[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
    case 'corners': {
      if (!/^[0-9a-e]{4}$/i.test(v)) return null;
      const out = [...v.toLowerCase()].map((c) => (c === '1' ? '0' : c));
      return out.every((c) => CORNER_CHARS.has(c)) ? out.join('') : null;
    }
    default:
      return null;
  }
}

export function encode(profile) {
  const parts = [];
  if (profile.rs === '1') parts.push('rs1');
  for (const s of SETTINGS) {
    if (profile[s.code] == null) continue;
    const v = normalise(s, profile[s.code]);
    if (v != null) parts.push(s.code + v);
  }
  return parts.join('.');
}

export const CODE_RE = /^[a-z]{2}[0-9a-zA-Z]+(\.[a-z]{2}[0-9a-zA-Z]+)*$/;

export function decode(code) {
  const profile = {};
  const problems = [];
  const text = String(code || '').trim().replace(/^\/+|\/+$/g, '').replace(/\.sh$/, '');
  if (!text) return { profile, problems };
  for (const tok of text.split('.')) {
    if (!tok) continue;
    const key = tok.slice(0, 2);
    const raw = tok.slice(2);
    if (key === 'rs') {
      if (raw === '1') profile.rs = '1';
      continue;
    }
    const s = BY_CODE[key];
    if (!s) {
      problems.push(`unknown setting "${key}"`);
      continue;
    }
    const v = normalise(s, raw);
    if (v == null) problems.push(`bad value "${raw}" for ${s.label}`);
    else profile[key] = v;
  }
  return { profile, problems };
}

// True when the path looks like a share code rather than a file.
export function looksLikeCode(path) {
  const p = String(path).replace(/^\/+|\/+$/g, '').replace(/\.sh$/, '');
  return CODE_RE.test(p) && decode(p).problems.length === 0;
}
