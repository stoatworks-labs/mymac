// Writes generated scripts to a folder for inspection and shell tests.
//   node test/gen.mjs <outdir> <code> [origin]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from '../public/lib/code.js';
import { applyScript, captureScript, restoreRunner } from '../public/lib/script.js';

const [outdir, code = '', origin = 'https://mymac.example'] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const { profile, problems } = decode(code);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
writeFileSync(join(outdir, 'apply.sh'), applyScript(profile, { origin }));
writeFileSync(join(outdir, 'capture.sh'), captureScript({ origin }));
writeFileSync(join(outdir, 'restore-runner.sh'), restoreRunner());
console.log(`wrote ${outdir}`);
