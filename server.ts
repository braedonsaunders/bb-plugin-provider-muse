import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  MUSE_ICON_GLYPH,
  MUSE_REASONING_LEVELS,
  MUSE_INSTALL_URL,
  MUSE_LOGIN_COMMAND,
  MUSE_PROVIDER_ID,
  MUSE_USAGE_WINDOW_HOURS,
  museExtensionKinds,
  type MuseProviderOptions,
} from "./src/vocabulary.js";

/**
 * Settings values arrive as strings, and a budget is easier to paste as
 * "12_000_000" or "12000000" than to retype exactly, so separators are ignored.
 */
export function parseTokenBudget(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const digits = value.replace(/[\s_,]/gu, "");
  if (!/^\d+$/u.test(digits)) {
    return null;
  }
  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    windowTokenBudget: {
      type: "string",
      label: `Rolling ${MUSE_USAGE_WINDOW_HOURS}-hour token budget`,
      description:
        "Tokens your Muse plan allows per rolling window. Meta publishes no usage endpoint for Muse subscriptions, so BB measures the window from Muse's own session logs and needs this number for the denominator. Leave empty to show the account without a meter.",
      default: "",
    },
    planLabel: {
      type: "string",
      label: "Plan label",
      description:
        "How your Muse subscription is shown in usage surfaces, for example \"High usage\".",
      default: "",
    },
    trustWorkspace: {
      type: "boolean",
      label: "Load workspace skills and rules",
      description:
        "Start Muse sessions with the workspace trusted so its AGENTS.md, skills, and rules load.",
      default: true,
    },
    disableSandbox: {
      type: "boolean",
      label: "Disable Muse's own sandbox",
      description:
        "Muse sandboxes shell filesystem and network access by default. Turning this off hands sandboxing entirely to BB's own permission modes.",
      default: false,
    },
    sandboxNetwork: {
      type: "select",
      label: "Sandbox network",
      description:
        "Network posture for sandboxed Muse shell commands. Fixed for the lifetime of a Muse host process.",
      options: ["proxy-only", "on", "off"],
      default: "proxy-only",
    },
  });

  bb.providers.register({
    id: MUSE_PROVIDER_ID,
    displayName: "Muse Code",
    icon: MUSE_ICON_GLYPH,
    family: "muse",
    strings: {
      signInHint: `Run \`${MUSE_LOGIN_COMMAND}\` on the machine to sign in.`,
      expiredHint: `Your Muse Code session expired. Run \`${MUSE_LOGIN_COMMAND}\`, then reload.`,
      installUrl: MUSE_INSTALL_URL,
      brandPrefix: "Muse ",
      iconTint: { light: "#1d4ed8", dark: "#93c5fd" },
    },
    experimental_visibility: "installed",
    models: { scope: "host" },
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "tip",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: [...MUSE_REASONING_LEVELS],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High", description: "Muse Code's own default." },
      { id: "xhigh", label: "X-High", description: "Muse's deepest reasoning." },
    ],
    composerActions: [],
    env: { passthrough: ["BB_MUSE_EXECUTABLE", "MUSE_HOME", "META_API_KEY"] },
    extensionKinds: museExtensionKinds,
    deriveProviderOptions(context): MuseProviderOptions {
      return {
        trustWorkspace: context.settings.trustWorkspace !== false,
        disableSandbox: context.settings.disableSandbox === true,
        sandboxNetwork:
          context.settings.sandboxNetwork === "on"
            ? "on"
            : context.settings.sandboxNetwork === "off"
              ? "off"
              : "proxy-only",
        tokenBudget: parseTokenBudget(context.settings.windowTokenBudget),
        planLabel: nonEmptyStringOrNull(context.settings.planLabel),
      };
    },
  });
}
