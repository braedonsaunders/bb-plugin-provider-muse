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

/**
 * Scripts the one failure a client cannot paper over by waiting: a session whose
 * opaque reasoning the active route will not accept, which fails every turn it
 * is asked to run. Seeded with a transcript so the recovery suite can check what
 * the replacement session was told about the conversation it inherited.
 */
const poisonedSessionId = process.env.FAKE_MUSE_POISONED_SESSION ?? null;
/** Poisons the replacement too, so a rerun that cannot work is scriptable. */
const poisonEverySession = process.env.FAKE_MUSE_POISON_ALL === "1";
/** A stored session, named by id, that resumes holding an unanswered approval. */
const pendingApprovalSessionId =
  process.env.FAKE_MUSE_PENDING_APPROVAL ?? null;
if (pendingApprovalSessionId !== null) {
  sessions.set(pendingApprovalSessionId, { turns: 0, poisoned: false });
}
if (poisonedSessionId !== null) {
  sessions.set(poisonedSessionId, {
    turns: 0,
    poisoned: true,
    items: [
      {
        itemId: `${poisonedSessionId}-u1`,
        kind: "userMessage",
        status: "completed",
        revision: 1,
        text: "why does copy assessment submit a blank hazard assessment?",
      },
      {
        itemId: `${poisonedSessionId}-r1`,
        kind: "reasoning",
        status: "completed",
        revision: 1,
        text: "opaque reasoning that must never travel",
      },
      {
        itemId: `${poisonedSessionId}-a1`,
        kind: "agentMessage",
        status: "completed",
        revision: 1,
        text: "copyAssessment posts an empty form on mobile.",
      },
    ],
  });
}

const INCOMPATIBLE_HISTORY_MESSAGE =
  "provider-private history is incompatible with the active route: reasoning " +
  "replay `rs_fake:rs_fake` has no provider attribution after a provider " +
  "switch; start a fresh turn without opaque reasoning history";

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

