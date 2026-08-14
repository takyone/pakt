import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Repo hygiene: normative files must actually parse, and no tracked text file
// may contain stray control bytes (this session's emitter work proved how
// easily they sneak in).

const ROOT = new URL("../../..", import.meta.url).pathname;

function trackedFiles(): string[] {
  const p = Bun.spawnSync(["git", "-C", ROOT, "ls-files", "-z"]);
  if (p.exitCode !== 0) return [];
  return p.stdout.toString().split("\0").filter(Boolean);
}

const TEXT_EXTS = [".ts", ".md", ".yaml", ".yml", ".json", ".toml"];

describe("repo hygiene", () => {
  test("no control bytes in tracked text files (tab/newline allowed)", () => {
    const offenders: string[] = [];
    for (const f of trackedFiles()) {
      if (!TEXT_EXTS.some((e) => f.endsWith(e))) continue;
      const buf = readFileSync(join(ROOT, f));
      for (const b of buf) {
        const bad = b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d;
        if (bad || b === 0x7f) {
          offenders.push(f);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("normative spec schemas are valid JSON", () => {
    for (const s of ["pack.schema.json", "agent.schema.json", "conformance-case.schema.json"]) {
      const parsed = JSON.parse(readFileSync(join(ROOT, "spec", "schemas", s), "utf8"));
      expect(parsed.$schema).toContain("json-schema.org");
    }
  });

  test("conformance case parses as YAML with required fields", () => {
    const src = readFileSync(join(ROOT, "packs/repo-analyze/conformance/repo-analyze/case-01.yaml"), "utf8");
    const c = Bun.YAML.parse(src) as any;
    expect(typeof c.prompt).toBe("string");
    expect(Array.isArray(c.expect.must_call)).toBe(true);
  });
});
