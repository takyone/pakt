import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit, fail, type Ctx } from "./cli";
import { loadPlan, resolveTokens, type Plan } from "./plan";

// Run state: an append-only ledger + current position, stored as one JSON file
// under <cwd>/.pakt/runs/<run>/. Every write is atomic (temp + rename), so the
// state file is parseable no matter when the executor dies. Silence is never a
// terminal state: a run without a terminal record is open (running or stalled).

interface LedgerEntry {
  seq: number;
  ts: string;
  event: string;
  node?: string;
  detail?: unknown;
}

interface RunState {
  run: string;
  planPath: string;
  planHash: string;
  planName: string;
  args: Record<string, string>;
  startedAt: string;
  status: "running" | "awaiting_approval" | "done" | "failure" | "exhausted" | "aborted" | "panicked";
  current: string;
  iters: Record<string, number>;
  rubricHashes: Record<string, string>;
  forkedFrom?: { parent: string; atSeq: number; parentStatus: string };
  ledger: LedgerEntry[];
}

const TERMINAL = new Set(["done", "failure", "exhausted", "aborted", "panicked"]);
const STALE_MINUTES = 30;
const TAIL_BYTES = 2048;

const runDirOf = (run: string) => join(process.cwd(), ".pakt", "runs", run);
const statePathOf = (run: string) => join(runDirOf(run), "state.json");

function saveState(st: RunState): void {
  const path = statePathOf(st.run);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n");
  renameSync(tmp, path);
}

function record(st: RunState, event: string, node?: string, detail?: unknown): void {
  const seq = (st.ledger[st.ledger.length - 1]?.seq ?? 0) + 1;
  st.ledger.push({ seq, ts: new Date().toISOString(), event, ...(node ? { node } : {}), ...(detail !== undefined ? { detail } : {}) });
}

function finalize(ctx: Ctx, st: RunState, status: RunState["status"], reason?: string): void {
  st.status = status;
  record(st, "ended", st.current, { status, ...(reason ? { reason } : {}) });
  saveState(st);
  emit(ctx, { run: st.run, terminal: true, status, ...(reason ? { reason } : {}) }, () =>
    `run ${st.run}: ${status}${reason ? ` (${reason})` : ""}`);
}

function panicNow(ctx: Ctx, st: RunState, why: string, detail?: unknown): never {
  st.status = "panicked";
  record(st, "panic", st.current, { why, ...(detail !== undefined ? { detail } : {}) });
  record(st, "ended", st.current, { status: "panicked" });
  saveState(st);
  fail(ctx, 1, `run ${st.run} PANICKED: ${why}`,
    "an invariant was violated; the run is sealed and will not auto-recover",
    "inspect with `pakt plan report <run>`, then start a new run (revive/fork not implemented in v0.2)");
}

function loadRun(ctx: Ctx, run: string): { st: RunState; plan: Plan } {
  const path = statePathOf(run);
  if (!existsSync(path)) {
    fail(ctx, 2, `unknown run "${run}"`, `no state at ${path}`, "start one with `pakt plan start <plan.yaml>`");
  }
  const st = JSON.parse(readFileSync(path, "utf8")) as RunState;
  if (!existsSync(st.planPath)) {
    panicNow(ctx, st, `plan file disappeared: ${st.planPath}`);
  }
  let plan: Plan;
  try {
    plan = loadPlan(st.planPath);
  } catch (e) {
    panicNow(ctx, st, `plan no longer loads: ${(e as Error).message}`);
  }
  if (plan.hash !== st.planHash) {
    panicNow(ctx, st, "plan file changed mid-run (hash mismatch)",
      { expected: st.planHash.slice(0, 12), actual: plan.hash.slice(0, 12) });
  }
  return { st, plan };
}

