import { resolve } from "node:path";
import { emit, fail, fmtInt, type Ctx } from "./cli";

function resolveRename(p: string): string {
  const braces = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braces) return (braces[1] + braces[3] + braces[4]).replace(/\/\//g, "/");
  const plain = p.match(/^(.*) => (.*)$/);
  if (plain) return plain[2];
  return p;
}

export function runChurn(ctx: Ctx, rootArg: string, opts: { top: number; since?: string }): void {
  const root = resolve(rootArg);
  const check = Bun.spawnSync(["git", "-C", root, "rev-parse", "--is-inside-work-tree"]);
  if (check.exitCode !== 0) {
    fail(ctx, 2, `not a git repository: ${rootArg}`,
      "churn is computed from git history",
      "pass a path inside a git repository, or skip churn for this repo");
  }

  const args = ["git", "-C", root, "log", "--numstat", "--format=@%H|%as", "-n", "1000"];
  if (opts.since) args.push(`--since=${opts.since}`);
  const p = Bun.spawnSync(args);
  if (p.exitCode !== 0) {
    fail(ctx, 1, "git log failed", p.stderr.toString().trim().slice(0, 200),
      "check that the repository has at least one commit");
  }

  const agg = new Map<string, { commits: number; adds: number; dels: number; lastTouched: string }>();
  let commitsScanned = 0;
  let curDate = "";
  for (const line of p.stdout.toString().split("\n")) {
    if (line.startsWith("@")) {
      commitsScanned++;
      curDate = line.slice(line.indexOf("|") + 1);
      continue;
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const path = resolveRename(m[3]);
    const e = agg.get(path) ?? { commits: 0, adds: 0, dels: 0, lastTouched: "" };
    e.commits++;
    if (m[1] !== "-") e.adds += Number(m[1]);
    if (m[2] !== "-") e.dels += Number(m[2]);
    if (curDate > e.lastTouched) e.lastTouched = curDate;
    agg.set(path, e);
  }

  const files = [...agg.entries()]
    .map(([path, v]) => ({ path, ...v }))
    .sort((a, b) =>
      b.commits - a.commits || b.adds + b.dels - (a.adds + a.dels) || a.path.localeCompare(b.path))
    .slice(0, opts.top);

  const data = {
    root,
    commitsScanned,
    ...(opts.since ? { since: opts.since } : {}),
    files,
  };
  emit(ctx, data, () => {
    const rows = files.map((f) =>
      `  ${String(f.commits).padStart(4)}x  +${fmtInt(f.adds)}/-${fmtInt(f.dels)}  ${f.lastTouched}  ${f.path}`);
    return [`${root} — hotspots over ${fmtInt(commitsScanned)} commits${opts.since ? ` since ${opts.since}` : ""}`, ...rows].join("\n");
  });
}
