// Prints a bash script that dumps every preference key mymac can touch, one line each:
//   host|domain|key|type|value      (or ...|unset)
// Used to compare a real Mac (or VM) before apply and after restore.
import { SETTINGS } from '../public/lib/catalogue.js';

const keys = new Map();
const add = (host, domain, key) => keys.set(`${host}|${domain}|${key}`, [host, domain, key]);
const values = (s) => ({
  bool: ['0', '1'], flag: ['1'], color: ['000000'], corners: ['0000'],
  choice: s.options?.map((o) => o.v), range: s.range && [String(s.range.min)],
}[s.kind] ?? []);

for (const s of SETTINGS) {
  for (const v of values(s)) for (const op of s.apply(v)) if (['w', 'd', 'wif'].includes(op[0])) add(op[1], op[2], op[3]);
  if (s.resetOps) for (const op of s.resetOps()) add(op[1], op[2], op[3]);
}
add(0, 'NSGlobalDomain', 'AppleInterfaceStyle');
add(0, 'NSGlobalDomain', '_HIHideMenuBar');

const lines = [...keys.values()].sort().map(([h, d, k]) => `k ${h} '${d}' '${k}'`);
console.log(`#!/bin/bash
k() {
  local h=""; [ "$1" = 1 ] && h=-currentHost
  local t; if t=$(defaults $h read-type "$2" "$3" 2>/dev/null); then
    printf '%s|%s|%s|%s|%s\\n' "$1" "$2" "$3" "\${t#Type is }" "$(defaults $h read "$2" "$3" 2>/dev/null)"
  else
    printf '%s|%s|%s|unset\\n' "$1" "$2" "$3"
  fi
}
${lines.join('\n')}`);
