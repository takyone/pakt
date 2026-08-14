import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emit, type Ctx } from "./cli";
import { buildPack } from "./build";
import { loadPack, parseFrontmatter } from "./pack";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function which(bin: string): string[] {
  const p = Bun.spawnSync(["which", "-a", bin]);
  if (p.exitCode !== 0) return [];
  return p.stdout.toString().trim().split("\n").filter(Boolean);
}

export function runDoctor(ctx: Ctx, dirArg?: string): number {
  const checks: Check[] = [];

  checks.push({ name: "bun", status: "ok", detail: `v${Bun.version}` });
  const gitPaths = which("git");
  checks.push(gitPaths.length
    ? { name: "git", status: "ok", detail: gitPaths[0] }
    : { name: "git", status: "fail", detail: "not found on PATH" });

  const dir = dirArg ?? ".";
  if (existsSync(join(dir, "pack.yaml"))) {
    try {
      const pack = loadPack(dir);
      checks.push({ name: "pack.yaml", status: "ok", detail: `${pack.manifest.name}@${pack.manifest.version}` });

      for (const req of pack.manifest.requires ?? []) {
        const found = which(req);
        checks.push(found.length
          ? { name: `requires:${req}`, status: "ok", detail: found[0] }
          : { name: `requires:${req}`, status: "fail", detail: "not found on PATH" });
      }

      if (pack.manifest.bin) {
        const found = which(pack.manifest.bin.name);
        checks.push(found.length
          ? { name: `bin:${pack.manifest.bin.name}`, status: "warn", detail: `already on PATH: ${found.join(", ")} (ok if it is the pakt shim)` }
          : { name: `bin:${pack.manifest.bin.name}`, status: "ok", detail: "name free on PATH (install will claim it)" });
      }

      for (const s of pack.skills) {
        try {
          const { fm } = parseFrontmatter(readFileSync(join(dir, "skills", s, "SKILL.md"), "utf8"));
          const okFm = typeof fm.name === "string" && typeof fm.description === "string";
          checks.push({
            name: `skill:${s}`,
            status: okFm ? "ok" : "fail",
            detail: okFm ? "frontmatter ok" : "frontmatter must declare name and description",
          });
        } catch (e) {
          checks.push({ name: `skill:${s}`, status: "fail", detail: `SKILL.md: ${(e as Error).message}` });
        }
      }
      if (pack.skills.length === 0) checks.push({ name: "skills", status: "warn", detail: "no skills found" });

      const { drift } = buildPack(pack, { check: true });
      checks.push(drift.length
        ? { name: "adapters", status: "fail", detail: `drift from agents/*.agent.yaml: ${drift.join(", ")} (run pakt build)` }
        : { name: "adapters", status: "ok", detail: `in sync (${pack.agents.length} agents)` });
    } catch (e) {
      checks.push({ name: "pack", status: "fail", detail: (e as Error).message });
    }
  } else if (dirArg) {
    checks.push({ name: "pack", status: "fail", detail: `no pack.yaml in ${dir}` });
  }

  const failed = checks.some((c) => c.status === "fail");
  emit(ctx, { ok: !failed, checks }, () =>
    checks.map((c) => `  ${c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"} ${c.name.padEnd(24)} ${c.detail}`).join("\n"));
  return failed ? 1 : 0;
}
