# Best Practices for LLM Model Routing Systems

*Research compiled: January 31, 2026*

## Executive Summary

This document synthesizes external best practices for LLM model routing systems. Key findings:

1. **Cascade routing outperforms pure routing or cascading** — combines adaptability with cost-efficiency
2. **Preference data is gold** — routers trained on human preference data significantly outperform rule-based approaches
3. **Data augmentation is key** — even small amounts of domain-specific golden-label data (2% of training) dramatically improves routing accuracy
4. **Semantic routing excels at domain classification** — use embeddings for broad categories, LLM classifiers for fine-grained decisions
5. **Online learning from feedback enables continuous improvement** — bandit-style feedback loops refine routing decisions over time

---

## 1. Routing Paradigms

### 1.1 Pure Routing
*Send each query to a single model based on classification*

**How it works:**
- Classify query → Select model → Execute
- No fallback or retry

**Pros:**
- Simple to implement
- Predictable costs
- Low latency (single model call)

**Cons:**
- Commits to initial decision
- No recovery from poor predictions

**Used by:** LangChain's `RouterChain`, LlamaIndex's `RouterQueryEngine`

### 1.2 Cascading
*Try smaller models first, escalate to larger models if needed*

**How it works:**
- Start with cheapest model
- Check if answer is "good enough" (self-evaluation or threshold)
- Escalate to next tier if not

**Pattern (from FrugalGPT):**
```
for model in [cheapest → most_expensive]:
    response = model.generate(query)
    if confidence_score(response) >= threshold:
        return response
return most_expensive_model.generate(query)
```

**Pros:**
- Cost-efficient for easy queries
- Guarantees quality through fallback

**Cons:**
- Latency increases with escalation
- Sequential execution is slow

**Research finding:** FrugalGPT achieves up to **98% cost reduction** vs GPT-4 while matching quality.

### 1.3 Cascade Routing (RECOMMENDED)
*Hybrid approach combining routing and cascading*

**From ETH Zurich research (arXiv:2410.10347):**
- Initial routing to any model (not just cheapest)
- Can re-route to different models based on output quality
- Provably optimal under their framework

**Key insight:** Cascade routing outperforms both pure routing and cascading by 1-4% across benchmarks while reducing costs.

**Implementation:** Route based on predicted complexity, but allow escalation if initial model fails quality check.

---

## 2. Routing Strategies

### 2.1 Rule-Based / Keyword Routing
*Current approach in our system*

**Patterns to keep:**
- Keyword scoring for complexity estimation
- Base scores by task type (code, research, content)
- File count and code block detection

**Improvements needed:**
- Add more sophisticated pattern matching
- Weight keywords by position (title vs body)
- Consider query length as factor

### 2.2 Semantic Routing
*Use embeddings for similarity-based routing*

**How it works:**
1. Pre-define reference prompts for each category/model
2. Embed incoming query
3. Find nearest reference prompts via cosine similarity
4. Route to corresponding model

**Open-source options:**
- **Semantic Router** (Aurelio Labs) — fastest, uses vector similarity
- **Pulze AI KNN Router** — Go-based, k-nearest neighbors approach

**Best for:**
- Large number of task categories
- Domain classification (billing, technical, sales)
- Coarse-grained routing decisions

**Integration with MemOS:** Use BGE-M3 embeddings (already available via memos-mcp) for semantic similarity matching.

### 2.3 LLM-Classifier Routing
*Use small LLM to classify query complexity*

**From RouteLLM research:**
- BERT classifier predicting which model performs better
- Causal LLM classifier for more nuanced decisions
- Matrix factorization for scoring model-query affinity

**Cost:** ~150 input tokens + 1 output token per classification

**When to use:**
- Fine-grained classification within domains
- Task complexity estimation
- When semantic similarity isn't sufficient

### 2.4 Hybrid Approach (RECOMMENDED)
*Combine semantic routing for broad categories + classifier for fine-grained decisions*

```
┌─────────────────────────────────────────────────────────┐
│ Query                                                   │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Semantic Router (fast, cheap)                           │
│ → Route to domain: code | research | content | complex  │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
          [code]      [research]    [complex]
              │            │            │
              ▼            ▼            ▼
       Keyword +      → Perplexity  LLM Classifier
       complexity                   for tier decision
       scoring                      (Sonnet vs Opus)
```

---

## 3. Success Tracking & Learning

### 3.1 Outcome Recording (Current Implementation)
Our `record_outcome.py` already tracks:
- Task signature (hashed)
- Model used
- Success/failure
- Duration

**Keep this pattern.** It's aligned with best practices.

