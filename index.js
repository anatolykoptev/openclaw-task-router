/**
 * OpenClaw Task Router Plugin
 * 
 * Dynamic model routing with MemOS learning.
 * All logic inlined to avoid module caching issues.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const MCPORTER = '/home/krolik/.nvm/versions/node/v24.13.0/bin/mcporter';

// Dedicated cube for task-router data (keeps personal memories clean)
const TASK_ROUTER_CUBE_ID = 'fea6f89c-f9e5-4894-8e15-a22b8e756c04';

const TIER_THRESHOLDS = {
  free: [0, 20], cheap: [21, 40], standard: [41, 65], premium: [66, 100]
};

const FALLBACK_MODELS = {
  free: 'openrouter/moonshotai/kimi-k2:free',
  cheap: 'google/gemini-2.5-flash',
  standard: 'anthropic/claude-sonnet-4',
  premium: 'anthropic/claude-opus-4-5',
  research: 'openrouter/perplexity/sonar-pro',
};

const BASE_SCORES = {
  trivial: 15, simple: 25, code: 45, content: 40,
  analysis: 55, research: 50, architect: 75, general: 40,
};

const COMPLEXITY_KEYWORDS = {
  // EN
  'architect': 25, 'design system': 25, 'security audit': 25,
  'refactor entire': 25, 'performance optimization': 20,
  'rewrite': 20, 'migrate': 18, 'integrate': 15, 'complex': 15,
  'analyze': 12, 'debug': 12, 'implement': 10, 'add feature': 10,
  'create': 8, 'build': 8, 'fix bug': 6, 'update': 5,
  'format': -10, 'rename': -10, 'typo': -15, 'comment': -8,
  'simple': -15, 'quick': -10, 'trivial': -15, 'lint': -12,
  // RU
  'архитектур': 25, 'спроектир': 25, 'безопасност': 20,
  'рефактор': 20, 'оптимизир': 15, 'мигрир': 18, 'интегрир': 15,
  'сложн': 15, 'комплексн': 15, 'анализ': 12, 'отладк': 12,
  'реализ': 10, 'создай подборк': 12, 'напиши статью': 10,
  'создай': 8, 'напиши': 6, 'исправ': 5, 'обнов': 5,
  'опечатк': -15, 'простой': -12, 'быстро': -10, 'мелк': -10,
  'перевед': 5, 'seo': 10, 'парс': 8, 'спарс': 8,
};

const RESEARCH_KEYWORDS = [
  'research', 'find out', 'search for', 'compare', 'alternatives',
  'what is', 'how does', 'explore', 'investigate', 'benchmark',
  // RU
  'исследуй', 'найди информацию', 'сравни', 'альтернатив',
  'что такое', 'как работает', 'изучи', 'проанализируй рынок',
];

// ═══════════════════════════════════════════════════════════════════════════
// MEMOS INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

function callMemos(method, args = {}, useCube = true) {
  try {
    // Auto-inject cube for model/routing operations
    if (useCube) {
      if (method === 'search_memories' && !args.cube_ids) {
        args.cube_ids = `["${TASK_ROUTER_CUBE_ID}"]`;
      } else if (method === 'add_memory' && !args.cube_id) {
        args.cube_id = TASK_ROUTER_CUBE_ID;
      }
    }
    
    const argsStr = Object.entries(args)
      .map(([k, v]) => {
        // Don't double-quote arrays
        if (typeof v === 'string' && v.startsWith('[')) {
          return `${k}: ${v}`;
        }
        return `${k}: "${String(v).replace(/"/g, '\\"')}"`;
      })
      .join(', ');
    
    const tmpPath = join(tmpdir(), `memos-${Date.now()}.json`);
    execSync(`${MCPORTER} call 'memos.${method}(${argsStr})' > ${tmpPath} 2>/dev/null`, { timeout: 10000 });
    
    const data = JSON.parse(readFileSync(tmpPath, 'utf-8'));
    unlinkSync(tmpPath);
    return data;
  } catch {
    return null;
  }
}

function loadModelsForTier(tier) {
  const result = callMemos('search_memories', { query: `MODEL tier:${tier}` });
  if (!result) return [];
  
  const bestByFull = new Map();
  const disabledModels = new Set();
  
  // First pass: collect all entries and track disabled models
  for (const cube of result.text_mem || []) {
    for (const mem of cube.memories || []) {
      const text = mem.memory || '';
      if (!text.startsWith('MODEL ')) continue;
      
      const tierMatch = text.match(/tier:(\w+)/);
      const fullMatch = text.match(/full:([^\s]+)/);
      const priorityMatch = text.match(/priority:(\d+)/);
      const statusMatch = text.match(/status:(\w+)/);
      
      if (!tierMatch || tierMatch[1] !== tier) continue;
      if (!fullMatch) continue;
      
      const full = fullMatch[1];
      const status = statusMatch ? statusMatch[1] : 'active';
      
      // If this entry is disabled, mark the model as disabled and remove from bestByFull
      if (status === 'disabled') {
        disabledModels.add(full);
        bestByFull.delete(full);
        continue;
      }
      
      // Skip if model is already marked as disabled
      if (disabledModels.has(full)) continue;
      
      // Only keep active entries
      if (status !== 'active') continue;
      
      const priority = priorityMatch ? parseInt(priorityMatch[1]) : 0;
      
      const existing = bestByFull.get(full);
      if (!existing || priority > existing.priority) {
        bestByFull.set(full, { full, priority });
      }
    }
  }
  
  return Array.from(bestByFull.values()).sort((a, b) => b.priority - a.priority);
}

function getModelForTier(tier) {
  try {
    const models = loadModelsForTier(tier);
    if (models.length > 0) return models[0].full;
  } catch { /* fallback */ }
  return FALLBACK_MODELS[tier] || FALLBACK_MODELS.standard;
}

