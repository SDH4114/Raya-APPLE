import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "@earendil-works/pi-ai";

export type RayaTool<TParameters extends TSchema = TSchema, TDetails = unknown> =
  AgentTool<TParameters, TDetails>;

export type RayaToolResult<TDetails = unknown> = AgentToolResult<TDetails>;

export type RayaToolInput<TParameters extends TSchema> = Static<TParameters>;

/** A deliberately small extension point for local or remote execution policies. */
export type ToolExecutionPolicy = {
  confirmDangerousAction?: (action: string, details: string) => Promise<void>;
  /** Explicit opt-out used only by the user-selected Full access mode. */
  allowWithoutApproval?: boolean;
};

export async function requireToolApproval(policy: ToolExecutionPolicy, action: string, details: string): Promise<void> {
  if (policy.allowWithoutApproval) return;
  if (!policy.confirmDangerousAction) {
    throw new Error(`Approval is required to ${action}, but no approval handler is available.`);
  }
  await policy.confirmDangerousAction(action, details);
}
