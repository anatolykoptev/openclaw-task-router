# Felix Model Router - Complete Architecture Analysis

> Research from `/tmp/krolik-cli/src/lib/@felix/` codebase
> Date: 2026-01-31

## Executive Summary

Felix is an adaptive model routing system that combines:
1. **Rule-based scoring** from task attributes
2. **History-based learning** from SQLite patterns
3. **Cascade execution** with automatic escalation
4. **ADK integration** for multi-agent orchestration
5. **Plugin system** for validation, retry, and cost control

---

## 1. Complete Scoring Algorithm

### 1.1 Rule-Based Scoring (`router/rules.ts`)

```typescript
// Complexity base scores (0-100)
const COMPLEXITY_SCORES: Record<TaskComplexity, number> = {
  trivial: 10,
  simple: 25,
  moderate: 50,
  complex: 75,
  epic: 95,
};

// Tag modifiers
const TAG_BOOSTS: Record<string, number> = {
  // Increases complexity
  architecture: +20,
  security: +15,
  performance: +10,
  refactor: +10,
  migration: +15,
  database: +10,
  api: +5,
  
  // Decreases complexity
  lint: -15,
  typo: -25,
  formatting: -20,
  docs: -10,
  comment: -15,
  rename: -10,
  cleanup: -5,
};

function calculateTaskScore(task: TaskAttributes): ScoringResult {
  const complexity = task.complexity ?? 'moderate';
  const base = COMPLEXITY_SCORES[complexity];
  
  // Files boost: +5 per file over 2
  const filesBoost = Math.max(0, (task.filesAffected?.length ?? 0 - 2) * 5);
  
  // Criteria boost: +3 per criterion over 2
  const criteriaBoost = Math.max(0, (task.acceptanceCriteria?.length ?? 0 - 2) * 3);
  
  // Tags boost: sum of matching tag weights
  const tagsBoost = (task.tags ?? []).reduce((sum, tag) => {
    return sum + (TAG_BOOSTS[tag.toLowerCase()] ?? 0);
  }, 0);
  
  // Final score clamped to 0-100
  const score = Math.max(0, Math.min(100, base + filesBoost + criteriaBoost + tagsBoost));
  const tier = scoreToTier(score);
  
  return { score, tier, breakdown: {...}, suggestedModel: DEFAULT_MODELS[tier] };
}
```

### 1.2 Score-to-Tier Mapping (`router/model-tiers.ts`)

```typescript
const TIER_THRESHOLDS: Record<ModelTier, { min: number; max: number }> = {
  free: { min: 0, max: 20 },
  cheap: { min: 21, max: 40 },
  mid: { min: 41, max: 65 },
  premium: { min: 66, max: 100 },
};

function scoreToTier(score: number): ModelTier {
  if (score <= 20) return 'free';
  if (score <= 40) return 'cheap';
  if (score <= 65) return 'mid';
  return 'premium';
}
```

### 1.3 Task Signature Generation (`router/history.ts`)

Tasks are grouped by signature for history comparison:

```typescript
function createTaskSignature(task: TaskAttributes): TaskSignature {
  const complexity = task.complexity ?? 'moderate';
  const tags = [...(task.tags ?? [])].sort();
  const filesRange = getFilesRange(task.filesAffected?.length ?? 0);
  // 'few' (1-2), 'some' (3-5), 'many' (6+)
  
  const hash = createHash('md5')
    .update(JSON.stringify({ complexity, tags, filesRange }))
    .digest('hex')
    .slice(0, 12);
    
  return { hash, complexity, tags, filesRange };
}
```

---

## 2. History Tracking Schema (SQLite)

### 2.1 Core Tables