/** One write for several messages, so a client reads them in one chunk. */
function sendBurst(messages) {
  process.stdout.write(
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

/**
 * Every session's view, the way a real host keeps one: the notifications push
 * delivers are the same ones `view/page` serves back later.
 */
const viewLogs = new Map();

/**
 * After this many view events on a session, push delivery stops while the view
 * itself keeps growing — the shape of a Muse projection going unavailable
 * mid-turn, which is what leaves a thread reading as busy after Muse is done.
 */
const VIEW_DEAD_AFTER = Number(process.env.FAKE_MUSE_VIEW_DEAD_AFTER ?? "0");

function viewMessage(sessionId, method, params) {
  const message = {
    jsonrpc: "2.0",
    method,
    params: {
      sessionId,
      viewCursor: nextCursor(),
      sourceRange: sourceRange(sessionId),
      ...params,
    },
  };
  const log = viewLogs.get(sessionId) ?? [];
  log.push({ method: message.method, params: message.params });
  viewLogs.set(sessionId, log);
  return message;
}

function pushIsDead(sessionId) {
  return (
    VIEW_DEAD_AFTER > 0 &&
    (viewLogs.get(sessionId)?.length ?? 0) > VIEW_DEAD_AFTER
  );
}

function viewNotify(sessionId, method, params) {
  const message = viewMessage(sessionId, method, params);
  if (pushIsDead(sessionId)) {
    return;
  }
  send(message);
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

/**
 * Muse reviews a shell command one argv stage at a time, and only the stages
 * its grammar cannot resolve come back for a decision. `approval/decide`
 * settles one stage and reports the *approval* as non-terminal while others
 * remain, so this host scripts the whole chain: a client that answers once and
 * stops never sees the turn finish.
 */
const APPROVAL_STAGES = Number(process.env.FAKE_MUSE_APPROVAL_STAGES ?? "0");
/** Drops `approval/updated`, leaving the pending fold as the only way on. */
const APPROVAL_SILENT = process.env.FAKE_MUSE_APPROVAL_SILENT === "1";
/** Marks the approval the way Muse marks a write past the permission scope. */
const APPROVAL_PROTECTED = process.env.FAKE_MUSE_APPROVAL_PROTECTED === "1";

const approvals = new Map();

function approvalChoices() {
  return [
    {
      choiceId: "allow_once",
      decision: "approved",
      label: "Allow once",
      scope: "once",
    },
    {
      choiceId: "allow_session",
      decision: "approvedForSession",
      label: "Allow for this session",
      scope: "session",
    },
    { choiceId: "abort", decision: "abort", label: "Reject", scope: "once" },
  ];
}

function approvalRequestParams(approval) {
  return {
    sessionId: approval.sessionId,
    approvalId: approval.approvalId,
    itemId: approval.itemId,
    turnId: approval.turnId,
    toolName: "bash",
    toolCallId: "call_1",
    ...(APPROVAL_PROTECTED ? { protectedWrite: true } : {}),
    currentRequirementId: {
      approvalId: approval.approvalId,
      sourceIndex: approval.index,
    },
    availableChoices: approvalChoices(),
    subject: {
      kind: "shell",
      command: approval.command,
      workspaceRoot: "/tmp/fake-muse",
      stages: approval.stages.map((stage, index) => ({
        requirementId: { approvalId: approval.approvalId, sourceIndex: index },
        sourcePosition: index + 1,
        totalStages: approval.stages.length,
        argv: [stage],
        resolution: { kind: index < approval.index ? "approved" : "unresolved" },
      })),
    },
  };
}

function openApproval(sessionId, turnId, itemId, command, finish, options = {}) {
  const approvalId = randomUUID();
  const approval = {
    approvalId,
    sessionId,
    turnId,
    itemId,
    command,
    stages: Array.from({ length: APPROVAL_STAGES }, (_, index) =>
      index === 0 ? "echo" : `stage-${String(index)}`,
    ),
    index: 0,
    decisions: [],
    finish,
  };
  approvals.set(approvalId, approval);
  if (options.announce !== false) {
    viewNotify(sessionId, "approval/requested", approvalRequestParams(approval));
  }
}

function decideApproval(id, params) {
  const approval = approvals.get(params?.approvalId);
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  if (approval === undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32040,
        message: "unknown approval",
        data: { kind: "approvalNotFound" },
      },
    });
    return;
  }
  if (params?.requirementId?.sourceIndex !== approval.index) {
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32041,
        message: "requirement is stale",
        data: { kind: "approvalRequirementStale" },
      },
    });
    return;
  }
  approval.decisions.push(params.choiceId);
  const refused = params.choiceId === "abort";
  approval.index += 1;
  const terminal = refused || approval.index >= approval.stages.length;
  reply({
    commandId: params.commandId,
    approvalId: approval.approvalId,
    status: "accepted",
    terminal,
  });
  if (!terminal) {
    if (!APPROVAL_SILENT) {
      viewNotify(
        approval.sessionId,
        "approval/updated",
        approvalRequestParams(approval),
      );
    }
    return;
  }
  approvals.delete(approval.approvalId);
  viewNotify(approval.sessionId, "approval/resolved", {
    approvalId: approval.approvalId,
    decision: refused ? "abort" : "approved",
    resolvedBy: "user",
  });
  approval.finish(refused, approval.decisions);
}

