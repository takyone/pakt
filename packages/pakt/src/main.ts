#!/usr/bin/env bun
// pakt — reference toolchain for the pakt capability-pack protocol (spec/SPEC.md).
import { fail, type Ctx } from "./cli";
import { buildPack } from "./build";
import { loadPack } from "./pack";
import { runDoctor } from "./doctor";
import { runInstall } from "./install";
import { runX } from "./x";

const VERSION = "0.1.0";

const HELP = `pakt — capability pack toolchain (reference implementation)

Usage:
  pakt build   <packdir> [--check]      compile agents/*.agent.yaml → adapters/
  pakt doctor  [packdir] [--json]       environment + pack health checks
  pakt install <packdir> [--dry-run]    register pack, link skills, create bin shim
  pakt x <pack|dir> [--] <args...>      run a pack's bin without PATH install
  pakt run ...                          (not implemented in v0.1 — see spec §7)

The pack format and all contracts are defined in spec/SPEC.md.`;

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
    case "run":
      fail(ctx, 2, "runner not implemented in v0.1",
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
