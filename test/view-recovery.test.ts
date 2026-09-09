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
  delete process.env.FAKE_MUSE_VIEW_BAD_ANCHOR;
  delete process.env.FAKE_MUSE_RESUME_BROKEN;
  delete process.env.BB_MUSE_VIEW_ABANDON_READS;
  delete process.env.FAKE_MUSE_SESSION_STOPPED;
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

/**
 * The failure that is worse than hanging.
 *
 * A prompt Muse answers without working and a turn running on a session whose
 * view has stopped look identical from the bridge: no `turn/started` arrives
 * either way. Settling the second as a completed turn reports success for work
 * that is still going — seen here as a recovered thread that accepted a message
 * and closed the turn in the same second, having done nothing.
 */
it("does not invent a completed turn while the view is merely quiet", async () => {
  const deltas = await runTurn();

  const fabricated = deltas.filter(
    (delta) =>
      delta.kind === "turn.boundary" &&
      typeof delta.providerTurnId === "string" &&
      delta.providerTurnId.startsWith("zero-work"),
  );
  expect(fabricated).toEqual([]);

  /** It settles on what the page actually said instead. */
  const closed = deltas.filter((delta) => delta.kind === "item.close");
  expect(closed.length).toBeGreaterThan(0);
});

/**
 * Muse will hand back a session it can no longer serve a view for — the resume
 * succeeds and returns an empty view cursor. Carrying a thread on it means
 * every later turn runs unwatched, so bb declines it.
 */
it("refuses to resume a session Muse can no longer show", async () => {
  /** A session the host knows, so the resume itself succeeds. */
  const seed = `thr_${randomUUID().slice(0, 8)}`;
  harness.sendRequest(1, "initialize", {
    protocolVersion: 1,
    client: { name: "bb", version: "1" },
  });
  await harness.waitForResponse(1);
  harness.sendRequest(2, "thread/start", {
    threadId: seed,
    cwd: workspaceDir,
    instructionMode: "append",
    options: OPTIONS,
  });
  const seeded = (await harness.waitForResponse(2)) as {
    result?: { providerThreadId?: string };
  };
  const staleSession = seeded.result?.providerThreadId ?? "";
  expect(staleSession).not.toBe("");
  harness.takeMessages();

  process.env.FAKE_MUSE_UNVIEWABLE_RESUME = "1";
  harness.sendRequest(3, "thread/resume", {
    threadId: `thr_${randomUUID().slice(0, 8)}`,
    cwd: workspaceDir,
    providerThreadId: staleSession,
    instructionMode: "append",
    options: OPTIONS,
  });
  await harness.waitForResponse(3);
  await harness.flushWork();
  delete process.env.FAKE_MUSE_UNVIEWABLE_RESUME;

  const deltas = deltasFrom(harness.takeMessages());
  const warned = deltas.find(
    (delta) =>
      delta.kind === "provider.warning" &&
      String(delta.details).includes("could no longer serve a view"),
  );
  expect(warned).toBeDefined();

  /** And bb is now on a session it can watch, not the one it was handed. */
  const reset = deltas.filter((delta) => delta.kind === "session.reset");
  expect(reset.length).toBeGreaterThan(0);
});

/**
 * The regression that cost real work.
 *
 * A turn is the user's work in flight. Muse names exactly one condition as
 * unrecoverable by paging; every other way a page can fail — a rejected anchor,
 * a timeout — is bb failing to read, not Muse failing to run. Settling on those
 * trades a thread that looks stuck for one that reports a failure over work
 * still running, which is the worse of the two.
 *
 * Observed: a `git log` took four minutes, the watchdog paged from a cursor
 * minted by a session bb had abandoned, Muse refused the anchor, and the bridge
 * killed a healthy turn.
 */
