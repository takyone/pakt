#!/usr/bin/env bun
// pakt — reference toolchain for the pakt capability-pack protocol (spec/SPEC.md).
import { fail, type Ctx } from "./cli";
import { buildPack } from "./build";
import { loadPack } from "./pack";
import { runDoctor } from "./doctor";
import { runInstall } from "./install";
import { runX } from "./x";
import { runAsk } from "./ask";
import {
  planAdvance, planAnswer, planNext, planReport, planStart, planStatus, planTerminate,
} from "./planCli";

const VERSION = "0.2.0";

const HELP = `pakt — capability pack toolchain (reference implementation)

Usage:
  pakt build   <packdir> [--check]      compile agents/*.agent.yaml → adapters/
  pakt doctor  [packdir] [--json]       environment + pack health checks
  pakt install <packdir> [--dry-run]    register pack, link skills, create bin shim
  pakt x <pack|dir> [--] <args...>      run a pack's bin without PATH install

  pakt plan start <plan.yaml> [--run id] [--arg k=v]...
  pakt plan next <run>                  current node payload (exit 4 = awaiting approval)
  pakt plan advance <run> --node <n> (--ok | --fail --reason s | --answer label)
                                        report a node; check-gate cmds run here, by the
                                        toolchain — the executor never asserts a pass
  pakt plan answer <run> --choice <label>
  pakt plan status <run> [--check]      --check: exit 1 when stale or panicked
  pakt plan abort <run> --reason s      authorized stop
  pakt plan panic <run> --reason s      executor escape hatch for the unexpected
  pakt plan report <run>                human-readable md from the ledger
  pakt ask --payload <q.json>           TTY fallback for approve gates

  pakt run ...                          (not implemented — see spec §7)

The pack format and all contracts are defined in spec/SPEC.md.
Judge gates parse but do not execute in v0.2. revive/fork: not implemented.`;

function planMain(ctx: Ctx, args: string[]): void {
  const verb = args.shift();
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const argKV: Record<string, string> = {};
  const artifacts: string[] = [];
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--json") continue;
    else if (a === "--ok" || a === "--fail" || a === "--check") flags[a.slice(2)] = true;
    else if (a === "--arg") {
      const kv = args.shift() ?? "";
      const eq = kv.indexOf("=");
      if (eq < 1) fail(ctx, 2, `bad --arg "${kv}"`, "expected k=v", "--arg target=/path/to/repo");
      argKV[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--artifact") {
      const v = args.shift();
      if (v) artifacts.push(v);
    } else if (a.startsWith("--")) {
      const v = args.shift();
      if (v === undefined) fail(ctx, 2, `missing value for ${a}`, `${a} takes a value`, "see pakt --help");
      flags[a.slice(2)] = v;
    } else positional.push(a);
  }
  const runId = positional[0];
  const need = (what: string): string => {
    if (!runId) fail(ctx, 2, `missing run id`, `plan ${what} needs a run id`, `pakt plan ${what} <run> ...`);
    return runId;
  };
  switch (verb) {
    case "start": {
      if (!runId) fail(ctx, 2, "missing plan file", "start needs a plan path", "pakt plan start <plan.yaml>");
      return planStart(ctx, runId, { run: flags.run as string | undefined, args: argKV });
    }
    case "next": return planNext(ctx, need("next"));
    case "advance": return planAdvance(ctx, need("advance"), {
      node: flags.node as string | undefined,
      ok: flags.ok === true,
      failFlag: flags.fail === true,
      answer: flags.answer as string | undefined,
      reason: flags.reason as string | undefined,
      artifacts,
    });
    case "answer": return planAnswer(ctx, need("answer"), flags.choice as string | undefined);
    case "status": return planStatus(ctx, need("status"), { check: flags.check === true });
    case "abort": return planTerminate(ctx, need("abort"), "aborted", flags.reason as string | undefined);
    case "panic": return planTerminate(ctx, need("panic"), "panicked", flags.reason as string | undefined);
    case "report": return planReport(ctx, need("report"));
    case "revive":
    case "fork":
      fail(ctx, 2, `${verb} is not implemented in v0.2`,
        "recovery from panicked runs is designed but not built",
        "inspect with `pakt plan report`, then start a new run");
    default:
      fail(ctx, 2, `unknown plan verb "${verb}"`, "plan has: start, next, advance, answer, status, abort, panic, report", "run pakt --help");
  }
}

function main(argv: string[]): void {
  const args = [...argv];
  const ctx: Ctx = { json: args.includes("--json") };
  const cmd = args.shift();

  switch (cmd) {
    case "build": {
      const check = args.includes("--check");
      const dir = args.find((a) => !a.startsWith("--"));
      if (!dir) fail(ctx, 2, "missing pack directory", "build needs a pack to compile", "pakt build <packdir>");
      let pack;
      try {
        pack = loadPack(dir);
      } catch (e) {
        fail(ctx, 2, "invalid pack", (e as Error).message, "fix pack.yaml / agents/*.agent.yaml (spec §2, §5)");
      }
      const res = buildPack(pack, { check });
      for (const w of res.warnings) console.error(`warn: ${w}`);
      if (check) {
        if (res.drift.length > 0) {
          console.error(`drift detected:\n${res.drift.map((d) => `  ${d}`).join("\n")}`);
          process.exit(1);
        }
        console.log("adapters in sync");
        return;
      }
      console.log(`wrote ${res.wrote.length} adapter files for ${pack.agents.length} agent(s)`);
      return;
    }
    case "doctor": {
      const dir = args.find((a) => !a.startsWith("--"));
      process.exit(runDoctor(ctx, dir));
    }
    case "install": {
      const dir = args.find((a) => !a.startsWith("--"));
      if (!dir) fail(ctx, 2, "missing pack directory", "install needs a pack", "pakt install <packdir> [--dry-run]");
      runInstall(ctx, dir, { dryRun: args.includes("--dry-run") });
      return;
    }
    case "x": {
      const ref = args.shift();
      if (!ref) fail(ctx, 2, "missing pack reference", "x needs a pack name or directory", "pakt x <pack|dir> [--] <args...>");
      process.exit(runX(ctx, ref, args));
    }
    case "plan":
      return planMain(ctx, args);
    case "ask": {
      let payload: string | undefined;
      while (args.length > 0) {
        const a = args.shift()!;
        if (a === "--payload") payload = args.shift();
      }
      return runAsk(ctx, payload);
    }
    case "run":
      fail(ctx, 2, "runner not implemented",
        "the runner contract exists (spec/SPEC.md §7) but no backend is bundled yet",
        "use your existing harness (Claude Code / Codex / pi read installed packs directly)");
    case "version":
    case "--version":
      console.log(VERSION);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      process.exit(cmd === undefined ? 2 : 0);
    default:
      fail(ctx, 2, `unknown command "${cmd}"`, "pakt has: build, doctor, install, x, run, version", "run pakt --help");
  }
}

main(process.argv.slice(2));
