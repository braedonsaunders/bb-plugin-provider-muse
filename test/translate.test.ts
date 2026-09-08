import { describe, expect, it } from "vitest";
import { MuseTranslator, classifyMuseTool } from "../src/translate.js";

const SESSION_ID = "01a0-session";
const TURN_ID = "01a0-turn";

function translator(): MuseTranslator {
  const instance = new MuseTranslator({ cwd: "/workspace" });
  instance.onNotification("turn/started", {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    viewCursor: "cur-1",
  });
  return instance;
}

function item(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    viewCursor: "cur-2",
    item: {
      itemId: "item-1",
      status: "inProgress",
      revision: 1,
      turnId: TURN_ID,
      ...overrides,
    },
  };
}

describe("tool classification", () => {
  it("reads a shell call as a command with its output channel", () => {
    const classified = classifyMuseTool({
      tool: "muse.bash",
      toolArgs: JSON.stringify({ command: "ls -la", cwd: "/repo" }),
      cwd: "/workspace",
      result: undefined,
      exitCode: undefined,
      failed: false,
    });
    expect(classified.shape).toMatchObject({
      type: "command",
      command: "ls -la",
      cwd: "/repo",
    });
    expect(classified.outputChannel).toBe("command");
  });

  it("reads a file read and a content search", () => {
    expect(
      classifyMuseTool({
        tool: "read_file",
        toolArgs: JSON.stringify({ path: "/repo/README.md" }),
        cwd: "/workspace",
        result: undefined,
        exitCode: undefined,
        failed: false,
      }).shape,
    ).toEqual({ type: "fileRead", path: "/repo/README.md" });

    expect(
      classifyMuseTool({
        tool: "grep",
        toolArgs: JSON.stringify({ pattern: "TODO", path: "/repo" }),
        cwd: "/workspace",
        result: undefined,
        exitCode: undefined,
        failed: false,
      }).shape,
    ).toEqual({ type: "search", mode: "content", query: "TODO", path: "/repo" });
  });

  it("keeps an unknown tool generic and carries its error", () => {
    const classified = classifyMuseTool({
      tool: "muse.some_new_tool",
      toolArgs: JSON.stringify({ description: "do a thing" }),
      cwd: "/workspace",
      result: "boom",
      exitCode: undefined,
      failed: true,
    });
    expect(classified.shape).toMatchObject({
      type: "tool",
      tool: "muse.some_new_tool",
      error: "boom",
    });
  });

  it("survives argument JSON the model mangled", () => {
    const classified = classifyMuseTool({
      tool: "muse.bash",
      toolArgs: '{"command": "echo hi"',
      cwd: "/workspace",
      result: undefined,
      exitCode: undefined,
      failed: false,
    });
    expect(classified.shape).toMatchObject({ type: "command", cwd: "/workspace" });
  });
});

describe("turn lifecycle", () => {
  it("opens and settles a turn on its provider id", () => {
    const instance = new MuseTranslator({ cwd: "/workspace" });
    expect(
      instance.onNotification("turn/started", {
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        viewCursor: "cur-1",
      }),
    ).toEqual([{ kind: "turn.open", providerTurnId: TURN_ID }]);

    expect(
      instance.onNotification("turn/completed", {
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        terminal: "completed",
        viewCursor: "cur-9",
        sourceRange: {},
      }),
    ).toEqual([
      { kind: "turn.boundary", status: "completed", providerTurnId: TURN_ID },
    ]);
  });

  it("claims an idle turn when the terminal names a turn it never opened", () => {
    const instance = new MuseTranslator({ cwd: "/workspace" });
    expect(
      instance.onNotification("turn/completed", {
        sessionId: SESSION_ID,
        turnId: "unseen",
        terminal: "cancelled",
        viewCursor: "cur-9",
        sourceRange: {},
      }),
    ).toEqual([
      { kind: "turn.boundary", status: "interrupted", claimIfIdle: true },
    ]);
  });

  it("settles a reclaimed submission so its accepted input cannot hang", () => {
    const instance = translator();
    expect(
      instance.onNotification("turn/unqueued", {
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        commandId: TURN_ID,
        viewCursor: "cur-3",
        sourceRange: {},
      }),
    ).toEqual([
      { kind: "turn.boundary", status: "interrupted", providerTurnId: TURN_ID },
    ]);
  });
});

