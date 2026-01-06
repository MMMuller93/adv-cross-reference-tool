# State Persistence Pattern

> **Purpose**: Ensure Claude never loses critical context, even when context windows reset or compact.
> This is your "long-term memory" within a project.

---

## Core Concept

**You must maintain a state file that serves as your persistent memory.**

This file should be:
- **Read at the START of every response** (ground yourself)
- **Updated at the END of every response** (preserve progress)
- **Structured for quick scanning** (not verbose prose)

---

## The project_state.md Pattern

### File Location
```
/project/project_state.md
```
Or for Claude.ai chat interface:
```
/home/claude/project_state.md
```

### Required Structure

```markdown
# Project State

## Meta
- **Project**: [Name]
- **Goal**: [One-line description]
- **Started**: [Date]
- **Last Updated**: [Timestamp]

---

## Current Phase
[Which major phase of the project are we in?]
- [ ] Phase 1: Setup & Foundation
- [x] Phase 2: Core Implementation  ← CURRENT
- [ ] Phase 3: Testing & Polish
- [ ] Phase 4: Documentation

---

## Active Task
**Currently Working On**: [Specific feature/task]
**Feature ID**: feat-XXX
**Status**: [Not Started | In Progress | Testing | Blocked]

### Acceptance Criteria
- [ ] Criterion 1
- [x] Criterion 2 (done)
- [ ] Criterion 3

### Progress Notes
- [What's been done on this specific task]
- [What remains]

---

## Known Issues
| Issue | Severity | Status | Notes |
|-------|----------|--------|-------|
| Bug in auth flow | High | Open | Affects login |
| Slow query | Medium | Investigating | See commit abc123 |

---

## Architectural Decisions
| Decision | Rationale | Date |
|----------|-----------|------|
| Using SQLite over Postgres | Simpler for MVP | 2025-01-15 |
| React over Vue | Team familiarity | 2025-01-15 |

---

## Context for Next Session
[Critical information that would be lost if context resets NOW]

- Currently in the middle of: [specific task]
- Files being modified: [list]
- Uncommitted changes: [yes/no, what]
- Next immediate step: [very specific action]
- Blockers: [anything preventing progress]

---

## Quick Stats
- Features Complete: X/Y
- Tests Passing: X/Y
- Last Commit: [hash] - [message]
```

---

## Usage Protocol

### At Session Start (MANDATORY)

```
1. cat project_state.md
2. Understand current phase and active task
3. Check "Context for Next Session" for immediate priorities
4. Review known issues
5. THEN proceed with work
```

### During Work

Update the file when:
- Completing an acceptance criterion
- Discovering a new issue
- Making an architectural decision
- Reaching a natural breakpoint

### At Session End (MANDATORY)

Before ending OR when context is running low:

```
1. Update "Active Task" progress
2. Update "Known Issues" if any discovered
3. Fill in "Context for Next Session" with:
   - Exactly what you were doing
   - What the immediate next step is
   - Any uncommitted work
4. Update "Last Updated" timestamp
5. Commit: git commit -am "Update project state"
```

---

## Why This Matters

> "Your context window might be reset at any moment, so you risk losing any progress that is not recorded."
> — Anthropic Memory Tool Documentation

### The Problem
- Context compaction loses details
- Session breaks lose everything not in files
- Resuming work requires expensive re-discovery

### The Solution
- State file acts as "save game"
- Quick to read (structured, not prose)
- Contains exactly what's needed to resume
- No guessing about what happened before

---

## Integration with Other Files

```
project_state.md  ← Current state & context (what's happening NOW)
       ↓
features.json     ← Feature tracking (what needs to be done)
       ↓
claude-progress.txt ← Historical log (what WAS done, by session)
```

**project_state.md** is the "hot" file - updated frequently, read at every session start.

**features.json** is the "cold" file - updated when features complete.

**claude-progress.txt** is the "archive" - historical record of all sessions.

---

## Template

```markdown
# Project State

## Meta
- **Project**: 
- **Goal**: 
- **Started**: 
- **Last Updated**: 

---

## Current Phase
- [ ] Phase 1: Setup
- [ ] Phase 2: Core Implementation
- [ ] Phase 3: Testing
- [ ] Phase 4: Polish

---

## Active Task
**Currently Working On**: 
**Feature ID**: 
**Status**: Not Started

### Acceptance Criteria
- [ ] 

### Progress Notes
- 

---

## Known Issues
| Issue | Severity | Status | Notes |
|-------|----------|--------|-------|

---

## Architectural Decisions
| Decision | Rationale | Date |
|----------|-----------|------|

---

## Context for Next Session
- Currently in the middle of: 
- Files being modified: 
- Uncommitted changes: 
- Next immediate step: 
- Blockers: 

---

## Quick Stats
- Features Complete: 0/0
- Tests Passing: 0/0
- Last Commit: none
```

---

## Prompt Addition

Add this to your system prompt:

```
STATE PERSISTENCE PROTOCOL:
1. ALWAYS read project_state.md at the start of every response
2. Ground yourself in the current phase and active task
3. As you work, update the state file at natural breakpoints
4. BEFORE ending or if context is running low:
   - Update all sections with current progress
   - Fill "Context for Next Session" completely
   - Commit the state file

ASSUME INTERRUPTION: Your context window might reset at any moment.
Any progress not in project_state.md WILL BE LOST.
```

---

*This pattern is adapted from Anthropic's "structured note-taking" recommendation for long-horizon tasks.*
