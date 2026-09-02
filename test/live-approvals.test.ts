import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  type CapturedBridgeJsonRpcOutput,
  type CapturedBridgeNotification,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

/**
 * Full access must mean no approvals. This drives the real binary with a turn
 * that writes and reads a file — the shape that a sandboxed Muse session gates
 * even when its approval mode is `allowAll`.
 *
 *   BB_MUSE_LIVE=1 npx vitest run test/live-approvals.test.ts
 */
const live = process.env.BB_MUSE_LIVE === "1";

const { handleLine } = await import("../src/provider-bridge.js");

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-approval-"));
  output = captureBridgeJsonRpcOutput();
});

afterAll(() => {
  output?.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function send(message: Record<string, unknown>): void {
  handleLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
}

const transcript: CapturedBridgeNotification[] = [];

async function drain(
  predicate: (messages: readonly CapturedBridgeNotification[]) => boolean,
  timeoutMs: number,
): Promise<CapturedBridgeNotification[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    transcript.push(...output.takeMessages());
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
  "asks for no approvals under full access",
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
        threadId: "approval-thread",
        cwd: workspaceDir,
        instructionMode: "append",
        options: FULL_ACCESS,
      },
    });
    const started = await drain(
      (messages) => messages.some((m) => (m as { id?: unknown }).id === 2),
      60_000,
    );
    const startResult = started.find(
      (m) => (m as { id?: unknown }).id === 2,
    ) as { result?: { providerThreadId?: string } } | undefined;
    const providerThreadId = startResult?.result?.providerThreadId;
    expect(typeof providerThreadId).toBe("string");

    send({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "approval-thread",
        providerThreadId,
        clientRequestId: "creq_abcdefghij",
        input: [
          {
            type: "text",
            text: process.env.BB_MUSE_PROBE ??
              "Use the shell to write the word hello into ./probe.txt, then read the file back and tell me what it says.",
            mentions: [],
          },
        ],
        options: FULL_ACCESS,
      },
    });

    const messages = await drain(
      (collected) =>
        collected.some(
          (m) =>
            (m as { method?: string }).method === "interaction/request" ||
            JSON.stringify(m).includes('"turn.boundary"'),
        ),
      180_000,
    );

    const interactions = messages.filter(
      (m) => (m as { method?: string }).method === "interaction/request",
    );
    if (interactions.length > 0) {
      console.info(
        `approval requested under full access: ${JSON.stringify(interactions[0]).slice(0, 900)}`,
      );
    }
    expect(interactions).toEqual([]);
  },
  240_000,
);