describe("streamed text", () => {
  it("streams an assistant message and closes it with the provider's final text", () => {
    const instance = translator();
    instance.onNotification(
      "item/started",
      item({ kind: "agentMessage", text: "" }),
    );

    expect(
      instance.onNotification("item/delta", {
        sessionId: SESSION_ID,
        itemId: "item-1",
        delta: "hel",
        viewCursor: "cur-3",
      }),
    ).toEqual([
      {
        kind: "item.textDelta",
        key: { providerItemId: "item-1" },
        channel: "agentMessage",
        text: "hel",
        providerTurnId: TURN_ID,
      },
    ]);

    expect(
      instance.onNotification("item/completed", {
        sessionId: SESSION_ID,
        viewCursor: "cur-4",
        item: {
          itemId: "item-1",
          kind: "agentMessage",
          status: "completed",
          revision: 2,
          turnId: TURN_ID,
          text: "hello",
        },
      }),
    ).toEqual([
      {
        kind: "item.textClose",
        key: { providerItemId: "item-1" },
        channel: "agentMessage",
        text: "hello",
        providerTurnId: TURN_ID,
      },
    ]);
  });

  it("keys each reasoning summary part on its own stream", () => {
    const instance = translator();
    instance.onNotification("item/started", item({ kind: "reasoning" }));
    const deltas = instance.onNotification("item/delta", {
      sessionId: SESSION_ID,
      itemId: "item-1",
      field: "summary.1",
      delta: "thinking",
      viewCursor: "cur-3",
    });
    expect(deltas).toEqual([
      {
        kind: "item.textDelta",
        key: { providerItemId: "item-1", channel: "summary-1" },
        channel: "reasoningSummary",
        text: "thinking",
        providerTurnId: TURN_ID,
      },
    ]);
  });

  it("drops an empty assistant message that never streamed", () => {
    const instance = translator();
    instance.onNotification("item/started", item({ kind: "agentMessage" }));
    expect(
      instance.onNotification("item/completed", {
        sessionId: SESSION_ID,
        viewCursor: "cur-4",
        item: {
          itemId: "item-1",
          kind: "agentMessage",
          status: "completed",
          revision: 2,
          turnId: TURN_ID,
          text: "   ",
        },
      }),
    ).toEqual([]);
  });
});

describe("usage", () => {
  it("accumulates session totals and reports the last completion", () => {
    const instance = translator();
    instance.onNotification("session/contextUsage", {
      sessionId: SESSION_ID,
      usedTokens: 100,
      windowTokens: 1_000_000,
      pressure: "normal",
      viewCursor: "cur-3",
      sourceRange: {},
    });
    const first = instance.onNotification("session/tokenUsage", {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      promptTokens: 100,
      totalTokens: 130,
      usage: {
        inputTokens: 100,
        outputTokens: 30,
        cachedTokens: 10,
        reasoningTokens: 5,
      },
      cumulative: { promptTokens: 100, outputTokens: 30, totalTokens: 130 },
      viewCursor: "cur-4",
      sourceRange: {},
    });
    expect(first[0]).toMatchObject({
      kind: "usage",
      modelContextWindow: 1_000_000,
      last: {
        totalTokens: 130,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 30,
        reasoningOutputTokens: 5,
      },
    });

    const second = instance.onNotification("session/tokenUsage", {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      promptTokens: 50,
      totalTokens: 60,
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        cachedTokens: 0,
        reasoningTokens: 0,
      },
      cumulative: { promptTokens: 150, outputTokens: 40, totalTokens: 190 },
      viewCursor: "cur-5",
      sourceRange: {},
    });
    expect(second[0]).toMatchObject({ total: { totalTokens: 190 } });
  });
});