function nodePayload(st: RunState, plan: Plan, name: string): Record<string, unknown> {
  const node = plan.nodes[name];
  const rd = runDirOf(st.run);
  const payload: Record<string, unknown> = {
    run: st.run,
    node: name,
    kind: node.kind,
    iter: st.iters[name] ?? 0,
    run_dir: rd,
  };
  if (node.run) payload.commands = node.run.map((c) => resolveTokens(c, rd, st.args));
  if (node.agent) payload.agent = node.agent;
  if (node.check) payload.check = { cmd: resolveTokens(node.check.cmd, rd, st.args), executed_by: "toolchain on advance" };
  if (node.judge) {
    payload.judge = {
      model: node.judge.model, votes: node.judge.votes, min_pass: node.judge.min_pass,
      executed_by: "toolchain on advance (requires ANTHROPIC_API_KEY)",
    };
  }
  if (node.approve) payload.approve = node.approve;
  if (node.note) payload.note = node.note;
  return payload;
}

function goto_(ctx: Ctx, st: RunState, plan: Plan, target: string): void {
  st.current = target;
  const node = plan.nodes[target];
  if (node.kind === "end") {
    finalize(ctx, st, node.status === "failure" ? "failure" : "done");
    return;
  }
  saveState(st);
  emit(ctx, { run: st.run, advanced_to: target, kind: node.kind }, () => `run ${st.run}: → ${target} (${node.kind})`);
}

function gateFail(ctx: Ctx, st: RunState, plan: Plan, name: string, why: string): void {
  const node = plan.nodes[name];
  st.iters[name] = (st.iters[name] ?? 0) + 1;
  record(st, "gate_fail", name, { iter: st.iters[name], why });
  if (st.iters[name] > node.max_iters!) {
    record(st, "exhausted", name, { max_iters: node.max_iters });
    if (node.on_exhaust) {
      goto_(ctx, st, plan, node.on_exhaust);
    } else {
      finalize(ctx, st, "exhausted", `gate ${name} exceeded max_iters=${node.max_iters}`);
    }
    return;
  }
  goto_(ctx, st, plan, node.fail!);
}

function applyAnswer(ctx: Ctx, st: RunState, plan: Plan, name: string, choice: string): void {
  const node = plan.nodes[name];
  const option = node.approve!.ask.options.find((o) => o.label === choice);
  if (!option) {
    const labels = node.approve!.ask.options.map((o) => o.label).join(", ");
    fail(ctx, 2, `unknown choice "${choice}"`, `gate ${name} accepts: ${labels}`, "pass one of the listed labels");
  }
  st.status = "running";
  record(st, "answered", name, { choice, means: option.means, by: node.approve!.by });
  if (option.means === "pass") {
    record(st, "gate_pass", name, { via: "approve" });
    goto_(ctx, st, plan, node.pass!);
  } else if (option.means === "fail") {
    gateFail(ctx, st, plan, name, `answer: ${choice}`);
  } else {
    finalize(ctx, st, "aborted", `answer: ${choice}`);
  }
}

export function planStart(ctx: Ctx, planPath: string, opts: { run?: string; args: Record<string, string> }): void {
  let plan: Plan;
  try {
    plan = loadPlan(planPath);
  } catch (e) {
    fail(ctx, 2, "invalid plan", (e as Error).message, "fix the plan file (spec §10)");
  }
  const missing = plan.requiredArgs.filter((a) => !(a in opts.args));
  if (missing.length > 0) {
    fail(ctx, 2, `missing required args: ${missing.join(", ")}`,
      "the plan's command templates reference these {args.*} tokens; unresolved tokens never reach the shell",
      `pass ${missing.map((a) => `--arg ${a}=<value>`).join(" ")}`);
  }
  const run = opts.run ?? "r-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  if (existsSync(statePathOf(run))) {
    fail(ctx, 2, `run "${run}" already exists`, `state present at ${statePathOf(run)}`, "pick another --run id");
  }
  mkdirSync(join(runDirOf(run), "artifacts"), { recursive: true });
  const rubricHashes: Record<string, string> = {};
  for (const [name, node] of Object.entries(plan.nodes)) {
    if (node.judge) rubricHashes[name] = node.judge.rubricHash;
  }
  const st: RunState = {
    run,
    planPath: plan.path,
    planHash: plan.hash,
    planName: plan.name,
    args: opts.args,
    startedAt: new Date().toISOString(),
    status: "running",
    current: plan.start,
    iters: {},
    rubricHashes,
    ledger: [],
  };
  record(st, "started", plan.start, { plan: plan.name, args: opts.args });
  saveState(st);
  emit(ctx, { run, plan: plan.name, current: plan.start, run_dir: runDirOf(run) }, () =>
    `started run ${run} (plan ${plan.name}) at node ${plan.start}`);
}

