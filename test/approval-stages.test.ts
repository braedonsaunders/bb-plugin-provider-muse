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
 * Muse splits one shell command into argv stages and reviews each stage it
 * cannot resolve statically, so a single `bash` call can hold several
 * approvals. `approval/decide` settles one stage and reports the approval
 * non-terminal while others remain; a client that answers the first stage and
 * stops leaves Muse holding the tool call forever, with nothing on screen but
 * the approval bb already resolved.
 *
 * This suite drives the whole chain against a scripted host: one prompt to the
 * user, every stage answered, and the turn finishes.
 */
const fixtureDir = dirname(fileURLToPath(import.meta.url));

const previousExecutable = process.env.BB_MUSE_EXECUTABLE;
const previousApiKey = process.env.META_API_KEY;
const previousStages = process.env.FAKE_MUSE_APPROVAL_STAGES;
process.env.BB_MUSE_EXECUTABLE = join(fixtureDir, "fake-muse-serve.mjs");
process.env.META_API_KEY = "approval-key";
process.env.FAKE_MUSE_APPROVAL_STAGES = "3";

const { handleLine } = await import("../src/provider-bridge.js");

let harness: BridgeJsonRpcTestHarness;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-stages-"));
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(() => {
  harness.restore();
  delete process.env.FAKE_MUSE_APPROVAL_SILENT;
  delete process.env.FAKE_MUSE_APPROVAL_PROTECTED;
  rmSync(workspaceDir, { recursive: true, force: true });
});

afterAll(() => {
  restore("BB_MUSE_EXECUTABLE", previousExecutable);
  restore("META_API_KEY", previousApiKey);
  restore("FAKE_MUSE_APPROVAL_STAGES", previousStages);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/**
 * `accept-edits` is the one mode whose reviewer is the user, so it is the only
 * one where an approval reaching bb is correct. `auto` and `full` are policies
 * bb has already decided, and the suite asserts they never reach the user.
 */
const EXECUTION_OPTIONS = {
  model: "muse-spark-1.3",
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "ask",
} as const;

const AUTO_OPTIONS = {
  ...EXECUTION_OPTIONS,
  permissionMode: "auto",
  approvalReviewer: "automatic",
} as const;

/** bb's schema rejects a reviewer or an escalation on `full`: nobody reviews. */
const FULL_OPTIONS = {
  ...EXECUTION_OPTIONS,
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

interface Collected {
  deltas: Record<string, unknown>[];
  interactions: { id: string; payload: Record<string, unknown> }[];
}

function collect(
  messages: readonly BridgeJsonRpcOutputMessage[],
  into: Collected,
): void {
  for (const message of messages) {
    const envelope = message as {
      id?: unknown;
      method?: unknown;
      params?: { deltas?: unknown; payload?: unknown };
    };
    if (Array.isArray(envelope.params?.deltas)) {
      into.deltas.push(
        ...(envelope.params.deltas as Record<string, unknown>[]),
      );
    }
    if (
      envelope.method === "interaction/request" &&
      typeof envelope.id === "string"
    ) {
      into.interactions.push({
        id: envelope.id,
        payload: envelope.params?.payload as Record<string, unknown>,
      });
    }
  }
}

/** Answers every approval bb puts up, with the decision under test. */
async function drive(
  decision: string,
  done: (collected: Collected) => boolean,
  windowMs = 20_000,
): Promise<Collected> {
  const collected: Collected = { deltas: [], interactions: [] };
  const answered = new Set<string>();
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await harness.flushWork();
    await new Promise((resolve) => setTimeout(resolve, 25));
    collect(harness.takeMessages(), collected);
    for (const interaction of collected.interactions) {
      if (answered.has(interaction.id)) {
        continue;
      }
      answered.add(interaction.id);
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: interaction.id,
          result: { decision, grantedPermissions: null },
        }),
      );
    }
    if (done(collected)) {
      break;
    }
  }
  return collected;
}

type ExecutionOptions =
  | typeof EXECUTION_OPTIONS
  | typeof AUTO_OPTIONS
  | typeof FULL_OPTIONS;

async function startTurn(
  options: ExecutionOptions = EXECUTION_OPTIONS,
): Promise<void> {
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
    options,
  });
  const started = (await harness.waitForResponse(2)) as {
    result?: { providerThreadId?: string };
  };
  const providerThreadId = started.result?.providerThreadId ?? "";
  harness.takeMessages();
  harness.sendRequest(3, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_abcdefghij",
    input: [{ type: "text", text: "run the probe", mentions: [] }],
    options,
  });
}

function completedTurn(collected: Collected): boolean {
  return collected.deltas.some(
    (delta) => delta.kind === "turn.boundary" && delta.status === "completed",
  );
}

function agentText(collected: Collected): string {
  return JSON.stringify(collected.deltas);
}