function recordOutcome(signature, model, outcome, task = '') {
  const date = new Date().toISOString().split('T')[0];
  const taskClean = task.slice(0, 100).replace(/"/g, "'");
  callMemos('add_memory', { 
    memory_content: `ROUTING sig:${signature} model:${model} outcome:${outcome} task:${taskClean} ts:${date}` 
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════════════════════════════

function computeSignature(task) {
  let normalized = task.toLowerCase()
    .replace(/\b\w+\.(py|js|ts|tsx|sh|md|json|yaml|yml)\b/g, 'FILE.$1')
    .replace(/\d+/g, 'N')
    .split(/\s+/).join(' ').trim();
  return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12);
}

function detectTaskType(task) {
  const lower = task.toLowerCase();
  if (RESEARCH_KEYWORDS.some(kw => lower.includes(kw))) return 'research';
  if (/architect|design.*system|infrastructure/i.test(lower)) return 'architect';
  if (/typo|format|rename|lint/i.test(lower)) return 'trivial';
  if (/simple|quick|trivial/i.test(lower)) return 'simple';
  if (/code|implement|function|class|module|api/i.test(lower)) return 'code';
  if (/write|article|content|blog|documentation/i.test(lower)) return 'content';
  if (/analyze|report|data|metrics/i.test(lower)) return 'analysis';
  return 'general';
}

function scoreToTier(score, isResearch) {
  if (isResearch) return 'research';
  for (const [tier, [min, max]] of Object.entries(TIER_THRESHOLDS)) {
    if (score >= min && score <= max) return tier;
  }
  return score > 85 ? 'premium' : 'free';
}

function routeTask(prompt) {
  const taskType = detectTaskType(prompt);
  const isResearch = taskType === 'research';
  let score = BASE_SCORES[taskType] || 40;
  const matchedKeywords = [];
  
  const lower = prompt.toLowerCase();
  for (const [kw, mod] of Object.entries(COMPLEXITY_KEYWORDS)) {
    if (lower.includes(kw)) {
      score += mod;
      matchedKeywords.push(`${kw}(${mod > 0 ? '+' : ''}${mod})`);
    }
  }
  score = Math.max(5, Math.min(95, score));
  
  const tier = scoreToTier(score, isResearch);
  const signature = computeSignature(prompt);
  const model = getModelForTier(tier);
  
  const reasoning = [
    `type=${taskType}`,
    `base=${BASE_SCORES[taskType] || 40}`,
    matchedKeywords.length > 0 ? `keywords=${matchedKeywords.join(',')}` : null,
    `→${tier}(score=${score})`,
  ].filter(Boolean).join(' | ');
  
  return { model, tier, score, signature, taskType, reasoning };
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

const COST_THRESHOLD = 0.15; // $0.15 per 1M tokens

function classifyModelTier(cost) {
  if (cost === 0) return 'free';
  if (cost < 0.05) return 'cheap';
  if (cost < 0.15) return 'standard';
  return 'premium';
}

function calculatePriority(model, cost) {
  let priority = 50;
  
  // Cost-based (lower is better for budget tiers)
  if (cost === 0) priority += 20;
  else if (cost < 0.02) priority += 15;
  else if (cost < 0.05) priority += 10;
  
  // Context length bonus
  const ctx = model.context_length || 0;
  if (ctx >= 128000) priority += 15;
  else if (ctx >= 32000) priority += 10;
  else if (ctx >= 16000) priority += 5;
  
  // Recency bonus (newer models preferred)
  if (model.created) {
    const age = Date.now() / 1000 - model.created;
    const daysOld = age / 86400;
    if (daysOld < 30) priority += 10;
    else if (daysOld < 90) priority += 5;
  }
  
  // Capability bonuses
  if (model.name && /gpt-4|claude|gemini/i.test(model.name)) priority += 5;
  
  return Math.min(100, Math.max(0, priority));
}

async function fetchOpenRouterModels() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set');
  }
  
  const resp = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  
  if (!resp.ok) {
    throw new Error(`OpenRouter API error: ${resp.status}`);
  }
  
  const data = await resp.json();
  return data.data || [];
}

function getExistingModels() {
  const existing = new Set();
  
  for (const tier of ['free', 'cheap', 'standard', 'premium']) {
    const result = callMemos('search_memories', { query: `MODEL tier:${tier}` });
    if (!result) continue;
    
    for (const cube of result.text_mem || []) {
      for (const mem of cube.memories || []) {
        const text = mem.memory || '';
        const fullMatch = text.match(/full:([^\s]+)/);
        if (fullMatch) {
          existing.add(fullMatch[1]);
        }
      }
    }
  }
  
  return existing;
}

async function discoverAndSyncModels() {
  const results = { added: [], skipped: [], errors: [] };
  
  try {
    // Fetch all models from OpenRouter
    const models = await fetchOpenRouterModels();
    console.log(`[discovery] Fetched ${models.length} models from OpenRouter`);
    
    // Get existing models in MemOS
    const existing = getExistingModels();
    console.log(`[discovery] Found ${existing.size} existing models in MemOS`);
    
    // Filter and process models
    for (const model of models) {
      const modelId = model.id;
      const fullId = `openrouter/${modelId}`;
      
      // Skip if already exists
      if (existing.has(fullId)) {
        results.skipped.push({ id: fullId, reason: 'already exists' });
        continue;
      }
      
      // Get cost (prompt cost per 1M tokens)
      const promptCost = parseFloat(model.pricing?.prompt || '0') * 1000000;
      
      // Skip expensive models
      if (promptCost > COST_THRESHOLD) {
        results.skipped.push({ id: fullId, reason: `cost $${promptCost.toFixed(3)}/1M > threshold` });
        continue;
      }
      
      // Determine tier and priority
      const tier = classifyModelTier(promptCost);
      const priority = calculatePriority(model, promptCost);
      
      // Build memory entry
      const memoryContent = [
        'MODEL',
        `tier:${tier}`,
        `full:${fullId}`,
        `priority:${priority}`,
        `status:active`,
        `cost:${promptCost.toFixed(4)}`,
        `ctx:${model.context_length || 0}`,
        `added:${new Date().toISOString().split('T')[0]}`,
      ].join(' ');
      
      try {
        callMemos('add_memory', { memory_content: memoryContent });
        results.added.push({ id: fullId, tier, priority, cost: promptCost });
        console.log(`[discovery] Added: ${fullId} (tier=${tier}, priority=${priority})`);
      } catch (err) {
        results.errors.push({ id: fullId, error: err.message });
      }
    }
    
    return results;
  } catch (err) {
    results.errors.push({ error: err.message });
    return results;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PLUGIN REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

const activeTasks = new Map();

export default {
  id: 'openclaw-task-router',
  name: 'Task Router',
  kind: 'lifecycle',
  
  register(api) {
    const config = api.pluginConfig || {};
    const injectRecommendation = config.injectRecommendation !== false;
    const recordOutcomes = config.recordOutcomes !== false;
    
    api.logger.info('[task-router] Registering...');
    
    // Before agent start: inject routing recommendation
    if (injectRecommendation) {
      api.on('before_agent_start', async (event) => {
        if (!event.prompt || event.prompt.length < 10) return;
        
        try {
          const route = routeTask(event.prompt);
          
          const taskId = `${Date.now()}-${route.signature}`;
          activeTasks.set(taskId, {
            signature: route.signature,
            model: route.model,
            prompt: event.prompt.slice(0, 200),
            startedAt: Date.now(),
          });
          
          // Cleanup old tasks
          const cutoff = Date.now() - 3600000;
          for (const [id, task] of activeTasks) {
            if (task.startedAt < cutoff) activeTasks.delete(id);
          }
          
          return {
            prependContext: `<task_routing>
Model: ${route.model}
Tier: ${route.tier} (score: ${route.score})
Reasoning: ${route.reasoning}
</task_routing>`,
          };
        } catch (err) {
          api.logger.warn(`[task-router] ${err.message}`);
        }
      }, { priority: 50 });
    }
    
    // Agent end: record outcome
    if (recordOutcomes) {
      api.on('agent_end', async (event) => {
        for (const [id, task] of activeTasks) {
          if (Date.now() - task.startedAt < 1800000) {
            try {
              recordOutcome(task.signature, task.model, event.success ? 'success' : 'fail', task.prompt);
              activeTasks.delete(id);
            } catch { /* ignore */ }
            break;
          }
        }
      }, { priority: 10 });
    }
    
    // HTTP endpoint
    api.registerHttpRoute({
      path: '/task-router/route',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        
        let body = '';
        for await (const chunk of req) body += chunk;
        
        try {
          const { task } = JSON.parse(body);
          if (!task) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'task required' }));
            return;
          }
          
          const result = routeTask(task);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      },
    });
    
    // Tool: route_task
    api.registerTool({
      name: 'route_task',
      description: 'Get model routing recommendation for a task',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string' } },
        required: ['task'],
      },
      execute: async (params) => routeTask(params.task),
    });
    
    // Tool: discover_models
    api.registerTool({
      name: 'discover_models',
      description: 'Discover and sync cheap/free models from OpenRouter to MemOS',
      parameters: { type: 'object', properties: {} },
      execute: async () => discoverAndSyncModels(),
    });
    
    // HTTP endpoint for discovery
    api.registerHttpRoute({
      path: '/task-router/discover',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        
        try {
          const result = await discoverAndSyncModels();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result, null, 2));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      },
    });
    
    api.logger.info('[task-router] Registered ✓');
  },
};

// Export for CLI usage
export { discoverAndSyncModels, routeTask };
