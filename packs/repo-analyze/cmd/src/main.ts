#!/usr/bin/env bun
// rlens — deterministic repository analysis (repo-analyze pack Cmd dispatcher).
import { fail, type Ctx } from "./cli";
import { runTree } from "./tree";
import { runDeps } from "./deps";
import { runChurn } from "./churn";
import { runVerify } from "./verify";

const HELP = `rlens — deterministic repository analysis

Usage:
  rlens tree  [path] [--json]                    language/size/layout breakdown
  rlens deps  [path] [--json]                    normalized dependency list from manifests
  rlens churn [path] [--json] [--top N] [--since DATE]
                                                 git change hotspots (needs git history)
  rlens verify <findings.json...> --repo <path> [--json]
                                                 check that every finding's evidence
                                                 (path:line) resolves in the repo.
                                                 Scope: shape + evidence resolution only;
                                                 it does NOT cross-check quoted numbers.
                                                 exit 1 = verification failed (gate-fail)

Read-only and deterministic; no LLM calls. Default path: current directory.
--json prints a stable object on stdout; errors go to stderr as
{"error":{"what","why","remediation"}}. Exit codes: 0 ok, 1 transient/failed, 2 bad input.`;

function main(argv: string[]): void {
  const args = [...argv];
  const ctx: Ctx = { json: args.includes("--json") };
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--json") continue;
    if (a === "--help" || a === "-h") {
      console.log(HELP);
      return;
    }
    if (a === "--top" || a === "--since" || a === "--repo") {
      const v = args.shift();
      if (v === undefined) {
        fail(ctx, 2, `missing value for ${a}`, `${a} requires an argument`,
          a === "--top" ? "pass e.g. --top 20" : "pass e.g. --since 2026-01-01");
      }
      opts[a.slice(2)] = v;
      continue;
    }
    if (a.startsWith("--")) {
      fail(ctx, 2, `unknown flag ${a}`, "flag is not recognized", "run rlens --help for supported flags");
    }
    positional.push(a);
  }

  if (positional[0] === "verify") {
    return runVerify(ctx, positional.slice(1), opts.repo);
  }

  const [sub, pathArg] = positional;
  const root = pathArg ?? ".";
  let top = 20;
  if (opts.top !== undefined) {
    top = Number(opts.top);
    if (!Number.isInteger(top) || top < 1) {
      fail(ctx, 2, `invalid --top value "${opts.top}"`, "--top must be a positive integer", "pass e.g. --top 20");
    }
  }

  switch (sub) {
    case "tree":
      return runTree(ctx, root);
    case "deps":
      return runDeps(ctx, root);
    case "churn":
      return runChurn(ctx, root, { top, since: opts.since });
    case undefined:
      console.log(HELP);
      process.exit(2);
    default:
      fail(ctx, 2, `unknown subcommand "${sub}"`, "rlens has subcommands: tree, deps, churn", "run rlens --help");
  }
}

main(process.argv.slice(2));
