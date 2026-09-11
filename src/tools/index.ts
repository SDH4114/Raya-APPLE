import type { RayaConfig } from "../config/config.js";
import type { RayaTool, ToolExecutionPolicy } from "../types/tool.js";
import { createAppControlTool } from "./app-control.js";
import { createListFilesTool, createReadFileTool, createWriteFileTool } from "./files.js";
import { createShellTool } from "./shell.js";
import { createWebTool } from "./web.js";
import { createMemoryTool } from "./memory.js";
import { createScheduleTool } from "./schedule.js";
import { createUseSkillTool } from "./skill.js";
import { createSkillAuthoringTool } from "./skill-authoring.js";
import { createSessionsTool } from "./sessions.js";

export function createDefaultTools(config: RayaConfig, policy: ToolExecutionPolicy = {}, workspace = process.cwd()): RayaTool[] {
  const tools: RayaTool[] = [createListFilesTool(workspace), createReadFileTool(workspace), createShellTool(config, policy, workspace), createWebTool(config), createMemoryTool(config.activeProfile, policy), createSessionsTool(config.activeProfile), createScheduleTool(policy), createUseSkillTool()];
  if (config.mode === "build") {
    tools.push(createWriteFileTool(policy, workspace), createAppControlTool(policy), createSkillAuthoringTool(policy));
  }
  return tools;
}