```sql
-- Migration 10: Model router patterns
CREATE TABLE felix_routing_patterns (
  id INTEGER PRIMARY KEY,
  signature_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  avg_cost REAL DEFAULT 0,
  last_updated TEXT NOT NULL,
  UNIQUE(signature_hash, model)
);

-- Migration 7: Task attempts with routing info
CREATE TABLE felix_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  prd_task_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  model TEXT,
  error_message TEXT,
  error_stack TEXT,
  files_modified TEXT DEFAULT '[]',
  commands_executed TEXT DEFAULT '[]',
  commit_sha TEXT,
  validation_passed INTEGER DEFAULT 0,
  validation_output TEXT,
  -- Added in Migration 10:
  signature_hash TEXT,
  escalated_from TEXT
);

-- Migration 9: ADK sessions
CREATE TABLE felix_adk_sessions (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE felix_adk_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  author TEXT,
  content TEXT,
  actions TEXT DEFAULT '{}',
  branch TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES felix_adk_sessions(id) ON DELETE CASCADE
);
```

### 2.2 Pattern Storage Operations

```typescript
// Update pattern after task completion
function updateRoutingPattern(
  signatureHash: string,
  model: ModelName,
  success: boolean,
  cost: number,
  projectPath: string
): void {
  // Try update first
  const updateSql = `
    UPDATE felix_routing_patterns SET
      success_count = success_count + ?,
      fail_count = fail_count + ?,
      avg_cost = (avg_cost * (success_count + fail_count) + ?) 
                 / (success_count + fail_count + 1),
      last_updated = ?
    WHERE signature_hash = ? AND model = ?
  `;
  
  const result = db.prepare(updateSql).run(
    success ? 1 : 0,  // success_count increment
    success ? 0 : 1,  // fail_count increment
    cost, now, signatureHash, model
  );
  
  // Insert if no update
  if (result.changes === 0) {
    db.prepare(`INSERT INTO felix_routing_patterns ...`).run(...);
  }
}
```

---

## 3. Escalation & Downgrade Logic

### 3.1 History Analysis Thresholds

```typescript
const MIN_SAMPLES = 3;           // Minimum attempts for decision
const FAIL_THRESHOLD = 0.5;      // >50% failures → escalate
const SUCCESS_THRESHOLD = 0.8;   // >80% success → can downgrade
```

### 3.2 Tier Adjustment Algorithm

```typescript
function analyzeHistory(
  task: TaskAttributes,
  currentTier: ModelTier,
  projectPath: string
): HistoryAdjustment | null {
  const signature = createTaskSignature(task);
  const patterns = getRoutingPatterns(signature.hash, projectPath);
  
  if (patterns.length === 0) return null;
  
  // Group by tier
  const tierStats = new Map<ModelTier, { success: number; fail: number }>();
  for (const pattern of patterns) {
    const tier = getModelTier(pattern.model);
    // accumulate stats...
  }
  
  // ESCALATION: cheap → mid
  if (currentTier === 'cheap') {
    const cheapStats = tierStats.get('cheap');
    if (cheapStats) {
      const total = cheapStats.success + cheapStats.fail;
      if (total >= MIN_SAMPLES) {
        const failRate = cheapStats.fail / total;
        if (failRate > FAIL_THRESHOLD) {
          return {
            originalTier: 'cheap',
            adjustedTier: 'mid',
            reason: `Cheap models failed ${failRate*100}% on similar tasks`,
            confidence: Math.min(1, total / 10),
          };
        }
      }
    }
  }
  
  // DOWNGRADE: mid → cheap (cost savings)
  if (currentTier === 'mid') {
    const cheapStats = tierStats.get('cheap');
    if (cheapStats) {
      const total = cheapStats.success + cheapStats.fail;
      if (total >= MIN_SAMPLES) {
        const successRate = cheapStats.success / total;
        if (successRate > SUCCESS_THRESHOLD) {
          return {
            originalTier: 'mid',
            adjustedTier: 'cheap',
            reason: `Cheap models succeeded ${successRate*100}% on similar tasks`,
            confidence: Math.min(1, total / 10),
          };
        }
      }
    }
  }
  
  return null;
}
```

### 3.3 Default Escalation Probabilities

```typescript
const DEFAULT_ESCALATION_PROBABILITY: Record<ModelTier, number> = {
  free: 0.3,    // 30% expected escalation from free tier
  cheap: 0.2,   // 20% from cheap
  mid: 0.1,     // 10% from mid
  premium: 0,   // No escalation from premium
};
```

