---
name: repo-analyze
description: Analyze a repository's tech stack, structure, dependencies, and change hotspots to produce a structured report. Use when asked to analyze a repo, understand an unfamiliar codebase, assess reuse potential, or summarize what a project uses and how it is laid out.
---

# repo-analyze

Analyze the repository at the given path (default: current directory) and
produce a structured report. Facts come from deterministic commands; deep
reading is delegated so the main context stays small.

## Step 1 — collect facts (deterministic, cheap)

Run all three; every subcommand supports `--json`:

```sh
rlens tree <path> --json
rlens deps <path> --json
rlens churn <path> --json --top 20
```

If `rlens` is not on PATH, use `pakt x repo-analyze -- <subcommand> ...` instead.

- `churn` exits with code 2 when there is no git history — skip it and note
  that in the report; do not treat it as a failure.
- Do NOT hand-count files or parse manifests yourself: these commands are the
  source of truth for stack, layout, dependency, and hotspot facts.

## Step 2 — deep read (delegate; keep the main context clean)

Choose 2–4 dimensions that Step 1 makes interesting, e.g.: architecture
(entry points, layering), how the top dependencies are actually used, test
strategy, quality of the top churn hotspots.

For each dimension, delegate to the subagent `dim-reader`. Do not read the
repository files in the main context.

Brief template (fill everything in — the worker cannot ask back):

```
dimension: <one of the chosen dimensions>
repo: <absolute path>
files: <up to 10 paths selected from Step 1 output (topDirs / hotspots)>
return: compact JSON only, <=30 lines:
  {"dimension": ..., "findings": [{"point": ..., "evidence": "path:line"}],
   "gaps": [...], "confidence": "high|medium|low"}
```

Run dim-reader invocations in parallel when the harness supports it. Do not
re-delegate. Treat worker output as unverified claims: spot-check anything
surprising against the actual file before putting it in the report.

## Step 3 — synthesize

Merge Step 1 facts and Step 2 findings into a report with sections:

1. **Overview** — what the project is, size, activity
2. **Stack** — languages, key dependencies (from `deps`, not guesses)
3. **Structure** — layout, entry points, layering
4. **Hotspots** — top churn files and what they imply
5. **Reuse notes** — what is worth borrowing, and license caveats if visible

Step 1 numbers are authoritative; never restate them from memory — quote the
command output. Where Step 2 confidence was low, say so.
