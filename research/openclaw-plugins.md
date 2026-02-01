# OpenClaw Plugin System — Deep Research

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Gateway Startup                              │
├─────────────────────────────────────────────────────────────────────┤
│  1. loadOpenClawPlugins()                                           │
│     └─ discoverOpenClawPlugins() — scan paths                       │
│     └─ loadPluginManifestRegistry() — parse manifests               │
│     └─ jiti.import() — load each plugin                             │
│     └─ plugin.register(api) — call register function                │
│                                                                      │
│  2. initializeGlobalHookRunner(registry)                            │
│     └─ Makes hooks available globally                               │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. Plugin Discovery

Plugins are discovered from multiple paths:

| Priority | Path | Type |
|----------|------|------|
| 1 | `~/.openclaw/extensions/{name}/` | Installed via npm |
| 2 | `{workspace}/plugins/{name}/` | Workspace plugins |
| 3 | `plugins.loadPaths` config | Custom paths |

## 3. Plugin Structure

### 3.1 Manifest (`openclaw.plugin.json`)

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "What it does",
  "version": "1.0.0",
  "kind": "lifecycle",  // lifecycle | memory | channel | provider
  "main": "./index.js",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
```

### 3.2 Package.json Extension

```json
{
  "name": "openclaw-my-plugin",
  "openclaw": {
    "extensions": ["./index.js"]
  }
}
```

### 3.3 Plugin Entry Point

```javascript
export default {
  id: "my-plugin",
  name: "My Plugin",
  kind: "lifecycle",
  
  register(api) {
    // Registration logic here
  }
}
```

## 4. Plugin API (`api` object)

| Method | Description |
|--------|-------------|
| `api.on(hookName, handler, opts)` | Register typed lifecycle hook |
| `api.registerTool(tool, opts)` | Register agent tool |
| `api.registerHook(events, handler, opts)` | Register event hook |
| `api.registerHttpHandler(handler)` | Register HTTP handler |
| `api.registerHttpRoute({path, handler})` | Register HTTP route |
| `api.registerChannel(registration)` | Register messaging channel |
| `api.registerProvider(provider)` | Register LLM provider |
| `api.registerGatewayMethod(method, handler)` | Register gateway RPC method |
| `api.registerService(service)` | Register background service |
| `api.registerCommand(command)` | Register CLI command |
| `api.config` | Full OpenClaw config |
| `api.pluginConfig` | Plugin-specific config |
| `api.runtime` | Runtime utilities |
| `api.logger` | Logger instance |
| `api.resolvePath(path)` | Resolve user path |

## 5. Lifecycle Hooks

### 5.1 Available Hooks

| Hook | Type | When | Can Modify |
|------|------|------|------------|
| **Agent Hooks** ||||
| `before_agent_start` | modifying | Before LLM call | systemPrompt, prependContext |
| `agent_end` | void | After LLM completes | - |
| `before_compaction` | void | Before context compaction | - |
| `after_compaction` | void | After context compaction | - |
| **Message Hooks** ||||
| `message_received` | void | Inbound message | - |
| `message_sending` | modifying | Before send | content, cancel |
| `message_sent` | void | After send | - |
| **Tool Hooks** ||||
| `before_tool_call` | modifying | Before tool exec | params, block, blockReason |
| `after_tool_call` | void | After tool exec | - |
| `tool_result_persist` | sync modifying | When saving result | message |
| **Session Hooks** ||||
| `session_start` | void | Session begins | - |
| `session_end` | void | Session ends | - |
| **Gateway Hooks** ||||
| `gateway_start` | void | Gateway starts | - |
| `gateway_stop` | void | Gateway stops | - |

### 5.2 Hook Registration

```javascript
// Typed hook (recommended)
api.on("before_agent_start", async (event) => {
  return {
    prependContext: "<memory>...</memory>"
  };
});