### 3.2 Learning from Preference Data
**Key insight from RouteLLM:**
- Routers trained on human preference data (Arena battles) dramatically outperform heuristics
- Even matrix factorization (simple) achieves 85% cost reduction with 95% quality

**For our system:**
- Track which model actually succeeded for each task type
- Use success/failure as implicit preference signal
- Aggregate patterns: "code refactoring tasks succeed 90% with Sonnet, 98% with Opus"

### 3.3 Online Learning with Bandit Feedback
**From recent research (arXiv:2510.07429, arXiv:2508.21141):**
- Model routing as contextual bandit problem
- Explore/exploit tradeoff for trying new models
- Cost-aware exploration (don't explore with Opus when Flash might work)

**Implementation ideas:**
- Track confidence intervals per (task_type, model) pair
- Occasionally route to uncertain models to gather data
- UCB-style exploration: try models with high uncertainty

### 3.4 Success Rate Thresholds for Auto-Escalation
```python
# Pseudo-code for adaptive tier selection
def get_adaptive_tier(task_signature: str, base_tier: str) -> str:
    success_rate = get_success_rate(task_signature, base_tier)
    
    if success_rate < 0.5:  # Below 50% - escalate
        return escalate_tier(base_tier)
    elif success_rate > 0.85 and sample_size > 10:  # High success - consider downgrade
        return maybe_downgrade_tier(base_tier)
    else:
        return base_tier
```

---

## 4. Cost Optimization Strategies

### 4.1 Tier Pricing Reality
```
Tier       | Model                 | ~Cost per 1M tokens | Relative
-----------|----------------------|---------------------|----------
free       | Gemini Flash         | $0.075 input        | 1x
standard   | Claude Sonnet        | $3 input / $15 out  | 40x input
premium    | Claude Opus          | $15 input / $75 out | 200x input
research   | Perplexity Sonar Pro | ~$3 per query       | varies
```

**Key insight:** A 10x cheaper model that succeeds 80% of the time is better than a 10x more expensive model that succeeds 90%.

### 4.2 Cost-Quality Optimization Formula
From ETH Zurich research:
```
τ(query, λ) = quality(query) - λ × cost(query)
```

Where `λ` controls the quality-cost tradeoff. Higher λ = more cost-sensitive.

### 4.3 Budget-Constrained Routing
**Pattern:** Set daily/weekly budget, let router optimize within it.

```python
class BudgetAwareRouter:
    def __init__(self, daily_budget: float):
        self.budget = daily_budget
        self.spent_today = 0.0
    
    def route(self, task: str) -> str:
        remaining = self.budget - self.spent_today
        
        if remaining < OPUS_COST:
            return force_tier("standard")
        
        # Normal routing with cost awareness
        tier = compute_tier(task)
        if tier == "premium" and remaining < OPUS_COST * 2:
            return "standard"  # Save budget for truly critical tasks
        return tier
```

### 4.4 Prompt Caching Benefits
**From OpenRouter/Anthropic:**
- Repeated context can be cached
- Cache hits are ~10x cheaper
- Consider routing to same model for similar tasks to maximize cache hits

---

## 5. Anti-Patterns to Avoid

### 5.1 ❌ Defaulting to Largest Model
**Problem:** Using Opus for everything because "it's best"
**Reality:** 60-80% of tasks can be handled by Sonnet/Flash with equal success
**Fix:** Start with lower tier, escalate only when needed

### 5.2 ❌ Static Task-Model Mapping
**Problem:** "All code = Sonnet, all analysis = Opus"
**Reality:** Code complexity varies 100x, simple analysis doesn't need Opus
**Fix:** Score complexity within task type, not just by type

### 5.3 ❌ Ignoring Failure Feedback
**Problem:** Router keeps making same mistakes
**Reality:** Without learning, you repeat errors indefinitely
**Fix:** Track outcomes, adjust routing based on historical success

### 5.4 ❌ Over-Routing
**Problem:** Spending 500ms on routing decision for 2s task
**Reality:** Router overhead should be <5% of task time
**Fix:** Keep routing fast (keyword + lookup), use LLM classifiers sparingly

### 5.5 ❌ No Fallback Strategy
**Problem:** Router picks wrong model, task fails, user frustrated
**Reality:** Any single model can fail on any task
**Fix:** Implement cascade/retry with escalation

### 5.6 ❌ Exposing Logic-Layer LLMs to Raw User Input
**From Softlandia research:**
**Problem:** Users can phrase questions many ways, confusing classifiers
**Fix:** Normalize/preprocess queries before classification

---

## 6. Novel Ideas for Our System

### 6.1 MemOS-Specific Optimizations

**Leverage semantic memory for routing:**
```python
# Query MemOS for similar past tasks
similar_tasks = memos.search_memories(
    query=f"TASK:{task_description} STATUS:done"
)
# Extract which models succeeded for similar tasks
winning_models = extract_winning_models(similar_tasks)
# Route based on historical success
```

**Store routing outcomes as memories:**
```python
memos.add_memory(
    f"ROUTING task_sig:{sig} model:{model} outcome:{success} "
    f"duration:{duration}s complexity:{score}"
)
```

### 6.2 Adaptive Threshold Learning
Instead of fixed thresholds (40/70), learn from data:

```python
def optimize_thresholds():
    # Collect outcome data
    outcomes = load_outcomes()
    
    # Find optimal threshold via binary search
    # Maximize: quality(threshold) - λ × cost(threshold)
    
    # Update TIER_THRESHOLDS dynamically
```

### 6.3 Task Signature Clustering
```python
# Group similar tasks by embedding
task_clusters = cluster_by_embedding(all_tasks)

# For each cluster, track best model
for cluster in task_clusters:
    best_model = max(models, key=lambda m: success_rate(cluster, m))
    cluster.default_model = best_model
```

### 6.4 Speculative Execution for Latency-Critical Tasks
From Google Research "Speculative Cascades":
- Start cheaper model immediately
- Speculatively start expensive model in parallel if uncertain
- Return first good response
- Cancel other if not needed

### 6.5 Quality Verification Step
Add lightweight verification after model response:
```python
response = model.generate(task)
quality_score = quick_evaluate(response, task)  # Cheap check

if quality_score < threshold:
    # Escalate to better model
    response = better_model.generate(task)
```

---

## 7. Framework Patterns Summary

### LangChain Router Patterns
1. **Semantic Router** — embed routes, match by similarity
2. **LLM Router Chain** — small LLM decides routing
3. **Multi-Route Chain** — parallel fan-out to multiple experts
4. **Configurable Alternatives** — switch models via config

### LlamaIndex RouterQueryEngine
- Supports single or multi-selection routing
- Uses OpenAI Function API for structured selection
- Selector types: LLM, Pydantic, Embedding-based

### OpenRouter Auto Router
- Powered by NotDiamond
- Analyzes prompt complexity
- Routes to Claude/GPT/Gemini/DeepSeek based on task
- No additional fee beyond model cost

### AutoGen (Microsoft Agent Framework)
- GroupChat with description-based agent selection
- Model config with fallback chains
- No implicit "best model for task" logic — developer responsibility

---

## 8. Recommended Improvements for Our Router

### Immediate (This Week)
1. ✅ Add success rate tracking to tier selection
2. ✅ Implement auto-escalation when success_rate < 50%
3. ✅ Add downgrade consideration when success_rate > 85%

### Short-Term (Next 2 Weeks)
4. Add semantic similarity matching using MemOS embeddings
5. Store routing outcomes in MemOS for pattern learning
6. Implement task signature clustering

### Medium-Term (Next Month)
7. Train lightweight classifier on our outcome data
8. Add speculative execution for time-sensitive tasks
9. Implement budget-aware routing

### Metrics to Track
- Cost per task type
- Success rate by (task_type, model, complexity_bucket)
- Escalation rate (how often we needed to retry)
- Routing decision latency

---

## 9. Key Research Papers

| Paper | Key Contribution |
|-------|-----------------|
| **RouteLLM** (LMSYS, 2024) | Preference-based router training, 85% cost reduction |
| **FrugalGPT** (Stanford, 2023) | LLM cascade pattern, up to 98% cost reduction |
| **Cascade Routing** (ETH Zurich, 2024) | Unified routing+cascading, provably optimal |
| **Hybrid LLM** (2024) | Query difficulty estimation for routing |
| **PILOT** (2025) | Online bandit learning for adaptive routing |

---

## 10. Conclusion

**The winning strategy:**
1. Fast keyword/semantic pre-classification (< 50ms)
2. Historical success rate adjustment
3. Cascade fallback on failure
4. Continuous learning from outcomes

**Our current router is solid.** Key enhancements:
- Add MemOS integration for historical patterns
- Implement success-rate-based threshold adjustment
- Add lightweight cascade (retry with escalation on failure)

**Expected impact:** 30-50% cost reduction while maintaining or improving quality.

---

## References

1. Ong et al. "RouteLLM: Learning to Route LLMs with Preference Data" (2024)
2. Chen et al. "FrugalGPT: How to Use Large Language Models While Reducing Cost" (2023)
3. Dekoninck et al. "A Unified Approach to Routing and Cascading for LLMs" (2024)
4. AWS Blog "Multi-LLM routing strategies for generative AI applications" (2025)
5. Not Diamond "Awesome AI Model Routing" curated list
6. OpenRouter Documentation on Auto Router and Provider Routing
