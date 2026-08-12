# Agent Coding Workflow

This document defines the required workflow for agents completing coding tasks.

The goal is to maximize **agent autonomy** while preserving explicit human control over major design decisions, manual verification when necessary, and final pull request approval.

The agent should independently handle implementation details, testing, debugging, verification where possible, Git operations, and pull request publication. Human involvement should be requested only at the gates defined below.

---

## Core Principles

### 1. Default to autonomy

The agent should make routine implementation decisions independently.

Do **not** ask for approval on:
- naming
- small refactors
- file organization within established patterns
- test implementation details
- minor UI implementation details that follow an approved design
- straightforward library/API usage
- debugging approaches
- other reversible, low-impact engineering choices

When uncertain, use strong engineering judgment and continue.

### 2. Escalate major design decisions

A **major design decision** is a choice that meaningfully affects one or more of:

- system architecture
- public APIs or interfaces
- data models or schemas
- security or privacy boundaries
- persistent behavior
- dependencies with meaningful long-term cost or lock-in
- user-visible product behavior
- compatibility or migration requirements
- significant performance, scalability, or reliability tradeoffs
- scope in a way that materially changes the requested feature
- choices that would be expensive or risky to reverse later

Use best judgment rather than treating this as an exhaustive checklist.

Every major design decision requires an explicit human decision before implementation proceeds.

### 3. Prefer complete passes over incremental hand-holding

After design decisions are resolved, implement as much as possible in one autonomous pass.

Do not stop for routine status checks or minor implementation choices.

### 4. Gates are hard gates

A phase is not complete until its gate is satisfied.

Do not skip ahead because a later phase appears straightforward.

---

# Phase 1 — Design Decisions

Before writing implementation code, inspect the task and relevant codebase context.

Identify all major design decisions required to complete the task.

For each major decision:

1. Clearly state the decision that must be made.
2. Describe the most relevant options.
3. Summarize important tradeoffs.
4. Give a recommended option when there is a clear preference.
5. Ask for an explicit decision.

Bundle related decisions together so the human can resolve the design phase efficiently.

Do not begin implementation while any known major design decision remains unresolved.

Routine engineering details should **not** be escalated.

## Gate

**Every identified major design decision has an explicit human answer.**

Only then proceed to Phase 2.

---

# Phase 2 — Implementation

Implement the approved design as completely as possible in one pass.

The agent owns the implementation process, including:

- modifying production code
- adding or updating tests
- updating types, schemas, migrations, configuration, or documentation when required
- handling edge cases
- preserving established codebase conventions
- fixing issues discovered while implementing
- performing reasonable refactors necessary for a clean implementation

Tests are part of the implementation, not a later optional step.

## New design decisions discovered during implementation

If a **new major design decision** surfaces:

1. Stop implementation at the point where the decision is required.
2. Explain the decision, options, tradeoffs, and recommendation.
3. Wait for an explicit human decision.
4. Resume implementation after the decision is resolved.

Do not stop for minor or reversible choices. Resolve those autonomously.

## Gate

**Implementation is complete, including relevant automated tests.**

Then proceed to Phase 3.

---

# Phase 3 — Automated Verification

Run the relevant automated test suite.

This may include, as appropriate:

- unit tests
- integration tests
- end-to-end tests
- type checking
- linting
- static analysis
- build verification

If any required check fails:

1. Diagnose the failure.
2. Re-enter the implementation loop.
3. Fix the issue.
4. Add or adjust tests when appropriate.
5. Re-run verification.

Repeat until all required checks pass.

Do not ask the human to debug test failures that the agent can investigate independently.

## Gate

**All relevant automated tests and required checks pass.**

Then proceed to Phase 4.

---

# Phase 4 — Local / Functional Verification

Determine whether the completed functionality requires verification beyond automated tests.

Typical examples include:

- UI behavior
- visual layout
- browser interaction
- drag-and-drop behavior
- animation
- device-specific behavior
- flows that require credentials or an environment unavailable to the agent

Whenever the agent can perform the functional verification directly, it should do so.

Human verification should be requested only when the agent cannot reasonably perform the check itself.

When human verification is required:

1. State exactly what should be verified.
2. Provide concise reproduction steps.
3. State the expected behavior.
4. Wait for the result.

If verification reveals a defect, return to Phase 2, fix it, rerun Phase 3, and repeat Phase 4 as necessary.

## Gate

**The completed functionality has been locally/functionally verified.**

Then proceed to Phase 5.

---

# Phase 5 — Commit and Pull Request

Once implementation and verification are complete:

1. Review the final diff.
2. Ensure no accidental, unrelated, generated, secret, or debugging changes are included.
3. Commit the implementation.
4. Push the implementation branch.
5. Create and publish the pull request as ready for review, not as a draft.

The pull request must use the following structure:

```md
Notes:

<One or two sentences explaining WHAT changed and WHY.>

- Change and its reason
- Change and its reason

References:

- Link to previous pull request
- Link to external reference when applicable

Testing:

- All tests pass (<test count> passed, <coverage>% coverage)
- Verified locally with <specific scenario or fixture>
```

Only include references that actually apply. Do not invent links, test counts, coverage numbers, or verification results.

The `Notes` section should emphasize **what changed and why**, not provide a file-by-file implementation log.

The `Testing` section should describe the actual verification performed.

After publishing the pull request, present it for human review.

## Gate

**The human explicitly approves the pull request.**

---

# Review / Rework Loop

If the pull request is not approved, the human will describe the required changes.

The agent should then:

1. Re-enter Phase 2 using the review feedback as implementation requirements.
2. Make the requested changes autonomously.
3. Update or add tests as needed.
4. Complete Phase 3 again.
5. Complete Phase 4 again when functional verification is relevant.
6. Review the final diff.
7. **Amend the existing commit rather than creating a new implementation commit.**
8. Update the pull request description if the scope, rationale, references, or testing information changed.
9. Return the pull request for another review.

Repeat until approved.

---

# Workflow Summary

```text
Phase 1: Design Decisions
        ↓
Human resolves every major decision
        ↓
Phase 2: Implement + Write Tests
        ↓
    ┌── New major design decision? ── Yes ─→ Human decision ─┐
    │                                                        │
    └──────────────────────── Resume implementation ←─────────┘
        ↓
Implementation complete
        ↓
Phase 3: Run Automated Verification
        ↓
Failures? ── Yes ─→ Phase 2
        ↓ No
All tests pass
        ↓
Phase 4: Local / Functional Verification
        ↓
Issue found? ── Yes ─→ Phase 2
        ↓ No
Functionality verified
        ↓
Phase 5: Commit + Publish Pull Request
        ↓
Human review
        ↓
Approved? ── No ─→ Phase 2 → amend commit → re-review
        ↓ Yes
       DONE
```

---

# Expected Human Involvement

The human should primarily be responsible for:

1. **Major design decisions** before or during implementation.
2. **Manual functional verification** when the agent cannot perform it directly, especially UI interactions.
3. **Final pull request review and approval.**

Everything else should be handled autonomously by the agent whenever reasonably possible.

The intended operating model is:

> **Human controls consequential decisions and final acceptance. The agent owns the engineering work between those gates.**
