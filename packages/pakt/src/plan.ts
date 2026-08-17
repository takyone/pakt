import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Declarative plan (state machine) model + validation. See spec/SPEC.md §10.
// Transitions are computed by the toolchain (planCli.ts); the LLM executes
// nodes but never decides transitions.

export interface AskOption {
  label: string;
  description?: string;
  means: "pass" | "fail" | "abort";
}

export interface AskSpec {
  question: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface PlanNode {
  kind: "cmd" | "delegate" | "gate" | "agent" | "end";
  run?: string[];
  agent?: string;
  next?: string;
  note?: string;
  check?: { cmd: string };
  judge?: Record<string, unknown>; // schema-reserved; not executable in v0.2
  approve?: { by: string; ask: AskSpec };
  pass?: string;
  fail?: string;
  max_iters?: number;
  on_exhaust?: string;
  status?: "done" | "failure";
}

export interface Plan {
  name: string;
  start: string;
  nodes: Record<string, PlanNode>;
  path: string;
  hash: string;
  requiredArgs: string[];
}

const NAME_RE = /^[a-z][a-z0-9_-]*$/;
const TOKEN_RE = /\{([^{}]+)\}/g;

function bad(msg: string): never {
  throw new Error(`plan: ${msg}`);
}

function collectTokens(strings: string[], requiredArgs: Set<string>): void {
  for (const s of strings) {
    for (const m of s.matchAll(TOKEN_RE)) {
      const token = m[1];
      if (token === "run_dir") continue;
      if (token.startsWith("args.")) {
        const name = token.slice(5);
        if (!name) bad(`empty arg token in "${s}"`);
        requiredArgs.add(name);
        continue;
      }
      bad(`unknown token {${token}} in "${s}" (only {run_dir} and {args.*} exist; there is no expression language)`);
    }
  }
}

export function loadPlan(pathArg: string): Plan {
  const path = resolve(pathArg);
  const src = readFileSync(path, "utf8");
  const raw = Bun.YAML.parse(src) as any;
  if (typeof raw !== "object" || raw === null) bad("not a mapping");

  const name = String(raw.name ?? "");
  if (!NAME_RE.test(name)) bad(`invalid name "${name}"`);
  const start = String(raw.start ?? "");
  const nodesRaw = raw.nodes;
  if (typeof nodesRaw !== "object" || nodesRaw === null) bad("nodes is required");

  const nodes: Record<string, PlanNode> = {};
  const requiredArgs = new Set<string>();

  for (const [nodeName, defRaw] of Object.entries(nodesRaw as Record<string, any>)) {
    if (!NAME_RE.test(nodeName)) bad(`invalid node name "${nodeName}"`);
    const kind = defRaw?.kind;
    const ref = (field: string, value: unknown, required: boolean): string | undefined => {
      if (value === undefined) {
        if (required) bad(`${nodeName}: "${field}" is required for kind ${kind}`);
        return undefined;
      }
      return String(value);
    };
    const node: PlanNode = { kind };
    switch (kind) {
      case "cmd": {
        if (!Array.isArray(defRaw.run) || defRaw.run.length === 0 || !defRaw.run.every((r: unknown) => typeof r === "string")) {
          bad(`${nodeName}: cmd node needs run: [string, ...]`);
        }
        node.run = defRaw.run;
        collectTokens(node.run!, requiredArgs);
        node.next = ref("next", defRaw.next, true);
        break;
      }
      case "delegate": {
        node.agent = ref("agent", defRaw.agent, true);
        node.next = ref("next", defRaw.next, true);
        break;
      }
      case "agent": {
        node.next = ref("next", defRaw.next, true);
        if (defRaw.note !== undefined) node.note = String(defRaw.note);
        break;
      }
      case "gate": {
        const acts = ["check", "judge", "approve"].filter((a) => defRaw[a] !== undefined);
        if (acts.length !== 1) bad(`${nodeName}: gate needs exactly one of check | judge | approve (got: ${acts.join(", ") || "none"})`);
        if (defRaw.check !== undefined) {
          if (typeof defRaw.check?.cmd !== "string") bad(`${nodeName}: check needs {cmd: string}`);
          node.check = { cmd: defRaw.check.cmd };
          collectTokens([node.check.cmd], requiredArgs);
        }
        if (defRaw.judge !== undefined) node.judge = defRaw.judge;
        if (defRaw.approve !== undefined) {
          const ask = defRaw.approve.ask;
          if (typeof ask?.question !== "string" || !Array.isArray(ask?.options) || ask.options.length < 2) {
            bad(`${nodeName}: approve needs ask: {question, options: [>=2]}`);
          }
          for (const o of ask.options) {
            if (typeof o?.label !== "string" || !["pass", "fail", "abort"].includes(o?.means)) {
              bad(`${nodeName}: every approve option needs {label, means: pass|fail|abort}`);
            }
          }
          node.approve = { by: String(defRaw.approve.by ?? "user"), ask };
        }
        node.pass = ref("pass", defRaw.pass, true);
        node.fail = ref("fail", defRaw.fail, true);
        if (!Number.isInteger(defRaw.max_iters) || defRaw.max_iters < 1) {
          bad(`${nodeName}: gate needs max_iters >= 1 (bounded loops are what guarantee termination)`);
        }
        node.max_iters = defRaw.max_iters;
        node.on_exhaust = ref("on_exhaust", defRaw.on_exhaust, false);
        break;
      }
      case "end": {
        if (defRaw.status !== undefined && !["done", "failure"].includes(defRaw.status)) {
          bad(`${nodeName}: end status must be done | failure`);
        }
        node.status = defRaw.status ?? "done";
        break;
      }
      default:
        bad(`${nodeName}: unknown kind "${kind}" (cmd | delegate | gate | agent | end)`);
    }
    nodes[nodeName] = node;
  }

  if (!(start in nodes)) bad(`start node "${start}" does not exist`);
  for (const [nodeName, node] of Object.entries(nodes)) {
    for (const field of ["next", "pass", "fail", "on_exhaust"] as const) {
      const target = node[field];
      if (target !== undefined && !(target in nodes)) {
        bad(`${nodeName}.${field} points to unknown node "${target}"`);
      }
    }
  }

  assertTerminating(nodes);

  const hash = new Bun.CryptoHasher("sha256").update(src).digest("hex");
  return { name, start, nodes, path, hash, requiredArgs: [...requiredArgs].sort() };
}

// Cycles are allowed only through gate fail-edges (which carry max_iters).
// Dropping those edges must leave a DAG, or the plan cannot terminate.
function assertTerminating(nodes: Record<string, PlanNode>): void {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const edges = (n: PlanNode): string[] =>
    [n.next, n.pass, n.on_exhaust].filter((t): t is string => t !== undefined);

  const visit = (name: string, path: string[]): void => {
    const c = color.get(name) ?? WHITE;
    if (c === GRAY) bad(`cycle without a gate fail-edge: ${[...path, name].join(" → ")} (loops must go through gate.fail + max_iters)`);
    if (c === BLACK) return;
    color.set(name, GRAY);
    for (const t of edges(nodes[name])) visit(t, [...path, name]);
    color.set(name, BLACK);
  };
  for (const name of Object.keys(nodes)) visit(name, []);
}

export function resolveTokens(s: string, runDir: string, args: Record<string, string>): string {
  return s.replace(TOKEN_RE, (_, token) => {
    if (token === "run_dir") return runDir;
    if (token.startsWith("args.")) return args[token.slice(5)] ?? "";
    return "";
  });
}
