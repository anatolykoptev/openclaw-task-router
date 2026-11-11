# CLAUDE.md

Notes for coding agents. Overview and configuration: [README.md](README.md); all documents:
[docs/INDEX.md](docs/INDEX.md).

## Layout

- `index.js` the whole plugin, deliberately inlined in one file: scoring (`routeTask`,
  `COMPLEXITY_KEYWORDS`, `TIER_THRESHOLDS`), MemOS access via the `mcporter` CLI (`callMemos`), model
  discovery from OpenRouter, and `register(api)` with two hooks, two HTTP routes and two tools.
- `discover-cli.js` standalone model-discovery script for cron.
- `openclaw.plugin.json` plugin manifest and config schema; `package.json` ESM package, Node >= 18.
- `research/` design notes from January 2026, not documentation of the current behaviour.

## Gate

There is no CI and no build. Before a commit:

```sh
npm test
node --check index.js && node --check discover-cli.js
node -e "import('./index.js').then(m => console.log(m.default.id, m.routeTask('fix typo').tier))"
```

## Invariants easy to break

- Keep the tier thresholds in `index.js` and the table in README in step, and the version in
  `package.json` and `openclaw.plugin.json` equal.
- `routeTask` must stay synchronous and total: when MemOS or `mcporter` fails, `getModelForTier` falls
  back to `FALLBACK_MODELS` instead of throwing.
- External commands go through `memos-exec.js` (`execFileSync` with a fixed argument vector, payload on
  stdin); never build a shell command string, and keep `test/no-shell.test.js` passing.
- Outcomes are recorded but not yet read back; do not document learning or escalation as working.
- `enabled` and `memosEndpoint` exist in the config schema but no code reads them; wire them or
  remove them together.
- Keyword weights are substring matches on the lower-cased prompt, English and Russian; a new keyword
  can match inside longer words.