export function planNext(ctx: Ctx, run: string): void {
  const { st, plan } = loadRun(ctx, run);
  if (TERMINAL.has(st.status)) {
    emit(ctx, { run, terminal: true, status: st.status }, () => `run ${run}: terminal (${st.status})`);
    return;
  }
  if (st.status === "awaiting_approval") {
    const node = plan.nodes[st.current];
    emit(ctx, { run, awaiting_approval: true, node: st.current, ask: node.approve!.ask, by: node.approve!.by }, () =>
      `run ${run}: awaiting approval at ${st.current} — answer with \`pakt plan answer ${run} --choice <label>\``);
    process.exit(4);
  }
  emit(ctx, nodePayload(st, plan, st.current), () => {
    const p = nodePayload(st, plan, st.current);
    return `run ${run}: current node = ${st.current} (${p.kind})`;
  });
}

const JUDGE_SYSTEM = `You are a gate judge. Apply the rubric strictly to the material.
Reply with EXACTLY one JSON object and nothing else:
{"verdict":"pass"|"fail","reason":"<one short sentence>"}`;

class JudgeConfigError extends Error {}

async function judgeVote(model: string, rubric: string, inputsText: string): Promise<{ verdict: string; reason: string }> {
  const base = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  let res: Response;
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        temperature: 0,
        system: `${JUDGE_SYSTEM}\n\n## Rubric\n${rubric}`,
        messages: [{ role: "user", content: `## Material\n${inputsText || "(no inputs declared)"}\n\nJudge now.` }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return { verdict: "api_error", reason: String((e as Error).message).slice(0, 120) };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status !== 429 && res.status < 500) {
      throw new JudgeConfigError(`api ${res.status}: ${body}`);
    }
    return { verdict: "api_error", reason: `api ${res.status}` };
  }
  const data = (await res.json()) as any;
  const text = String(data?.content?.[0]?.text ?? "").trim();
  // Strict parse: a judge whose output needs fuzzy extraction is an unchecked
  // assertion with extra steps. Malformed output = failed vote, not a retry.
  try {
    const p = JSON.parse(text);
    if (p?.verdict === "pass" || p?.verdict === "fail") {
      return { verdict: p.verdict, reason: String(p.reason ?? "") };
    }
  } catch { /* falls through to malformed */ }
  return { verdict: "malformed", reason: text.slice(0, 120) };
}

