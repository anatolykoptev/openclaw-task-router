# OpenClaw Task Router

**Dynamic model routing based on task complexity with learning from outcomes.**

Route tasks to the optimal LLM model tier (free → cheap → standard → premium → research) based on complexity scoring, and learn from success/failure history to improve routing over time.

## Features

- 🎯 **5-Tier Routing**: free, cheap, standard, premium, research
- 🧠 **MemOS Learning**: Records outcomes and adjusts routing based on success rates
- 🔄 **Auto-Escalation**: Moves to higher tier after repeated failures
- 💰 **Cost Optimization**: Uses cheapest model that can handle the task
- 🌍 **Multilingual**: Supports English and Russian keywords
- 📊 **Model Discovery**: Auto-syncs cheap/free models from OpenRouter

## Installation

```bash
# Clone to extensions directory
cd ~/.openclaw/extensions
git clone https://github.com/anatolykoptev/openclaw-task-router.git

# Or install via npm (when published)
npm install openclaw-task-router
```

## Configuration

Add to your `openclaw.json`:

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

Models and routing history are stored in MemOS (requires `memos-mcp` running):

```
MODEL tier:free full:openrouter/moonshotai/kimi-k2:free priority:20 status:active
ROUTING sig:abc123 model:claude-sonnet outcome:success ts:2026-01-31
```

The router learns from outcomes:
- **< 50% success rate** after 3+ attempts → escalate tier
- **> 80% success rate** after 3+ attempts → can downgrade tier

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

### Lifecycle Hooks

The plugin automatically:
- Injects `<task_routing>` block before agent starts
- Records outcomes when agent completes

## Model Discovery

Sync cheap/free models from OpenRouter:

```bash
cd ~/.openclaw/extensions/openclaw-task-router
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
- MemOS (memos-api + memos-mcp) for learning features
- mcporter CLI configured

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

## License

MIT © [Anatoly Koptev](https://github.com/anatolykoptev)

## Contributing

PRs welcome! See [research/](./research/) for architecture docs.