### 3.4 Tier Hierarchy & Escalation Paths

```typescript
const TIER_HIERARCHY: ModelTier[] = ['free', 'cheap', 'mid', 'premium'];

function getEscalationPath(fromModel: ModelName): ModelName[] {
  const currentTier = getModelTier(fromModel);
  const currentTierIndex = TIER_HIERARCHY.indexOf(currentTier);
  
  // Premium has nowhere to escalate
  if (currentTier === 'premium') return [];
  
  const path: ModelName[] = [];
  
  // Add remaining models in current tier (excluding current)
  for (const model of getModelsInTier(currentTier)) {
    if (model !== fromModel) path.push(model);
  }
  
  // Add models from higher tiers
  for (let i = currentTierIndex + 1; i < TIER_HIERARCHY.length; i++) {
    path.push(...getModelsInTier(TIER_HIERARCHY[i]));
  }
  
  return path;
}
```

---

## 4. Cascade Execution System

### 4.1 Error Classification

```typescript
type ErrorCategory = 'syntax' | 'validation' | 'capability' | 'timeout' | 'unknown';

function classifyError(error: Error | string): ErrorCategory {
  const message = (typeof error === 'string' ? error : error.message).toLowerCase();
  
  // Syntax/parsing → retry same model
  if (message.includes('syntax error') || message.includes('parse error') ||
      message.includes('unexpected token') || message.includes('invalid json')) {
    return 'syntax';
  }
  
  // Validation → retry same model
  if (message.includes('validation failed') || message.includes('invalid input')) {
    return 'validation';
  }
  
  // Capability → escalate to stronger model
  if (message.includes('too complex') || message.includes('context too long') ||
      message.includes('rate limit') || message.includes('overloaded')) {
    return 'capability';
  }
  
  // Timeout → escalate (simpler model might be faster)
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  
  return 'unknown';
}
```

### 4.2 Default Cascade Configuration

```typescript
const DEFAULT_CASCADE_CONFIG: CascadeConfig = {
  maxRetries: 3,
  retrySameModel: ['syntax', 'validation'],    // Retry same model
  escalateOn: ['capability', 'timeout'],        // Escalate to next tier
  escalationPath: getTierEscalationPaths(),
};
```

### 4.3 Cascade Executor Loop

```typescript
async function executeWithCascade(options: CascadeExecutorOptions): Promise<ExecutionResult> {
  const { decision, config, projectPath, signatureHash, onExecute } = options;
  
  let currentModel = decision.selectedModel;
  let retriesRemaining = config.maxRetries;
  const escalationPath = [...decision.escalationPath];
  let escalatedFrom: ModelName | undefined;
  
  while (true) {
    try {
      const result = await onExecute(currentModel);
      
      // Record outcome for learning
      if (signatureHash) {
        updateRoutingPattern(signatureHash, currentModel, result.success, result.costUsd, projectPath);
      }
      
      if (result.success) {
        return { ...result, escalatedFrom };
      }
      
      const errorCategory = result.errorCategory ?? 'unknown';
      
      // Retry same model for syntax/validation errors
      if (config.retrySameModel.includes(errorCategory) && retriesRemaining > 0) {
        retriesRemaining--;
        continue;
      }
      
      // Escalate for capability/timeout errors
      if (config.escalateOn.includes(errorCategory) && 
          escalationPath.length > 0 && 
          decision.canEscalate) {
        const nextModel = escalationPath.shift()!;
        escalatedFrom = escalatedFrom ?? currentModel;
        currentModel = nextModel;
        retriesRemaining = config.maxRetries;  // Reset retries for new model
        continue;
      }
      
      // No more options
      return { ...result, escalatedFrom };
      
    } catch (error) {
      // Same retry/escalate logic for thrown errors
      // ...
    }
  }
}
```

---

## 5. Plugin System

### 5.1 Plugin Architecture (ADK BasePlugin)

Felix plugins extend `@google/adk` `BasePlugin` with lifecycle hooks:

