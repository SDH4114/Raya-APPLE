import { Type } from "@earendil-works/pi-ai";
import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import { requireToolApproval, type RayaTool, type ToolExecutionPolicy } from "../types/tool.js";

const execFileAsync = promisify(execFile);
const AppParameters = Type.Object({
  action: Type.Union([Type.Literal("open"), Type.Literal("close")]),
  target: Type.String({ description: "Application name, executable, or app bundle name." })
});

export function createAppControlTool(policy: ToolExecutionPolicy = {}): RayaTool<typeof AppParameters, { action: string; target: string }> {
  return {
    name: "app_control",
    label: "App control",
    description: "Open an application or close a named application/process on macOS, Linux, or Windows.",
    parameters: AppParameters,
    executionMode: "sequential",
    async execute(_id, params) {
      if (!params.target.trim() || params.target.startsWith("-")) throw new Error("Application target must be a non-empty name.");
      await requireToolApproval(policy, `${params.action} application`, params.target);
      const hostPlatform = platform();
      if (params.action === "open") {
        if (hostPlatform === "darwin") await execFileAsync("open", ["-a", params.target]);
        else await new Promise<void>((resolve, reject) => {
          const child = spawn(params.target, [], { detached: true, stdio: "ignore" });
          child.once("error", reject);
          child.once("spawn", () => { child.unref(); resolve(); });
        });
      } else if (hostPlatform === "win32") {
        const targetName = basename(params.target);
        const imageName = targetName.toLowerCase().endsWith(".exe") ? targetName : `${targetName}.exe`;
        await execFileAsync("taskkill.exe", ["/IM", imageName, "/T", "/F"]);
      } else {
        await execFileAsync("pkill", ["-x", params.target]);
      }
      const details = { action: params.action, target: params.target };
      return { content: [{ type: "text", text: `${params.action} requested for ${params.target}` }], details };
    }
  };
}
