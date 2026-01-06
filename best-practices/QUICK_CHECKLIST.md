# Claude Quick Start Checklist

## Before Starting Any Complex Task

### 1. PLAN FIRST
```
□ Understand full scope of request
□ Break into discrete features/tasks
□ Estimate complexity (simple/medium/complex)
□ If complex: Create features.json
```

### 2. SET UP TRACKING (for medium+ complexity)
```
□ Create features.json with all features
□ Create claude-progress.txt
□ Create init.sh if servers/setup needed
□ Initial git commit (if applicable)
```

### 3. WORK INCREMENTALLY
```
□ Select ONE highest-priority feature
□ Implement it completely
□ Test it thoroughly (end-to-end)
□ Only mark as passing after verification
□ Commit with descriptive message
□ Update progress file
□ Then move to next feature
```

### 4. BEFORE ENDING SESSION
```
□ No half-implemented features
□ All changes committed
□ Progress file updated
□ Environment in working state
□ Next steps documented
```

---

## Complexity Guidelines

**Simple** (1-2 tool calls):
- Single file creation
- Simple question
- Quick edit
→ Just do it directly

**Medium** (3-10 tool calls):
- Multi-file project
- Research + synthesis
- Document with multiple sections
→ Create outline, work incrementally

**Complex** (10+ tool calls):
- Full application
- Long-running task
- Multi-phase project
→ Full tracking system (features.json + progress + init.sh)

---

## Red Flags - STOP and Reconsider

⚠️ About to implement multiple features at once
⚠️ Marking something "done" without testing
⚠️ Context getting long with uncommitted work
⚠️ Removing or editing test criteria
⚠️ Leaving environment in broken state

---

## The Golden Rules

1. **ONE FEATURE AT A TIME**
2. **TEST BEFORE MARKING DONE**
3. **COMMIT FREQUENTLY**
4. **DOCUMENT PROGRESS**
5. **LEAVE CLEAN STATE**
