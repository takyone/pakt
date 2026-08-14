// Shared CLI conventions for the pakt reference toolchain.
// Same contract as spec/SPEC.md §3: exit 0 ok / 1 transient / 2 bad input,
// --json errors as {"error":{what,why,remediation}} on stderr.

export interface Ctx {
  json: boolean;
}

export function fail(ctx: Ctx, code: number, what: string, why: string, remediation: string): never {
  const msg = ctx.json
    ? JSON.stringify({ error: { what, why, remediation } })
    : `pakt: ${what}\n  why: ${why}\n  fix: ${remediation}`;
  console.error(msg);
  process.exit(code);
}

export function emit(ctx: Ctx, data: unknown, human: () => string): void {
  console.log(ctx.json ? JSON.stringify(data, null, 2) : human());
}
