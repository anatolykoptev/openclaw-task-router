# Contributing

Pull requests are welcome. For anything larger than a fix, open an issue first.

## Build and test

There is no build step and no dependencies. Node.js 18 or newer. Check a change with:

```sh
npm test
node --check index.js && node --check discover-cli.js
node -e "import('./index.js').then(m => console.log(m.routeTask('implement user authentication')))"
```

A full run needs an OpenClaw installation; `node discover-cli.js --dry-run` previews model discovery
(it needs `OPENROUTER_API_KEY` and a working `mcporter`).

## Pull requests

- Branch from `main`, one concern per pull request.
- Use Conventional Commits as in the history (`feat:`, `fix:`, `chore:`, `docs:`).
- Keep the tier table and options in [README.md](README.md) in step with `index.js` and
  `openclaw.plugin.json`.
- Never commit API keys, tokens or machine-specific paths; report vulnerabilities as described in
  [SECURITY.md](SECURITY.md), not in issues.
- Add notable changes to [CHANGELOG.md](CHANGELOG.md) and new documents to [docs/INDEX.md](docs/INDEX.md).
