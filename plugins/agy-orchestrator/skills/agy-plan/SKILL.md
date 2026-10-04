---
name: agy-plan
description: Plan a coding task as a blueprint that the Antigravity CLI (agy) will implement, with Claude reviewing. Use when the user asks to plan a feature or change ("lên kế hoạch", "plan this", "/plan"), in plan mode, or asks to delegate work to agy. Produces one blueprint file for the user to approve; does not modify source code.
argument-hint: <task description>
---

# agy-plan

You are the planner. agy (newest Gemini Flash) is a fast but careless implementer: its
code compiles, but it puts code in the wrong place, re-invents helpers that already
exist, piles logic into one "god" class, and misses framework gotchas. Your plan removes
those choices from agy. You do NOT write the implementation here.

Your Claude quota is the expensive resource. Spend it on decisions, not on prose.

## Process

1. **Understand the request and size it.** If a decision is genuinely the user's
   (behavior, UX, data rules), ask before planning. Do not ask about things the code can
   tell you. Then judge the size by the code that will be written:
   - Small (under ~150 changed lines, or one or two files): do it yourself, no
     blueprint, unless the user explicitly asks for agy. Tell the user why in one line.
     Measured: below this size the plan + review round trips cost more Claude quota
     than writing the code.
   - Medium (~150–400 lines): a blueprint with a single PLAN.
   - Large: several PLANs.
   Uncommitted changes in the working tree are part of the codebase you plan against;
   agy works in place and sees them too.

2. **Map the working area, not the whole repo.**
   - Find the module/folders the task belongs to. Read only what you need there.
   - For each kind of thing the task creates (controller, service, DTO, view, component,
     hook, migration...), find the **closest existing precedent** in the same module and
     note its path. Precedents are the conventions; there is no conventions file.
   - Find reusable helpers by **searching names** (Grep/Glob in the module and in shared
     folders like Shared/Common/Utils/Infrastructure/lib). Do not read them fully unless
     a signature matters.
   - If the repo has CLAUDE.md / AGENTS.md / GEMINI.md, skim it. Do not require one.
   - Find the build/typecheck command the project already uses (solution/csproj, package
     scripts, Makefile...). It becomes `validate`.

3. **Decide the structure yourself.** Every new public symbol gets a fixed location.
   Every reusable helper is named explicitly. New shared helpers are created only if you
   decide so, and in the place you decide.

4. **Split into PLANs.**
   - Prefer few, larger PLANs. Each PLAN is a full delegate/review round trip.
   - A PLAN is independent unless it uses something another PLAN creates → `depends_on`.
     PLANs run one after another; you review once per dependency layer.
   - Set `executor: claude` for tricky core logic where agy would likely fail and the
     rework would cost more than doing it yourself. Default is `agy`.

5. **Write contracts as code when they are public or shared.** New interfaces, DTOs,
   API/request/response shapes, or types used by more than one PLAN go in the PLAN's
   `### Contracts` as code blocks with `file=<path>`. The runner writes them to disk
   verbatim before agy starts. Signatures only, no bodies. Skip for internal code.
   Contracts are **only for files that do not exist yet** — check `git status` too,
   since untracked files from earlier work count. New functions in an existing file go
   in the Placement map as one-line signatures instead.

6. **Write the blueprint** — one markdown file in the exact format of
   `${CLAUDE_PLUGIN_ROOT}/skills/agy-plan/blueprint-template.md` (read it the first time
   in a session). Where it goes:
   - **In plan mode:** the blueprint IS the plan file named in the plan mode
     instructions. Write it there, then call ExitPlanMode. The user's approval starts
     execution (the agy-execute skill takes over).
   - **Otherwise:** write it to `.agy/drafts/<short-slug>.md` in the repository root.
     The runner keeps `.agy/` out of git automatically on import.

7. **Report to the user** in a short message: the PLAN table, decisions worth checking,
   and where the file is. Do not paste the blueprint into chat. Outside plan mode, tell
   the user to edit the file if needed and say "ok" (or similar) to start execution.

## Quality bar for each PLAN

A PLAN is ready when agy has nothing structural left to decide:

- **Precedents** (`### Làm theo mẫu`) — a concrete file to imitate for each kind of thing.
- **Placement map** — every new public class/function/component → exact file.
- **Reuse** — existing helpers that must be used, by exact name and path.
- **Boundary** — `write` (prefer exact files; a folder only for genuinely open sets like
  a views folder), `wiring` files with the exact edit in `### Wiring`, `read_only` shared
  folders.
- **Edge cases** — the ones that matter, each with the expected behavior.
- **Gotchas** — framework traps visible in this code, e.g. Vue `@click` inside Razor
  `.cshtml` must be written `@@click`. Point to the precedent that shows it.
- **Done when** — observable results.

Do not include: architecture essays, restating the user request, generic coding advice,
or rules agy already gets from its fixed worker brief (recon report, scope rules, no
shell commands, final report format).

**Keep it short — the blueprint is Claude output, the most expensive tokens.** Point,
do not write: name the precedent and the helper instead of describing them, one line
per edge case, one line per test case. No function bodies, no pseudo-code, no
copy of code that agy can read in the precedent. Target: the blueprint is at most about
a third of the expected diff. If it is growing to the size of the code, the task is
better done yourself.

## Validation and testing

- `validate` = the project's existing build/typecheck/lint/test commands, one executable
  per line, runnable from the repo root, no `&&`, pipes or redirects. The runner runs
  them after each PLAN; agy cannot run commands.
- Do NOT plan new test files unless the user asks. When they do, put the test files in
  `write` (agy only touches tests listed there). The user tests features manually:
  write a short `## Checklist test tay` (steps → expected result) after the last PLAN.

## Language

Write plan content in the user's language. Keep the fenced block names, field names and
`## PLAN-XX: title` headings exactly as in the template so the runner can parse them.
