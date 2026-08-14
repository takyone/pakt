import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fail, type Ctx } from "./cli";
import { loadPack } from "./pack";

function resolvePackDir(ctx: Ctx, ref: string): string {
  if (existsSync(join(ref, "pack.yaml"))) return resolve(ref);
  const regFile = join(homedir(), ".pakt", "packs.json");
  if (existsSync(regFile)) {
    const registry = JSON.parse(readFileSync(regFile, "utf8"));
    if (registry[ref]?.dir) return registry[ref].dir;
  }
  fail(ctx, 2, `unknown pack "${ref}"`, "not a pack directory and not in ~/.pakt/packs.json",
    "pass a pack directory path, or run: pakt install <packdir>");
}

export function runX(ctx: Ctx, ref: string, argsIn: string[]): number {
  const args = argsIn[0] === "--" ? argsIn.slice(1) : argsIn;
  const dir = resolvePackDir(ctx, ref);
  const pack = loadPack(dir);
  if (!pack.manifest.bin) {
    fail(ctx, 2, `pack "${pack.manifest.name}" has no bin`, "pack.yaml declares no bin entry",
      "this pack ships skills/agents only");
  }
  const p = Bun.spawnSync(["bun", join(dir, pack.manifest.bin.entry), ...args], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  return p.exitCode ?? 1;
}