export async function planAdvance(ctx: Ctx, run: string, opts: {
  node?: string; ok: boolean; failFlag: boolean; answer?: string; reason?: string; artifacts: string[];
}): Promise<void> {
  const { st, plan } = loadRun(ctx, run);
  if (st.status === "awaiting_approval") {
    fail(ctx, 2, "run is awaiting approval", `gate ${st.current} parked this run`, `use \`pakt plan answer ${run} --choice <label>\``);
  }
  if (TERMINAL.has(st.status)) {
    fail(ctx, 2, `run is terminal (${st.status})`, "no transitions after a terminal record", "start a new run");
  }
  if (!opts.node) {
    fail(ctx, 2, "missing --node", "advance must name the node it is reporting on", `pass --node ${st.current}`);
  }
  if (opts.node !== st.current) {
    panicNow(ctx, st, "out-of-order advance (executor desync or concurrent executors)",
      { expected: st.current, got: opts.node });
  }

  const node = plan.nodes[st.current];
  if (opts.artifacts.length > 0) record(st, "artifacts", st.current, { paths: opts.artifacts });

  switch (node.kind) {
    case "cmd":
    case "delegate":
    case "agent": {
      if (opts.failFlag) {
        record(st, "node_failed", st.current, { reason: opts.reason ?? "(none given)" });
        finalize(ctx, st, "failure", opts.reason ?? `node ${st.current} reported failure`);
        return;
      }
      if (!opts.ok) {
        fail(ctx, 2, "missing --ok or --fail", `${node.kind} nodes report completion explicitly`, "pass --ok (or --fail --reason ...)");
      }
      record(st, "advanced", st.current, opts.reason ? { note: opts.reason } : undefined);
      goto_(ctx, st, plan, node.next!);
      return;
    }
    case "gate": {
      if (node.check) {
        // The toolchain runs check commands itself: the executor cannot
        // assert a pass, only ask for the check to be performed.
        const cmd = resolveTokens(node.check.cmd, runDirOf(st.run), st.args);
        const p = Bun.spawnSync(["sh", "-c", cmd], { cwd: process.cwd() });
        const tail = (p.stdout.toString() + p.stderr.toString()).slice(-TAIL_BYTES);
        record(st, "check_run", st.current, { cmd, exit: p.exitCode, tail });
        if (p.exitCode === 0) {
          record(st, "gate_pass", st.current, { via: "check" });
          goto_(ctx, st, plan, node.pass!);
        } else {
          gateFail(ctx, st, plan, st.current, `check exit ${p.exitCode}`);
        }
        return;
      }
      if (node.judge) {
        const j = node.judge;
        if (!process.env.ANTHROPIC_API_KEY) {
          fail(ctx, 2, "ANTHROPIC_API_KEY is not set",
            "judge gates are executed by the toolchain calling the pinned model directly (the executor cannot assert a verdict)",
            "export ANTHROPIC_API_KEY — check/approve paths work without it");
        }
        // Rubric = the judge's plan file: same mid-run-change invariant as planHash.
        let rubricNow = "";
        try {
          rubricNow = new Bun.CryptoHasher("sha256").update(readFileSync(j.rubricPath)).digest("hex");
        } catch {
          panicNow(ctx, st, `rubric disappeared: ${j.rubric}`);
        }
        if (rubricNow !== st.rubricHashes[st.current]) {
          panicNow(ctx, st, "rubric changed mid-run (hash mismatch)",
            { node: st.current, expected: st.rubricHashes[st.current]?.slice(0, 12), actual: rubricNow.slice(0, 12) });
        }
        const rubric = readFileSync(j.rubricPath, "utf8");
        const inputsText = (j.inputs ?? []).map((p) => {
          const rp = resolveTokens(p, runDirOf(st.run), st.args);
          let body: string;
          try {
            body = readFileSync(rp, "utf8").slice(0, 30_000);
          } catch {
            body = "(missing file)";
          }
          return `=== ${rp} ===\n${body}`;
        }).join("\n\n");
        const votes: Array<{ verdict: string; reason: string }> = [];
        try {
          for (let i = 0; i < j.votes; i++) {
            votes.push(await judgeVote(j.model, rubric, inputsText));
          }
        } catch (e) {
          if (e instanceof JudgeConfigError) {
            fail(ctx, 2, "judge API rejected the request", e.message, "check ANTHROPIC_API_KEY / model name / ANTHROPIC_BASE_URL");
          }
          throw e;
        }
        const passes = votes.filter((v) => v.verdict === "pass").length;
        record(st, "judge_run", st.current, {
          model: j.model, rubricHash: rubricNow.slice(0, 12), min_pass: j.min_pass,
          votes: votes.map((v) => ({ verdict: v.verdict, reason: v.reason.slice(0, 160) })),
          passes,
        });
        if (passes >= j.min_pass) {
          record(st, "gate_pass", st.current, { via: "judge" });
          goto_(ctx, st, plan, node.pass!);
        } else {
          gateFail(ctx, st, plan, st.current, `judge ${passes}/${j.votes} passes (min ${j.min_pass})`);
        }
        return;
      }
      // approve
      if (opts.answer !== undefined) {
        applyAnswer(ctx, st, plan, st.current, opts.answer);
        return;
      }
      st.status = "awaiting_approval";
      record(st, "awaiting_approval", st.current, { by: node.approve!.by });
      saveState(st);
      emit(ctx, { run, awaiting_approval: true, node: st.current, ask: node.approve!.ask, by: node.approve!.by }, () =>
        `run ${run}: parked for approval at ${st.current}`);
      process.exit(4);
    }
    case "end":
      // unreachable: goto_ finalizes on arrival at end nodes
      panicNow(ctx, st, "current node is an end node (state corruption)");
  }
}

