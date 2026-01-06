# Claude Best Practices & Agent Harness Reference

> This document captures proven patterns from Anthropic's research on effective long-running agents. 
> Reference this at the start of complex tasks to avoid common failure modes.

---

## Table of Contents
1. [Core Problem & Solution](#core-problem--solution)
2. [Two-Agent Pattern](#two-agent-pattern)
3. [Environment Management](#environment-management)
4. [Feature List System](#feature-list-system)
5. [Incremental Progress Pattern](#incremental-progress-pattern)
6. [Testing Best Practices](#testing-best-practices)
7. [Session Startup Protocol](#session-startup-protocol)
8. [Common Failure Modes & Solutions](#common-failure-modes--solutions)
9. [Task Decomposition Guidelines](#task-decomposition-guidelines)
10. [Specialized Agent Patterns](#specialized-agent-patterns)

---

## Core Problem & Solution

### The Challenge
Long-running tasks must span multiple context windows. Each new session begins with no memory of what came before. Like engineers working in shifts with no handoff notes.

### Key Failure Modes
1. **One-shotting**: Trying to do everything at once, running out of context mid-implementation
2. **Premature completion**: Declaring victory after seeing some progress
3. **Lost context**: Having to guess what happened in previous sessions
4. **Undocumented bugs**: Leaving environment in broken state

### The Solution
Two-part architecture:
- **Initializer agent**: Sets up structured environment on first run
- **Coding agent**: Makes incremental progress with clear artifacts for next session

---

## Two-Agent Pattern

### Initializer Agent Responsibilities
```
1. Create init.sh script for environment setup
2. Create progress tracking file (claude-progress.txt)
3. Create feature list in structured format (features.json or tests.json)
4. Make initial git commit
5. Document project structure and conventions
```

### Coding Agent Responsibilities
```
1. Read progress file and git history first
2. Run basic tests to verify environment works
3. Choose ONE feature to work on
4. Implement and test thoroughly
5. Commit with descriptive message
6. Update progress file
7. Leave environment in clean, working state
```

---

## Environment Management

### Required Files for Long-Running Tasks

#### 1. init.sh - Environment Setup Script
```bash
#!/bin/bash
# Purpose: Gracefully start servers, run tests, set up environment
# Run this at the start of each session

# Example structure:
echo "Starting development server..."
# Start servers in background
# Run linters
# Execute basic smoke tests
echo "Environment ready"
```

#### 2. claude-progress.txt - Progress Log
```markdown
## Session Log

### Session 1 - [DATE]
- Set up initial project structure
- Created feature list with X features
- Implemented: [feature names]
- Status: All tests passing
- Next priority: [feature name]

### Session 2 - [DATE]
...
```

#### 3. features.json or tests.json - Feature Tracking
```json
{
  "features": [
    {
      "id": "feat-001",
      "category": "functional",
      "description": "User can create new chat",
      "steps": [
        "Navigate to main interface",
        "Click 'New Chat' button",
        "Verify new conversation created"
      ],
      "passes": false,
      "priority": 1
    }
  ]
}
```

**CRITICAL**: Use JSON format, not Markdown. Claude is less likely to inappropriately modify JSON files.

---

## Feature List System

### Purpose
- Prevents one-shotting by breaking work into discrete features
- Prevents premature completion by providing clear checklist
- Enables incremental progress tracking

### Rules
1. **Never remove features** - only mark as passing/failing
2. **Never edit test descriptions** - this could mask missing functionality
3. **Only change the `passes` field** after thorough testing
4. Use strongly-worded instructions: "It is unacceptable to remove or edit tests because this could lead to missing or buggy functionality."

### Feature Structure
```json
{
  "category": "functional|ui|integration|edge-case",
  "description": "Clear description of expected behavior",
  "steps": ["Step 1", "Step 2", "Step 3"],
  "passes": false,
  "priority": 1-5
}
```

---

## Incremental Progress Pattern

### The Golden Rule
**Work on ONE feature at a time.**

### Workflow
```
1. Read features.json
2. Select highest-priority incomplete feature
3. Implement the feature
4. Test thoroughly (unit + end-to-end)
5. Only mark as passing after verification
6. Git commit with descriptive message
7. Update progress file
8. If context remains, select next feature
```

### Git Hygiene
- Commit after each feature
- Use descriptive commit messages
- This enables:
  - Reverting bad changes
  - Understanding what changed between sessions
  - Recovering working states

---

## Testing Best Practices

### The Problem
Claude tends to mark features complete without proper testing. May do unit tests but miss end-to-end verification.

### Requirements
1. **Write tests BEFORE implementation** (TDD approach)
2. **Store tests in structured format** (tests.json)
3. **Run tests and confirm they fail first**
4. **Test end-to-end as a user would** (not just unit tests)
5. **Use browser automation for web apps** (Puppeteer, etc.)

### Test-First Workflow
```
1. Write test cases in tests.json
2. Run tests - verify they fail
3. Implement code
4. Run tests - verify they pass
5. Commit tests AND implementation
```

### Testing Rules
```
"It is unacceptable to remove or edit tests because this could 
lead to missing or buggy functionality."
```

### End-to-End Verification
For web apps:
- Use browser automation (Puppeteer MCP)
- Test as a human user would
- Take screenshots to verify visual state
- Don't rely solely on curl commands or unit tests

---

## Session Startup Protocol

### Every Session Must Begin With:

```
1. pwd - Confirm working directory
2. Read claude-progress.txt - Understand recent work
3. Read features.json/tests.json - Know what's done/remaining
4. git log --oneline -20 - See recent commits
5. Run init.sh - Start servers, verify environment
6. Run basic smoke test - Confirm app isn't broken
7. THEN begin new work
```

### Example Session Start
```
[Claude] I'll start by getting my bearings.
[Tool] pwd
[Tool] cat claude-progress.txt
[Tool] cat features.json
[Tool] git log --oneline -20
[Claude] Let me verify the environment works.
[Tool] ./init.sh
[Tool] <runs basic test>
[Claude] Environment verified. Now selecting next feature...
```

---

## Common Failure Modes & Solutions

| Problem | Solution |
|---------|----------|
| Declares victory too early | Use feature list with explicit pass/fail tracking |
| Leaves bugs/undocumented progress | Commit after each feature + update progress file |
| Marks features done prematurely | Require end-to-end testing before marking pass |
| Wastes time figuring out setup | Create init.sh script |
| One-shots complex tasks | Feature list forces incremental work |
| Context lost between sessions | Progress file + git history |

---

## Task Decomposition Guidelines

### For Complex Tasks

#### Step 1: Create Initial Plan
```markdown
## Task Breakdown
1. [Phase 1 name]
   - Feature A
   - Feature B
2. [Phase 2 name]
   - Feature C
   - Feature D
```

#### Step 2: Convert to Feature List
Convert each feature to JSON format with clear acceptance criteria.

#### Step 3: Prioritize
Assign priority 1-5 to each feature. Work on highest priority first.

#### Step 4: Estimate Scope
- Simple task: 1 search/1 file
- Medium task: 3-5 tool calls
- Complex task: 5-10+ tool calls, feature list recommended
- Very complex: 20+ tool calls → suggest breaking into multiple sessions

---

## Specialized Agent Patterns

### When to Use Sub-Agents
Consider specialized agents for:
- **Testing agent**: Dedicated to verification
- **QA agent**: Code review and quality checks
- **Cleanup agent**: Refactoring and documentation

### Multi-Agent Coordination
```
Main Agent
  ├── Planning: Creates feature list
  ├── Implementation: Works on features
  ├── Testing: Verifies each feature
  └── Documentation: Updates progress
```

---

## Quick Reference Card

### Session Start Checklist
- [ ] Check working directory (pwd)
- [ ] Read progress file
- [ ] Read feature/test file
- [ ] Check git history
- [ ] Run init script
- [ ] Verify basic functionality
- [ ] Select next feature

### Before Ending Session
- [ ] Code compiles/runs without errors
- [ ] All new code is committed
- [ ] Progress file updated
- [ ] Feature status updated
- [ ] No half-implemented features left
- [ ] Environment in clean state

### Red Flags to Avoid
- ❌ Starting implementation without reading context
- ❌ Working on multiple features simultaneously
- ❌ Marking features done without testing
- ❌ Removing or editing test descriptions
- ❌ Leaving uncommitted changes
- ❌ Skipping end-to-end verification

---

## Application to Chat Interface Tasks

When working in Claude.ai chat (vs. Claude Code), adapt these principles:

### For Document Creation
```
1. Create outline first (planning phase)
2. Build incrementally section by section
3. Verify each section before moving on
4. Save progress to outputs directory
```

### For Code Projects
```
1. Create project structure first
2. Define test cases in structured format
3. Implement one component at a time
4. Test each component
5. Save working versions frequently
```

### For Research Tasks
```
1. Define research questions
2. Search and gather incrementally
3. Document findings as you go
4. Synthesize at the end
```

---

## Sources

- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [claude-quickstarts repository](https://github.com/anthropics/claude-quickstarts)

---

*Last updated: November 2025*
*Reference this document at the start of complex tasks*