// Priority control (higher = runs first)
api.on("agent_end", handler, { priority: 100 });
```

### 5.3 Hook Execution

- **Modifying hooks**: Run sequentially, results merged
- **Void hooks**: Run in parallel (fire-and-forget)
- **Sync hooks** (`tool_result_persist`): Must be synchronous

## 6. Plugin Kinds

| Kind | Purpose | Special Behavior |
|------|---------|------------------|
| `lifecycle` | Extend agent lifecycle | Hook into before/after |
| `memory` | Memory backend | Only one active (via `plugins.slots.memory`) |
| `channel` | Messaging channel | Requires channel registration |
| `provider` | LLM provider | Requires provider registration |

## 7. Configuration

### 7.1 openclaw.json

```json
{
  "plugins": {
    "allow": ["my-plugin"],           // Allowlist
    "entries": {
      "my-plugin": {
        "enabled": true,
        "config": { /* plugin config */ }
      }
    },
    "slots": {
      "memory": "my-memory-plugin"    // Memory slot assignment
    },
    "loadPaths": ["/extra/plugins"]   // Additional search paths
  }
}
```

### 7.2 Enable/Disable Logic

1. Plugin must be in `allow` list (if allowlist mode)
2. Plugin must have `enabled: true` in entries
3. For `memory` kind: must match `slots.memory` or be first

## 8. Example: MemOS Lifecycle Plugin

```javascript
// index.js
import { searchMemories, addMemory } from "./lib/memos-api.js";

export default {
  id: "openclaw-memos-lifecycle-plugin",
  kind: "lifecycle",

  register(api) {
    // Inject memory context before agent starts
    api.on("before_agent_start", async (event) => {
      const memories = await searchMemories(event.prompt);
      if (memories.length === 0) return;
      
      return {
        prependContext: `<user_memory_context>
${memories.map(m => m.memory).join('\n')}
</user_memory_context>`
      };
    });

    // Extract and save facts after agent completes
    api.on("agent_end", async (event) => {
      if (!event.success) return;
      
      const facts = await extractFacts(event.messages);
      for (const fact of facts) {
        await addMemory(fact);
      }
    });
  }
};
```

## 9. Internal Hooks (Built-in)

OpenClaw has internal hooks configured in `hooks.internal.entries`:

| Hook | Purpose |
|------|---------|
| `boot-md` | Load AGENTS.md, SOUL.md, etc. |
| `command-logger` | Log commands |
| `session-memory` | Session persistence |

## 10. Advanced Features

### 10.1 HTTP Routes

```javascript
api.registerHttpRoute({
  path: "/my-plugin/webhook",
  handler: async (req, res) => {
    res.end(JSON.stringify({ ok: true }));
  }
});
```

### 10.2 Custom Tools

```javascript
api.registerTool({
  name: "my_tool",
  description: "Does something",
  parameters: { /* JSON schema */ },
  execute: async (params) => {
    return { result: "done" };
  }
});
```

### 10.3 Gateway Methods

```javascript
api.registerGatewayMethod("myMethod", async (params, ctx) => {
  return { result: "ok" };
});
```

## 11. Key Files in OpenClaw

| File | Purpose |
|------|---------|
| `plugins/loader.js` | Main plugin loading logic |
| `plugins/registry.js` | Plugin registry and API creation |
| `plugins/hooks.js` | Hook runner implementation |
| `plugins/hook-runner-global.js` | Global hook runner singleton |
| `plugins/discovery.js` | Plugin discovery from filesystem |
| `plugins/manifest-registry.js` | Manifest parsing |
| `plugin-sdk/index.js` | SDK exports for plugin authors |

## 12. Best Practices

1. **Use typed hooks** (`api.on`) over generic hooks
2. **Set priority** for ordering when multiple plugins hook same event
3. **Handle errors gracefully** — hook runner catches but logs errors
4. **Avoid async in sync hooks** — `tool_result_persist` is sync-only
5. **Use plugin config schema** — validated at load time
6. **Respect memory slot** — only one memory plugin can be active

## 13. Creating a Task Router Plugin

A task-router plugin could use:

```javascript
api.on("before_agent_start", async (event, ctx) => {
  // Determine model based on task complexity
  const model = routeTask(event.prompt);
  
  // Can't change model here, but could log recommendation
  // Model selection happens at sessions_spawn level
  
  return {
    prependContext: `<routing_recommendation>
Recommended model: ${model.model}
Tier: ${model.tier}
Reasoning: ${model.reasoning}
</routing_recommendation>`
  };
});
```

**Note:** Lifecycle plugins cannot override model selection — that's determined by `sessions_spawn` params or agent config. The plugin can inject recommendations into context though.

---

*Research completed: 2026-01-31*
