import type { DeltaPresentation } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const MUSE_PLUGIN_ID = "provider-muse";
export const MUSE_PROVIDER_ID = "muse";

export const MUSE_EXECUTABLE_ENV = "BB_MUSE_EXECUTABLE";
export const MUSE_HOME_ENV = "MUSE_HOME";

export const MUSE_DEFAULT_EXECUTABLE = "muse";
export const MUSE_INSTALL_SCRIPT_URL = "https://dev.meta.ai/install.sh";
export const MUSE_INSTALL_COMMAND = `curl -fsSL ${MUSE_INSTALL_SCRIPT_URL} | bash`;
export const MUSE_LOGIN_COMMAND = "muse login";
export const MUSE_INSTALL_URL =
  "https://developer.meta.com/ai/products/muse-code/";

export const MUSE_MINIMUM_SUPPORTED_VERSION = "1.0.0";

export const MUSE_WORKFLOW_EXTENSION_NAME = "workflow";
export const MUSE_SESSION_EXTENSION_NAME = "session";
export const MUSE_WORKFLOW_EXTENSION_KIND = `${MUSE_PLUGIN_ID}/${MUSE_WORKFLOW_EXTENSION_NAME}`;
export const MUSE_SESSION_EXTENSION_KIND = `${MUSE_PLUGIN_ID}/${MUSE_SESSION_EXTENSION_NAME}`;

export const MUSE_ICON_GLYPH = `${MUSE_PLUGIN_ID}/muse`;
export const MUSE_WORKFLOW_ICON_GLYPH = `${MUSE_PLUGIN_ID}/workflow`;

/**
 * Meta rate-limits Muse subscriptions on a rolling window and publishes no
 * usage endpoint, so the plugin measures that window itself from Muse's own
 * durable session logs.
 */
export const MUSE_USAGE_WINDOW_HOURS = 5;

export const museProviderOptionsSchema = z.object({
  trustWorkspace: z.boolean().optional(),
  disableSandbox: z.boolean().optional(),
  sandboxNetwork: z.enum(["proxy-only", "off", "on"]).optional(),
  tokenBudget: z.number().int().positive().nullable().optional(),
  planLabel: z.string().min(1).nullable().optional(),
});
export type MuseProviderOptions = z.infer<typeof museProviderOptionsSchema>;

/**
 * bb states a permission policy, not an approval prompt count. `full` is full
 * access, and `auto` names bb — not the user — as the reviewer; in both, a
 * prompt per command is the provider failing to honour the policy. Only
 * `accept-edits`, where the reviewer is the user, leaves Muse asking.
 *
 * Muse's sandbox is a separate constraint from its approval mode, so a
 * workspace-scoped session keeps the sandbox that bb's scope implies while
 * Muse stops asking.
 */
export function museApprovalMode(policy: {
  permissionMode: string;
  permissionScope?: string;
  approvalReviewer?: string | null;
}): "allowAll" | "onRequest" {
  if (policy.permissionScope === "full" || policy.permissionMode === "full") {
    return "allowAll";
  }
  if (
    policy.approvalReviewer === "automatic" ||
    policy.permissionMode === "auto"
  ) {
    return "allowAll";
  }
  return "onRequest";
}

/**
 * Muse Code offers four efforts — low, medium, high, x-high — and defaults to
 * high. MSP's wire enum is wider than the product's picker, so BB levels above
 * x-high land on x-high rather than selecting a tier the user cannot pick, and
 * `none` takes the lowest offered tier.
 */
export const MUSE_REASONING_EFFORTS = {
  none: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
  ultra: "xhigh",
  ultracode: "xhigh",
} as const;

export const MUSE_REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export const MUSE_DEFAULT_REASONING_LEVEL = "high";

const museWorkflowChildSchema = z.object({
  childId: z.string(),
  attempt: z.number(),
  label: z.string().nullable(),
  phase: z.string().nullable(),
  status: z.string(),
  terminal: z.string().nullable(),
});

export const museWorkflowItemSchema = z.object({
  entryId: z.string().nullable(),
  scriptId: z.string().nullable(),
  message: z.string().nullable(),
  triggerSource: z.string().nullable(),
  children: z.array(museWorkflowChildSchema),
});
export type MuseWorkflowItem = z.infer<typeof museWorkflowItemSchema>;

export const museSessionStateSchema = z.object({
  approvalMode: z.string().nullable(),
  modelId: z.string().nullable(),
  museHome: z.string().nullable(),
  serverVersion: z.string().nullable(),
  sessionLogPath: z.string().nullable(),
});
export type MuseSessionState = z.infer<typeof museSessionStateSchema>;

export const museExtensionKinds = {
  [MUSE_WORKFLOW_EXTENSION_NAME]: { item: museWorkflowItemSchema },
  [MUSE_SESSION_EXTENSION_NAME]: { state: museSessionStateSchema },
} as const;

export function workflowPresentation(label: string): DeltaPresentation {
  return {
    label: { pending: "Running workflow", completed: "Workflow" },
    icon: { glyph: MUSE_WORKFLOW_ICON_GLYPH },
    title: label,
  };
}

export function subagentPresentation(objective: string): DeltaPresentation {
  return {
    label: { pending: "Delegating", completed: "Delegated" },
    icon: { glyph: "Users" },
    title: objective,
  };
}
