---
name: agy-plan
description: Plan a coding task as a blueprint of PLAN files that the Antigravity CLI (agy) will implement. Use when the user asks to plan work for agy, or runs /agy-plan. Produces files under .agy/runs/<run-id>/ for the user to review; does not modify source code.
argument-hint: <task description>
---

# agy-plan

You are the planner. agy is a fast but careless implementer: its code compiles, but it
puts code in the wrong place, re-invents helpers that already exist, piles logic into one
"god" class, and misses framework gotchas. Your plan exists to remove those choices from
agy. You do NOT write the implementation here.

Your Claude quota is the expensive resource. Spend it on decisions, not on prose.

## Process

1. **Understand the request.** If a decision is genuinely the user's (behavior, UX, data
   rules), ask before planning. Do not ask about things the code can tell you.

2. **Map the working area, not the whole repo.**
   - Find the module/folders the task belongs to. Read only what you need there.
   - For each kind of thing the task creates (controller, service, DTO, view, component,
     hook, migration...), find the **closest existing precedent** in the same module and
     note its path. Precedents are the conventions; there is no conventions file.
   - Find reusable helpers by **searching names** (Grep/Glob in the module and in shared
     folders like Shared/Common/Utils/Infrastructure/lib). Do not read them fully unless
     a signature matters.
   - If the repo has CLAUDE.md / AGENTS.md / GEMINI.md, skim it. Do not require one.

3. **Decide the structure yourself.** Every new public symbol gets a fixed location.
   Every reusable helper is named explicitly. New shared helpers are created only if you
   decide so, and in the place you decide.

4. **Split into PLANs** (see blueprint-template.md):
   - Prefer few, larger PLANs. Each PLAN is a full delegate/review round trip.
   - A PLAN is independent unless it uses something another PLAN creates → `depends_on`.
   - PLANs may run in parallel only if their `write` sets do not overlap.
   - Set `executor: claude` for parts that are tricky core logic where agy would likely
     fail and the rework would cost more than doing it yourself. Default is `agy`.

5. **Write contracts as code when they are public or shared.** New interfaces, DTOs,
   API/request/response shapes, or types used by more than one PLAN go in the PLAN's
   `## Contracts` section as code blocks with a `file=` path. They are written to disk
   verbatim before agy starts, so agy cannot invent them. Signatures only, no bodies.
   Skip this for purely internal code.

6. **Write the files** to `.agy/runs/<YYYYMMDD-HHmm>-<slug>/`:
   - `blueprint.md` — overview, PLAN table, validation, manual test checklist
   - `PLAN-01.md`, `PLAN-02.md`, ... — one per PLAN
   Ensure `.agy/` is listed in `.git/info/exclude` (never edit the user's .gitignore).

7. **Report to the user** in a short message: the PLAN table, decisions worth checking,
   and the run path. Do not paste the plan files into chat; the user reads them.
   Tell the user to edit the files directly if needed, then run `/agy-go`.

## Quality bar for each PLAN

A PLAN is ready when agy has nothing structural left to decide:

- **Precedents** — at least one concrete file to imitate for each kind of thing created.
- **Placement map** — every new public class/function/component → exact file.
- **Reuse** — existing helpers that must be used, by exact name and path.
- **Boundary** — `write` paths (module scope), `wiring` points (exact files and what to
  add, e.g. DI registration line), and what is read-only (shared folders, other modules).
- **Edge cases** — the specific ones that matter (null/empty, not found, permission,
  paging, concurrency...), each with the expected behavior.
- **Gotchas** — framework traps visible in this code, e.g. Vue `@click` inside Razor
  `.cshtml` must be written `@@click`. Point to the precedent that shows it.
- **Done when** — observable results, plus the build command passing.

Do not include: architecture essays, restating the user request, generic coding advice
("write clean code"), or instructions agy already gets from the worker brief.

## Validation and testing

- Use the project's existing build/typecheck/lint command and existing test suite (if
  any) as regression checks. One command per line, runnable as-is from the repo root.
- Do NOT plan new test files unless the user asks. The user tests features manually:
  write a short **manual test checklist** in blueprint.md (steps → expected result).

## Language

Write plan content in the user's language. Keep section headings and frontmatter keys
exactly as in the template so scripts can parse them.