```typescript
class CostPlugin extends BasePlugin {
  // Called after every model response
  async afterModelCallback({ callbackContext, llmResponse }): Promise<LlmResponse | undefined>
  
  // Called after run completes
  async afterRunCallback({ invocationContext }): Promise<void>
}
```

### 5.2 Available Plugins

| Plugin | File | Purpose |
|--------|------|---------|
| `CostPlugin` | `cost-plugin.ts` | Track tokens, calculate costs, enforce budgets |
| `RetryPlugin` | `retry-plugin.ts` | Exponential backoff, inject failure context |
| `ValidationPlugin` | `validation-plugin.ts` | Run typecheck/lint/tests after changes |
| `CircuitBreakerPlugin` | `circuit-breaker-plugin.ts` | Stop on consecutive failures |
| `ContextPlugin` | `context-plugin.ts` | Inject project context |
| `QualityGatePlugin` | `quality-gate-plugin.ts` | Run krolik_audit post-task |
| `GitPlugin` | `git-plugin.ts` | Auto-commit on success |
| `MemoryPlugin` | `memory-plugin.ts` | Save decisions/bugfixes to memory |
| `RateLimitPlugin` | `rate-limit-plugin.ts` | Enforce API rate limits |
| `ActionPlugin` | `action-plugin.ts` | Felix Actions system |

### 5.3 Cost Plugin Implementation

```typescript
class CostPlugin extends BasePlugin {
  private totalTokens: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private totalCostUsd = 0;
  
  async afterModelCallback({ callbackContext, llmResponse }) {
    if (llmResponse.partial) return undefined;
    
    const usage = llmResponse.usageMetadata;
    const model = extractModelFromAgent(callbackContext);
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    
    // Calculate cost using pricing table
    const pricing = getPricing(model);
    const costUsd = (inputTokens / 1_000_000) * pricing.input 
                  + (outputTokens / 1_000_000) * pricing.output;
    
    // Update totals
    this.totalTokens.inputTokens += inputTokens;
    this.totalTokens.outputTokens += outputTokens;
    this.totalCostUsd += costUsd;
    
    // Store in session state
    callbackContext.eventActions.stateDelta['__cost'] = {
      current: { tokens, costUsd, model },
      total: { tokens: this.totalTokens, costUsd: this.totalCostUsd }
    };
    
    // Budget enforcement
    if (this.config.maxCostUsd && this.totalCostUsd > this.config.maxCostUsd) {
      this.config.onBudgetExceeded?.({ tokens, costUsd: this.totalCostUsd });
      return {
        ...llmResponse,
        errorCode: 'BUDGET_EXCEEDED',
        errorMessage: `Budget limit exceeded: $${this.totalCostUsd}`
      };
    }
    
    return undefined;
  }
}
```

### 5.4 Retry Plugin with Error Classification

```typescript
class RetryPlugin extends BasePlugin {
  async onModelErrorCallback({ callbackContext, llmRequest, error }) {
    const invocationId = callbackContext.invocationContext.invocationId;
    const state = this.getAttemptState(invocationId);
    state.count++;
    
    const category = this.classifyError(error);
    
    // Check retry limits
    if (state.count >= this.config.maxAttempts) return undefined;
    if (!this.config.retryableCategories.includes(category)) return undefined;
    
    // Exponential backoff with jitter
    const delay = this.calculateDelay(state.count);
    await this.sleep(delay);
    
    // Inject retry context for next attempt
    llmRequest.contents.push({
      role: 'user',
      parts: [{ text: `⚠️ RETRY ATTEMPT ${state.count}/${this.config.maxAttempts}
        Previous attempt failed: ${error.message}
        Please try a different approach.` 
      }]
    });
    
    return undefined;  // Trigger retry
  }
  
  private calculateDelay(attempt: number): number {
    const exponential = this.config.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = exponential * Math.random() * 0.25;
    return Math.min(exponential + jitter, this.config.maxDelayMs);
  }
}
```

### 5.5 Validation Plugin

