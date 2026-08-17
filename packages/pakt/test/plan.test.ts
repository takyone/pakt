import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan } from "../src/plan";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

let ws: string; // workspace cwd (state root lives under it)
let planFile: string;

const PLAN = `
name: t
start: work
nodes:
  work:
    kind: cmd
    run: ["echo {args.greeting} > {run_dir}/artifacts/out.txt"]
    next: check_it
  check_it:
    kind: gate
    check: { cmd: "test -f {run_dir}/artifacts/out.txt" }
    pass: review
    fail: work
    max_iters: 2
    on_exhaust: bad
  review:
    kind: gate
    approve:
      ask:
        question: "ok?"
        options:
          - { label: "yes", means: pass }
          - { label: "redo", means: fail }
          - { label: "stop", means: abort }
    pass: fin
    fail: work
    max_iters: 1
  fin: { kind: end }
  bad: { kind: end, status: failure }
`;

function pakt(args: string[], cwd = ws) {
  const p = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function state(run: string) {
  return JSON.parse(readFileSync(join(ws, ".pakt", "runs", run, "state.json"), "utf8"));
}

function noTmpFiles(run: string) {
  const dir = join(ws, ".pakt", "runs", run);
  return readdirSync(dir).filter((f) => f.endsWith(".tmp")).length === 0;
}

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "pakt-plan-ws-"));
  planFile = join(ws, "t.plan.yaml");
  writeFileSync(planFile, PLAN);
});

afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe("plan validation", () => {
  test("rejects refs to unknown nodes", () => {
    const f = join(ws, "bad1.yaml");
    writeFileSync(f, "name: b\nstart: a\nnodes:\n  a: { kind: agent, next: ghost }\n");
    expect(() => loadPlan(f)).toThrow(/unknown node "ghost"/);
  });

  test("rejects cycles that bypass gate fail-edges", () => {
    const f = join(ws, "bad2.yaml");
    writeFileSync(f, "name: b\nstart: a\nnodes:\n  a: { kind: agent, next: b }\n  b: { kind: agent, next: a }\n");
    expect(() => loadPlan(f)).toThrow(/cycle without a gate fail-edge/);
  });

  test("rejects unknown template tokens", () => {
    const f = join(ws, "bad3.yaml");
    writeFileSync(f, 'name: b\nstart: a\nnodes:\n  a: { kind: cmd, run: ["echo {oops}"], next: z }\n  z: { kind: end }\n');
    expect(() => loadPlan(f)).toThrow(/unknown token \{oops\}/);
  });

  test("gate requires max_iters", () => {
    const f = join(ws, "bad4.yaml");
    writeFileSync(f, 'name: b\nstart: g\nnodes:\n  g: { kind: gate, check: {cmd: "true"}, pass: z, fail: g }\n  z: { kind: end }\n');
    expect(() => loadPlan(f)).toThrow(/max_iters/);
  });

  test("the shipped analyze plan loads and declares its args", () => {
    const plan = loadPlan(join(REPO_ROOT, "packs/repo-analyze/plans/analyze.plan.yaml"));
    expect(plan.requiredArgs).toEqual(["target"]);
  });
});