describe("todo lists", () => {
  it("renders a replaced todo snapshot as a plan-steps item", () => {
    const instance = translator();
    const deltas = instance.onNotification("session/todoListChanged", {
      sessionId: SESSION_ID,
      revision: 3,
      sourceTool: "muse.todo",
      items: [
        { text: "read the code", status: "completed" },
        { text: "write the fix", status: "inProgress" },
      ],
      viewCursor: "cur-3",
      sourceRange: {},
    });
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      kind: "item.open",
      key: { providerItemId: "todo-3" },
      item: {
        type: "planSteps",
        steps: [
          { step: "read the code", status: "completed" },
          { step: "write the fix", status: "active" },
        ],
      },
    });
  });
});

describe("model catalog", () => {
  it("titles a model whose label is only its id", async () => {
    const { museModelDisplayName } = await import("../src/provider-bridge.js");
    expect(
      museModelDisplayName({
        modelId: "muse-spark-1.3-contributor",
        displayLabel: "muse-spark-1.3-contributor",
      }),
    ).toBe("Muse Spark 1.3 Contributor");
    expect(
      museModelDisplayName({
        modelId: "muse-spark-1.3",
        displayLabel: "Muse Spark 1.3 Preview",
      }),
    ).toBe("Muse Spark 1.3 Preview");
  });
});

describe("permission policy", () => {
  it("stops asking whenever bb, not the user, is the reviewer", async () => {
    const { museApprovalMode } = await import("../src/vocabulary.js");
    expect(
      museApprovalMode({
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
      }),
    ).toBe("allowAll");
    expect(
      museApprovalMode({
        permissionMode: "auto",
        permissionScope: "workspace",
        approvalReviewer: "automatic",
      }),
    ).toBe("allowAll");
    expect(
      museApprovalMode({
        permissionMode: "accept-edits",
        permissionScope: "workspace",
        approvalReviewer: "user",
      }),
    ).toBe("onRequest");
  });

  it("matches an MCP tool name back to the tool bb declared", async () => {
    const { stripMcpPrefix } = await import("../src/provider-bridge.js");
    expect(stripMcpPrefix("mcp__bb_bridge__ultragoal_state")).toBe(
      "ultragoal_state",
    );
    expect(stripMcpPrefix("mcp__bb_bridge.ultragoal_state")).toBe(
      "ultragoal_state",
    );
    expect(stripMcpPrefix("muse.bash")).toBe("muse.bash");
  });
});

describe("session instructions", () => {
  it("delivers bb's instructions ahead of the user's prompt", async () => {
    const { withInstructions } = await import("../src/provider-bridge.js");
    const parts = withInstructions(
      [{ type: "text", text: "Continue from @thread:thr_x" }],
      "You are working inside bb.",
    );
    expect(parts).toEqual([
      {
        type: "text",
        text: "<system_instructions>\nYou are working inside bb.\n</system_instructions>",
      },
      { type: "text", text: "Continue from @thread:thr_x" },
    ]);
  });

  it("leaves the prompt untouched when bb sent no instructions", async () => {
    const { withInstructions } = await import("../src/provider-bridge.js");
    const parts = [{ type: "text" as const, text: "hello" }];
    expect(withInstructions(parts, null)).toEqual(parts);
    expect(withInstructions(parts, "   ")).toEqual(parts);
  });
});

