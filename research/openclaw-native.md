# OpenClaw Native Model Selection Research

**Date:** 2026-01-31
**Researcher:** subagent:research-openclaw

## Executive Summary

OpenClaw has a **native model routing system** built into the config. Model selection for isolated sessions (subagents, cron) is already handled through a priority cascade. There's no need to build external routing — we can **leverage and enhance** the native system.

---

## 1. Native Model Configuration Structure

### Config Location
`~/.openclaw/openclaw.json` → `agents.defaults`

### Key Config Sections

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-5"  // Main session default
      },
      "heartbeat": {
        "every": "1h",
        "model": "google/gemini-2.5-flash"  // Heartbeat model override
      },
      "subagents": {
        "maxConcurrent": 8,
        "model": "anthropic/claude-sonnet-4"  // Subagent default
      }
    }
  }
}
```

### Model Priority Cascade (sessions_spawn)

From `sessions-spawn-tool.js`:
```typescript
const resolvedModel = 
  normalizeModelSelection(modelOverride) ??                        // 1. Explicit param
  normalizeModelSelection(targetAgentConfig?.subagents?.model) ??  // 2. Per-agent config
  normalizeModelSelection(cfg.agents?.defaults?.subagents?.model); // 3. Global default
```

**Priority Order:**
1. `model` parameter passed to `sessions_spawn`
2. Per-agent `subagents.model` config (for multi-agent setups)
3. Global `agents.defaults.subagents.model`

---

## 2. Model Aliases System

### CLI Commands
```bash
openclaw models aliases list    # Show all aliases
openclaw models aliases add     # Add/update alias
openclaw models aliases remove  # Remove alias
```

### Current Aliases (11 total)
```
Claude Opus → anthropic/claude-opus-4-5
Claude Sonnet → anthropic/claude-sonnet-4
Gemini Pro → google/gemini-2.5-pro
Gemini Flash → google/gemini-2.5-flash
Gemini 2 Flash → google/gemini-2.0-flash
Perplexity Sonar → openrouter/perplexity/sonar
Perplexity Pro → openrouter/perplexity/sonar-pro
Perplexity Reasoning → openrouter/perplexity/sonar-reasoning-pro
Perplexity Deep Research → openrouter/perplexity/sonar-deep-research
Kimi K2 Free → openrouter/moonshotai/kimi-k2:free
```

**Usage:** Aliases can be used in place of full model IDs.

---

## 3. Cron Jobs Model Handling

### CLI
```bash
openclaw cron add --model "google/gemini-2.5-flash" --message "..." 
```

### Options
- `--model <model>` — Model override for agent jobs (provider/model or alias)
- `--thinking <level>` — off|minimal|low|medium|high
- `--session <target>` — main|isolated

Cron jobs inherit the model from config unless explicitly overridden.

---

## 4. Lifecycle Plugin System

### Hook Points Available

From `memory-lancedb/index.ts`:
```typescript
api.on("before_agent_start", async (event) => {
  // event.prompt — user prompt
  // return { prependContext: "..." } to inject context
});

api.on("agent_end", async (event) => {
  // event.success, event.messages
});
```

### Plugin Registration
```typescript
export default {
  id: "plugin-name",
  kind: "lifecycle",
  register(api) {
    api.on("before_agent_start", async (event) => { ... });
  }
};
```

**⚠️ Limitation:** `before_agent_start` can inject context but **cannot modify model selection**. Model is resolved before this hook fires.

---

## 5. Subagent Tool Internals

### sessions_spawn Tool Parameters
```typescript
{
  task: string;           // Required
  label?: string;         // Optional label
  agentId?: string;       // Target different agent
  model?: string;         // Model override ⭐
  thinking?: string;      // Thinking level
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
}
```

### Model Application Flow
```typescript
// 1. Resolve model from cascade
const resolvedModel = modelOverride ?? agentConfig?.subagents?.model ?? defaults;

// 2. Apply via gateway
await callGateway({
  method: "sessions.patch",
  params: { key: childSessionKey, model: resolvedModel }
});
```

---

## 6. Where to Hook Model Routing

### Option A: Pre-spawn Script (Current Approach)
Agent calls `spawn_routed.py` before `sessions_spawn`, passes recommended model.

**Pros:** Simple, no OpenClaw changes needed
**Cons:** Requires agent compliance, extra step

### Option B: Config-Based Rules (Native)
Extend `agents.defaults.subagents` with rules:

```json
{
  "subagents": {
    "model": "anthropic/claude-sonnet-4",
    "routing": {
      "rules": [
        { "match": "research|search", "model": "perplexity/sonar-pro" },
        { "match": "simple|quick", "model": "google/gemini-2.5-flash" }
      ]
    }
  }
}
```

**Pros:** Native, transparent
**Cons:** Requires OpenClaw PR

### Option C: Lifecycle Plugin (Limited)
Create plugin that analyzes task in `before_agent_start` and suggests model.

**⚠️ Problem:** Cannot change model after agent started. Would need `before_spawn` hook (doesn't exist).

---

## 7. Native Interface Summary

### Main Session → Sub-agents
```
sessions_spawn(task: "...", model: "...") 
  → Gateway resolves model from cascade
  → Gateway calls sessions.patch to set model
  → Isolated session runs with specified model
```

### Session Keys
- Main: `agent:main:main` or alias
- Subagent: `agent:{agentId}:subagent:{uuid}`
- Cron: Uses isolated sessions by default

---

## 8. Recommendations

1. **Continue with spawn_routed.py approach** — it works within native system
2. **Add model outcome tracking** via cron (already done: `model-router-outcomes`)
3. **Consider PR to OpenClaw** for native `routing.rules` support
4. **Use aliases** for cleaner model references
5. **Per-task type defaults** could be AGENTS.md convention, not code

### Quick Wins
- Set `subagents.model` to most common model (Sonnet)
- Use `heartbeat.model` for cheap periodic checks (Flash)
- Pass `model` explicitly only for edge cases (research, complex)

---

## 9. Config Commands Reference

```bash
# View current model config
openclaw config get agents.defaults.model
openclaw config get agents.defaults.subagents
openclaw config get agents.defaults.heartbeat

# Set subagent default
openclaw config set agents.defaults.subagents.model "anthropic/claude-sonnet-4"

# List all configured models
openclaw models list

# Check model status
openclaw models status
```

---

## 10. Files Examined

- `~/.openclaw/openclaw.json` — main config
- `sessions-spawn-tool.js` — spawn implementation
- `memory-lancedb/index.ts` — lifecycle plugin example
- `openclaw-memos-lifecycle-plugin/index.js` — custom lifecycle plugin
- Various CLI help outputs

---

## Conclusion

OpenClaw's native model selection is **well-designed and sufficient** for most use cases. The config cascade (`param > agent > default`) covers the hierarchy. Our `spawn_routed.py` approach is a lightweight enhancement that works within this system, adding intelligence without requiring OpenClaw modifications.

**Next steps:**
1. Ensure AGENTS.md documents model routing clearly
2. Consider proposing `routing.rules` feature upstream
3. Track outcomes to validate routing decisions over time