```typescript
class ValidationPlugin extends BasePlugin {
  async afterModelCallback({ callbackContext, llmResponse }) {
    if (llmResponse.partial || llmResponse.errorCode) return undefined;
    
    const result = await this.runValidation();
    
    // Store for RetryPlugin to check
    callbackContext.eventActions.stateDelta['__validation'] = {
      passed: result.passed,
      failedSteps: result.steps.filter(s => !s.passed).map(s => s.step),
    };
    
    if (!result.passed) {
      return this.appendValidationErrors(llmResponse, result);
    }
    
    return undefined;
  }
  
  async runValidation(): Promise<ValidationResult> {
    const steps: StepResult[] = [];
    
    for (const step of this.config.steps) {
      const command = DEFAULT_COMMANDS[step];  // 'npx tsc --noEmit', etc.
      const { exitCode, output } = await this.exec(command);
      steps.push({ step, passed: exitCode === 0, output });
      
      if (!passed && this.config.failFast) break;
    }
    
    return { passed: steps.every(s => s.passed), steps };
  }
}
```

### 5.6 Plugin Factory

```typescript
function buildPluginList(corePlugins: CorePlugins, deps: PluginFactoryDeps): BasePlugin[] {
  const { config } = deps;
  const { costPlugin, validationPlugin, retryPlugin } = corePlugins;
  
  const plugins = [costPlugin, validationPlugin, retryPlugin];
  
  if (config.enableContext) plugins.push(new ContextPlugin({ projectRoot }));
  if (config.qualityGateMode) plugins.push(new QualityGatePlugin({ mode }));
  if (config.enableGitAutoCommit) plugins.push(new GitPlugin({ autoCommit: true }));
  plugins.push(new ActionPlugin({ projectRoot }));  // Always enabled
  if (config.enableMemory) plugins.push(new MemoryPlugin({ projectRoot }));
  if (config.rateLimit) plugins.push(new RateLimitPlugin(config.rateLimit));
  if (config.circuitBreaker) plugins.push(new CircuitBreakerPlugin(config.circuitBreaker));
  
  return [...plugins, ...config.plugins];  // Allow custom plugins
}
```

---

## 6. ADK Integration

### 6.1 Agent Hierarchy

Felix uses Google ADK's agent types:

```
OrchestratorAgent (LlmAgent)
└── subAgents:
    ├── Level0Agent (Sequential/Parallel/Worker)
    ├── Level1Agent (Sequential/Parallel/Worker)
    └── Level2Agent (Sequential/Parallel/Worker)
```

### 6.2 Agent Factory

```typescript
function createAgentHierarchy(prd: PRD, config: AgentFactoryConfig): BaseAgent {
  // Analyze tasks by dependency level
  const levels = analyzeTaskLevels(prd.tasks);
  
  // Create level agents
  const levelAgents = levels.map(level => createLevelAgent(level, config));
  
  // Wrap in orchestrator
  return createOrchestratorAgent(prd, levelAgents, config);
}

function createLevelAgent(level: TaskLevel, config: AgentFactoryConfig): BaseAgent {
  // Single task → Worker
  if (level.tasks.length === 1) {
    return createWorkerAgent(level.tasks[0], config, level.levelIndex);
  }
  
  // Multiple independent tasks → ParallelAgent
  if (level.isParallelizable && config.enableParallel) {
    return new ParallelAgent({
      name: `parallel_level_${level.levelIndex}`,
      subAgents: level.tasks.map(t => createWorkerAgent(t, config, level.levelIndex))
    });
  }
  
  // Multiple dependent tasks → SequentialAgent
  return new SequentialAgent({
    name: `sequential_level_${level.levelIndex}`,
    subAgents: level.tasks.map(t => createWorkerAgent(t, config, level.levelIndex))
  });
}
```

### 6.3 Worker Agent with Router Integration

