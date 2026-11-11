/**
 * Runs a MemOS tool through the mcporter CLI without a shell.
 *
 * The binary is spawned directly with a fixed argument vector and the tool
 * arguments travel as one JSON document on stdin (`--args -`), so no text from
 * a prompt, a memory or a remote API can be parsed by a shell or by mcporter's
 * call-expression parser.
 */

import { execFileSync } from 'node:child_process';

// MCPORTER_BIN lets operators (and tests) point at a different binary.
export const MCPORTER = process.env.MCPORTER_BIN
  || '/home/user/.nvm/versions/node/v24.13.0/bin/mcporter';

const METHOD_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @param {string} method  MemOS tool name, e.g. "search_memories"
 * @param {Record<string, unknown>} args  tool arguments; sent as JSON
 * @param {number} timeout  milliseconds
 * @returns {string} stdout of the call (throws on spawn error, non-zero exit or timeout)
 */
export function runMemos(method, args, timeout) {
  if (!METHOD_RE.test(method)) throw new Error(`invalid MemOS method: ${method}`);
  return execFileSync(MCPORTER, ['call', `memos.${method}`, '--args', '-'], {
    input: JSON.stringify(args),
    timeout,
    encoding: 'utf-8',
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}
