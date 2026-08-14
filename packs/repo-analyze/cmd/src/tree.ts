import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { emit, fail, fmtInt, type Ctx } from "./cli";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "vendor", "target",
  ".venv", "venv", "__pycache__", ".next", ".cache", ".turbo",
]);
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tgz", "tar",
  "7z", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi",
  "sqlite", "db", "wasm", "jar", "class", "so", "dylib", "dll", "exe", "bin",
  "pyc", "o", "a", "lockb",
]);
const MAX_COUNT_BYTES = 1_000_000;

const LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", rb: "Ruby", java: "Java", kt: "Kotlin",
  swift: "Swift", c: "C", cpp: "C++", cc: "C++", h: "C/C++ header",
  hpp: "C/C++ header", cs: "C#", php: "PHP",
  sh: "Shell", bash: "Shell", zsh: "Shell", fish: "Shell", ps1: "PowerShell",
  md: "Markdown", mdx: "Markdown", json: "JSON", yaml: "YAML", yml: "YAML",
  toml: "TOML", html: "HTML", css: "CSS", scss: "CSS", sass: "CSS", less: "CSS",
  sql: "SQL", proto: "Protobuf", tf: "Terraform", lua: "Lua",
  ex: "Elixir", exs: "Elixir", hs: "Haskell", ml: "OCaml", jl: "Julia",
  r: "R", vue: "Vue", svelte: "Svelte", dart: "Dart", scala: "Scala", zig: "Zig",
};

function gitListFiles(root: string): string[] | null {
  const p = Bun.spawnSync(["git", "-C", root, "ls-files", "-z", "-co", "--exclude-standard"]);
  if (p.exitCode !== 0) return null;
  return p.stdout.toString().split("\0").filter((f) => f.length > 0);
}

function walk(root: string): string[] {
  const files: string[] = [];
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel ? join(root, rel) : root;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(childRel);
      } else if (e.isFile()) {
        files.push(childRel);
      }
    }
  }
  return files.sort();
}

function countLines(abs: string, size: number, ext: string): number | null {
  if (BINARY_EXTS.has(ext) || size > MAX_COUNT_BYTES) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }
  if (buf.length === 0) return 0;
  if (buf.includes(0)) return null;
  let lines = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
  if (buf[buf.length - 1] !== 10) lines++;
  return lines;
}

export function runTree(ctx: Ctx, rootArg: string): void {
  const root = resolve(rootArg);
  let st;
  try {
    st = statSync(root);
  } catch {
    fail(ctx, 2, `path not found: ${rootArg}`, "the given path does not exist",
      "pass an existing directory, e.g. rlens tree ~/workspace/foo");
  }
  if (!st.isDirectory()) {
    fail(ctx, 2, `not a directory: ${rootArg}`, "rlens tree analyzes directories", "pass a directory path");
  }

  const gitFiles = gitListFiles(root);
  const files = gitFiles ?? walk(root);

  const byLang = new Map<string, { files: number; lines: number; bytes: number }>();
  const byDir = new Map<string, { files: number; lines: number }>();
  let totFiles = 0;
  let totLines = 0;
  let totBytes = 0;

  for (const f of files) {
    const abs = join(root, f);
    let s;
    try {
      s = statSync(abs);
    } catch {
      continue; // e.g. tracked but deleted from worktree
    }
    if (!s.isFile()) continue;
    const ext = extname(f).slice(1).toLowerCase();
    const lang = LANG[ext] ?? (ext ? `.${ext}` : "(no ext)");
    const lines = countLines(abs, s.size, ext) ?? 0;
    totFiles++;
    totLines += lines;
    totBytes += s.size;
    const lv = byLang.get(lang) ?? { files: 0, lines: 0, bytes: 0 };
    lv.files++;
    lv.lines += lines;
    lv.bytes += s.size;
    byLang.set(lang, lv);
    const topDir = f.includes("/") ? f.slice(0, f.indexOf("/")) : "(root)";
    const dv = byDir.get(topDir) ?? { files: 0, lines: 0 };
    dv.files++;
    dv.lines += lines;
    byDir.set(topDir, dv);
  }

  const languages = [...byLang.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.lines - a.lines || b.files - a.files || a.name.localeCompare(b.name));
  const topDirs = [...byDir.entries()]
    .map(([dir, v]) => ({ dir, ...v }))
    .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir))
    .slice(0, 15);

  const data = {
    root,
    vcs: gitFiles ? "git" : "none",
    files: totFiles,
    lines: totLines,
    bytes: totBytes,
    languages,
    topDirs,
  };

  emit(ctx, data, () => {
    const langs = languages.slice(0, 8)
      .map((l) => `  ${l.name.padEnd(16)} ${fmtInt(l.lines).padStart(9)} lines  ${fmtInt(l.files).padStart(6)} files`);
    const dirs = topDirs.slice(0, 10)
      .map((d) => `  ${d.dir.padEnd(24)} ${fmtInt(d.files).padStart(6)} files  ${fmtInt(d.lines).padStart(9)} lines`);
    return [
      `${root} (${gitFiles ? "git" : "no vcs"}) — ${fmtInt(totFiles)} files, ${fmtInt(totLines)} lines`,
      "languages:", ...langs,
      "top dirs:", ...dirs,
    ].join("\n");
  });
}
