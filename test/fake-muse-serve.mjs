#!/usr/bin/env node
/**
 * A scripted MSP host: enough of `muse serve` for the bridge's conformance and
 * translation suites to run without Meta's binary or a network call. It speaks
 * the same wire shapes the real host does — session/turn/item notifications with
 * view cursors — and answers the same command plane.
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const sessions = new Map();
let cursor = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function nextCursor() {
  cursor += 1;
  return `cur-${String(cursor).padStart(6, "0")}`;
}

function sourceRange(sessionId) {
  const position = { id: randomUUID(), sequence: cursor };
  return {
    first: position,
    last: position,
    stream: { kind: "session", id: sessionId },
  };
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function viewNotify(sessionId, method, params) {
  notify(method, {
    sessionId,
    viewCursor: nextCursor(),
    sourceRange: sourceRange(sessionId),
    ...params,
  });
}

function session(sessionId, extra = {}) {
  return {
    sessionId,
    activeTurnId: null,
    approvalMode: { mode: "onRequest", source: "startup", lastCommandId: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    forkedFrom: null,
    modelId: "muse-spark-1.3",
    providerId: "meta",
    path: `/tmp/fake-muse/${sessionId}/session.jsonl`,
    status: "idle",
    turnCount: 0,
    workspaceRoot: "/tmp/fake-muse",
    ...extra,
  };
}

function runTurn(sessionId, turnId, promptText) {
  viewNotify(sessionId, "turn/started", { turnId, commandId: turnId });

  const toolItemId = `${turnId}-tool`;
  viewNotify(sessionId, "item/started", {
    item: {
      itemId: toolItemId,
      kind: "toolCall",
      status: "inProgress",
      revision: 1,
      turnId,
      tool: "muse.bash",
      args: JSON.stringify({ command: "echo hello" }),
      callId: "call_1",
    },
  });
  notify("item/delta", {
    sessionId,
    viewCursor: nextCursor(),
    itemId: toolItemId,
    field: "output",
    delta: "hello\n",
  });
  viewNotify(sessionId, "item/completed", {
    item: {
      itemId: toolItemId,
      kind: "toolCall",
      status: "completed",
      revision: 2,
      turnId,
      tool: "muse.bash",
      args: JSON.stringify({ command: "echo hello" }),
      callId: "call_1",
      visibleOutput: "hello\n",
      exitCode: 0,
    },
  });

  const messageItemId = `${turnId}-message`;
  const reply = `muse echo: ${promptText}`;
  viewNotify(sessionId, "item/started", {
    item: {
      itemId: messageItemId,
      kind: "agentMessage",
      status: "inProgress",
      revision: 1,
      turnId,
      text: "",
    },
  });
  notify("item/delta", {
    sessionId,
    viewCursor: nextCursor(),
    itemId: messageItemId,
    delta: reply,
  });
  viewNotify(sessionId, "item/completed", {
    item: {
      itemId: messageItemId,
      kind: "agentMessage",
      status: "completed",
      revision: 2,
      turnId,
      text: reply,
    },
  });

  viewNotify(sessionId, "session/tokenUsage", {
    turnId,
    promptTokens: 120,
    totalTokens: 140,
    modelId: "muse-spark-1.3",
    usage: {
      inputTokens: 120,
      outputTokens: 20,
      cachedTokens: 0,
      reasoningTokens: 4,
    },
    cumulative: { promptTokens: 120, outputTokens: 20, totalTokens: 140 },
  });
  viewNotify(sessionId, "session/contextUsage", {
    usedTokens: 140,
    windowTokens: 1_048_576,
    pressure: "normal",
  });
  viewNotify(sessionId, "turn/completed", {
    turnId,
    terminal: "completed",
    usage: {
      inputTokens: 120,
      outputTokens: 20,
      cachedTokens: 0,
      reasoningTokens: 4,
    },
  });
}

function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  const fail = (code, text, data) =>
    send({
      jsonrpc: "2.0",
      id,
      error: { code, message: text, ...(data === undefined ? {} : { data }) },
    });

  switch (method) {
    case "initialize":
      reply({
        experimentalApi: false,
        grantedCapabilities: ["userShell"],
        museHome: "/tmp/fake-muse",
        platformFamily: "unix",
        platformOs: "linux",
        schema: { version: 1, fingerprint: "sha256:fake" },
        serverInfo: { name: "muse", version: "1.0.2" },
        sessionDurability: "durable",
        userAgent: "fake-muse/1.0.2",
      });
      return;

    case "model/list":
      reply({
        models: [
          {
            modelId: "muse-spark-1.3",
            displayLabel: "Muse Spark 1.3",
            description: "Agentic coding model.",
            contextLimit: 1_048_576,
            outputLimit: 131_072,
            cost: {
              input: "1.25",
              output: "4.25",
              cached: "0.15",
              currency: "USD",
            },
            providerId: "meta",
            profileId: null,
            releaseDate: "2026-08-20",
            isDefault: true,
            isActive: false,
          },
        ],
        providerId: "meta",
        profileId: null,
        source: "providerCatalog",
      });
      return;

    case "session/start": {
      const sessionId = params?.sessionId ?? randomUUID();
      sessions.set(sessionId, { turns: 0 });
      reply({ session: session(sessionId), viewCursor: nextCursor() });
      return;
    }

    case "session/resume":
    case "session/fork": {
      const source = params?.sessionId;
      if (method === "session/resume" && !sessions.has(source)) {
        fail(-32031, `unknown session ${source}`, { kind: "sessionNotFound" });
        return;
      }
      const sessionId = method === "session/fork" ? randomUUID() : source;
      sessions.set(sessionId, { turns: 0 });
      reply({
        session: session(sessionId),
        history: { mode: "none", items: null, snapshot: null },
        pendingRequests: [],
        viewCursor: nextCursor(),
      });
      return;
    }

    case "turn/start": {
      const sessionId = params.sessionId;
      if (!sessions.has(sessionId)) {
        fail(-32031, `unknown session ${sessionId}`, { kind: "sessionNotFound" });
        return;
      }
      const turnId = params.commandId;
      const promptText = (params.input ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      reply({
        commandId: params.commandId,
        turnId,
        disposition: "started",
        startedNewTurn: true,
        status: "accepted",
      });
      setTimeout(() => {
        runTurn(sessionId, turnId, promptText);
      }, 1);
      return;
    }

    case "turn/steer":
      reply({
        commandId: params.commandId,
        turnId: params.expectedTurnId,
        status: "accepted",
      });
      return;

    case "turn/interrupt": {
      const turnId = params.turnId ?? "unknown-turn";
      reply({ commandId: params.commandId, turnId, status: "accepted" });
      setTimeout(() => {
        viewNotify(params.sessionId, "turn/completed", {
          turnId,
          terminal: "cancelled",
        });
      }, 1);
      return;
    }

    case "session/setApprovalMode":
      reply({
        commandId: params.commandId,
        status: "accepted",
        applyOutcome: "completed",
        effectiveMode: {
          mode: params.mode,
          source: "approvalReconfigure",
          lastCommandId: params.commandId,
        },
      });
      return;

    case "session/setModel":
    case "session/compact":
      reply({ commandId: params.commandId, status: "accepted" });
      return;

    case "approval/decide":
      reply({
        approvalId: params.approvalId,
        commandId: params.commandId,
        status: "accepted",
        terminal: true,
      });
      return;

    case "userInput/answer":
    case "userInput/clarify":
    case "userInput/cancel":
      reply({
        commandId: params.commandId,
        status: "accepted",
        userInputId: params.userInputId,
      });
      return;

    case "view/unsubscribe":
      reply({});
      return;

    default:
      fail(-32601, `method not found: ${method}`, { kind: "methodNotFound" });
  }
}

createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  if (line.trim() === "") {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) {
    return;
  }
  handle(message);
});
