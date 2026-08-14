import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BinDecl {
  name: string;
  entry: string;
}

export interface PackManifest {
  name: string;
  version: string;
  description: string;
  bin?: BinDecl;
  requires?: string[];
}

export interface AgentDef {
  name: string;
  description: string;
  instructions: string;
  model?: string;
  skills?: string[];
  tools?: string[];
  source: string;
}

export interface Pack {
  dir: string;
  manifest: PackManifest;
  agents: AgentDef[];
  skills: string[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Structural validation mirrors spec/schemas/*.schema.json (kept dependency-free
// on purpose; the schemas are the normative source for third parties).
export function loadPack(dirArg: string): Pack {
  const dir = resolve(dirArg);
  const manifestPath = join(dir, "pack.yaml");
  if (!existsSync(manifestPath)) throw new Error(`no pack.yaml in ${dir}`);
  const raw = Bun.YAML.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
  if (typeof raw !== "object" || raw === null) throw new Error("pack.yaml: not a mapping");

  const name = String(raw.name ?? "");
  if (!NAME_RE.test(name)) throw new Error(`pack.yaml: invalid name "${name}" (want ${NAME_RE})`);
  const version = String(raw.version ?? "");
  if (!SEMVER_RE.test(version)) throw new Error(`pack.yaml: invalid version "${version}" (want semver)`);
  const description = String(raw.description ?? "");
  if (!description) throw new Error("pack.yaml: description is required");

  let bin: BinDecl | undefined;
  if (raw.bin !== undefined) {
    const bname = String(raw.bin?.name ?? "");
    const entry = String(raw.bin?.entry ?? "");
    if (!NAME_RE.test(bname)) throw new Error(`pack.yaml: invalid bin.name "${bname}"`);
    if (!existsSync(join(dir, entry))) throw new Error(`pack.yaml: bin.entry not found: ${entry}`);
    bin = { name: bname, entry };
  }

  const requires = Array.isArray(raw.requires) ? raw.requires.map(String) : undefined;

  return { dir, manifest: { name, version, description, bin, requires }, agents: loadAgents(dir), skills: listSkills(dir) };
}

function loadAgents(dir: string): AgentDef[] {
  const agentsDir = join(dir, "agents");
  if (!existsSync(agentsDir)) return [];
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".agent.yaml")).sort();
  return files.map((f) => {
    const raw = Bun.YAML.parse(readFileSync(join(agentsDir, f), "utf8")) as Record<string, any>;
    for (const key of ["name", "description", "instructions"]) {
      if (typeof raw?.[key] !== "string" || raw[key].length === 0) {
        throw new Error(`agents/${f}: "${key}" is required and must be a non-empty string`);
      }
    }
    if (!NAME_RE.test(raw.name)) throw new Error(`agents/${f}: invalid name "${raw.name}"`);
    return {
      name: raw.name,
      description: raw.description,
      instructions: raw.instructions,
      model: raw.model !== undefined ? String(raw.model) : undefined,
      skills: Array.isArray(raw.skills) ? raw.skills.map(String) : undefined,
      tools: Array.isArray(raw.tools) ? raw.tools.map(String) : undefined,
      source: `agents/${f}`,
    };
  });
}

function listSkills(dir: string): string[] {
  const skillsDir = join(dir, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

export function parseFrontmatter(src: string): { fm: Record<string, unknown>; body: string } {
  if (!src.startsWith("---\n")) throw new Error("no frontmatter");
  const end = src.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("unterminated frontmatter");
  const fm = Bun.YAML.parse(src.slice(4, end + 1)) as Record<string, unknown>;
  return { fm, body: src.slice(end + 5) };
}
