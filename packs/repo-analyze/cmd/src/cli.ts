// Shared CLI conventions for rlens (pakt Cmd-layer contract):
// exit codes 0 = success, 1 = transient/internal, 2 = usage or input error;
// with --json, errors are {"error":{what,why,remediation}} on stderr.

export interface Ctx {
  json: boolean;
}

export function fail(ctx: Ctx, code: number, what: string, why: string, remediation: string): never {
  const msg = ctx.json
    ? JSON.stringify({ error: { what, why, remediation } })
    : `rlens: ${what}\n  why: ${why}\n  fix: ${remediation}`;
  console.error(msg);
  process.exit(code);
}

export function emit(ctx: Ctx, data: unknown, human: () => string): void {
  console.log(ctx.json ? JSON.stringify(data, null, 2) : human());
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}
