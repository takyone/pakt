import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { emit, fail, type Ctx } from "./cli";

// Deterministic verifier for dim-reader findings (check-gate ammunition).
// v0.2 scope: shape validation + evidence resolution (path:line exists and the
// line number is within the file). It does NOT cross-check quoted numbers
// against command outputs — that残差 belongs to a judge/approve gate.

interface Failure {
  file: string;
  where: string;
  why: string;
}

const EVIDENCE_RE = /^(.+?):(\d+)(?:-(\d+))?$/;
const CONFIDENCE = new Set(["high", "medium", "low"]);
const MAX_LINE_COUNT_BYTES = 2_000_000;

function lineCount(abs: string): number | null {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_LINE_COUNT_BYTES) return null;
  const buf = readFileSync(abs);
  let lines = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
  if (buf.length > 0 && buf[buf.length - 1] !== 10) lines++;
  return lines;
}

export function runVerify(ctx: Ctx, files: string[], repoArg: string | undefined): void {
  if (files.length === 0) {
    fail(ctx, 2, "no findings files given", "verify needs at least one findings JSON file",
      "rlens verify <findings.json...> --repo <path>");
  }
  if (!repoArg) {
    fail(ctx, 2, "missing --repo", "evidence paths are resolved relative to the repository root",
      "pass --repo <path>");
  }
  const repo = resolve(repoArg);
  if (!existsSync(repo)) {
    fail(ctx, 2, `repo not found: ${repoArg}`, "the --repo path does not exist", "pass an existing directory");
  }

  const failures: Failure[] = [];
  let claims = 0;
  const lineCache = new Map<string, number | null>();

  for (const f of files) {
    if (!existsSync(f)) {
      // A missing work product is a failed verification, not a usage error:
      // the gate should send the run back, not crash the executor.
      failures.push({ file: f, where: "(file)", why: "findings file does not exist" });
      continue;
    }
    let doc: any;
    try {
      doc = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      failures.push({ file: f, where: "(file)", why: `not valid JSON: ${(e as Error).message.slice(0, 80)}` });
      continue;
    }
    if (typeof doc?.dimension !== "string" || !Array.isArray(doc?.findings)) {
      failures.push({ file: f, where: "(shape)", why: "required shape: {dimension: string, findings: []}" });
      continue;
    }
    if (doc.confidence !== undefined && !CONFIDENCE.has(doc.confidence)) {
      failures.push({ file: f, where: "(shape)", why: `confidence must be high|medium|low, got "${doc.confidence}"` });
    }
    doc.findings.forEach((fd: any, i: number) => {
      claims++;
      const where = `findings[${i}]`;
      if (typeof fd?.point !== "string" || typeof fd?.evidence !== "string") {
        failures.push({ file: f, where, why: "each finding needs {point: string, evidence: string}" });
        return;
      }
      const m = fd.evidence.match(EVIDENCE_RE);
      if (!m) {
        failures.push({ file: f, where, why: `evidence "${fd.evidence}" is not path:line form` });
        return;
      }
      const rel = m[1];
      const lineFrom = Number(m[2]);
      const lineTo = m[3] ? Number(m[3]) : lineFrom;
      const abs = join(repo, rel);
      if (!lineCache.has(abs)) lineCache.set(abs, lineCount(abs));
      const lines = lineCache.get(abs)!;
      if (lines === null) {
        failures.push({ file: f, where, why: `evidence file not found in repo: ${rel}` });
        return;
      }
      if (lineFrom < 1 || lineTo < lineFrom || lineTo > lines) {
        failures.push({ file: f, where, why: `evidence ${rel}:${m[2]}${m[3] ? "-" + m[3] : ""} out of range (file has ${lines} lines)` });
      }
    });
  }

  const data = { repo, files: files.length, claims, failures, ok: failures.length === 0 };
  emit(ctx, data, () => {
    if (data.ok) return `verify: OK — ${claims} claims across ${files.length} file(s), all evidence resolves`;
    const rows = failures.map((x) => `  ${x.file} ${x.where}: ${x.why}`);
    return [`verify: FAILED — ${failures.length} problem(s) in ${claims} claims`, ...rows].join("\n");
  });
  if (!data.ok) process.exit(1);
}