describe("run lifecycle", () => {
  test("start fails closed on missing args", () => {
    const r = pakt(["plan", "start", planFile, "--run", "miss", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err).error.what).toContain("greeting");
  });

  test("happy path: cmd → check gate (toolchain-run) → approve park → answer → done", () => {
    expect(pakt(["plan", "start", planFile, "--run", "r1", "--arg", "greeting=hi", "--json"]).code).toBe(0);

    let next = JSON.parse(pakt(["plan", "next", "r1", "--json"]).out);
    expect(next.node).toBe("work");
    expect(next.commands[0]).toContain("echo hi");
    expect(next.commands[0]).not.toContain("{");

    // executor performs the cmd node, then reports
    Bun.spawnSync(["sh", "-c", next.commands[0]], { cwd: ws });
    expect(pakt(["plan", "advance", "r1", "--node", "work", "--ok", "--json"]).code).toBe(0);

    // check gate: advance runs the check itself and records it
    const adv = pakt(["plan", "advance", "r1", "--node", "check_it", "--json"]);
    expect(adv.code).toBe(0);
    const st1 = state("r1");
    expect(st1.current).toBe("review");
    expect(st1.ledger.some((e: any) => e.event === "check_run" && e.detail.exit === 0)).toBe(true);

    // approve gate parks with exit 4 (spec §3 "needs input")
    const park = pakt(["plan", "advance", "r1", "--node", "review", "--json"]);
    expect(park.code).toBe(4);
    expect(state("r1").status).toBe("awaiting_approval");
    expect(pakt(["plan", "next", "r1", "--json"]).code).toBe(4);

    // answered → done
    expect(pakt(["plan", "answer", "r1", "--choice", "yes", "--json"]).code).toBe(0);
    const st2 = state("r1");
    expect(st2.status).toBe("done");
    expect(st2.ledger[st2.ledger.length - 1].event).toBe("ended");
    expect(noTmpFiles("r1")).toBe(true);

    // next on a terminal run: exit 0 with terminal flag (executor stop condition)
    const done = pakt(["plan", "next", "r1", "--json"]);
    expect(done.code).toBe(0);
    expect(JSON.parse(done.out).terminal).toBe(true);
  });

  test("failing check loops back, then exhausts to on_exhaust", () => {
    const f = join(ws, "loop.yaml");
    writeFileSync(f, `
name: loopy
start: g
nodes:
  g:
    kind: gate
    check: { cmd: "false" }
    pass: win
    fail: retry
    max_iters: 2
    on_exhaust: lose
  retry: { kind: agent, next: g }
  win: { kind: end }
  lose: { kind: end, status: failure }
`);
    pakt(["plan", "start", f, "--run", "r2", "--json"]);
    // fail 1 → retry, fail 2 → retry, fail 3 (> max_iters) → exhaust
    for (const _ of [1, 2]) {
      expect(state("r2").current).toBe("g");
      pakt(["plan", "advance", "r2", "--node", "g", "--json"]);
      expect(state("r2").current).toBe("retry");
      pakt(["plan", "advance", "r2", "--node", "retry", "--ok", "--json"]);
    }
    pakt(["plan", "advance", "r2", "--node", "g", "--json"]);
    const st = state("r2");
    expect(st.status).toBe("failure"); // lose end node
    expect(st.iters.g).toBe(3);
    expect(st.ledger.some((e: any) => e.event === "exhausted")).toBe(true);
  });

  test("answer with means:abort terminates as aborted", () => {
    pakt(["plan", "start", planFile, "--run", "r3", "--arg", "greeting=yo", "--json"]);
    Bun.spawnSync(["sh", "-c", "mkdir -p .pakt/runs/r3/artifacts && touch .pakt/runs/r3/artifacts/out.txt"], { cwd: ws });
    pakt(["plan", "advance", "r3", "--node", "work", "--ok", "--json"]);
    pakt(["plan", "advance", "r3", "--node", "check_it", "--json"]);
    pakt(["plan", "advance", "r3", "--node", "review", "--json"]);
    pakt(["plan", "answer", "r3", "--choice", "stop", "--json"]);
    expect(state("r3").status).toBe("aborted");
  });
});

describe("failure semantics", () => {
  test("out-of-order advance panics and seals the run", () => {
    pakt(["plan", "start", planFile, "--run", "r4", "--arg", "greeting=x", "--json"]);
    const r = pakt(["plan", "advance", "r4", "--node", "review", "--ok", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error.what).toContain("PANICKED");
    expect(state("r4").status).toBe("panicked");
    // sealed: no transitions after a terminal record
    expect(pakt(["plan", "advance", "r4", "--node", "work", "--ok", "--json"]).code).toBe(2);
    expect(pakt(["plan", "status", "r4", "--check", "--json"]).code).toBe(1);
  });

  test("plan file edited mid-run → hash mismatch panic", () => {
    const f = join(ws, "mut.yaml");
    writeFileSync(f, PLAN);
    pakt(["plan", "start", f, "--run", "r5", "--arg", "greeting=x", "--json"]);
    writeFileSync(f, PLAN + "\n# edited mid-run\n");
    const r = pakt(["plan", "next", "r5", "--json"]);
    expect(r.code).toBe(1);
    expect(state("r5").status).toBe("panicked");
    expect(state("r5").ledger.some((e: any) => e.event === "panic")).toBe(true);
  });

  test("abort requires a reason and records it", () => {
    pakt(["plan", "start", planFile, "--run", "r6", "--arg", "greeting=x", "--json"]);
    expect(pakt(["plan", "abort", "r6", "--json"]).code).toBe(2);
    pakt(["plan", "abort", "r6", "--reason", "changed my mind", "--json"]);
    const st = state("r6");
    expect(st.status).toBe("aborted");
    expect(JSON.stringify(st.ledger)).toContain("changed my mind");
  });

  test("judge gates refuse to execute in v0.2", () => {
    const f = join(ws, "judge.yaml");
    writeFileSync(f, `
name: j
start: g
nodes:
  g:
    kind: gate
    judge: { agent: reviewer }
    pass: z
    fail: z
    max_iters: 1
  z: { kind: end }
`);
    pakt(["plan", "start", f, "--run", "r7", "--json"]);
    const r = pakt(["plan", "advance", "r7", "--node", "g", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err).error.what).toContain("judge");
  });

  test("report renders a timeline for any state", () => {
    const r = pakt(["plan", "report", "r4"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("panicked");
    expect(r.out).toContain("## timeline");
    expect(r.out).toContain("## next action");
  });
});