it("answers every stage of one command from a single approval", async () => {
  await startTurn();
  const collected = await drive("allow_once", completedTurn);

  /** One command, one question — not one per argv fragment. */
  expect(collected.interactions).toHaveLength(1);
  expect(completedTurn(collected)).toBe(true);
  /** The fake host echoes the choice it was handed for each stage. */
  expect(agentText(collected)).toContain("allow_once,allow_once,allow_once");
  expect(
    collected.deltas.filter((delta) => delta.kind === "provider.error"),
  ).toEqual([]);
});

it("advances on the pending fold when no update notification arrives", async () => {
  process.env.FAKE_MUSE_APPROVAL_SILENT = "1";
  await startTurn();
  const collected = await drive("allow_once", completedTurn);

  expect(collected.interactions).toHaveLength(1);
  expect(completedTurn(collected)).toBe(true);
  expect(agentText(collected)).toContain("allow_once,allow_once,allow_once");
});

it("says how much of the command one answer covers", async () => {
  await startTurn();
  const collected = await drive(
    "allow_once",
    (seen) => seen.interactions.length > 0,
  );

  expect(String(collected.interactions[0]?.payload.reason)).toContain(
    "3 stages",
  );
});

it("puts an approval a resumed session is still holding back on screen", async () => {
  const sessionId = randomUUID();
  process.env.FAKE_MUSE_PENDING_APPROVAL = sessionId;
  const threadId = `thr_${randomUUID().slice(0, 8)}`;
  harness.sendRequest(1, "initialize", {
    protocolVersion: 1,
    client: { name: "bb", version: "1" },
  });
  await harness.waitForResponse(1);
  harness.sendRequest(2, "thread/resume", {
    threadId,
    cwd: workspaceDir,
    providerThreadId: sessionId,
    instructionMode: "append",
    options: EXECUTION_OPTIONS,
  });
  await harness.waitForResponse(2);

  const collected = await drive(
    "deny",
    (seen) => seen.interactions.length > 0,
    10_000,
  );
  delete process.env.FAKE_MUSE_PENDING_APPROVAL;

  expect(collected.interactions).toHaveLength(1);
  expect(JSON.stringify(collected.interactions[0]?.payload)).toContain(
    "select 1",
  );
});

it("stops at the first stage when the user refuses", async () => {
  await startTurn();
  const collected = await drive("deny", completedTurn);

  expect(collected.interactions).toHaveLength(1);
  expect(completedTurn(collected)).toBe(true);
  expect(agentText(collected)).toContain("abort");
  expect(agentText(collected)).not.toContain("allow_once");
});

/**
 * The reason this provider asked for permission where none of the others did.
 *
 * Muse escalates any shell command its grammar cannot statically canonicalise
 * — a substitution, a `${VAR}`, a pipeline, a heredoc — to a human, whatever
 * approval mode the session is in. Selecting `allowAll` is therefore only half
 * a policy; the bridge has to answer those itself, or bb's `full` ("approval
 * bypass") and `auto` ("provider-native automatic review") both degrade into a
 * prompt per command.
 */
it.each([
  ["auto", AUTO_OPTIONS],
  ["full", FULL_OPTIONS],
])("never asks the user under %s, a policy bb has already decided", async (_name, options) => {
  await startTurn(options);
  const collected = await drive("deny", completedTurn);

  expect(collected.interactions).toEqual([]);
  expect(completedTurn(collected)).toBe(true);
  /** Answered, not skipped: every stage of the command still gets a decision. */
  expect(agentText(collected)).toContain("allow_once,allow_once,allow_once");
  expect(
    collected.deltas.filter((delta) => delta.kind === "provider.error"),
  ).toEqual([]);
});

/**
 * The other axis of bb's policy. `permissionEscalation` governs only a reach
 * past the permission scope — what Muse marks with `protectedWrite` and
 * `judgeEscalated` — so `auto` still puts those to the user, and bypassing
 * them along with the rest would quietly widen the mode.
 */
it("still asks under auto when Muse flags a reach past the scope", async () => {
  process.env.FAKE_MUSE_APPROVAL_PROTECTED = "1";
  await startTurn(AUTO_OPTIONS);
  const collected = await drive("allow_once", completedTurn);

  expect(collected.interactions).toHaveLength(1);
  expect(String(collected.interactions[0]?.payload.reason)).toContain(
    "protected path",
  );
  expect(completedTurn(collected)).toBe(true);
});

it("asks nobody under full, even for a reach past the scope", async () => {
  process.env.FAKE_MUSE_APPROVAL_PROTECTED = "1";
  await startTurn(FULL_OPTIONS);
  const collected = await drive("deny", completedTurn);

  expect(collected.interactions).toEqual([]);
  expect(completedTurn(collected)).toBe(true);
});
