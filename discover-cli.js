#!/usr/bin/env node
/**
 * CLI for model discovery - Cron-optimized version
 * Usage: node discover-cli.js [--dry-run] [--limit N]
 */

import { runMemos } from './memos-exec.js';

const COST_THRESHOLD = 0.15;

function callMemos(method, args = {}) {
  try {
    const payload = Object.fromEntries(
      Object.entries(args).map(([k, v]) => [k, String(v)]),
    );
    const content = runMemos(method, payload, 15000).trim();
    
    // Handle both JSON and plain text responses
    try {
      return JSON.parse(content);
    } catch {
      // Plain text response (like "Memory added successfully")
      return content.length > 0 ? { success: true, message: content } : null;
    }
  } catch (err) {
    return null;
  }
}

function getExistingModels() {
  const existing = new Set();
  const result = callMemos('search_memories', { query: 'MODEL tier:' });
  if (!result) return existing;
  
  for (const cube of result.text_mem || []) {
    for (const mem of cube.memories || []) {
      const text = mem.memory || '';
      const fullMatch = text.match(/full:([^\s]+)/);
      if (fullMatch) existing.add(fullMatch[1]);
    }
  }
  return existing;
}

function classifyTier(cost) {
  if (cost === 0) return 'free';
  if (cost < 0.05) return 'cheap';
  if (cost < 0.15) return 'standard';
  return 'premium';
}

function calcPriority(model, cost) {
  let p = 50;
  if (cost === 0) p += 20;
  else if (cost < 0.02) p += 15;
  else if (cost < 0.05) p += 10;
  
  const ctx = model.context_length || 0;
  if (ctx >= 128000) p += 15;
  else if (ctx >= 32000) p += 10;
  else if (ctx >= 16000) p += 5;
  
  return Math.min(100, Math.max(0, p));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || 50 : 50;
  
  console.log(`[discovery] Starting (dryRun=${dryRun}, limit=${limit})...`);
  
  // Fetch models from OpenRouter
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY not set');
    process.exit(1);
  }
  
  const resp = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  
  if (!resp.ok) {
    console.error(`API error: ${resp.status}`);
    process.exit(1);
  }
  
  const data = await resp.json();
  const models = data.data || [];
  console.log(`[discovery] Fetched ${models.length} models`);
  
  // Get existing
  const existing = getExistingModels();
  console.log(`[discovery] Existing in MemOS: ${existing.size}`);
  
  // Filter and sort by priority (best first)
  const candidates = [];
  for (const m of models) {
    const fullId = `openrouter/${m.id}`;
    if (existing.has(fullId)) continue;
    
    const cost = parseFloat(m.pricing?.prompt || '0') * 1000000;
    if (cost > COST_THRESHOLD) continue;
    
    const tier = classifyTier(cost);
    const priority = calcPriority(m, cost);
    candidates.push({ fullId, tier, priority, cost, ctx: m.context_length || 0 });
  }
  
  // Sort by priority descending
  candidates.sort((a, b) => b.priority - a.priority);
  const toAdd = candidates.slice(0, limit);
  
  console.log(`[discovery] Candidates: ${candidates.length}, will add: ${toAdd.length}`);
  
  let added = 0;
  for (const c of toAdd) {
    const mem = `MODEL tier:${c.tier} full:${c.fullId} priority:${c.priority} status:active cost:${c.cost.toFixed(4)} ctx:${c.ctx} added:${new Date().toISOString().split('T')[0]}`;
    
    if (dryRun) {
      console.log(`[dry-run] Would add: ${c.fullId} (${c.tier}, p=${c.priority})`);
    } else {
      const result = callMemos('add_memory', { memory_content: mem });
      if (result) {
        console.log(`[added] ${c.fullId} (${c.tier}, p=${c.priority})`);
        added++;
      }
    }
  }
  
  console.log(`\n=== Summary ===`);
  console.log(`Total models: ${models.length}`);
  console.log(`Already in MemOS: ${existing.size}`);
  console.log(`Cheap/free candidates: ${candidates.length}`);
  console.log(`Added this run: ${added}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
