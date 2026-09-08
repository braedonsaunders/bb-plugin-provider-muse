import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcOutputMessage,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

/**
 * Muse's live view can stop while the session keeps running: its materialized
 * projection is marked unavailable, push delivery goes silent, and the turn's
 * own `turn/completed` never reaches bb. Observed on this host as a thread that
 * read as working for two hours after Muse's session log recorded the turn
 * completed.
 *
 * `view/page` serves the view from the source rather than that projection, so
 * it still answers. These drive a host whose push dies mid-turn and assert the
 * turn still settles — and, where the page cannot be served either, that it
 * settles as a typed failure rather than staying open forever.
 */
const fixtureDir = dirname(fileURLToPath(import.meta.url));

const previousExecutable = process.env.BB_MUSE_EXECUTABLE;
const previousApiKey = process.env.META_API_KEY;
process.env.BB_MUSE_EXECUTABLE = join(fixtureDir, "fake-muse-serve.mjs");
process.env.META_API_KEY = "view-recovery-key";
/** Push stops after the first view event, which is `turn/started`. */
process.env.FAKE_MUSE_VIEW_DEAD_AFTER = "1";
/** The watchdog's own clock, shortened so the suite does not wait it out. */
process.env.BB_MUSE_VIEW_STALL_MS = "150";
process.env.BB_MUSE_VIEW_WATCHDOG_TICK_MS = "50";

const { handleLine } = await import("../src/provider-bridge.js");

let harness: BridgeJsonRpcTestHarness;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-view-"));
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(() => {
  harness.restore();
  delete process.env.FAKE_MUSE_VIEW_UNREADABLE;
  rmSync(workspaceDir, { recursive: true, force: true });
});

afterAll(() => {
  restore("BB_MUSE_EXECUTABLE", previousExecutable);
  restore("META_API_KEY", previousApiKey);
  delete process.env.FAKE_MUSE_VIEW_DEAD_AFTER;
  delete process.env.BB_MUSE_VIEW_STALL_MS;
  delete process.env.BB_MUSE_VIEW_WATCHDOG_TICK_MS;
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const OPTIONS = {
  model: "muse-spark-1.3",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

function deltasFrom(
  messages: readonly BridgeJsonRpcOutputMessage[],
): Record<string, unknown>[] {
  const deltas: Record<string, unknown>[] = [];
  for (const message of messages) {
    const params = (message as { params?: { deltas?: unknown } }).params;
    if (Array.isArray(params?.deltas)) {
      deltas.push(...(params.deltas as Record<string, unknown>[]));
    }
  }
  return deltas;
}

async function runTurn(windowMs = 8_000): Promise<Record<string, unknown>[]> {
  const threadId = `thr_${randomUUID().slice(0, 8)}`;
  harness.sendRequest(1, "initialize", {
    protocolVersion: 1,
    client: { name: "bb", version: "1" },
  });
  await harness.waitForResponse(1);
  harness.sendRequest(2, "thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: OPTIONS,
  });
  const started = (await harness.waitForResponse(2)) as {
    result?: { providerThreadId?: string };
  };
  const collected: Record<string, unknown>[] = [];
  collected.push(...deltasFrom(harness.takeMessages()));
  harness.sendRequest(3, "turn/start", {
    threadId,
    providerThreadId: started.result?.providerThreadId ?? "",
    clientRequestId: "creq_abcdefghij",
    input: [{ type: "text", text: "run the probe", mentions: [] }],
    options: OPTIONS,
  });

  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await harness.flushWork();
    await new Promise((resolve) => setTimeout(resolve, 25));
    collected.push(...deltasFrom(harness.takeMessages()));
    if (collected.some((delta) => delta.kind === "turn.boundary")) {
      break;
    }
  }
  return collected;
}

it("reads the view back when Muse stops streaming mid-turn", async () => {
  const deltas = await runTurn();

  const boundary = deltas.find((delta) => delta.kind === "turn.boundary");
  expect(boundary).toMatchObject({ status: "completed" });

  /** The rows push never delivered are on the timeline, not just the terminal. */
  const closed = deltas.filter((delta) => delta.kind === "item.close");
  expect(closed.length).toBeGreaterThan(0);

  /** And the user is told the stream dropped, once. */
  const warnings = deltas.filter(
    (delta) =>
      delta.kind === "provider.warning" &&
      String(delta.summary).includes("stopped streaming"),
  );
  expect(warnings).toHaveLength(1);
});

it("settles the turn as a typed failure when the view cannot be read either", async () => {
  process.env.FAKE_MUSE_VIEW_UNREADABLE = "1";
  const deltas = await runTurn();

  const boundary = deltas.find((delta) => delta.kind === "turn.boundary");
  expect(boundary).toMatchObject({ status: "failed" });

  const error = deltas.find(
    (delta) =>
      delta.kind === "provider.error" &&
      (delta.errorInfo as { providerCode?: string } | undefined)
        ?.providerCode === "viewUnreadable",
  );
  expect(error).toBeDefined();
});
