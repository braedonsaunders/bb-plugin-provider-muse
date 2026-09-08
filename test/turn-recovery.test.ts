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

const fixtureDir = dirname(fileURLToPath(import.meta.url));

/**
 * The session this suite resumes is poisoned the way the real failure is: its
 * opaque reasoning has no attribution on the active route, so every turn it is
 * asked to run fails. The bridge has to notice, rebuild, and rerun the prompt
 * on its own — the user is not the retry mechanism.
 */
const POISONED_SESSION_ID = randomUUID();

const previousExecutable = process.env.BB_MUSE_EXECUTABLE;
const previousApiKey = process.env.META_API_KEY;
const previousPoisoned = process.env.FAKE_MUSE_POISONED_SESSION;
process.env.BB_MUSE_EXECUTABLE = join(fixtureDir, "fake-muse-serve.mjs");
process.env.META_API_KEY = "recovery-key";
process.env.FAKE_MUSE_POISONED_SESSION = POISONED_SESSION_ID;

const { handleLine } = await import("../src/provider-bridge.js");

const PROMPT =
  '"clicking copy assessment on my phone isnt working, and it caused it to submit a blank jsa"';
const INSTRUCTIONS = "You are working inside bb.";

let harness: BridgeJsonRpcTestHarness;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-recovery-"));
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(() => {
  harness.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

afterAll(() => {
  restore("BB_MUSE_EXECUTABLE", previousExecutable);
  restore("META_API_KEY", previousApiKey);
  restore("FAKE_MUSE_POISONED_SESSION", previousPoisoned);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function deltas(messages: readonly BridgeJsonRpcOutputMessage[]): Record<
  string,
  unknown
>[] {
  const collected: Record<string, unknown>[] = [];
  for (const message of messages) {
    const params = (message as { params?: { deltas?: unknown } }).params;
    if (Array.isArray(params?.deltas)) {
      collected.push(...(params.deltas as Record<string, unknown>[]));
    }
  }
  return collected;
}

/**
 * Drains the bridge until `done`, or for ten seconds. Two `muse serve` children
 * are spawned along this path, so a fixed tick budget goes flaky the moment the
 * suite shares a machine with anything else.
 */
async function drain(
  done: (collected: readonly Record<string, unknown>[]) => boolean,
  windowMs = 20_000,
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await harness.flushWork();
    await new Promise((resolve) => setTimeout(resolve, 25));
    collected.push(...deltas(harness.takeMessages()));
    if (done(collected)) {
      break;
    }
  }
  return collected;
}

function countRerunWarnings(
  collected: readonly Record<string, unknown>[],
): number {
  return collected.filter(
    (delta) =>
      delta.kind === "provider.warning" &&
      String(delta.summary).includes("running it again"),
  ).length;
}

const EXECUTION_OPTIONS = {
  model: "muse-spark-1.3",
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} as const;

async function resumeThread(threadId: string): Promise<void> {
  harness.sendRequest(1, "initialize", {
    protocolVersion: 1,
    client: { name: "bb", version: "1" },
  });
  await harness.waitForResponse(1);
  harness.sendRequest(2, "thread/resume", {
    threadId,
    cwd: workspaceDir,
    providerThreadId: POISONED_SESSION_ID,
    instructionMode: "append",
    options: { ...EXECUTION_OPTIONS, instructions: INSTRUCTIONS },
  });
  await harness.waitForResponse(2);
  harness.takeMessages();
}

it("reruns the prompt when Muse refuses the session's reasoning history", async () => {
  const threadId = `thr_${randomUUID().slice(0, 8)}`;
  await resumeThread(threadId);

  harness.sendRequest(3, "turn/start", {
    threadId,
    providerThreadId: POISONED_SESSION_ID,
    clientRequestId: "creq_2345678abc",
    input: [{ type: "text", text: PROMPT }],
    options: EXECUTION_OPTIONS,
  });
  await harness.waitForResponse(3);

  const collected = await drain((seen) =>
    seen.some((delta) => JSON.stringify(delta).includes("muse echo:")),
  );

  expect(countRerunWarnings(collected)).toBe(1);

  /**
   * The failure reaches bb typed, not just described: core's `turn.failed`
   * carries this category, and bb's retry policy is written against it.
   */
  const typed = collected.filter(
    (delta) => delta.kind === "provider.error" && delta.errorInfo !== undefined,
  );
  expect(typed.length).toBeGreaterThanOrEqual(1);
  expect(typed[0].errorInfo).toEqual({
    category: "internal",
    providerCode: "projectionError",
    httpStatusCode: null,
  });

  /** The prompt reaches the replacement session, not the void. */
  const echoed = collected
    .map((delta) => JSON.stringify(delta))
    .filter((text) => text.includes("muse echo:"))
    .join("\n");
  expect(echoed).toContain(PROMPT.slice(1, 40));

  /** The replacement is told what the discarded session had already said. */
  expect(echoed).toContain("session_handoff");
  expect(echoed).toContain("copyAssessment posts an empty form on mobile.");
  expect(echoed).not.toContain("opaque reasoning that must never travel");

  /** A fresh session has never seen bb's instructions, so they ride again. */
  expect(echoed).toContain(INSTRUCTIONS);

  /** Accepted exactly once: the rerun is bb's, not a second client request. */
  const accepted = collected.filter((delta) => delta.kind === "input.accepted");
  expect(accepted).toHaveLength(1);
}, 45_000);

it("gives up after one rerun rather than looping on a prompt", async () => {
  /** Every session the thread can reach is poisoned, so the rerun fails too. */
  process.env.FAKE_MUSE_POISON_ALL = "1";
  try {
    const threadId = `thr_${randomUUID().slice(0, 8)}`;
    await resumeThread(threadId);

    harness.sendRequest(3, "turn/start", {
      threadId,
      providerThreadId: POISONED_SESSION_ID,
      clientRequestId: "creq_bcdefghjkm",
      input: [{ type: "text", text: "second opinion" }],
      options: EXECUTION_OPTIONS,
    });
    await harness.waitForResponse(3);

    const failed = (collected: readonly Record<string, unknown>[]): number =>
      collected.filter(
        (delta) =>
          delta.kind === "turn.boundary" && String(delta.status) === "failed",
      ).length;

    /** Both the original turn and its one rerun settle as failures. */
    const collected = await drain((seen) => failed(seen) >= 2);
    expect(failed(collected)).toBeGreaterThanOrEqual(2);

    /** And nothing reruns the rerun. */
    const after = await drain(() => false, 1_500);
    expect(countRerunWarnings([...collected, ...after])).toBe(1);
  } finally {
    delete process.env.FAKE_MUSE_POISON_ALL;
  }
}, 45_000);
