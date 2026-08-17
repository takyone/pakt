# pakt spec v0.1 (draft)

pakt defines a **capability pack**: a distributable unit of agent capability made
of skills (semantic actions), deterministic CLIs (Cmds), and subagent
definitions, designed to behave equivalently across agent harnesses. This
document is the contract; implementations (toolchains, runners, harness
adapters) are interchangeable as long as they satisfy it.

Keywords MUST / SHOULD / MAY follow RFC 2119 usage.

## 1. Terms

- **pack**: one repo/directory conforming to §2.
- **Cmd**: a deterministic, non-LLM command-line program shipped by a pack (§3).
- **skill**: an Agent Skills-standard SKILL.md describing when and how to use
  Cmds and how to delegate (§4).
- **agent (subagent)**: a context-isolated worker definition (§5) invoked under
  the delegation contract (§6).
- **runner**: any program that can execute a pack's skills with an LLM (§7).
  Existing harnesses (Claude Code, Codex CLI, ...) are runners. In layer terms
  this is the **Harness layer**; `runner` is this spec's word for any
  conforming implementation of it.
- **toolchain**: tooling that validates, compiles, and installs packs
  (reference: `packages/pakt/`). Any implementation MAY replace it.

## 2. Pack format

```
<pack>/
├── pack.yaml            # manifest (schemas/pack.schema.json)
├── skills/<name>/SKILL.md
├── cmd/                 # Cmd sources; language free
├── agents/<name>.agent.yaml   # schemas/agent.schema.json
├── adapters/            # GENERATED harness glue; MUST be reproducible from agents/
└── conformance/<skill>/case-*.yaml   # schemas/conformance-case.schema.json
```

- `pack.yaml` MUST declare `name`, `version` (semver), `description`. It MAY
  declare `bin` (`{name, entry}`) and `requires` (runtime dependencies such as
  `bun`, `git`).
- The pack MUST NOT depend on any toolchain at Cmd runtime: Cmds are plain
  programs.
- `adapters/` MUST be deterministically derivable from `agents/*.agent.yaml`
  (toolchain `build --check` gate).

## 3. Cmd contract

A Cmd MUST be deterministic given its inputs and observable state, MUST NOT call
an LLM, and MUST be non-interactive (all input via argv/stdin/env).

- One dispatcher binary per pack (noun-verb subcommands). The bin name is API:
  renaming it is a semver-major change.
- Every subcommand MUST support `--json` (stable, machine-readable stdout).
- Exit codes: `0` success; `1` transient/internal (retry may help); `2` bad
  usage or input (deterministic — do not retry); `4` RESERVED for
  "needs user input / confirmation" (`{"needs_input": ...}` on stdout).
- With `--json`, errors MUST be emitted on stderr as
  `{"error": {"what": ..., "why": ..., "remediation": ...}}`.
- `--help` MUST fit in one screen and is written for agents (it is the schema).
- Output SHOULD respect context budgets: truncate/paginate by default, provide
  flags to widen.
- Stateful resources (browser, DB, REPL) SHOULD use a daemon + ref-handle
  pattern (`svc up/down`, short stable handles in output) rather than
  protocol-level sessions.

## 4. Skill conventions

Skills follow the Agent Skills open standard (SKILL.md + frontmatter
`name`/`description`), plus:

- Cmd invocations MUST use the bare bin name and MUST include the fallback line
  "if `<bin>` is not on PATH, use `pakt x <pack> -- ...`".
- Delegation MUST be written explicitly in the skill body (which step, which
  agent, what brief, what return shape). Harness auto-routing is a bonus, never
  a dependency.
- Progressive disclosure: the SKILL.md body SHOULD stay under ~100 lines with
  "read when" pointers into `references/`.

## 5. Agent definitions

`agents/<name>.agent.yaml`: `name`, `description` (routing trigger),
`instructions`, optional `model`, `skills[]` (regime subset), `tools[]`.