```typescript
function createWorkerAgent(task: PRDTask, config: AgentFactoryConfig, levelIndex: number) {
  // Get routed LLM
  const { llm, decision } = selectLlmForTask(task, config);
  
  return new LlmAgent({
    name: toAgentName(task.id),
    model: llm,
    instruction: buildWorkerInstruction(task),
    outputKey: STATE_KEYS.taskResult(task.id),
    tools: config.tools,
    
    beforeModelCallback: async ({ context, request }) => {
      // Store routing decision in state
      if (decision) {
        context.state.set(ROUTING_DECISION_KEY(task.id), decision);
      }
      // Inject context from previous tasks
      const accumulated = context.state.get(STATE_KEYS.accumulatedChanges);
      if (accumulated) {
        request.contents.unshift({
          role: 'user',
          parts: [{ text: accumulated }]
        });
      }
    },
    
    afterModelCallback: async ({ context, response }) => {
      // Extract files changed, accumulate context for next tasks
      const filesChanged = extractFilesChanged(response);
      context.state.set(STATE_KEYS.taskFiles(task.id), filesChanged);
    }
  });
}

function selectLlmForTask(task: PRDTask, config: AgentFactoryConfig) {
  if (config.getLlmForTask) {
    return config.getLlmForTask(task);  // Router-based selection
  }
  return { llm: config.llm, decision: null };  // Fallback
}
```

### 6.4 SQLite Session Service for ADK

```typescript
class SQLiteSessionService extends BaseSessionService {
  async createSession(request: CreateSessionRequest): Promise<Session> {
    const id = request.sessionId ?? randomUUID();
    db.prepare(`INSERT INTO felix_adk_sessions ...`).run(id, request.appName, ...);
    return { id, appName, userId, state: {}, events: [], lastUpdateTime: Date.now() };
  }
  
  async getSession(request: GetSessionRequest): Promise<Session | undefined> {
    const row = db.prepare(`SELECT * FROM felix_adk_sessions WHERE id = ?`).get(...);
    const events = db.prepare(`SELECT * FROM felix_adk_events WHERE session_id = ?`).all(...);
    return { id: row.id, state: safeParseState(row.state), events: events.map(...) };
  }
  
  async appendEvent({ session, event }: AppendEventRequest): Promise<Event> {
    if (event.partial) return event;
    
    // Apply state delta
    this.applyStateDelta(session, event);
    
    // Persist event
    db.prepare(`INSERT INTO felix_adk_events ...`).run(event.id, session.id, ...);
    
    // Update session state
    db.prepare(`UPDATE felix_adk_sessions SET state = ? WHERE id = ?`)
      .run(JSON.stringify(session.state), session.id);
    
    return event;
  }
}
```

---

## 7. Model Configuration

### 7.1 Model Definitions (`router/models.config.ts`)

```typescript
const MODEL_DEFINITIONS: ModelDefinition[] = [
  // FREE TIER - VibeProxy (Antigravity)
  { id: 'vibe-opus', tier: 'free', inputCostPer1M: 0, outputCostPer1M: 0, ... },
  { id: 'vibe-sonnet', tier: 'free', ... },
  
  // FREE TIER - Groq
  { id: 'llama-70b', tier: 'free', inputCostPer1M: 0, outputCostPer1M: 0, ... },
  { id: 'deepseek-r1', tier: 'free', ... },
  
  // CHEAP TIER
  { id: 'flash', tier: 'cheap', inputCostPer1M: 0.075, outputCostPer1M: 0.3, ... },
  { id: 'haiku', tier: 'cheap', inputCostPer1M: 0.25, outputCostPer1M: 1.25, ... },
  { id: 'gpt-4o-mini', tier: 'cheap', inputCostPer1M: 0.15, outputCostPer1M: 0.6, ... },
  
  // MID TIER
  { id: 'pro', tier: 'mid', inputCostPer1M: 1.25, outputCostPer1M: 5.0, ... },
  { id: 'sonnet', tier: 'mid', inputCostPer1M: 3.0, outputCostPer1M: 15.0, ... },
  { id: 'gpt-4o', tier: 'mid', inputCostPer1M: 2.5, outputCostPer1M: 10.0, ... },
  
  // PREMIUM TIER
  { id: 'opus', tier: 'premium', inputCostPer1M: 15.0, outputCostPer1M: 75.0, ... },
  { id: 'o1', tier: 'premium', inputCostPer1M: 15.0, outputCostPer1M: 60.0, ... },
  { id: 'thinking', tier: 'premium', inputCostPer1M: 10.0, outputCostPer1M: 40.0, ... },
];
```