describe("handoff into a replaced session", () => {
  it("carries what was said and nothing the provider cannot replay", async () => {
    const { handoffTranscript } = await import("../src/provider-bridge.js");
    const transcript = handoffTranscript([
      { kind: "userMessage", text: "why is the copy blank?" },
      { kind: "reasoning", text: "opaque provider reasoning" },
      { kind: "toolCall", text: "" },
      { kind: "agentMessage", text: "copyAssessment posts an empty form." },
    ]);
    expect(transcript).toBe(
      "user: why is the copy blank?\n\nassistant: copyAssessment posts an empty form.",
    );
  });

  it("carries the user's own words, not the wrappers bb added", async () => {
    const { handoffTranscript } = await import("../src/provider-bridge.js");
    expect(
      handoffTranscript([
        {
          kind: "userMessage",
          text: "<system_instructions>\nbb rules\n</system_instructions>\nship it",
        },
      ]),
    ).toBe("user: ship it");
    expect(
      handoffTranscript([
        {
          kind: "userMessage",
          text: "<system_instructions>\nbb rules\n</system_instructions>\nship it",
          displayText: "ship it",
        },
      ]),
    ).toBe("user: ship it");
  });

  it("keeps the end of a conversation too long to carry whole", async () => {
    const { handoffTranscript } = await import("../src/provider-bridge.js");
    const transcript = handoffTranscript([
      { kind: "agentMessage", text: "a".repeat(20_000) },
      { kind: "userMessage", text: "and then?" },
    ]);
    expect(transcript).not.toBeNull();
    expect(transcript?.length).toBeLessThan(13_000);
    expect(transcript?.endsWith("user: and then?")).toBe(true);
  });

  it("has nothing to carry from a session that never spoke", async () => {
    const { handoffTranscript } = await import("../src/provider-bridge.js");
    expect(handoffTranscript([])).toBeNull();
    expect(handoffTranscript([{ kind: "toolCall", text: "" }])).toBeNull();
  });
});

describe("turn failure classification", () => {
  const failed = (message: string) => ({
    sessionId: "s",
    turnId: "t",
    terminal: "failed",
    error: { kind: "modelError", message, retryable: false },
  });

  it("asks for a fresh session when Muse cannot replay its own history", async () => {
    const { classifyTurnFailure } = await import("../src/recovery.js");
    const classified = classifyTurnFailure(
      failed(
        "provider-private history is incompatible with the active route: reasoning replay `rs_a:rs_b` has no provider attribution after a provider switch; start a fresh turn without opaque reasoning history",
      ),
    );
    expect(classified.restart).toMatchObject({ fresh: true });
    expect(classified.rerun).toBe(true);
    expect(classified.hint).toBeNull();
  });

  it("types an expired login and a rate limit for bb to act on", async () => {
    const { classifyTurnFailure } = await import("../src/recovery.js");
    const auth = classifyTurnFailure(failed("request failed: 401 unauthorized"));
    expect(auth.hint).toMatchObject({ kind: "authRequired" });
    /** A new session does not clear an expired login, so nothing is rerun. */
    expect(auth.rerun).toBe(false);
    expect(
      classifyTurnFailure(failed("429 rate limit reached for this account"))
        .hint,
    ).toMatchObject({ kind: "rateLimited" });
  });

  it("leaves an ordinary failure alone", async () => {
    const { classifyTurnFailure } = await import("../src/recovery.js");
    expect(classifyTurnFailure(failed("step limit exceeded"))).toEqual({
      restart: null,
      rerun: false,
      hint: null,
    });
    expect(
      classifyTurnFailure({ sessionId: "s", turnId: "t", terminal: "completed" }),
    ).toEqual({ restart: null, rerun: false, hint: null });
  });
});

describe("typed provider errors", () => {
  const failed = (message: string, kind = "modelError") => ({
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    terminal: "failed",
    viewCursor: "cur-9",
    sourceRange: {},
    error: { kind, message, retryable: false },
  });

  it("reports the failure's category ahead of the boundary that settles it", () => {
    const instance = translator();
    const deltas = instance.onNotification(
      "turn/completed",
      failed("request failed: 429 rate limit reached for this account"),
    );
    expect(deltas).toEqual([
      {
        kind: "provider.error",
        message: "Muse turn failed",
        detail: "request failed: 429 rate limit reached for this account",
        settlesTurn: false,
        willRetry: false,
        errorInfo: {
          category: "rate-limit",
          providerCode: "modelError",
          httpStatusCode: null,
        },
        category: "rate-limit",
        providerTurnId: TURN_ID,
      },
      {
        kind: "turn.boundary",
        status: "failed",
        providerTurnId: TURN_ID,
        error: {
          message: "request failed: 429 rate limit reached for this account",
        },
      },
    ]);
  });

  it("says nothing typed about a turn that did not fail", () => {
    const instance = translator();
    const deltas = instance.onNotification("turn/completed", {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      terminal: "completed",
      viewCursor: "cur-9",
      sourceRange: {},
    });
    expect(deltas).toEqual([
      { kind: "turn.boundary", status: "completed", providerTurnId: TURN_ID },
    ]);
  });
});