Compilation semantics (toolchain): emit native fields where the target harness
supports them; degrade unsupported fields into instruction text and report the
loss ("lossy fallback"). Emission MUST be deterministic (stable ordering,
trailing newline) so `build --check` can gate drift.

## 6. Delegation contract

- The brief MUST contain everything the worker needs (inputs are closed at
  spawn; mid-flight redirects are unreliable).
- The brief MUST specify the return shape (e.g. "compact JSON, ≤30 lines").
- Workers MUST NOT re-delegate.
- Worker output is untrusted data: the parent MUST verify load-bearing claims
  against artifacts (files, diffs, Cmd output), not accept assertions.

## 7. Runner contract

A runner MUST provide, at minimum: shell execution (Cmds are invoked via
shell), file reading, skill discovery with progressive disclosure (frontmatter
listing → body on activation), and subagent spawn honoring §6 (a fresh-context
worker whose final output returns to the parent).

- **Headless invocation** (MUST): `<runner> --pack <dir> -p "<prompt>" [--json]`
  — exit 0 with the final answer on stdout (`--json`: `{"result": ..., "events": [...]}`).
  This is the shape the conformance runner drives.
- **Interactive/UI** (SHOULD): speak ACP (Agent Client Protocol) rather than
  inventing a session protocol.
- Auth is the runner's concern (API keys, subscriptions); packs never carry
  credentials.

## 8. Conformance

`conformance/<skill>/case-*.yaml` defines prompt fixtures with expectations
(`must_call`, `must_delegate`, `must_not`, `output_shape`). A conformance
runner executes cases across runners and judges transcripts against
expectations. Equivalence across harnesses is *measured*, not assumed.
(v0.1: case format only; the conformance runner is not yet implemented.)

## 9. Versioning

- This spec: semver; breaking contract changes bump major.
- Packs: semver; bin rename or Cmd exit-code/JSON-shape breaks are major.
- The JSON Schemas under `spec/schemas/` are normative for file formats; prose
  here is normative for behavior.

## 10. Plans (status: draft, v0.2)

A pack MAY ship declarative plans (`plans/*.plan.yaml`,
schemas/plan.schema.json): finite state machines whose transitions are
computed by the toolchain, not by the executing LLM. The executor performs
nodes and reports; `pakt plan next/advance` decides what comes next.

- **Node kinds**: `cmd` (deterministic commands), `delegate` (subagent
  fan-out), `gate`, `agent` (LLM work in the main context), `end`.
- **Gates** carry exactly one act: `check` (a Cmd, executed BY THE TOOLCHAIN
  during `advance` — the executor cannot assert a pass), `judge`
  (schema-reserved; not executable in v0.2), or `approve` (authorization by
  `by:` — default `user` — with an AskUserQuestion-compatible ask payload;
  every option declares `means: pass|fail|abort`). Back-edges exist only as
  gate `fail` targets and MUST carry `max_iters`; removing fail-edges MUST
  leave the graph acyclic (termination guarantee).
- **Approve delivery** degrades: harness-native ask tool → `pakt ask` TTY
  fallback → parked run (`awaiting_approval`, exit 4 per §3) answered later
  with `pakt plan answer`. Answers are ledger records.
- **Templates**: command strings may use `{run_dir}` and `{args.*}` only.
  Unresolvable tokens are a start-time error; there is no expression language.
- **State** lives in `<cwd>/.pakt/runs/<run>/state.json`: atomic writes
  (temp + rename), an append-only ledger, and one of five terminal statuses
  (`done`, `failure`, `exhausted`, `aborted`, `panicked`). Silence is never
  terminal: a run without a terminal record is open (running or stalled —
  distinguished by ledger staleness, `pakt plan status --check`).
- **Failure classes**: expected failures route inside the plan (retry only
  transient errors); budget exhaustion goes to `on_exhaust`; aborts are
  authorized stops; invariant violations (out-of-order advance, plan-file
  hash mismatch, state corruption) PANIC — the run seals immediately and
  never auto-recovers. Executors MUST use `pakt plan panic --reason` for
  unexpected situations instead of improvising.