it("re-reads from the start when an anchor is refused, and still recovers", async () => {
  process.env.FAKE_MUSE_VIEW_BAD_ANCHOR = "1";
  const deltas = await runTurn();
  delete process.env.FAKE_MUSE_VIEW_BAD_ANCHOR;

  /** The whole view is always a valid ask, so the turn still settles for real. */
  expect(deltas.find((delta) => delta.kind === "turn.boundary")).toMatchObject({
    status: "completed",
  });
  expect(
    deltas.filter((delta) => delta.kind === "provider.error"),
  ).toEqual([]);
});

it("leaves the turn running when no page can be read at all", async () => {
  process.env.FAKE_MUSE_VIEW_BAD_ANCHOR = "all";
  const deltas = await runTurn(3_000);
  delete process.env.FAKE_MUSE_VIEW_BAD_ANCHOR;

  const failed = deltas.filter(
    (delta) => delta.kind === "turn.boundary" && delta.status === "failed",
  );
  expect(failed).toEqual([]);

  /** It says so once, and says the turn is still Muse's to finish. */
  const warned = deltas.filter(
    (delta) =>
      delta.kind === "provider.warning" &&
      String(delta.summary).includes("could not read Muse's view"),
  );
  expect(warned).toHaveLength(1);
});

/**
 * A resume Muse refuses outright — seen as a session whose durable log it will
 * no longer replay, "durable child logical sequence is duplicate or
 * non-monotonic". Nothing clears that: the defect is on disk, so every later
 * message resumes the same broken session and is rejected the same way, and
 * the thread is unusable for good. bb's own bookkeeping is what chose to
 * resume, so bb starts a fresh session rather than handing the user a dead
 * thread.
 */
it("starts fresh when Muse refuses to reopen the session at all", async () => {
  process.env.FAKE_MUSE_RESUME_BROKEN = "1";
  harness.sendRequest(1, "initialize", {
    protocolVersion: 1,
    client: { name: "bb", version: "1" },
  });
  await harness.waitForResponse(1);
  harness.sendRequest(2, "thread/resume", {
    threadId: `thr_${randomUUID().slice(0, 8)}`,
    cwd: workspaceDir,
    providerThreadId: "01a0-broken-session",
    instructionMode: "append",
    options: OPTIONS,
  });
  const resumed = (await harness.waitForResponse(2)) as {
    error?: unknown;
    result?: { providerThreadId?: string };
  };
  await harness.flushWork();
  delete process.env.FAKE_MUSE_RESUME_BROKEN;

  /** The thread opens, on a session that is not the broken one. */
  expect(resumed.error).toBeUndefined();
  expect(resumed.result?.providerThreadId).not.toBe("01a0-broken-session");

  const deltas = deltasFrom(harness.takeMessages());
  expect(
    deltas.find(
      (delta) =>
        delta.kind === "provider.warning" &&
        String(delta.details).includes("could not reopen this session"),
    ),
  ).toBeDefined();
});

/**
 * The bounded end of a turn nothing will ever finish.
 *
 * Muse can stop mid-turn: its view projection goes unavailable, its own session
 * log stops growing, and the child stays alive holding a turn that will never
 * terminate. Left open that is the original bug; settled on a timer it is the
 * one after it, a failure reported over live work. Only repeated direct reads
 * of the session's own view, all empty, distinguish stopped from slow.
 */
it("settles a turn once repeated reads show the session has stopped", async () => {
  process.env.BB_MUSE_VIEW_ABANDON_READS = "2";
  process.env.FAKE_MUSE_SESSION_STOPPED = "1";
  const deltas = await runTurn(6_000);
  delete process.env.BB_MUSE_VIEW_ABANDON_READS;
  delete process.env.FAKE_MUSE_SESSION_STOPPED;

  const boundary = deltas.find(
    (delta) => delta.kind === "turn.boundary" && delta.status === "failed",
  );
  expect(boundary).toBeDefined();
  expect(
    deltas.find(
      (delta) =>
        delta.kind === "provider.error" &&
        (delta.errorInfo as { providerCode?: string } | undefined)
          ?.providerCode === "sessionStopped",
    ),
  ).toBeDefined();
});