export function planAnswer(ctx: Ctx, run: string, choice: string | undefined): void {
  const { st, plan } = loadRun(ctx, run);
  if (st.status !== "awaiting_approval") {
    fail(ctx, 2, `run is not awaiting approval (status: ${st.status})`, "answer only applies to parked approve gates", "check `pakt plan status`");
  }
  if (!choice) {
    fail(ctx, 2, "missing --choice", "answer needs the chosen option label", "pakt plan answer <run> --choice <label>");
  }
  applyAnswer(ctx, st, plan, st.current, choice);
}

export function planStatus(ctx: Ctx, run: string, opts: { check: boolean }): void {
  const { st } = loadRun(ctx, run);
  const last = st.ledger[st.ledger.length - 1];
  const ageMin = Math.round((Date.now() - Date.parse(last.ts)) / 60000);
  const stale = !TERMINAL.has(st.status) && ageMin > STALE_MINUTES;
  const data = {
    run,
    plan: st.planName,
    status: st.status,
    current: st.current,
    iters: st.iters,
    steps: st.ledger.length,
    lastEvent: last.event,
    lastTs: last.ts,
    ageMinutes: ageMin,
    ...(stale ? { stale: true, hint: "executor likely gone; resume by calling `pakt plan next` from a new session" } : {}),
  };
  emit(ctx, data, () =>
    `run ${run}: ${st.status} at ${st.current} (${st.ledger.length} ledger entries, last ${last.event} ${ageMin}m ago)${stale ? " [STALE]" : ""}`);
  if (opts.check && (stale || st.status === "panicked")) process.exit(1);
}

export function planTerminate(ctx: Ctx, run: string, status: "aborted" | "panicked", reason: string | undefined): void {
  const { st } = loadRun(ctx, run);
  if (TERMINAL.has(st.status)) {
    fail(ctx, 2, `run is already terminal (${st.status})`, "terminal records are final", "inspect with `pakt plan report`");
  }
  if (!reason) {
    fail(ctx, 2, "missing --reason", "abort/panic must say why (it goes into the ledger)", "pass --reason \"...\"");
  }
  if (status === "panicked") {
    record(st, "panic", st.current, { why: reason, source: "executor escape hatch" });
  }
  finalize(ctx, st, status, reason);
}

// Raw state read for recovery verbs: unlike loadRun, plan drift here must NOT
// panic (the parent may already be sealed) — it refuses instead.
function readStateRaw(ctx: Ctx, run: string): RunState {
  const path = statePathOf(run);
  if (!existsSync(path)) {
    fail(ctx, 2, `unknown run "${run}"`, `no state at ${path}`, "start one with `pakt plan start <plan.yaml>`");
  }
  return JSON.parse(readFileSync(path, "utf8")) as RunState;
}

function assertPlanUnchanged(ctx: Ctx, st: RunState, what: string): void {
  let plan: Plan;
  try {
    plan = loadPlan(st.planPath);
  } catch (e) {
    fail(ctx, 2, `plan no longer loads: ${(e as Error).message}`, `${what} requires the original plan`, "start a new run instead");
  }
  if (plan.hash !== st.planHash) {
    fail(ctx, 2, "plan file changed since this run started",
      `${what} under a different plan would be a new run wearing an old ledger`,
      "start a new run instead");
  }
}

export function planRevive(ctx: Ctx, run: string, reason: string | undefined): void {
  const st = readStateRaw(ctx, run);
  if (!["panicked", "aborted"].includes(st.status)) {
    fail(ctx, 2, `cannot revive a ${st.status} run`,
      "done/failure/exhausted are legitimate outcomes, not accidents — reviving them would reopen a door the termination guarantee closed",
      "revive applies to panicked/aborted only; otherwise start a new run (or fork)");
  }
  if (!reason) {
    fail(ctx, 2, "missing --reason", "revival is a human decision and the ledger records why", 'pass --reason "..."');
  }
  assertPlanUnchanged(ctx, st, "revive");
  st.status = "running";
  record(st, "revived", st.current, { reason });
  saveState(st);
  emit(ctx, { run, revived: true, current: st.current }, () =>
    `run ${run}: revived at ${st.current} (prefer fork when in doubt — a panicked run's assumptions may be corrupted)`);
}

