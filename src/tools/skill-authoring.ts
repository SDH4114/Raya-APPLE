import { Type } from "@earendil-works/pi-ai";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RAYA_SKILLS_DIR } from "../config/paths.js";
import { writePrivateFileAtomic } from "../storage/atomic-file.js";
import { requireToolApproval, type RayaTool, type ToolExecutionPolicy } from "../types/tool.js";

const Reference = Type.Object({
  filename: Type.String({ description: "Plain Markdown filename such as workflow.md." }),
  content: Type.String({ description: "Complete reference content." })
});

const Parameters = Type.Object({
  name: Type.String({ description: "Lowercase hyphenated skill name." }),
  description: Type.String({ description: "What the skill does and concrete situations that should activate it." }),
  instructions: Type.String({ description: "Concise Markdown instructions for the SKILL.md body, without YAML frontmatter." }),
  references: Type.Optional(Type.Array(Reference, { description: "Optional supporting Markdown references." })),
  overwrite: Type.Optional(Type.Boolean({ description: "Replace the existing SKILL.md. Use only when the user requested this update." }))
});

function validateName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error("Skill name must be 1-64 lowercase letters, digits, and hyphens.");
  }
}

function validateReference(filename: string): void {
  if (!/^[a-z0-9][a-z0-9.-]*\.md$/.test(filename) || filename.includes("..")) {
    throw new Error(`Invalid reference filename: ${filename}`);
  }
}

export function createSkillAuthoringTool(policy: ToolExecutionPolicy = {}): RayaTool<typeof Parameters, { name: string; path: string; references: string[]; updated: boolean }> {
  return {
    name: "create_skill",
    label: "Create skill",
    description: "Create or deliberately update a persistent Raya skill. Available only in Build mode and subject to the configured approval policy.",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      validateName(params.name);
      const description = params.description.trim();
      const instructions = params.instructions.trim();
      if (!description || description.length > 1_024) throw new Error("Skill description must be 1-1024 characters.");
      if (!instructions || instructions.length > 24_000) throw new Error("Skill instructions must be 1-24000 characters.");

      const references = params.references ?? [];
      const names = new Set<string>();
      for (const reference of references) {
        validateReference(reference.filename);
        if (names.has(reference.filename)) throw new Error(`Duplicate reference: ${reference.filename}`);
        if (!reference.content.trim() || reference.content.length > 64_000) throw new Error(`Reference ${reference.filename} must be 1-64000 characters.`);
        names.add(reference.filename);
      }

      mkdirSync(RAYA_SKILLS_DIR, { recursive: true, mode: 0o700 });
      if (lstatSync(RAYA_SKILLS_DIR).isSymbolicLink()) throw new Error("Raya skills directory cannot be a symbolic link.");
      const directory = join(RAYA_SKILLS_DIR, params.name);
      const skillPath = join(directory, "SKILL.md");
      const referenceDirectory = join(directory, "references");
      const updated = existsSync(skillPath);
      if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error("Skill directory cannot be a symbolic link.");
      if (existsSync(referenceDirectory) && lstatSync(referenceDirectory).isSymbolicLink()) throw new Error("Skill references directory cannot be a symbolic link.");
      if (updated && !params.overwrite) throw new Error(`Skill already exists: ${params.name}. Set overwrite only after the user requests an update.`);

      await requireToolApproval(policy, updated ? "update Raya skill" : "create Raya skill", params.name);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const referenceList = references.length
        ? `\n\n## References\n\n${references.map((reference) => `- Read [${reference.filename}](references/${reference.filename}) when its detailed guidance is needed.`).join("\n")}`
        : "";
      const skill = `---\nname: ${params.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}${referenceList}\n`;
      writePrivateFileAtomic(skillPath, skill);

      if (references.length) {
        mkdirSync(referenceDirectory, { recursive: true, mode: 0o700 });
        for (const reference of references) {
          writePrivateFileAtomic(join(referenceDirectory, reference.filename), `${reference.content.trim()}\n`);
        }
      }

      return {
        content: [{ type: "text", text: `${updated ? "Updated" : "Created"} skill ${params.name} at ${skillPath}. It is available immediately through use_skill.` }],
        details: { name: params.name, path: skillPath, references: [...names], updated }
      };
    }
  };
}
