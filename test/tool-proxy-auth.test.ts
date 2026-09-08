import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

/**
 * Marketplace review required the loopback proxy to bind each token to one
 * thread and that thread's allowed tools. This suite starts a real attachment
 * so `runInjectedTool` is exercised, not only the socket's first check.
 */

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const previousExecutable = process.env.BB_MUSE_EXECUTABLE;
const previousApiKey = process.env.META_API_KEY;
process.env.BB_MUSE_EXECUTABLE = join(fixtureDir, "fake-muse-serve.mjs");
process.env.META_API_KEY = "proxy-auth-key";

const { experimental_providerBridge, handleLine, runInjectedTool } = await import(
  "../src/provider-bridge.js"
);

let harness: BridgeJsonRpcTestHarness;
let workspaceDir: string;
let dataDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-proxy-auth-"));
  dataDir = mkdtempSync(join(tmpdir(), "bb-muse-proxy-data-"));
  experimental_providerBridge.start?.({
    pluginId: "provider-muse",
    dataDir,
    tempDir: dataDir,
  });
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(() => {
  harness.restore();
  experimental_providerBridge.onClose?.();
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  if (previousExecutable === undefined) {
    delete process.env.BB_MUSE_EXECUTABLE;
  } else {
    process.env.BB_MUSE_EXECUTABLE = previousExecutable;
  }
  if (previousApiKey === undefined) {
    delete process.env.META_API_KEY;
  } else {
    process.env.META_API_KEY = previousApiKey;
  }
});

const EXECUTION_OPTIONS = {
  model: "muse-spark-1.3",
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} as const;

function readIssuedProxy(threadId: string): {
  port: number;
  token: string;
  threadId: string;
  tools: string[];
} {
  const root = join(dataDir, "threads", threadId.replace(/[^A-Za-z0-9_-]/gu, "_"));
  const serials = readdirSync(root);
  const settings = JSON.parse(
    readFileSync(join(root, serials[0], "xdg", "muse", "settings.json"), "utf8"),
  ) as {
    mcpServers: {
      "bb-bridge": { env: Record<string, string> };
    };
  };
  const env = settings.mcpServers["bb-bridge"].env;
  return {
    port: Number(env.BB_MUSE_TOOL_PORT),
    token: env.BB_MUSE_TOOL_TOKEN,
    threadId: env.BB_MUSE_TOOL_THREAD_ID,
    tools: (JSON.parse(env.BB_MUSE_TOOLS) as { name: string }[]).map(
      (tool) => tool.name,
    ),
  };
}

async function startThread(args: {
  threadId: string;
  tools: readonly string[];
}): Promise<void> {
  harness.sendRequest(1, "initialize", {
    protocolVersion: 1,
    client: { name: "bb", version: "1" },
  });
  await harness.waitForResponse(1);
  harness.sendRequest(2, "thread/start", {
    threadId: args.threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: EXECUTION_OPTIONS,
    dynamicTools: args.tools.map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    })),
  });
  const started = (await harness.waitForResponse(2)) as { error?: unknown };
  expect(started.error).toBeUndefined();
}

it("rejects runInjectedTool when the token's thread or tool does not match", async () => {
  await startThread({ threadId: "thr_bound", tools: ["bb_probe"] });
  const issued = readIssuedProxy("thr_bound");
  expect(issued.threadId).toBe("thr_bound");
  expect(issued.tools).toEqual(["bb_probe"]);

  const mismatchedThread = await runInjectedTool({
    threadId: "thr_other",
    token: issued.token,
    tool: "bb_probe",
    callId: "call-1",
    arguments: {},
  });
  expect(mismatchedThread).toEqual({
    ok: false,
    error: "rejected tool proxy request",
  });

  const undeclaredTool = await runInjectedTool({
    threadId: "thr_bound",
    token: issued.token,
    tool: "bb_secret_store",
    callId: "call-2",
    arguments: {},
  });
  expect(undeclaredTool).toEqual({
    ok: false,
    error: "rejected tool proxy request",
  });

  const unknownToken = await runInjectedTool({
    threadId: "thr_bound",
    token: "not-the-issued-token",
    tool: "bb_probe",
    callId: "call-3",
    arguments: {},
  });
  expect(unknownToken).toEqual({
    ok: false,
    error: "rejected tool proxy request",
  });
});

it("does not let one thread's token call another thread's allowed tool", async () => {
  await startThread({ threadId: "thr_a", tools: ["bb_probe"] });
  harness.sendRequest(3, "thread/start", {
    threadId: "thr_b",
    cwd: workspaceDir,
    instructionMode: "append",
    options: EXECUTION_OPTIONS,
    dynamicTools: [
      {
        name: "bb_other",
        description: "bb_other",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  const startedB = (await harness.waitForResponse(3)) as { error?: unknown };
  expect(startedB.error).toBeUndefined();

  const tokenA = readIssuedProxy("thr_a").token;
  const cross = await runInjectedTool({
    threadId: "thr_b",
    token: tokenA,
    tool: "bb_other",
    callId: "call-x",
    arguments: {},
  });
  expect(cross).toEqual({
    ok: false,
    error: "rejected tool proxy request",
  });
});