export function planFork(ctx: Ctx, run: string, opts: { as?: string; reason?: string }): void {
  const parent = readStateRaw(ctx, run);
  if (!TERMINAL.has(parent.status)) {
    fail(ctx, 2, `parent run is still ${parent.status}`, "forking a live run risks two executors on one lineage", "wait for a terminal state or abort first");
  }
  if (!opts.as) fail(ctx, 2, "missing --as", "fork needs a name for the child run", "pakt plan fork <run> --as <new-run> --reason ...");
  if (!opts.reason) fail(ctx, 2, "missing --reason", "the ledger records why this lineage continues", 'pass --reason "..."');
  if (existsSync(statePathOf(opts.as))) {
    fail(ctx, 2, `run "${opts.as}" already exists`, `state present at ${statePathOf(opts.as)}`, "pick another --as id");
  }
  assertPlanUnchanged(ctx, parent, "fork");
  mkdirSync(join(runDirOf(opts.as), "artifacts"), { recursive: true });
  const lastSeq = parent.ledger[parent.ledger.length - 1]?.seq ?? 0;
  const child: RunState = {
    run: opts.as,
    planPath: parent.planPath,
    planHash: parent.planHash,
    planName: parent.planName,
    args: parent.args,
    startedAt: new Date().toISOString(),
    status: "running",
    current: parent.current,
    iters: { ...parent.iters }, // copied on purpose: gate budgets survive the fork
    rubricHashes: { ...parent.rubricHashes },
    forkedFrom: { parent: parent.run, atSeq: lastSeq, parentStatus: parent.status },
    ledger: [],
  };
  record(child, "forked_from", parent.current, {
    parent: parent.run, atSeq: lastSeq, parentStatus: parent.status,
    reason: opts.reason, parentArtifacts: join(runDirOf(parent.run), "artifacts"),
  });
  saveState(child);
  emit(ctx, { run: opts.as, forked_from: parent.run, current: child.current }, () =>
    `forked ${parent.run} → ${opts.as} at ${child.current} (artifacts stay with the parent; iters carried over)`);
}

export function planReport(ctx: Ctx, run: string): void {
  const { st } = loadRun(ctx, run);
  const lines: string[] = [
    `# plan run report: ${st.run}`,
    "",
    `- plan: ${st.planName} (\`${st.planPath}\`)`,
    `- status: **${st.status}**${TERMINAL.has(st.status) ? "" : " (open)"}`,
    `- position: ${st.current}`,
    `- started: ${st.startedAt}`,
    `- args: ${JSON.stringify(st.args)}`,
    `- artifacts: \`${join(runDirOf(run), "artifacts")}\``,
    "",
    "## timeline",
    "",
    "| # | time | event | node | detail |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const e of st.ledger) {
    const detail = e.detail !== undefined ? JSON.stringify(e.detail).slice(0, 160) : "";
    lines.push(`| ${e.seq} | ${e.ts} | ${e.event} | ${e.node ?? ""} | ${detail} |`);
  }
  lines.push("", "## next action", "");
  const advice: Record<string, string> = {
    done: "nothing — the run completed.",
    failure: "inspect the failing node's ledger entry and artifacts, then start a new run.",
    exhausted: "a gate ran out of iterations; inspect its check_run tails, fix the upstream work, start a new run.",
    aborted: "the run was stopped on purpose; start a new run if needed.",
    panicked: "an invariant broke; do not trust partial artifacts blindly. revive/fork are not implemented in v0.2 — start a new run.",
    awaiting_approval: `answer with \`pakt plan answer ${run} --choice <label>\`.`,
    running: `continue with \`pakt plan next ${run}\`.`,
  };
  lines.push(advice[st.status] ?? "");
  console.log(lines.join("\n"));
}
