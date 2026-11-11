# OpenClaw Task Router

**Dynamic model routing based on task complexity, with outcome recording.**

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that scores each task and recommends an LLM model tier (free → cheap → standard → premium → research). It injects the recommendation into the agent's context and records success or failure per task signature in MemOS. It is for OpenClaw operators who want cheap models on trivial tasks.

## Features

- 🎯 **5-Tier Routing**: free, cheap, standard, premium, research
- 🧠 **MemOS history**: Records an outcome (success or fail) per task signature; routing does not read it back yet
- 💰 **Cost Optimization**: Uses cheapest model that can handle the task
- 🌍 **Multilingual**: Supports English and Russian keywords
- 📊 **Model Discovery**: Auto-syncs cheap/free models from OpenRouter

## Installation

```bash
# Clone to extensions directory
cd ~/.openclaw/extensions
git clone https://github.com/anatolykoptev/openclaw-task-router.git

```

## Configuration

Add to your `openclaw.json` (options: `injectRecommendation` and `recordOutcomes`, both default true;
`enabled` and `memosEndpoint` are declared in the schema but not read by the code):

```json
{
  "plugins": {
    "allow": ["openclaw-task-router"],
    "entries": {
      "openclaw-task-router": {
        "enabled": true,
        "config": {
          "injectRecommendation": true,
          "recordOutcomes": true
        }
      }
    }
  }
}
```

Node.js 18 or newer; no npm dependencies and no build step. The plugin runs the
`mcporter` CLI to reach MemOS: set `MCPORTER_BIN` to the binary's path (the fallback is a constant in `memos-exec.js`).
The binary is run directly with fixed arguments, never through a shell.

## How It Works

### 1. Complexity Scoring

Each task is scored (0-100) based on:
- **Task type detection**: trivial, simple, code, content, analysis, research, architect
- **Keyword analysis**: +/- points for complexity indicators

```
"fix typo" → score: 5 → free tier
"implement auth" → score: 55 → standard tier  
"design system architecture" → score: 85 → premium tier
"research alternatives to redis" → research tier
```

### 2. Tier Mapping

| Tier | Score Range | Default Model |
|------|-------------|---------------|
| free | 0-20 | openrouter/moonshotai/kimi-k2:free |
| cheap | 21-40 | google/gemini-2.5-flash |
| standard | 41-65 | anthropic/claude-sonnet-4 |
| premium | 66+ | anthropic/claude-opus-4-5 |
| research | keyword | openrouter/perplexity/sonar-pro |

### 3. MemOS Integration

Models and routing history are stored as text memories in a dedicated MemOS cube (the cube id is a
constant in `index.js`; replace it with your own). The model for a tier is the highest-priority
active `MODEL` entry, falling back to the defaults in the table above when MemOS has none or is
unreachable:

```
MODEL tier:free full:openrouter/moonshotai/kimi-k2:free priority:20 status:active
ROUTING sig:abc123 model:anthropic/claude-sonnet-4 outcome:success task:... ts:2026-01-31
```

`ROUTING` entries are written when an agent run ends. Nothing reads them back to change a route
yet: the success-rate escalation sketched in `research/learning-loop-test.md` is not implemented.

## API

### HTTP Endpoint

```bash
curl -X POST http://localhost:18789/task-router/route \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task": "implement user authentication"}'
```

Response:
```json
{
  "model": "anthropic/claude-sonnet-4",
  "tier": "standard",
  "score": 55,
  "signature": "a1b2c3d4e5f6",
  "taskType": "code",
  "reasoning": "type=code | base=45 | keywords=implement(+10) | →standard(score=55)"
}
```

The HTTP route is registered through OpenClaw's gateway, which provides the authentication; the
plugin does not check the token itself. `POST /task-router/discover` runs model discovery.

### Agent tools

`route_task` (`task`) returns the same recommendation as the HTTP route; `discover_models` syncs
models from OpenRouter into MemOS.

### Lifecycle Hooks

The plugin automatically:
- Injects a `<task_routing>` block before the agent starts (`before_agent_start`)
- Records the outcome of the oldest unfinished task of the last 30 minutes when an agent run ends (`agent_end`)

## Model Discovery

Sync cheap/free models from OpenRouter into MemOS. Needs `OPENROUTER_API_KEY` in the environment:

```bash
cd ~/.openclaw/extensions/openclaw-task-router
node discover-cli.js --dry-run --limit 30   # preview
node discover-cli.js --limit 30
```

Set up daily discovery via cron:
```json
{
  "name": "openrouter-model-discovery",
  "schedule": { "kind": "cron", "expr": "0 6 * * *" },
  "payload": {
    "kind": "agentTurn",
    "message": "Run: cd ~/.openclaw/extensions/openclaw-task-router && node discover-cli.js --limit 30"
  }
}
```

## Requirements

- OpenClaw 2026.1.30+
- MemOS (memos-api + memos-mcp) for model and history storage; routing falls back to built-in default models without it
- mcporter CLI configured with a `memos` server
- `OPENROUTER_API_KEY` for model discovery

## Customization

### Adding Keywords

Edit `COMPLEXITY_KEYWORDS` in `index.js`:

```javascript
const COMPLEXITY_KEYWORDS = {
  // English
  'architect': 25,
  'security audit': 25,
  // Russian  
  'архитектур': 25,
  'рефактор': 20,
  // Add your own...
};
```

### Custom Tiers

Modify `TIER_THRESHOLDS`:

```javascript
const TIER_THRESHOLDS = {
  free: [0, 20],
  cheap: [21, 40], 
  standard: [41, 65],
  premium: [66, 100]
};
```

## Status

Version 1.0.0, no tagged releases. The `research/` directory holds the design notes from January 2026.

## Licence

Apache-2.0; see [LICENSE](LICENSE). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Agent notes:
[CLAUDE.md](CLAUDE.md); all documents: [docs/INDEX.md](docs/INDEX.md).