### 7.2 Provider Configuration

```typescript
const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  { id: 'anthropic', cliExecutable: 'claude', apiKeyEnvVar: 'ANTHROPIC_API_KEY', ... },
  { id: 'google', cliExecutable: 'gemini', apiKeyEnvVar: 'GOOGLE_API_KEY', ... },
  { id: 'groq', apiBaseUrl: 'https://api.groq.com/openai/v1', ... },
  { id: 'openai', apiBaseUrl: 'https://api.openai.com/v1', ... },
  { id: 'vibeproxy', apiBaseUrl: 'http://localhost:8318/v1', ... },
];
```

---

## 8. Cost Estimation

### 8.1 Token Estimation by Complexity

```typescript
const DEFAULT_INPUT_TOKENS = 4000;
const DEFAULT_OUTPUT_TOKENS = 2000;

const COMPLEXITY_TOKEN_MULTIPLIERS = {
  trivial: 0.5,
  simple: 0.75,
  moderate: 1.0,
  complex: 1.5,
  epic: 2.5,
};

function estimateTokens(task: TaskAttributes) {
  const multiplier = COMPLEXITY_TOKEN_MULTIPLIERS[task.complexity ?? 'moderate'];
  const filesMultiplier = 1 + (task.filesAffected?.length ?? 0) * 0.1;
  
  return {
    input: Math.round(DEFAULT_INPUT_TOKENS * multiplier * filesMultiplier),
    output: Math.round(DEFAULT_OUTPUT_TOKENS * multiplier * filesMultiplier)
  };
}
```

### 8.2 Three-Point Cost Estimation

```typescript
function estimateTaskCost(task: TaskAttributes, projectPath?: string): TaskCostEstimate {
  const { tier, suggestedModel } = calculateTaskScore(task);
  const tokens = estimateTokens(task);
  
  // Get escalation probability from history or defaults
  let escalationProbability = getDefaultEscalationProbability(tier);
  if (projectPath) {
    const patterns = getRoutingPatterns(createTaskSignature(task).hash, projectPath);
    if (patterns.length > 0) {
      // Calculate from actual history
      escalationProbability = calculateHistoricalEscalationRate(patterns, tier);
    }
  }
  
  // Calculate three scenarios
  const cheapestModel = getCheapestModel();
  const premiumModel = getPremiumModel();
  
  const optimisticCost = estimateCost(cheapestModel, tokens.input, tokens.output);
  const baseCost = estimateCost(suggestedModel, tokens.input, tokens.output);
  const premiumCost = estimateCost(premiumModel, tokens.input, tokens.output);
  
  // Expected includes escalation probability
  const expectedCost = baseCost * (1 - escalationProbability) 
                     + premiumCost * escalationProbability;
  
  return {
    taskId: task.id,
    estimatedModel: suggestedModel,
    optimisticCost,
    expectedCost,
    pessimisticCost: premiumCost,
    escalationProbability
  };
}
```

---

## 9. Main Router Flow

### 9.1 Complete Routing Decision (`router/router.ts`)

