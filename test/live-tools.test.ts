import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
  type CapturedBridgeNotification,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

/**
 * bb injects its own tools per thread; Muse reaches them through the bridge's
 * MCP proxy. This drives the real binary end to end: bb declares a tool, Muse
 * calls it, the bridge asks the runtime to run it, and the answer has to reach
 * the model.
 *
 *   BB_MUSE_LIVE=1 npx vitest run test/live-tools.test.ts
 */
const live = process.env.BB_MUSE_LIVE === "1";

const bridge = await import("../src/provider-bridge.js");

const SECRET = "BB-TOOL-OK-4271";
const TOOL_NAME = "bb_probe_secret";

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;
let dataDir: string;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-tools-ws-"));
  dataDir = mkdtempSync(join(tmpdir(), "bb-muse-tools-data-"));
  bridge.experimental_providerBridge.start?.({
    pluginId: "provider-muse",
    dataDir,
    tempDir: dataDir,
  });
  output = captureBridgeJsonRpcOutput();
});

afterAll(() => {
  output?.restore();
  bridge.experimental_providerBridge.onClose?.();
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

function send(message: Record<string, unknown>): void {
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
}

const transcript: CapturedBridgeNotification[] = [];

/**
 * Answers the bridge's own `item/tool/call` the way bb's runtime would, so the
 * proxy round trip is exercised rather than mocked.
 */
function answerToolCalls(): void {
  for (const message of transcript) {
    const record = message as { id?: unknown; method?: unknown };
    if (record.method !== "item/tool/call" || typeof record.id !== "string") {
      continue;
    }
    if (answered.has(record.id)) {
      continue;
    }
    answered.add(record.id);
    send({
      id: record.id,
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: SECRET }],
      },
    });
  }
}

const answered = new Set<string>();

async function drain(
  predicate: (messages: readonly CapturedBridgeNotification[]) => boolean,
  timeoutMs: number,
): Promise<CapturedBridgeNotification[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    transcript.push(...output.takeMessages());
    answerToolCalls();
    if (predicate(transcript)) {
      return transcript;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  transcript.push(...output.takeMessages());
  return transcript;
}

const FULL_ACCESS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  reasoningLevel: "low",
  providerOptions: {},
};

it.skipIf(!live)(
  "lets Muse call a tool bb injected",
  async () => {
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 2,
        client: { name: "bb", version: "test" },
        grammarVersions: [3, 3],
      },
    });
    send({
      id: 2,
      method: "thread/start",
      params: {
        threadId: "tools-thread",
        cwd: workspaceDir,
        instructionMode: "append",
        options: FULL_ACCESS,
        dynamicTools: [
          {
            name: TOOL_NAME,
            description:
              "Returns bb's probe secret. Call this tool when asked for the bb probe secret.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });

    const started = await drain(
      (messages) => messages.some((m) => (m as { id?: unknown }).id === 2),
      90_000,
    );
    const startResult = started.find(
      (m) => (m as { id?: unknown }).id === 2,
    ) as { result?: { providerThreadId?: string }; error?: unknown } | undefined;
    expect(startResult?.error).toBeUndefined();
    const providerThreadId = startResult?.result?.providerThreadId;

    send({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "tools-thread",
        providerThreadId,
        clientRequestId: "creq_abcdefghij",
        input: [
          {
            type: "text",
            text: `Call the ${TOOL_NAME} tool and reply with exactly the value it returns.`,
            mentions: [],
          },
        ],
        options: FULL_ACCESS,
      },
    });

    const messages = await drain((collected) => {
      const events = assembleCapturedThreadEvents(collected, "tools-thread");
      return events.some((event) => event.type === "turn/completed");
    }, 180_000);

    const toolCalls = messages.filter(
      (m) => (m as { method?: unknown }).method === "item/tool/call",
    );
    const text = JSON.stringify(
      assembleCapturedThreadEvents(messages, "tools-thread"),
    );

    expect(toolCalls.length).toBeGreaterThan(0);
    expect(text).toContain(SECRET);
  },
  300_000,
);
