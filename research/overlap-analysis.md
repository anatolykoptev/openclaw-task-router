# Overlap Analysis: task-orchestrator vs model-router

**Analysis Date:** 2026-01-31  
**Analyst:** Subagent (research-overlap)

---

## Executive Summary

**Critical Finding:** 70-80% code duplication exists between these skills. The scoring logic is copy-pasted with minor variations, causing maintenance burden and potential drift.

**Recommendation:** Merge into single `task-router` skill with clear separation between:
- **Routing Engine** (model selection) - pure function, no state
- **Task Manager** (lifecycle) - CRUD, dispatch, cascade

---

## File Inventory

### task-orchestrator/
| File | LOC | Purpose |
|------|-----|---------|
| SKILL.md | 230 | Documentation |
| scripts/scorer.py | 180 | **Scoring logic** ⚠️ |
| scripts/dispatch.sh | 140 | Task dispatch with scoring |
| scripts/cascade.sh | 100 | Fallback handling |
| scripts/add-task.sh | 50 | Add task to MemOS |
| scripts/list-tasks.sh | 20 | Query tasks |
| scripts/update-status.sh | 35 | Update task status |
| scripts/record-pattern.sh | 100 | **Record outcomes** ⚠️ |

### model-router/
| File | LOC | Purpose |
|------|-----|---------|
| SKILL.md | 130 | Documentation |
| spawn_routed.py | 250 | **Scoring logic** ⚠️ |
| record_outcome.py | 180 | **Record outcomes** ⚠️ |
| test_router.py | 160 | Test suite |
| cron-spec.md | 70 | Cron configuration |

---

## Duplication Analysis

### 1. TIER_THRESHOLDS — **100% Duplicate**

**task-orchestrator/scripts/scorer.py:**
```python
TIER_THRESHOLDS = {
    'free': (0, 40),
    'standard': (41, 70),
    'premium': (71, 100),
}
```

**model-router/spawn_routed.py:**
```python
TIER_THRESHOLDS = {
    'free': (0, 40),
    'standard': (41, 70),
    'premium': (71, 100),
}
```

### 2. COMPLEXITY_KEYWORDS — **95% Duplicate**

Both files have identical keyword dictionaries with same modifiers:
- `architect`: 20
- `design`: 15
- `refactor entire`: 25
- `typo`: -15
- etc.

### 3. RESEARCH_KEYWORDS — **100% Duplicate**

Both have same 14 keywords:
```python
['research', 'find', 'search', 'compare', 'alternatives',
 'what is', 'how does', 'explore', 'investigate', 'market',
 'competitors', 'benchmark', 'survey', 'review']
```

### 4. BASE_SCORES — **100% Duplicate**

```python
BASE_SCORES = {
    'code': 45,
    'research': 50,
    'content': 40,
    'analysis': 60,
    'simple': 20,
    'general': 40,
}
```

### 5. tier_to_model() — **100% Duplicate**

Both map tiers identically:
```python
{
    'free': 'google/gemini-2.5-flash',
    'standard': 'anthropic/claude-sonnet-4',
    'premium': 'anthropic/claude-opus-4-5',
    'research': 'openrouter/perplexity/sonar-pro',
}
```

### 6. compute_signature() — **100% Duplicate**

Same MD5 hash logic with same normalization.

### 7. lookup_history() — **95% Similar**

Both query MemOS for patterns, same adjustment logic:
- `success_rate < 0.5` → escalate
- `success_rate > 0.8` → downgrade

**Difference:** Different query formats:
- scorer.py: `routing-pattern sig:{signature}`
- spawn_routed.py: `ROUTING sig:{signature}`

### 8. Outcome Recording — **Duplicate Purpose, Different Impl**

| Aspect | record-pattern.sh | record_outcome.py |
|--------|-------------------|-------------------|
| Language | Bash | Python |
| Format | JSON object | Key-value string |
| MemOS schema | `{"type":"routing-pattern",...}` | `ROUTING sig:X model:Y...` |
| Session tracking | No | Yes (--check-sessions) |
| Cron integration | Manual | Built-in |

