import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Characters that are special to sh, to quoting layers and to line-oriented parsers.
// Each payload tries to create the file PWNED in the current directory if it is
// ever interpreted by a shell.
export const PAYLOADS = {
  'single quote break-out': `x'; touch PWNED; echo '`,
  'double quote break-out': `x"; touch PWNED; "`,
  'command substitution': `$(touch PWNED)`,
  'backticks': '`touch PWNED`',
  'semicolon': `a; touch PWNED #`,
  'newline': `line one\ntouch PWNED\nline three`,
  'backslash before quote': `a\\' ; touch PWNED ; '\\"`,
  'everything at once': `'"$(touch PWNED)\`touch PWNED\`;\n|&<>(){}\\`,
};

/** Creates a stub mcporter that records its argv and stdin as one JSON line per call. */
export function makeStub() {
  const dir = mkdtempSync(join(tmpdir(), 'tr-stub-'));
  const bin = join(dir, 'mcporter');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf-8'); } catch {}
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
process.stdout.write('{}');
`);
  chmodSync(bin, 0o755);
  const calls = () => (existsSync(log)
    ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  return { dir, bin, log, calls };
}
