import { readFileSync } from "node:fs";
import { fail, type Ctx } from "./cli";
import type { AskSpec } from "./plan";

// Interactive TTY fallback for approve gates. The AskUserQuestion-compatible
// schema {question, options[{label, description}], multiSelect} is the
// contract; delivery degrades: harness-native ask tool → this TUI → parked
// async approval via `pakt plan answer`. Inside a harness (no user TTY) this
// command refuses to run instead of blocking forever.

export function runAsk(ctx: Ctx, payloadPath: string | undefined): void {
  if (!payloadPath) {
    fail(ctx, 2, "missing --payload", "ask renders a question payload file", 'pakt ask --payload question.json');
  }
  let ask: AskSpec;
  try {
    ask = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch (e) {
    fail(ctx, 2, "unreadable payload", (e as Error).message, "pass a JSON file with {question, options[]}");
  }
  if (typeof ask.question !== "string" || !Array.isArray(ask.options) || ask.options.length === 0) {
    fail(ctx, 2, "invalid payload shape", "need {question: string, options: [{label, description?}]}", "see spec §10");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(ctx, 2, "no TTY", "ask is the interactive fallback and cannot prompt here",
      "use the harness-native ask tool, or `pakt plan answer <run> --choice <label>` for parked runs");
  }

  console.log(`\n${ask.question}\n`);
  ask.options.forEach((o, i) => {
    console.log(`  ${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`);
  });
  const raw = prompt(`\nchoice [1-${ask.options.length}]:`);
  const idx = Number(raw?.trim());
  if (!Number.isInteger(idx) || idx < 1 || idx > ask.options.length) {
    fail(ctx, 2, `invalid choice "${raw}"`, "pick an option number", `enter 1-${ask.options.length}`);
  }
  console.log(JSON.stringify({ choice: ask.options[idx - 1].label }));
}