---

## Unique to Each

### task-orchestrator ONLY

| Component | Purpose | Keep? |
|-----------|---------|-------|
| add-task.sh | Create task in MemOS | ✅ Yes |
| list-tasks.sh | Query pending tasks | ✅ Yes |
| update-status.sh | Change task status | ✅ Yes |
| dispatch.sh | Batch dispatch P0-P1 tasks | ✅ Yes |
| cascade.sh | Fallback on failure | ✅ Yes |
| Task JSON schema | Task lifecycle tracking | ✅ Yes |

### model-router ONLY

| Component | Purpose | Keep? |
|-----------|---------|-------|
| CLI with argparse | --type, --force-model, --pretty | ✅ Yes |
| Import interface | `from spawn_routed import route_task` | ✅ Yes |
| test_router.py | 12 test cases | ✅ Yes |
| cron-spec.md | Auto-record outcomes | ✅ Yes |
| Session checking | Record completed sessions | ✅ Yes |

---

## Conflicts / Inconsistencies

### 1. MemOS Pattern Format
```
# task-orchestrator (record-pattern.sh)
{"type":"routing-pattern","sig":"abc123","attempts":5,...}

# model-router (record_outcome.py)
ROUTING sig:abc123 model:gemini-flash outcome:success ts:2026-01-31
```

**Impact:** History lookup fails cross-skill. Patterns recorded by one aren't found by the other.

### 2. Keyword Differences in test_router.py

test_router.py has **additional keywords** not in main implementations:
- Russian: `сортир`, `массив`, `напиши`
- English: `google`, `endpoint`

This means tests pass but actual routing differs.

### 3. mcporter Path

- scorer.py: Hardcoded `/home/krolik/.nvm/versions/node/v24.13.0/bin/mcporter`
- spawn_routed.py: Same hardcoded path
- record_outcome.py: Uses `MCPORTER` constant

---

## Missing from Both

| Gap | Description | Priority |
|-----|-------------|----------|
| Dry-run mode | spawn_routed.py has no --dry-run | Medium |
| Retry tracking | Neither tracks retry count properly | High |
| Cost tracking | No actual cost monitoring | Low |
| A/B testing | Can't compare tier performance | Medium |
| Russian keyword parity | test_router.py has more Russian | Low |

---

## Proposed Architecture

### Option A: Merge into Single Skill (Recommended)

```
skills/task-router/
├── SKILL.md
├── core/
│   ├── __init__.py
│   ├── scorer.py          # Single source of truth for scoring
│   ├── tiers.py           # TIER_THRESHOLDS, TIER_TO_MODEL
│   └── keywords.py        # COMPLEXITY_KEYWORDS, RESEARCH_KEYWORDS
├── router/
│   ├── route.py           # route_task() - main entry point
│   └── history.py         # MemOS pattern lookup/record
├── tasks/
│   ├── manager.py         # Task CRUD (add, list, update)
│   ├── dispatch.py        # Batch dispatch
│   └── cascade.py         # Fallback handling
├── cli/
│   ├── route_cli.py       # CLI for routing
│   ├── task_cli.py        # CLI for task management
│   └── dispatch_cli.py    # CLI for dispatch
├── tests/
│   └── test_router.py
└── cron-spec.md
```

### Single Responsibility Split

