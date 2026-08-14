import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { emit, fail, type Ctx } from "./cli";

interface Dep {
  ecosystem: string;
  manifest: string;
  name: string;
  spec: string;
  dev: boolean;
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "vendor", "target",
  ".venv", "venv", "__pycache__", ".next", ".cache", ".turbo",
]);

function pep508(s: string): { name: string; spec: string } | null {
  const t = s.trim();
  const m = t.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
  if (!m) return null;
  return { name: m[0], spec: t.slice(m[0].length).trim() || "*" };
}

// Scans one directory for known manifests; `prefix` is "" at the root or
// "<subdir>/" for depth-1 scans (monorepos with web/ + server/ splits).
function scanDir(dir: string, prefix: string, deps: Dep[], manifests: string[], notes: string[]): void {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const has = (f: string) => existsSync(join(dir, f));
  const rel = (f: string) => `${prefix}${f}`;

  if (has("package.json")) {
    manifests.push(rel("package.json"));
    try {
      const pkg = JSON.parse(read("package.json"));
      for (const [section, dev] of [["dependencies", false], ["devDependencies", true]] as const) {
        for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
          deps.push({ ecosystem: "npm", manifest: rel("package.json"), name, spec: String(spec), dev });
        }
      }
    } catch {
      notes.push(`${rel("package.json")}: parse failed, skipped`);
    }
  }

  if (has("pyproject.toml")) {
    manifests.push(rel("pyproject.toml"));
    try {
      const py = Bun.TOML.parse(read("pyproject.toml")) as any;
      for (const d of py.project?.dependencies ?? []) {
        const p = pep508(String(d));
        if (p) deps.push({ ecosystem: "pypi", manifest: rel("pyproject.toml"), ...p, dev: false });
      }
      for (const group of Object.values(py["dependency-groups"] ?? {})) {
        for (const d of group as unknown[]) {
          if (typeof d !== "string") continue;
          const p = pep508(d);
          if (p) deps.push({ ecosystem: "pypi", manifest: rel("pyproject.toml"), ...p, dev: true });
        }
      }
      const poetry = py.tool?.poetry?.dependencies ?? {};
      for (const [name, spec] of Object.entries(poetry)) {
        if (name === "python") continue;
        const s = typeof spec === "string" ? spec : ((spec as any)?.version ?? "*");
        deps.push({ ecosystem: "pypi", manifest: rel("pyproject.toml"), name, spec: String(s), dev: false });
      }
    } catch {
      notes.push(`${rel("pyproject.toml")}: parse failed, skipped`);
    }
  }

  if (has("requirements.txt")) {
    manifests.push(rel("requirements.txt"));
    for (const line of read("requirements.txt").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("-")) continue;
      const p = pep508(t);
      if (p) deps.push({ ecosystem: "pypi", manifest: rel("requirements.txt"), ...p, dev: false });
    }
  }

  if (has("go.mod")) {
    manifests.push(rel("go.mod"));
    const src = read("go.mod");
    const lines: string[] = [];
    for (const block of src.matchAll(/require\s*\(([^)]*)\)/g)) lines.push(...block[1].split("\n"));
    for (const single of src.matchAll(/^require\s+(\S+\s+\S+.*)$/gm)) {
      if (!single[1].startsWith("(")) lines.push(single[1]);
    }
    for (const line of lines) {
      if (line.includes("// indirect")) continue;
      const m = line.trim().match(/^(\S+)\s+(\S+)/);
      if (m && m[1] !== "require") {
        deps.push({ ecosystem: "go", manifest: rel("go.mod"), name: m[1], spec: m[2], dev: false });
      }
    }
  }

  if (has("Cargo.toml")) {
    manifests.push(rel("Cargo.toml"));
    try {
      const cargo = Bun.TOML.parse(read("Cargo.toml")) as any;
      for (const [section, dev] of [["dependencies", false], ["dev-dependencies", true]] as const) {
        for (const [name, spec] of Object.entries(cargo[section] ?? {})) {
          const s = typeof spec === "string" ? spec : ((spec as any)?.version ?? "*");
          deps.push({ ecosystem: "cargo", manifest: rel("Cargo.toml"), name, spec: String(s), dev });
        }
      }
    } catch {
      notes.push(`${rel("Cargo.toml")}: parse failed, skipped`);
    }
  }
}

export function runDeps(ctx: Ctx, rootArg: string): void {
  const root = resolve(rootArg);
  let st;
  try {
    st = statSync(root);
  } catch {
    fail(ctx, 2, `path not found: ${rootArg}`, "the given path does not exist", "pass an existing directory");
  }
  if (!st.isDirectory()) {
    fail(ctx, 2, `not a directory: ${rootArg}`, "rlens deps scans manifests in a directory", "pass a directory path");
  }

  const deps: Dep[] = [];
  const manifests: string[] = [];
  const notes: string[] = [];

  scanDir(root, "", deps, manifests, notes);
  const subdirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  for (const sub of subdirs) scanDir(join(root, sub), `${sub}/`, deps, manifests, notes);

  deps.sort((a, b) =>
    a.ecosystem.localeCompare(b.ecosystem) || Number(a.dev) - Number(b.dev) || a.name.localeCompare(b.name));

  const data = { root, manifests, count: deps.length, deps, ...(notes.length ? { notes } : {}) };
  emit(ctx, data, () => {
    if (deps.length === 0) return `${root}: no dependencies found (manifests: ${manifests.join(", ") || "none"})`;
    const rows = deps.map((d) => `  ${d.ecosystem.padEnd(6)} ${(d.dev ? "dev" : "   ")} ${d.name.padEnd(32)} ${d.spec}`);
    return [`${root} — ${deps.length} deps from ${manifests.join(", ")}`, ...rows].join("\n");
  });
}
