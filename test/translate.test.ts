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
    process.env.BB_MUSE_EXECUTABLE = "/nonexistent/muse";
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
    process.env.BB_MUSE_EXECUTABLE = "/nonexistent/muse";
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