describe("error classification", () => {
  it("maps the conditions bb's retry policy acts on", async () => {
    const { museProviderErrorInfo } = await import("../src/error-info.js");
    const category = (message: string, kind?: string) =>
      museProviderErrorInfo(kind === undefined ? { message } : { kind, message })
        ?.category;

    expect(category("the model provider is overloaded, try again")).toBe(
      "overloaded",
    );
    expect(category("429 too many requests")).toBe("rate-limit");
    expect(category("401 unauthorized")).toBe("unauthorized");
    expect(category("payment required: 402")).toBe("billing");
    expect(category("prompt is too long for this model")).toBe(
      "context-window-exceeded",
    );
    expect(category("connection refused talking to the provider")).toBe(
      "connection-failed",
    );
    expect(category("step budget reached", "stepLimit")).toBe("max-turns");
    expect(
      category("provider-private history is incompatible", "projectionError"),
    ).toBe("internal");
  });

  it("reads a status code only where the message names one", async () => {
    const { museProviderErrorInfo } = await import("../src/error-info.js");
    expect(
      museProviderErrorInfo({ message: "http status 429 from the provider" })
        ?.httpStatusCode,
    ).toBe(429);
    /** `rs_…503…` is an id fragment, not a status. */
    expect(
      museProviderErrorInfo({
        kind: "projectionError",
        message: "reasoning replay `rs_503abc` has no provider attribution",
      })?.httpStatusCode,
    ).toBeNull();
  });

  it("stays quiet when it has nothing to add to the prose", async () => {
    const { museProviderErrorInfo } = await import("../src/error-info.js");
    expect(museProviderErrorInfo({ message: "something went wrong" })).toBeNull();
  });
});

/**
 * The grammar check the unit assertions above cannot make: bb's own assembler
 * discards an `item.*Delta` that names no turn, so a bridge can emit a
 * perfectly-shaped delta for every token and still put nothing on screen until
 * the item's terminal snapshot lands. These run the real assembler.
 */
describe("assembled stream", () => {
  async function assemble(deltas: readonly unknown[]): Promise<string[]> {
    const { experimental_createDeltaAssembler: createDeltaAssembler } =
      await import("@get-bb/plugin-sdk/provider-bridge/testing");
    const assembler = createDeltaAssembler({ providerId: "muse" });
    return assembler
      .assemble({
        threadId: "thr_assembled",
        deltas: deltas as never,
      })
      .map((event) => event.type);
  }

  it("streams an assistant message as it arrives, not only at its close", async () => {
    const instance = translator();
    const deltas: unknown[] = [
      { kind: "turn.open", providerTurnId: TURN_ID },
      ...instance.onNotification(
        "item/started",
        item({ kind: "agentMessage", text: "" }),
      ),
      ...instance.onNotification("item/delta", {
        sessionId: SESSION_ID,
        itemId: "item-1",
        delta: "hel",
        viewCursor: "cur-3",
      }),
      ...instance.onNotification("item/completed", {
        sessionId: SESSION_ID,
        viewCursor: "cur-4",
        item: {
          itemId: "item-1",
          kind: "agentMessage",
          status: "completed",
          revision: 2,
          turnId: TURN_ID,
          text: "hello",
        },
      }),
    ];

    expect(await assemble(deltas)).toContain("item/agentMessage/delta");
  });

  it("streams a command's output while it is still running", async () => {
    const instance = translator();
    const deltas: unknown[] = [
      { kind: "turn.open", providerTurnId: TURN_ID },
      ...instance.onNotification(
        "item/started",
        item({
          kind: "toolCall",
          tool: "muse.bash",
          args: JSON.stringify({ command: "ls -la" }),
        }),
      ),
      ...instance.onNotification("item/delta", {
        sessionId: SESSION_ID,
        itemId: "item-1",
        field: "output",
        delta: "total 0\n",
        viewCursor: "cur-3",
      }),
    ];

    expect(await assemble(deltas)).toContain(
      "item/commandExecution/outputDelta",
    );
  });
});
