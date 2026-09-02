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
 * Drives the real `muse serve` binary. It needs a signed-in Muse Code install
 * and spends subscription tokens, so it only runs when asked for explicitly:
 *
 *   BB_MUSE_LIVE=1 npx vitest run test/live-msp.test.ts
 */
const live = process.env.BB_MUSE_LIVE === "1";

const { handleLine } = await import("../src/provider-bridge.js");

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-live-"));
  output = captureBridgeJsonRpcOutput();
});

afterAll(() => {
  output?.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function send(message: Record<string, unknown>): void {
  handleLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
}

/**
 * The delta assembler needs one uninterrupted stream from `session.reset`
 * onward, so every drain appends to a single transcript instead of taking a
 * fresh slice.
 */
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

it.skipIf(!live)(
  "runs a real Muse turn end to end",
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
        threadId: "live-thread",
        cwd: workspaceDir,
        instructionMode: "append",
        options: {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
          reasoningLevel: "low",
          providerOptions: {},
        },
      },
    });

    const started = await drain(
      (messages) =>
        messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { id?: unknown }).id === 2,
        ),
      60_000,
    );
    const startResult = started.find(
      (message) => (message as { id?: unknown }).id === 2,
    ) as { result?: { providerThreadId?: string }; error?: unknown } | undefined;
    expect(startResult?.error).toBeUndefined();
    const providerThreadId = startResult?.result?.providerThreadId;
    expect(typeof providerThreadId).toBe("string");
    console.info(`muse session: ${providerThreadId}`);

    send({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "live-thread",
        providerThreadId,
        clientRequestId: "creq_abcdefghij",
        input: [
          {
            type: "text",
            text: "Reply with exactly: OK. Do not use any tools.",
            mentions: [],
          },
        ],
        options: {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
          reasoningLevel: "low",
          providerOptions: {},
        },
      },
    });

    const messages = await drain((collected) => {
      const events = assembleCapturedThreadEvents(collected, "live-thread");
      return events.some((event) => event.type === "turn/completed");
    }, 180_000);

    const events = assembleCapturedThreadEvents(messages, "live-thread");
    const types = events.map((event) => event.type);
    console.info(`assembled events: ${types.join(", ")}`);
    if (types.length === 0) {
      console.info(`raw bridge output: ${JSON.stringify(messages, null, 1)}`);
    }

    expect(types).toContain("turn/started");
    expect(types).toContain("turn/completed");
    expect(types.some((type) => type.startsWith("item/"))).toBe(true);
    expect(
      events.some((event) => event.type === "thread/tokenUsage/updated"),
    ).toBe(true);

    send({
      id: 5,
      method: "turn/start",
      params: {
        threadId: "live-thread",
        providerThreadId,
        clientraeplace: null,
        clientRequestId: "creq_bcdefghijk",
        input: [
          {
            type: "text",
            text: "Run the shell command `echo bb-muse-live` and then tell me its output.",
            mentions: [],
          },
        ],
        options: {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
          reasoningLevel: "low",
          providerOptions: {},
        },
      },
    });

    const toolMessages = await drain((collected) => {
      const assembled = assembleCapturedThreadEvents(collected, "live-thread");
      return (
        assembled.filter((event) => event.type === "turn/completed").length >= 2
      );
    }, 180_000);
    const toolEvents = assembleCapturedThreadEvents(toolMessages, "live-thread");
    console.info(
      `tool turn events: ${toolEvents.map((event) => event.type).join(", ")}`,
    );
    const commandItems = toolEvents.filter(
      (event) =>
        event.type === "item/completed" &&
        (event as { item?: { type?: string } }).item?.type === "commandExecution",
    );
    expect(commandItems.length).toBeGreaterThan(0);

    send({
      id: 4,
      method: "thread/stop",
      params: {
        threadId: "live-thread",
        providerThreadId,
        intent: "release",
        activeTurnId: null,
      },
    });
    await drain(
      (collected) =>
        collected.some((message) => (message as { id?: unknown }).id === 4),
      15_000,
    );
  },
  240_000,
);
