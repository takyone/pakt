# pakt

**pakt is a protocol, not a framework.** It defines a *capability pack*: skills +
deterministic CLIs + subagent definitions in one repo, usable from any agent
harness (Claude Code / Codex CLI / Antigravity / your own runner) with the same
behavior — maintained by conformance tests, not promises.

The durable artifact is the contract in [spec/SPEC.md](spec/SPEC.md). Everything
else in this repo is a replaceable reference implementation:

| part | role | replaceable? |
|---|---|---|
| `spec/` | the protocol: pack format, Cmd contract, delegation contract, runner contract | no — this IS pakt |
| `packages/pakt/` | reference toolchain (`pakt build/doctor/install/x`), TypeScript/bun | yes — reimplement in any language |
| runner backends | any program satisfying the runner contract (pi-based, hand-rolled, Agent SDK, ...) | yes — pluggable, none bundled yet |
| `packs/repo-analyze/` | example pack (`rlens` CLI + skill + agents) | it's an example |

Pack Cmds are polyglot by design: `pack.yaml` declares its runtime in `requires`.
This example uses bun/TypeScript; a Go-binary pack is equally spec-conformant.

## Quickstart

```sh
bun test                                                   # all tests
bun packages/pakt/src/main.ts build packs/repo-analyze     # compile agent adapters
bun packages/pakt/src/main.ts doctor packs/repo-analyze    # env + pack health
bun packs/repo-analyze/cmd/src/main.ts tree . --json       # run rlens directly
bun packages/pakt/src/main.ts install packs/repo-analyze --dry-run
```

## Design rules (short form)

- **Layers**: Harness / Skill / Subagent / Cmd. The pack ships the lower three;
  the Harness layer is whatever loads them (each layer name is one
  industry-standard word — orchestrator/worker are roles inside the Harness
  layer, not layers).
- **Pack vs skill**: the pack is the distribution unit (library); its skills
  are the exported entry points (1..N per pack). This example pack exports a
  single skill, so the two names coincide — they are still different things.
- **Cmd layer**: deterministic, `--json` everywhere, exit codes 0 ok / 1 transient /
  2 bad input, errors as `{"error":{what,why,remediation}}` on stderr. No LLM calls.
- **Skill layer**: explicit delegation written in SKILL.md (lowest common
  denominator across harnesses); bare bin names on PATH with a
  `pakt x <pack> --` fallback line.
- **Agents**: single-source YAML compiled per harness; unsupported fields degrade
  to instruction text (build prints lossy warnings).
- **Naming**: one dispatcher bin per pack (noun-verb tree); bin name is API —
  renaming is a semver-major change.

- **Plans** (v0.2): packs may ship declarative state machines
  (`plans/*.plan.yaml`, spec §10). Transitions are computed by `pakt plan`,
  never by the LLM; check-gate commands are executed by the toolchain during
  `advance`; loops exist only as gate fail-edges with `max_iters`; runs live in
  an append-only ledger with five terminal statuses and panic semantics.

v0.2 scope: spec + reference toolchain + plan engine + repo-analyze pack
(incl. `rlens verify` and `plans/analyze.plan.yaml`). Judge gates are
schema-reserved but not executable. Runner backends, the conformance runner,
and `plan revive/fork` are specified but not built.
