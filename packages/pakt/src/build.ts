import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Pack } from "./pack";

// JSON string escaping is a valid subset of YAML double-quoted scalars.
const q = (v: string) => JSON.stringify(v);

// TOML basic strings need their own escaper: Bun.TOML.parse (1.3.13) misreads
// the \t escape as \f, so tabs are emitted literally (valid TOML) instead.
// Control chars other than tab are \uXXXX-escaped.
const tomlStr = (s: string) =>
  '"' +
  s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()) +
  '"';

export interface EmitResult {
  files: Record<string, string>;
  warnings: string[];
}

export function emitAgents(pack: Pack): EmitResult {
  const files: Record<string, string> = {};
  const warnings: string[] = [];

  for (const a of pack.agents) {
    // Claude Code: name/description/tools/model are native; skills[] degrades.
    let claudeBody = a.instructions;
    if (a.skills?.length) {
      claudeBody += `\n\nSkill policy: use only these skills: ${a.skills.join(", ")}. Do not load others.`;
      warnings.push(`${a.name}: claude adapter has no native skills field — embedded in instructions (lossy)`);
    }
    const claudeFm = [`name: ${q(a.name)}`, `description: ${q(a.description)}`];
    if (a.tools?.length) claudeFm.push(`tools: ${q(a.tools.join(", "))}`);
    if (a.model) claudeFm.push(`model: ${q(a.model)}`);
    files[`adapters/claude/agents/${a.name}.md`] = `---\n${claudeFm.join("\n")}\n---\n\n${claudeBody}\n`;

    // Codex CLI: name/description/model/skills are native; tools[] degrades.
    let codexInstructions = a.instructions;
    if (a.tools?.length) {
      codexInstructions += `\n\nTool policy: use only these tools: ${a.tools.join(", ")}.`;
      warnings.push(`${a.name}: codex adapter has no native tools field — embedded in instructions (lossy)`);
    }
    const toml = [`name = ${tomlStr(a.name)}`, `description = ${tomlStr(a.description)}`];
    if (a.model) toml.push(`model = ${tomlStr(a.model)}`);
    if (a.skills?.length) toml.push(`skills = [${a.skills.map(tomlStr).join(", ")}]`);
    toml.push(`instructions = ${tomlStr(codexInstructions)}`);
    files[`adapters/codex/agents/${a.name}.toml`] = toml.join("\n") + "\n";

    // Antigravity: conservative — only name/description/subagent emitted natively.
    let agBody = a.instructions;
    if (a.tools?.length) agBody += `\n\nTool policy: use only these tools: ${a.tools.join(", ")}.`;
    if (a.skills?.length) agBody += `\n\nSkill policy: use only these skills: ${a.skills.join(", ")}.`;
    const agFm = [`name: ${q(a.name)}`, `description: ${q(a.description)}`, "subagent: true"];
    files[`adapters/antigravity/agents/${a.name}.md`] = `---\n${agFm.join("\n")}\n---\n\n${agBody}\n`;
  }

  return { files, warnings };
}

export function buildPack(pack: Pack, opts: { check?: boolean } = {}): {
  wrote: string[];
  drift: string[];
  warnings: string[];
} {
  const { files, warnings } = emitAgents(pack);
  const wrote: string[] = [];
  const drift: string[] = [];

  for (const [rel, content] of Object.entries(files)) {
    const abs = join(pack.dir, rel);
    if (opts.check) {
      const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (current !== content) drift.push(rel);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      wrote.push(rel);
    }
  }

  return { wrote, drift, warnings };
}
