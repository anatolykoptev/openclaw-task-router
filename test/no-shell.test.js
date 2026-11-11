import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PAYLOADS, makeStub } from './helpers.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const stub = makeStub();
const workDir = mkdtempSync(join(tmpdir(), 'tr-cwd-'));
const origCwd = process.cwd();
let plugin;

before(async () => {
  process.env.MCPORTER_BIN = stub.bin;
  process.env.STUB_LOG = stub.log;
  process.chdir(workDir); // a shell-injected `touch PWNED` would land here
  plugin = (await import(join(root, 'index.js'))).default;
});

after(() => {
  process.chdir(origCwd);
  rmSync(workDir, { recursive: true, force: true });
  rmSync(stub.dir, { recursive: true, force: true });
});

function registerPlugin() {
  const handlers = {};
  const api = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    on: (name, fn) => { handlers[name] = fn; },
    registerHttpRoute() {},
    registerTool() {},
  };
  plugin.register(api);
  return handlers;
}

for (const [name, payload] of Object.entries(PAYLOADS)) {
  test(`agent prompt (${name}) executes nothing and reaches mcporter as one literal value`, async () => {
    rmSync(join(workDir, 'PWNED'), { force: true });
    const before = stub.calls().length;
    const handlers = registerPlugin();

    // prompt -> before_agent_start stores it -> agent_end records it via MemOS
    const prompt = payload.padEnd(10, '.');
    await handlers.before_agent_start({ prompt });
    await handlers.agent_end({ success: true });

    assert.equal(existsSync(join(workDir, 'PWNED')), false, 'payload was executed by a shell');

    const add = stub.calls().slice(before).find((c) => c.argv.some((a) => a.includes('add_memory')));
    assert.ok(add, 'add_memory call never reached the binary');
    assert.deepEqual(add.argv, ['call', 'memos.add_memory', '--args', '-']);
    const sent = JSON.parse(add.stdin);
    const expected = prompt.slice(0, 100).replace(/"/g, "'"); // recordOutcome's own truncation
    assert.ok(sent.memory_content.endsWith(`task:${expected} ts:${new Date().toISOString().split('T')[0]}`),
      `payload not preserved literally: ${JSON.stringify(sent.memory_content)}`);
  });
}

test('search_memories passes cube_ids as a real array', async () => {
  const before = stub.calls().length;
  await registerPlugin().before_agent_start({ prompt: 'implement a function please' });
  const search = stub.calls().slice(before).find((c) => c.argv.includes('memos.search_memories'));
  assert.ok(search);
  assert.deepEqual(JSON.parse(search.stdin).cube_ids, ['fea6f89c-f9e5-4894-8e15-a22b8e756c04']);
});

for (const [name, payload] of Object.entries(PAYLOADS)) {
  test(`discover-cli remote model id (${name}) executes nothing and arrives literally`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tr-disc-'));
    const log = join(cwd, 'calls.jsonl');
    try {
      const r = spawnSync(process.execPath,
        ['--import', join(root, 'test', 'fetch-stub.mjs'), join(root, 'discover-cli.js'), '--limit', '1'],
        { cwd, encoding: 'utf-8', env: {
          ...process.env, OPENROUTER_API_KEY: 'k', MCPORTER_BIN: stub.bin, STUB_LOG: log, HOSTILE_MODEL_ID: payload,
        } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(existsSync(join(cwd, 'PWNED')), false, 'payload was executed by a shell');
      const lines = existsSync(log)
        ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      const add = lines.find((c) => c.argv.includes('memos.add_memory'));
      assert.ok(add, 'add_memory never reached the binary');
      assert.deepEqual(add.argv, ['call', 'memos.add_memory', '--args', '-']);
      assert.ok(JSON.parse(add.stdin).memory_content.includes(`full:openrouter/${payload} `));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