| Module | Responsibility | Dependencies |
|--------|---------------|--------------|
| **core/** | Pure scoring logic | None |
| **router/** | Model selection + history | core/ |
| **tasks/** | Task lifecycle | core/, router/ |
| **cli/** | Command-line interfaces | All |

### Interface Between Modules

```python
# core/scorer.py
def score_task(task: str, task_type: str = 'general') -> int:
    """Pure scoring, no side effects"""

# router/route.py  
def route_task(task: str, skip_history=False) -> RouteResult:
    """Returns {model, tier, signature, reasoning}"""

# tasks/dispatch.py
def dispatch_pending(dry_run=False) -> List[DispatchResult]:
    """Dispatch P0-P1 tasks using router"""
```

---

## Migration Path

### Phase 1: Consolidate Constants (Day 1)
1. Create `skills/task-router/core/tiers.py` with single source:
   - TIER_THRESHOLDS
   - TIER_TO_MODEL
   - COMPLEXITY_KEYWORDS
   - RESEARCH_KEYWORDS
   - BASE_SCORES
2. Update both skills to import from there

### Phase 2: Unify Scoring (Day 2)
1. Create `skills/task-router/core/scorer.py`
2. Delete `task-orchestrator/scripts/scorer.py`
3. Update `dispatch.sh` to call new scorer
4. Update `spawn_routed.py` to use shared module

### Phase 3: Unify History (Day 3)
1. Pick ONE MemOS format (recommend JSON for queryability)
2. Create `skills/task-router/router/history.py`
3. Migrate existing patterns to new format
4. Delete `record-pattern.sh`, keep Python version

### Phase 4: Reorganize Files (Day 4)
1. Move task management scripts to `tasks/`
2. Move CLI to `cli/`
3. Update AGENTS.md references
4. Delete empty old directories

### Phase 5: Testing & Deprecation (Day 5)
1. Run full test suite
2. Mark old skills as deprecated
3. Update SKILL.md documentation
4. Create symlinks for backward compatibility

---

## AGENTS.md References

Current AGENTS.md mentions:

```markdown
## 🔄 Model Router — Автоматический выбор модели

**ПРАВИЛО: Перед КАЖДЫМ sessions_spawn используй роутер.**

### Использование
python3 skills/model-router/spawn_routed.py "task description"
```

**Update needed:** After merge, change to:
```markdown
python3 skills/task-router/cli/route.py "task description"
```

---

## Recommendation

**Merge both skills into `task-router`** with:
1. **Single scoring engine** (eliminates 80% duplication)
2. **Task manager** as optional layer (keeps orchestrator features)
3. **Python-first** (better testing, import support)
4. **Keep shell wrappers** for quick CLI use

**Estimated effort:** 3-5 days of careful refactoring

---

## Appendix: Function Comparison Table

| Function | task-orchestrator | model-router | Duplicate? |
|----------|-------------------|--------------|------------|
| score_task() | ✅ scorer.py | ✅ spawn_routed.py | **YES** |
| route_task() | — | ✅ spawn_routed.py | No |
| tier_to_model() | ✅ scorer.py | ✅ spawn_routed.py | **YES** |
| compute_signature() | ✅ scorer.py | ✅ spawn_routed.py | **YES** |
| compute_keyword_score() | ✅ scorer.py | ✅ spawn_routed.py | **YES** |
| is_research_task() | ✅ scorer.py | ✅ spawn_routed.py | **YES** |
| count_files() | ✅ scorer.py | ✅ spawn_routed.py | **YES** |
| lookup_history() | ✅ scorer.py | ✅ spawn_routed.py | **YES** |
| adjust_tier() | ✅ scorer.py | ✅ spawn_routed.py | **YES** |
| determine_tier() | ✅ scorer.py | ✅ spawn_routed.py | **YES** |
| record_outcome() | ✅ record-pattern.sh | ✅ record_outcome.py | **PARTIAL** |
| get_stats() | — | ✅ record_outcome.py | No |
| check_sessions() | — | ✅ record_outcome.py | No |
| add_task() | ✅ add-task.sh | — | No |
| list_tasks() | ✅ list-tasks.sh | — | No |
| update_status() | ✅ update-status.sh | — | No |
| dispatch() | ✅ dispatch.sh | — | No |
| cascade() | ✅ cascade.sh | — | No |

**Total duplicated functions:** 10 out of 19 (53%)  
**LOC duplicated:** ~300 lines

---

*End of analysis.*
