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

function pakt(args: string[], envOverride?: Record<string, string>, dropKeys: string[] = []) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...envOverride };
  for (const k of dropKeys) delete env[k];
  const p = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd: ws, env });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

// Judge tests must NOT use spawnSync: the mock server lives in this process,
// and a synchronous child-wait would block the event loop that serves it.
async function paktA(args: string[], envOverride?: Record<string, string>) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...envOverride };
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd: ws, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

function mockJudge(responses: string[]) {
  let i = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      const text = responses[Math.min(i++, responses.length - 1)];
      return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, env: { ANTHROPIC_BASE_URL: `http://localhost:${server.port}`, ANTHROPIC_API_KEY: "test-key" } };
}

const JUDGE_PLAN = `
name: j
start: g
nodes:
  g:
    kind: gate
    judge: { model: test-model, rubric: rubric.md, votes: 3, min_pass: 2 }
    pass: win
    fail: retry
    max_iters: 1
  retry: { kind: agent, next: g }
  win: { kind: end }
`;
const V = (verdict: string) => JSON.stringify({ verdict, reason: "because" });

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

  test("report renders a timeline for any state", () => {
    const r = pakt(["plan", "report", "r4"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("panicked");
    expect(r.out).toContain("## timeline");
    expect(r.out).toContain("## next action");
  });
});

describe("judge gates (toolchain-executed, mock API)", () => {
  test("2/3 pass votes → gate_pass with per-vote ledger", async () => {
    writeFileSync(join(ws, "rubric.md"), "# rubric\npass if the material mentions apples.\n");
    writeFileSync(join(ws, "j.plan.yaml"), JUDGE_PLAN);
    const { server, env } = mockJudge([V("pass"), V("fail"), V("pass")]);
    try {
      await paktA(["plan", "start", join(ws, "j.plan.yaml"), "--run", "j1", "--json"], env);
      const r = await paktA(["plan", "advance", "j1", "--node", "g", "--json"], env);
      expect(r.code).toBe(0);
      const st = state("j1");
      expect(st.status).toBe("done"); // → win
      const jr = st.ledger.find((e: any) => e.event === "judge_run");
      expect(jr.detail.passes).toBe(2);
      expect(jr.detail.votes.length).toBe(3);
      expect(jr.detail.model).toBe("test-model");
      expect(jr.detail.rubricHash.length).toBe(12);
    } finally {
      server.stop(true);
    }
  });

  test("malformed judge output = failed vote, not a retry", async () => {
    writeFileSync(join(ws, "rubric.md"), "# rubric\npass if the material mentions apples.\n");
    writeFileSync(join(ws, "j2.plan.yaml"), JUDGE_PLAN);
    const { server, env } = mockJudge([`Sure! Here you go: ${V("pass")}`, V("fail"), V("pass")]);
    try {
      await paktA(["plan", "start", join(ws, "j2.plan.yaml"), "--run", "j2", "--json"], env);
      await paktA(["plan", "advance", "j2", "--node", "g", "--json"], env);
      const st = state("j2");
      const jr = st.ledger.find((e: any) => e.event === "judge_run");
      expect(jr.detail.passes).toBe(1); // prose-wrapped JSON is malformed
      expect(jr.detail.votes.some((v: any) => v.verdict === "malformed")).toBe(true);
      expect(st.current).toBe("retry"); // 1 < min_pass 2 → gate_fail
    } finally {
      server.stop(true);
    }
  });

  test("missing ANTHROPIC_API_KEY → exit 2, but the plan loads and starts fine", () => {
    writeFileSync(join(ws, "rubric.md"), "# rubric\n");
    writeFileSync(join(ws, "j3.plan.yaml"), JUDGE_PLAN);
    expect(pakt(["plan", "start", join(ws, "j3.plan.yaml"), "--run", "j3", "--json"], undefined, ["ANTHROPIC_API_KEY"]).code).toBe(0);
    const r = pakt(["plan", "advance", "j3", "--node", "g", "--json"], undefined, ["ANTHROPIC_API_KEY"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err).error.what).toContain("ANTHROPIC_API_KEY");
  });

  test("rubric edited mid-run → panic (same invariant class as plan hash)", async () => {
    writeFileSync(join(ws, "rubric.md"), "# rubric v1\n");
    writeFileSync(join(ws, "j4.plan.yaml"), JUDGE_PLAN);
    const { server, env } = mockJudge([V("pass")]);
    try {
      await paktA(["plan", "start", join(ws, "j4.plan.yaml"), "--run", "j4", "--json"], env);
      writeFileSync(join(ws, "rubric.md"), "# rubric v2 (edited mid-run)\n");
      const r = await paktA(["plan", "advance", "j4", "--node", "g", "--json"], env);
      expect(r.code).toBe(1);
      expect(state("j4").status).toBe("panicked");
    } finally {
      server.stop(true);
    }
  });
});

describe("recovery: revive / fork", () => {
  test("revive from exhausted is refused (termination guarantee)", () => {
    const f = join(ws, "exh.yaml");
    writeFileSync(f, `
name: e
start: g
nodes:
  g:
    kind: gate
    check: { cmd: "false" }
    pass: z
    fail: back
    max_iters: 1
  back: { kind: agent, next: g }
  z: { kind: end }
`);
    pakt(["plan", "start", f, "--run", "x1", "--json"]);
    pakt(["plan", "advance", "x1", "--node", "g", "--json"]);
    pakt(["plan", "advance", "x1", "--node", "back", "--ok", "--json"]);
    pakt(["plan", "advance", "x1", "--node", "g", "--json"]); // 2nd fail > max_iters, no on_exhaust
    expect(state("x1").status).toBe("exhausted");
    const r = pakt(["plan", "revive", "x1", "--reason", "please", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err).error.what).toContain("exhausted");
  });

  test("revive from panicked works and leaves a scar in the ledger", () => {
    expect(state("r4").status).toBe("panicked");
    const r = pakt(["plan", "revive", "r4", "--reason", "inspected; state is sound", "--json"]);
    expect(r.code).toBe(0);
    const st = state("r4");
    expect(st.status).toBe("running");
    expect(st.ledger.some((e: any) => e.event === "revived")).toBe(true);
  });

  test("fork carries gate budgets: exhausted lineage stays exhausted", () => {
    const r = pakt(["plan", "fork", "x1", "--as", "x2", "--reason", "retry after env fix", "--json"]);
    expect(r.code).toBe(0);
    const st = state("x2");
    expect(st.status).toBe("running");
    expect(st.iters.g).toBe(2); // budget survives the fork
    expect(st.ledger[0].event).toBe("forked_from");
    pakt(["plan", "advance", "x2", "--node", "g", "--json"]);
    expect(state("x2").status).toBe("exhausted"); // 3 > max_iters immediately
  });

  test("fork refuses a live parent and a changed plan", () => {
    pakt(["plan", "start", planFile, "--run", "x3", "--arg", "greeting=x", "--json"]);
    expect(pakt(["plan", "fork", "x3", "--as", "x4", "--reason", "r", "--json"]).code).toBe(2); // still running
    // r5 was panicked precisely because its plan file changed:
    expect(pakt(["plan", "fork", "r5", "--as", "x5", "--reason", "r", "--json"]).code).toBe(2);
  });
});
