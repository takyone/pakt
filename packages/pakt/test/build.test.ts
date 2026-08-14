import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPack, emitAgents } from "../src/build";
import { loadPack, parseFrontmatter } from "../src/pack";

// Instructions designed to break naive serializers: TOML triple quotes,
// backslashes, newlines, double quotes, unicode.
const TRICKY = `Line one with "quotes" and a backslash: C:\\path\\to\\thing
Line two has TOML poison: """ and '''
Line three is 日本語 with a tab\there.`;

let packDir: string;

beforeAll(() => {
  packDir = mkdtempSync(join(tmpdir(), "pakt-fixture-"));
  writeFileSync(join(packDir, "pack.yaml"), [
    "name: fixture-pack",
    "version: 0.1.0",
    "description: test fixture",
  ].join("\n"));
  mkdirSync(join(packDir, "agents"));
  // JSON is valid YAML — safest way to embed tricky strings in the fixture.
  writeFileSync(
    join(packDir, "agents", "tricky.agent.yaml"),
    JSON.stringify({
      name: "tricky",
      description: 'Reads "things" — with unicode ✓',
      instructions: TRICKY,
      model: "sonnet",
      skills: ["skill-a", "skill-b"],
      tools: ["Read", "Grep"],
    }),
  );
});

afterAll(() => rmSync(packDir, { recursive: true, force: true }));

describe("emit + parse-back (validate the wire form, not the in-memory form)", () => {
  test("codex TOML round-trips through a real TOML parser", () => {
    const pack = loadPack(packDir);
    const { files } = emitAgents(pack);
    const toml = files["adapters/codex/agents/tricky.toml"];
    const parsed = Bun.TOML.parse(toml) as any;
    expect(parsed.name).toBe("tricky");
    expect(parsed.description).toBe('Reads "things" — with unicode ✓');
    expect(parsed.model).toBe("sonnet");
    expect(parsed.skills).toEqual(["skill-a", "skill-b"]);
    // tools has no native codex field → degraded into instructions (lossy fallback)
    expect(parsed.instructions).toBe(`${TRICKY}\n\nTool policy: use only these tools: Read, Grep.`);
  });

  test("claude md frontmatter round-trips through a real YAML parser", () => {
    const pack = loadPack(packDir);
    const { files } = emitAgents(pack);
    const md = files["adapters/claude/agents/tricky.md"];
    const { fm, body } = parseFrontmatter(md);
    expect(fm.name).toBe("tricky");
    expect(fm.description).toBe('Reads "things" — with unicode ✓');
    expect(fm.tools).toBe("Read, Grep");
    expect(fm.model).toBe("sonnet");
    // skills has no native claude field → degraded into body (lossy fallback)
    expect(body.trim()).toBe(`${TRICKY}\n\nSkill policy: use only these skills: skill-a, skill-b. Do not load others.`);
  });

  test("antigravity md declares subagent: true", () => {
    const pack = loadPack(packDir);
    const { files } = emitAgents(pack);
    const { fm } = parseFrontmatter(files["adapters/antigravity/agents/tricky.md"]);
    expect(fm.subagent).toBe(true);
  });

  test("lossy fallbacks are reported as warnings", () => {
    const { warnings } = emitAgents(loadPack(packDir));
    expect(warnings.some((w) => w.includes("claude"))).toBe(true);
    expect(warnings.some((w) => w.includes("codex"))).toBe(true);
  });
});

describe("build --check drift gate", () => {
  test("clean right after build; drifts after mutation", () => {
    const pack = loadPack(packDir);
    buildPack(pack);
    expect(buildPack(pack, { check: true }).drift).toEqual([]);
    appendFileSync(join(packDir, "adapters/codex/agents/tricky.toml"), "# manual edit\n");
    const { drift } = buildPack(pack, { check: true });
    expect(drift).toEqual(["adapters/codex/agents/tricky.toml"]);
    buildPack(pack); // restore
  });
});

describe("pack validation", () => {
  test("rejects invalid names", () => {
    const bad = mkdtempSync(join(tmpdir(), "pakt-bad-"));
    writeFileSync(join(bad, "pack.yaml"), "name: Bad_Name\nversion: 0.1.0\ndescription: x\n");
    expect(() => loadPack(bad)).toThrow(/invalid name/);
    rmSync(bad, { recursive: true, force: true });
  });

  test("rejects agents missing required fields", () => {
    const bad = mkdtempSync(join(tmpdir(), "pakt-bad2-"));
    writeFileSync(join(bad, "pack.yaml"), "name: ok-pack\nversion: 0.1.0\ndescription: x\n");
    mkdirSync(join(bad, "agents"));
    writeFileSync(join(bad, "agents", "broken.agent.yaml"), JSON.stringify({ name: "broken" }));
    expect(() => loadPack(bad)).toThrow(/description/);
    rmSync(bad, { recursive: true, force: true });
  });
});