/** The rest of an approved turn: what a client that answered every stage sees. */
function finishTurn(sessionId, turnId, toolItemId, promptText, refused, decisions) {
  viewNotify(sessionId, "item/completed", {
    item: {
      itemId: toolItemId,
      kind: "toolCall",
      status: refused ? "failed" : "completed",
      revision: 2,
      turnId,
      tool: "muse.bash",
      args: JSON.stringify({ command: "echo hello" }),
      callId: "call_1",
      visibleOutput: refused ? "rejected by the user" : "hello\n",
      exitCode: refused ? 1 : 0,
    },
  });

  const messageItemId = `${turnId}-message`;
  const reply = `muse echo: ${promptText} (${decisions.join(",")})`;
  viewNotify(sessionId, "item/completed", {
    item: {
      itemId: messageItemId,
      kind: "agentMessage",
      status: "completed",
      revision: 1,
      turnId,
      text: reply,
    },
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

function runTurn(sessionId, turnId, promptText) {
  viewNotify(sessionId, "turn/started", { turnId, commandId: turnId });

  /**
   * A session that stops mid-turn: the turn is open, the child is alive, and
   * nothing more is ever pushed or written to the view. Neither push nor a
   * direct read will ever produce a terminal.
   */
  if (process.env.FAKE_MUSE_SESSION_STOPPED === "1") {
    return;
  }

  /**
   * A long foreground command: the turn is open and working, push says nothing
   * for its duration, and the view a page folds for it reports the run as
   * `incomplete` because it has not finished. Nothing is wrong.
   */
  if (process.env.FAKE_MUSE_LONG_COMMAND === "1") {
    const itemId = `${turnId}-long`;
    viewNotify(sessionId, "item/started", {
      item: {
        itemId,
        kind: "toolCall",
        status: "inProgress",
        revision: 1,
        turnId,
        tool: "muse.bash",
        args: JSON.stringify({ command: "sleep 600" }),
        callId: "call_long",
      },
    });
    /** The same fold one level down: the running tool, reported unfinished. */
    viewLogs.get(sessionId)?.push({
      method: "item/completed",
      params: {
        sessionId,
        viewCursor: nextCursor(),
        sourceRange: sourceRange(sessionId),
        item: {
          itemId,
          kind: "toolCall",
          status: "incomplete",
          revision: 2,
          turnId,
          tool: "muse.bash",
          args: JSON.stringify({ command: "sleep 600" }),
          callId: "call_long",
        },
      },
    });
    /** Only a page ever sees this, and it is a fold, not a terminal. */
    viewLogs.get(sessionId)?.push({
      method: "turn/completed",
      params: {
        sessionId,
        viewCursor: nextCursor(),
        sourceRange: sourceRange(sessionId),
        turnId,
        terminal: "incomplete",
        reason: "incomplete",
      },
    });
    return;
  }

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
  if (APPROVAL_STAGES > 0) {
    openApproval(
      sessionId,
      turnId,
      toolItemId,
      "echo hello; echo ${VAR}; psql -c 'select 1'",
      (refused, decisions) => {
        finishTurn(sessionId, turnId, toolItemId, promptText, refused, decisions);
      },
    );
    return;
  }
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

    case "view/page": {
      const sessionId = params?.sessionId;
      if (!sessions.has(sessionId)) {
        fail(-32031, `unknown session ${sessionId}`, { kind: "sessionNotFound" });
        return;
      }
      if (process.env.FAKE_MUSE_VIEW_UNREADABLE === "1") {
        fail(-32040, "no trustworthy materialized projection exists", {
          kind: "projectionUnavailable",
        });
        return;
      }
      /**
       * The refusal that is bb's fault, not the session's: an anchor from
       * another session's cursor space. Muse is fine; the read was wrong.
       */
      const badAnchor = process.env.FAKE_MUSE_VIEW_BAD_ANCHOR;
      if (badAnchor === "all" || (badAnchor === "1" && params?.cursor)) {
        fail(-32041, "unknown cursor anchor", { kind: "invalidParams" });
        return;
      }
      if (typeof params?.limit !== "number") {
        fail(-32602, "invalid view/page params: missing field `limit`", {
          kind: "invalidParams",
        });
        return;
      }
      const log = viewLogs.get(sessionId) ?? [];
      const cursor = params.cursor ?? "";
      const start =
        cursor === ""
          ? 0
          : log.findIndex((entry) => entry.params.viewCursor === cursor) + 1;
      const events = log.slice(start, start + params.limit);
      reply({
        events,
        ...(events.length === 0
          ? {}
          : { nextCursor: events[events.length - 1].params.viewCursor }),
      });
      return;
    }

    case "session/start": {
      const sessionId = params?.sessionId ?? randomUUID();
      sessions.set(sessionId, { turns: 0, poisoned: poisonEverySession });
      reply({ session: session(sessionId), viewCursor: nextCursor() });
      return;
    }

    case "session/resume":
    case "session/fork": {
      const source = params?.sessionId;
      /** A resume Muse refuses outright: a durable log it will not replay. */
      if (
        method === "session/resume" &&
        process.env.FAKE_MUSE_RESUME_BROKEN === "1"
      ) {
        fail(
          -32050,
          "internal error: seed run replay: durable child logical sequence is duplicate or non-monotonic",
          { kind: "internal" },
        );
        return;
      }
      /**
       * Each thread gets its own host process, so a session another host
       * opened is unknown here. The unviewable-resume case is about the cursor
       * Muse hands back, not about where the session lives.
       */
      if (
        method === "session/resume" &&
        !sessions.has(source) &&
        process.env.FAKE_MUSE_UNVIEWABLE_RESUME !== "1" &&
        process.env.FAKE_MUSE_RESUME_BROKEN !== "1"
      ) {
        fail(-32031, `unknown session ${source}`, { kind: "sessionNotFound" });
        return;
      }
      const sessionId = method === "session/fork" ? randomUUID() : source;
      /**
       * A session whose process died still holds the approval it was waiting
       * on, and a resumed host announces nothing it has already recorded — so
       * the pending fold is the only way a client can find it again.
       */
      if (
        method === "session/resume" &&
        process.env.FAKE_MUSE_PENDING_APPROVAL === source
      ) {
        openApproval(
          sessionId,
          `${sessionId}-t0`,
          `${sessionId}-i0`,
          "psql \"${DB:-postgres}\" -c 'select 1'",
          () => undefined,
          { announce: false },
        );
      }
      const inherited = sessions.get(source);
      sessions.set(sessionId, {
        turns: 0,
        poisoned: poisonEverySession || inherited?.poisoned === true,
        items: inherited?.items ?? [],
      });
      /**
       * A session Muse accepts back but hands no view cursor for: it still
       * runs, but nothing it does will ever be reported.
       */
      const unviewable =
        method === "session/resume" &&
        process.env.FAKE_MUSE_UNVIEWABLE_RESUME === "1";
      reply({
        session: session(sessionId),
        history: { mode: "none", items: null, snapshot: null },
        pendingRequests: [],
        viewCursor: unviewable ? "" : nextCursor(),
      });
      return;
    }

    case "session/read": {
      const record = sessions.get(params?.sessionId);
      if (record === undefined) {
        fail(-32020, `unknown session ${params?.sessionId}`, {
          kind: "sessionNotFound",
        });
        return;
      }
      reply({
        session: session(params.sessionId),
        history: {
          mode: params?.excludeItems === false ? "inline" : "none",
          items: params?.excludeItems === false ? (record.items ?? []) : null,
          snapshot: null,
        },
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
      if (sessions.get(sessionId).poisoned !== true) {
        reply({
          commandId: params.commandId,
          turnId,
          disposition: "started",
          startedNewTurn: true,
          status: "accepted",
        });
      } else {
        /**
         * One write, so the reply and the turn's terminal reach the client in
         * a single chunk. A real host does this whenever the client is busy
         * enough to coalesce reads, and it is the ordering that decides whether
         * a client can still attribute the failure to the prompt that caused
         * it — so the recovery suite runs against it every time.
         */
        sendBurst([
          {
            jsonrpc: "2.0",
            id,
            result: {
              commandId: params.commandId,
              turnId,
              disposition: "started",
              startedNewTurn: true,
              status: "accepted",
            },
          },
          viewMessage(sessionId, "turn/started", {
            turnId,
            commandId: turnId,
          }),
          viewMessage(sessionId, "turn/completed", {
            turnId,
            terminal: "failed",
            error: {
              kind: "projectionError",
              message: INCOMPATIBLE_HISTORY_MESSAGE,
              retryable: false,
            },
          }),
        ]);
        return;
      }
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
      if (APPROVAL_STAGES > 0) {
        decideApproval(id, params);
        return;
      }
      reply({
        approvalId: params.approvalId,
        commandId: params.commandId,
        status: "accepted",
        terminal: true,
      });
      return;

    case "approval/listPending":
      reply({
        approvals: [...approvals.values()]
          .filter((approval) => approval.sessionId === params?.sessionId)
          .map((approval) => approvalRequestParams(approval)),
        userInputs: [],
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
