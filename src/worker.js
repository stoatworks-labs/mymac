// mymac's Worker. Static files (the builder page) are served straight from ./public before this
// runs; the Worker only sees paths that are not files:
//
//   /<code>          curl/wget get the apply script, a browser gets the builder filled in
//   /<code>.sh       the apply script, whatever asks
//   /capture         the read-only capture script
//   /restore         runs ~/.mymac/restore.sh
//
// Nothing is stored: a profile lives entirely in its code, so the Worker keeps no state and
// sees nothing a request does not already carry in its URL.

import { decode, CODE_RE } from '../public/lib/code.js';
import { applyScript, captureScript, restoreRunner, VERSION } from '../public/lib/script.js';

const SCRIPT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
  'x-mymac-version': VERSION,
};

const script = (body) => new Response(body, { headers: SCRIPT_HEADERS });

// A shell-friendly error: piped into bash it prints the reason instead of running HTML.
// Single-quoted, because the message carries the request path and a path can hold $( ).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const failure = (msg) => script(`#!/bin/bash\necho ${shq(`mymac: ${msg}`)} >&2\nexit 1\n`);

export function wantsScript(request, path) {
  if (path.endsWith('.sh')) return true;
  const ua = request.headers.get('user-agent') || '';
  if (/^(curl|wget|fetch|libfetch|httpie|powershell)/i.test(ua)) return true;
  return !(request.headers.get('accept') || '').includes('text/html');
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '');
    const origin = url.origin;

    if (path === 'capture' || path === 'capture.sh') return script(captureScript({ origin }));
    if (path === 'restore' || path === 'restore.sh') return script(restoreRunner());

    const code = path.replace(/\.sh$/, '');
    if (CODE_RE.test(code)) {
      const { profile, problems } = decode(code);
      if (wantsScript(request, path)) {
        if (problems.length) return failure(`that code has problems: ${problems.join('; ')}`);
        return script(applyScript(profile, { origin }));
      }
      // The builder reads the code from the address bar and fills itself in (and says what it
      // skipped). A path where nothing decodes is not a code at all: let the assets 404 it.
      if (Object.keys(profile).length) return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }

    if (wantsScript(request, path)) return failure(`nothing at ${url.pathname}; make a code at ${origin}/`);
    return env.ASSETS.fetch(request);
  },
};