```typescript
function routeTask(options: RouteTaskOptions): RoutingDecision {
  const { task, preference, projectPath } = options;
  
  // 1. Explicit model preference
  if (preference?.model) {
    return createCascadeDecision(task.id, preference.model, 'preference', 100, 
                                 preference.noCascade, preference.forceMode);
  }
  
  // 2. Rule-based scoring
  const scoring = calculateTaskScore(task);
  let tier = scoring.tier;
  let suggestedModel = scoring.suggestedModel;
  let source: 'rule' | 'history' | 'preference' = 'rule';
  
  // 3. Apply minimum tier preference
  if (preference?.minTier && compareTiers(tier, preference.minTier) < 0) {
    tier = preference.minTier;
    suggestedModel = DEFAULT_MODELS[tier];
  }
  
  // 4. History-based adjustment
  const signature = createTaskSignature(task);
  const historyAdjustment = analyzeHistory(task, tier, projectPath);
  
  if (historyAdjustment && historyAdjustment.confidence > 0.5) {
    tier = historyAdjustment.adjustedTier;
    suggestedModel = DEFAULT_MODELS[tier];
    source = 'history';
  }
  
  // 5. Best model from history for this signature
  const historyModel = getBestModelFromHistory(signature.hash, tier, projectPath);
  if (historyModel) {
    suggestedModel = historyModel;
    source = 'history';
  }
  
  return createCascadeDecision(task.id, suggestedModel, source, scoring.score,
                               preference?.noCascade, preference?.forceMode);
}
```

### 9.2 Execution Plan Determination

```typescript
function determineExecutionPlan(score: number, tier: ModelTier, forceMode?: ExecutionMode) {
  if (forceMode) {
    return { mode: forceMode, parallelizable: forceMode === 'multi', ... };
  }
  
  // Cheap tier: single agent most cost-effective
  if (tier === 'cheap') {
    return { mode: 'single', parallelizable: false, suggestedAgentCount: 1 };
  }
  
  // Mid tier: single agent for focused work
  if (tier === 'mid') {
    return { mode: 'single', parallelizable: false, suggestedAgentCount: 1 };
  }
  
  // Premium tier: multi-agent for parallelization
  return {
    mode: 'multi',
    parallelizable: true,
    suggestedAgentCount: Math.min(5, Math.ceil(score / 25))  // 3-4 agents
  };
}
```

---

## 10. Key Files Reference

| File | Lines | Purpose |
|------|-------|---------|
| `router/router.ts` | ~300 | Main routing logic |
| `router/history.ts` | ~280 | History analysis & patterns |
| `router/model-tiers.ts` | ~350 | Tier definitions, escalation paths |
| `router/cascade.ts` | ~250 | Cascade execution with fallback |
| `router/rules.ts` | ~90 | Rule-based scoring |
| `router/cost-estimator.ts` | ~180 | Cost estimation |
| `router/models.config.ts` | ~400 | Model definitions |
| `plugins/cost-plugin.ts` | ~140 | Token/cost tracking |
| `plugins/retry-plugin.ts` | ~240 | Retry with backoff |
| `plugins/validation-plugin.ts` | ~160 | Validation pipeline |
| `agents/agent-factory.ts` | ~90 | Agent hierarchy creation |
| `agents/worker-agent.ts` | ~200 | Task execution agents |
| `services/sqlite-session.ts` | ~300 | ADK session persistence |

---

## 11. Adaptation for OpenClaw

### Key Concepts to Port

1. **Scoring Algorithm**
   - Task attributes → score → tier
   - Tag boosts for domain-specific adjustments

2. **History Learning**
   - Store outcomes by task signature
   - Adjust tier based on failure/success rates
   - Confidence threshold (MIN_SAMPLES=3)

3. **Cascade Execution**
   - Error classification (retry vs escalate)
   - Exponential backoff with jitter
   - Escalation path generation

4. **Cost Estimation**
   - Three-point estimates (optimistic/expected/pessimistic)
   - Factor in escalation probability

### Differences from OpenClaw

| Aspect | Felix | OpenClaw Adaptation |
|--------|-------|---------------------|
| Task format | PRD JSON | Session task description |
| Storage | SQLite in project | SQLite in workspace |
| Agents | ADK SequentialAgent/ParallelAgent | sessions_spawn |
| Session | ADK Session | OpenClaw session |

---

## Summary

Felix provides a sophisticated adaptive model routing system with:

- **Intelligent scoring** from task complexity, files, tags
- **Learning from history** with statistical thresholds
- **Automatic escalation** on capability failures
- **Cost optimization** through downgrades when successful
- **Plugin architecture** for validation, retry, cost control
- **ADK integration** for multi-agent orchestration

The core algorithms (scoring, history analysis, cascade execution) are portable to any LLM routing system.
