import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

function runInstall(packDir: string, home: string, extra: string[] = []) {
  const p = Bun.spawnSync([process.execPath, MAIN, "install", packDir, ...extra], {
    env: { ...process.env, HOME: home },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

let packDir: string;

beforeAll(() => {
  packDir = mkdtempSync(join(tmpdir(), "pakt-install-fx-"));
  writeFileSync(join(packDir, "pack.yaml"), [
    "name: demo-pack",
    "version: 0.1.0",
    "description: install fixture",
    "bin:",
    "  name: demobin",
    "  entry: cmd/main.ts",
  ].join("\n"));
  mkdirSync(join(packDir, "cmd"));
  writeFileSync(join(packDir, "cmd", "main.ts"), "console.log('demo');\n");
  mkdirSync(join(packDir, "skills", "demo-skill"), { recursive: true });
  writeFileSync(join(packDir, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: d\n---\nbody\n");
});

afterAll(() => rmSync(packDir, { recursive: true, force: true }));

describe("install (hermetic fake HOME)", () => {
  test("links skills, writes shims (pack bin + pakt self), registers pack", () => {
    const home = mkdtempSync(join(tmpdir(), "pakt-home-"));
    const r = runInstall(packDir, home);
    expect(r.code).toBe(0);

    for (const base of [".claude", ".agents"]) {
      const target = join(home, base, "skills", "demo-skill");
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readlinkSync(target)).toBe(join(packDir, "skills", "demo-skill"));
    }

    const shim = join(home, ".local", "bin", "demobin");
    expect(readFileSync(shim, "utf8")).toContain(join(packDir, "cmd", "main.ts"));
    expect(statSync(shim).mode & 0o111).toBeTruthy();

    const self = join(home, ".local", "bin", "pakt");
    expect(readFileSync(self, "utf8")).toContain("main.ts");
    expect(statSync(self).mode & 0o111).toBeTruthy();

    const registry = JSON.parse(readFileSync(join(home, ".pakt", "packs.json"), "utf8"));
    expect(registry["demo-pack"].dir).toBe(packDir);
    expect(registry["demo-pack"].bin).toBe("demobin");

    // idempotent: second run succeeds (existing links are ours)
    expect(runInstall(packDir, home).code).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  test("conflict (non-pakt file at a target) → exit 2, nothing written", () => {
    const home = mkdtempSync(join(tmpdir(), "pakt-home2-"));
    mkdirSync(join(home, ".claude", "skills", "demo-skill"), { recursive: true });
    const r = runInstall(packDir, home, ["--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err).error.what).toContain("conflict");
    // plan-validate-execute: registry must not exist after an aborted install
    expect(() => readFileSync(join(home, ".pakt", "packs.json"))).toThrow();
    rmSync(home, { recursive: true, force: true });
  });

  test("--dry-run writes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "pakt-home3-"));
    const r = runInstall(packDir, home, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(() => lstatSync(join(home, ".claude", "skills", "demo-skill"))).toThrow();
    expect(() => lstatSync(join(home, ".local", "bin", "demobin"))).toThrow();
    rmSync(home, { recursive: true, force: true });
  });
});
