import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

function run(args: string[]) {
  const p = Bun.spawnSync([process.execPath, MAIN, ...args]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function git(cwd: string, ...a: string[]) {
  const p = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a],
    { cwd },
  );
  if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr.toString()}`);
}

let repo: string;
let plainDir: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "rlens-fixture-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/app.ts"), "const a = 1;\nconst b = 2;\nexport { a, b };\n");
  writeFileSync(join(repo, "lib.py"), "x = 1\ny = 2\n");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fx", dependencies: { react: "^19.0.0" }, devDependencies: { typescript: "^5.6.0" } }),
  );
  writeFileSync(join(repo, "pyproject.toml"), `[project]\nname = "fx"\ndependencies = ["requests>=2.31", "rich"]\n`);
  writeFileSync(
    join(repo, "go.mod"),
    "module example.com/fx\n\ngo 1.22\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n\tgolang.org/x/sync v0.7.0 // indirect\n)\n",
  );
  mkdirSync(join(repo, "web"));
  writeFileSync(join(repo, "web", "package.json"), JSON.stringify({ name: "web", dependencies: { hono: "^4.0.0" } }));
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c1");
  writeFileSync(join(repo, "src/app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\nexport { a, b, c };\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c2");

  plainDir = mkdtempSync(join(tmpdir(), "rlens-plain-"));
  writeFileSync(join(plainDir, "a.ts"), "const x = 1;\n");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
});

describe("tree", () => {
  test("git repo: counts files/lines per language", () => {
    const r = run(["tree", repo, "--json"]);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.vcs).toBe("git");
    expect(d.files).toBe(7);
    const ts = d.languages.find((l: any) => l.name === "TypeScript");
    expect(ts).toEqual({ name: "TypeScript", files: 1, lines: 4, bytes: expect.any(Number) });
    const py = d.languages.find((l: any) => l.name === "Python");
    expect(py.lines).toBe(2);
    expect(d.topDirs.map((t: any) => t.dir)).toContain("src");
  });

  test("non-git dir works with vcs none", () => {
    const r = run(["tree", plainDir, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).vcs).toBe("none");
  });

  test("missing path → exit 2 with structured error", () => {
    const r = run(["tree", join(plainDir, "nope"), "--json"]);
    expect(r.code).toBe(2);
    const e = JSON.parse(r.err);
    expect(e.error.what).toContain("path not found");
    expect(e.error.remediation.length).toBeGreaterThan(0);
  });
});

describe("deps", () => {
  test("normalizes npm/pypi/go manifests incl. depth-1 subdirs", () => {
    const r = run(["deps", repo, "--json"]);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.manifests).toEqual(["package.json", "pyproject.toml", "go.mod", "web/package.json"]);
    const names = d.deps.map((x: any) => `${x.ecosystem}:${x.name}${x.dev ? ":dev" : ""}`);
    expect(names).toContain("npm:react");
    expect(names).toContain("npm:hono");
    expect(d.deps.find((x: any) => x.name === "hono").manifest).toBe("web/package.json");
    expect(names).toContain("npm:typescript:dev");
    expect(names).toContain("pypi:requests");
    expect(names).toContain("go:github.com/spf13/cobra");
    expect(names).not.toContain("go:golang.org/x/sync"); // indirect skipped
    const requests = d.deps.find((x: any) => x.name === "requests");
    expect(requests.spec).toBe(">=2.31");
    const rich = d.deps.find((x: any) => x.name === "rich");
    expect(rich.spec).toBe("*");
  });
});

describe("churn", () => {
  test("aggregates per-file commit counts", () => {
    const r = run(["churn", repo, "--json"]);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.commitsScanned).toBe(2);
    const app = d.files.find((f: any) => f.path === "src/app.ts");
    expect(app.commits).toBe(2);
    expect(app.lastTouched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("non-git dir → exit 2 (deterministic input error)", () => {
    const r = run(["churn", plainDir, "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err).error.why).toContain("git history");
  });
});

describe("verify", () => {
  test("all evidence resolves → exit 0", () => {
    const f = join(repo, "findings-good.json");
    writeFileSync(f, JSON.stringify({
      dimension: "test",
      findings: [{ point: "app has exports", evidence: "src/app.ts:2" }],
      confidence: "high",
    }));
    const r = run(["verify", f, "--repo", repo, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).ok).toBe(true);
  });

  test("bad evidence (out of range / missing file / wrong form) → exit 1 with reasons", () => {
    const f = join(repo, "findings-bad.json");
    writeFileSync(f, JSON.stringify({
      dimension: "test",
      findings: [
        { point: "line out of range", evidence: "src/app.ts:999" },
        { point: "file does not exist", evidence: "ghost.py:1" },
        { point: "not path:line form", evidence: "glob:**/*test* -> 1 match" },
      ],
    }));
    const r = run(["verify", f, "--repo", repo, "--json"]);
    expect(r.code).toBe(1);
    const d = JSON.parse(r.out);
    expect(d.failures.length).toBe(3);
  });

  test("unparseable findings = failed verification (exit 1), not usage error", () => {
    const f = join(repo, "findings-broken.json");
    writeFileSync(f, "not json at all");
    expect(run(["verify", f, "--repo", repo, "--json"]).code).toBe(1);
  });

  test("missing --repo → exit 2", () => {
    expect(run(["verify", "whatever.json", "--json"]).code).toBe(2);
  });
});

describe("cli contract", () => {
  test("unknown subcommand → exit 2", () => {
    const r = run(["nope", "--json"]);
    expect(r.code).toBe(2);
  });

  test("invalid --top → exit 2", () => {
    const r = run(["churn", repo, "--top", "zero", "--json"]);
    expect(r.code).toBe(2);
  });
});
