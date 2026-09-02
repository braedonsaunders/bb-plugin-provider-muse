import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  experimental_buildBridgeToolCallContent as buildBridgeToolCallContent,
  experimental_BridgeRecoveryError as BridgeRecoveryError,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  isStandaloneBuiltinCompactCommand,
  mimeTypeFromExtension,
  modelListParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  sanitizeInheritedChildProcessEnv,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  withoutBridgeRuntimeEnv,
  type AvailableModel,
  type DynamicTool,
  type PendingInteractionResolution,
  type PromptInput,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  approvalPayloadFromMsp,
  chooseApprovalChoiceId,
  userInputSettlementFromResolution,
  userQuestionPayloadFromMsp,
} from "./interactions.js";
import {
  createMspConnection,
  MspExitedError,
  MspRequestError,
  type MspConnection,
  type MspExitInfo,
} from "./msp/connection.js";
import { museExecutable } from "./msp/paths.js";
import { uuidV7 } from "./msp/uuid.js";
import {
  MSP_METHODS,
  mspApprovalRequestParamsSchema,
  mspCommandAckSchema,
  mspEmptyResultSchema,
  mspInitializeResultSchema,
  mspModelCatalogEntrySchema,
  mspModelListResultSchema,
  mspSessionResumeResultSchema,
  mspSessionStartResultSchema,
  mspTurnInterruptResultSchema,
  mspTurnStartResultSchema,
  mspTurnSteerResultSchema,
  mspUserInputRequestParamsSchema,
  type MspApprovalRequestParams,
  type MspModelCatalogEntry,
  type MspUserInputRequestParams,
} from "./msp/schemas.js";
import {
  getMuseInstallationRun,
  getMuseInstallationStatus,
  getMuseProviderHealth,
  getMuseProviderUsage,
  readMuseCredentials,
} from "./maintenance.js";
import { prepareMuseConfigHome } from "./tool-proxy/config-home.js";
import {
  startToolProxyEndpoint,
  type ToolProxyEndpoint,
} from "./tool-proxy/endpoint.js";
import { MUSE_TOOL_PROXY_SCRIPT } from "./tool-proxy/script.js";
import { MuseTranslator } from "./translate.js";
import {
  MUSE_APPROVAL_MODES,
  MUSE_DEFAULT_REASONING_LEVEL,
  MUSE_REASONING_EFFORTS,
  MUSE_SESSION_EXTENSION_KIND,
  museProviderOptionsSchema,
  type MuseProviderOptions,
} from "./vocabulary.js";

const CLIENT_NAME = "bb";
const CLIENT_VERSION = "1";
const HANDSHAKE_TIMEOUT_MS = 30_000;
/**
 * One `muse serve` process hosts every session that shares its sandbox posture.
 * Keeping it briefly after the last thread detaches makes stop-then-resume — and
 * the next thread in the same workspace — reuse a warm host instead of paying
 * for a fresh handshake.
 */
const HOST_IDLE_SHUTDOWN_MS = 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 8_000;

type JsonRpcId = string | number;
type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

const io = createBridgeIo<OutboundMessage>();

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emitDeltas(threadId: string, deltas: readonly ThreadDelta[]): void {
  if (deltas.length === 0) {
    return;
  }
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

let outboundRequestCounter = 0;
const pendingRuntimeRequests = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void }
>();

function sendRuntimeRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  outboundRequestCounter += 1;
  const id = `muse-req-${outboundRequestCounter}`;
  return new Promise((resolve, reject) => {
    pendingRuntimeRequests.set(id, { resolve, reject });
    io.send({ jsonrpc: "2.0", id, method, params });
  });
}

interface HostPosture {
  disableSandbox: boolean;
  sandboxNetwork: "proxy-only" | "off" | "on";
  trustWorkspace: boolean;
}

interface MuseHost {
  signature: string;
  connection: MspConnection;
  ready: Promise<void>;
  museHome: string | null;
  serverVersion: string | null;
  threadIds: Set<string>;
  idleTimer: NodeJS.Timeout | null;
}

interface MuseSession {
  threadId: string;
  sessionId: string;
  host: MuseHost;
  cwd: string;
  translator: MuseTranslator;
  approvalMode: string;
  modelId: string | null;
  sessionLogPath: string | null;
  pendingApprovals: Map<string, MspApprovalRequestParams>;
  pendingUserInputs: Map<string, MspUserInputRequestParams>;
  interruptWaiters: Set<() => void>;
}

const hosts = new Map<string, MuseHost>();
const sessions = new Map<string, MuseSession>();
const sessionsByMuseId = new Map<string, MuseSession>();

let bridgeDataDir: string | null = null;
let toolProxy: ToolProxyEndpoint | null = null;
let toolProxyScriptPath: string | null = null;

/**
 * bb injects its own tools per thread, and Muse reads MCP servers from its
 * config rather than from a per-session parameter. A thread that carries
 * injected tools therefore gets a Muse host of its own, so one thread's tools
 * can never be offered to another's session.
 */
async function ensureToolProxy(): Promise<ToolProxyEndpoint | null> {
  if (bridgeDataDir === null) {
    return null;
  }
  if (toolProxy !== null) {
    return toolProxy;
  }
  const scriptPath = join(bridgeDataDir, "bb-tool-proxy.mjs");
  await mkdir(bridgeDataDir, { recursive: true });
  await writeFile(scriptPath, MUSE_TOOL_PROXY_SCRIPT, { mode: 0o700 });
  toolProxyScriptPath = scriptPath;
  toolProxy = await startToolProxyEndpoint({
    onCall: runInjectedTool,
    onError: (error) => {
      process.stderr.write(
        `muse bridge: tool proxy error: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    },
  });
  return toolProxy;
}

async function runInjectedTool(call: {
  threadId: string;
  tool: string;
  callId: string;
  arguments: Record<string, unknown>;
}) {
  const session = sessions.get(call.threadId);
  if (session === undefined) {
    return {
      ok: false as const,
      error: `bb has no live session for thread ${call.threadId}`,
    };
  }
  const result = await sendRuntimeRequest(
    BRIDGE_INBOUND_REQUEST_METHODS.toolCall,
    {
      providerThreadId: session.sessionId,
      threadId: session.threadId,
      turnId: null,
      callId: call.callId,
      tool: call.tool,
      arguments: call.arguments,
      providerNativeIds: true,
    },
  );
  const decoded = decodeToolCallResponsePayload(result);
  return {
    ok: true as const,
    content: buildBridgeToolCallContent(decoded),
    isError: decoded.isError,
  };
}

function postureFrom(options: MuseProviderOptions): HostPosture {
  return {
    disableSandbox: options.disableSandbox === true,
    sandboxNetwork: options.sandboxNetwork ?? "proxy-only",
    trustWorkspace: options.trustWorkspace !== false,
  };
}

function postureSignature(posture: HostPosture): string {
  return [
    posture.disableSandbox ? "nosandbox" : "sandbox",
    posture.sandboxNetwork,
    posture.trustWorkspace ? "trusted" : "untrusted",
  ].join("|");
}

function serveArgs(posture: HostPosture): string[] {
  const args = ["serve"];
  if (posture.disableSandbox) {
    args.push("--disable-sandbox");
  } else {
    args.push("--sandbox-network", posture.sandboxNetwork);
  }
  if (posture.trustWorkspace) {
    args.push("--trust-workspace");
  }
  return args;
}

function parseProviderOptions(options: unknown): MuseProviderOptions {
  const parsed = museProviderOptionsSchema.safeParse(options ?? {});
  return parsed.success ? parsed.data : {};
}

function childEnv(
  envVars: Record<string, string> | undefined,
  configHome: string | null,
): NodeJS.ProcessEnv {
  const base = sanitizeInheritedChildProcessEnv({
    env: withoutBridgeRuntimeEnv(process.env),
  });
  return {
    ...base,
    ...(envVars ?? {}),
    ...(configHome === null ? {} : { XDG_CONFIG_HOME: configHome }),
  };
}

/**
 * The private config directory this thread's Muse host reads: the user's own
 * settings and credentials, plus the one MCP server that reaches bb's tools.
 */
async function buildThreadConfigHome(
  threadId: string,
  tools: readonly DynamicTool[],
): Promise<string | null> {
  const proxy = await ensureToolProxy();
  if (proxy === null || bridgeDataDir === null || toolProxyScriptPath === null) {
    return null;
  }
  return prepareMuseConfigHome({
    root: join(bridgeDataDir, "threads", threadId.replace(/[^A-Za-z0-9_-]/gu, "_")),
    mcpServer: {
      command: process.execPath,
      args: [toolProxyScriptPath],
      env: {
        /**
         * bb ships as an Electron app, so the bridge's own `execPath` is the
         * Electron binary. Muse spawns the proxy directly, and without this the
         * spawn opens a GUI process whose stdio transport closes at once.
         */
        ELECTRON_RUN_AS_NODE: "1",
        BB_MUSE_TOOL_PORT: String(proxy.port),
        BB_MUSE_TOOL_TOKEN: proxy.token,
        BB_MUSE_TOOL_THREAD_ID: threadId,
        BB_MUSE_TOOLS: JSON.stringify(
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ),
      },
    },
  });
}

async function ensureHost(args: {
  posture: HostPosture;
  cwd: string;
  envVars?: Record<string, string>;
  recordThreadId: string | null;
  threadId?: string;
  dynamicTools?: readonly DynamicTool[];
}): Promise<MuseHost> {
  const tools = args.dynamicTools ?? [];
  const scopedToThread = tools.length > 0 && args.threadId !== undefined;
  const signature = scopedToThread
    ? `${postureSignature(args.posture)}|thread:${args.threadId}`
    : postureSignature(args.posture);
  const configHome = scopedToThread
    ? await buildThreadConfigHome(args.threadId as string, tools)
    : null;
  const existing = hosts.get(signature);
  if (existing !== undefined && !existing.connection.exited) {
    cancelIdleShutdown(existing);
    await existing.ready;
    return existing;
  }

  const host: MuseHost = {
    signature,
    connection: undefined as unknown as MspConnection,
    ready: Promise.resolve(),
    museHome: null,
    serverVersion: null,
    threadIds: new Set(),
    idleTimer: null,
  };

  host.connection = createMspConnection({
    command: museExecutable(process.env),
    args: serveArgs(args.posture),
    cwd: args.cwd,
    env: childEnv(args.envVars, configHome),
    recordThreadId: args.recordThreadId,
    onNotification: (method, params) => {
      handleMuseNotification(host, method, params);
    },
    onRequest: (method, params, responder) => {
      handleMuseRequest(host, method, params);
      responder.result({});
    },
    onExit: (info) => {
      handleHostExit(host, info);
    },
  });

  host.ready = host.connection
    .request({
      method: MSP_METHODS.initialize,
      params: {
        clientInfo: { name: CLIENT_NAME, title: "bb", version: CLIENT_VERSION },
        capabilities: { requestedCapabilities: ["userShell"] },
      },
      resultSchema: mspInitializeResultSchema,
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    })
    .then((result) => {
      host.museHome = result.museHome;
      host.serverVersion = result.serverInfo.version;
      host.connection.notify("initialized");
    });

  hosts.set(signature, host);
  try {
    await host.ready;
  } catch (error) {
    hosts.delete(signature);
    host.connection.kill();
    throw error;
  }
  return host;
}

function handleHostExit(host: MuseHost, info: MspExitInfo): void {
  hosts.delete(host.signature);
  cancelIdleShutdown(host);
  const message = `muse serve exited (code ${info.code ?? "null"}, signal ${
    info.signal ?? "null"
  })${info.stderrTail === "" ? "" : `: ${info.stderrTail}`}`;
  for (const threadId of host.threadIds) {
    const session = sessions.get(threadId);
    if (session === undefined) {
      continue;
    }
    emitDeltas(threadId, session.translator.settleOpenTurns("failed", message));
    for (const waiter of session.interruptWaiters) {
      waiter();
    }
    session.interruptWaiters.clear();
    sessions.delete(threadId);
    sessionsByMuseId.delete(session.sessionId);
    notify(BRIDGE_NOTIFICATION_METHODS.providerRecovery, {
      threadId,
      kind: "restartRecommended",
      message,
      retryable: true,
    });
  }
  host.threadIds.clear();
}

function sessionFor(params: unknown): MuseSession | null {
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string"
    ? (sessionsByMuseId.get(sessionId) ?? null)
    : null;
}

function handleMuseNotification(
  host: MuseHost,
  method: string,
  params: unknown,
): void {
  const session = sessionFor(params);
  if (session === null || session.host !== host) {
    return;
  }

  if (method === "approval/requested") {
    openApprovalInteraction(session, params);
    return;
  }
  if (method === "userInput/requested") {
    openUserInputInteraction(session, params);
    return;
  }
  if (method === "approval/resolved") {
    const approvalId = (params as { approvalId?: unknown }).approvalId;
    if (typeof approvalId === "string") {
      session.pendingApprovals.delete(approvalId);
    }
    return;
  }
  if (method === "userInput/settled") {
    const userInputId = (params as { userInputId?: unknown }).userInputId;
    if (typeof userInputId === "string") {
      session.pendingUserInputs.delete(userInputId);
    }
    return;
  }
  if (method === "session/approvalModeChanged") {
    /**
     * Track the mode Muse reports rather than the one bb asked for: a belief
     * that drifts from the host is how a full-access thread ends up prompting
     * for every command.
     */
    const mode = (params as { mode?: unknown }).mode;
    if (typeof mode === "string") {
      session.approvalMode = mode;
      emitDeltas(session.threadId, [sessionStateDelta(session)]);
    }
    return;
  }
  if (method === "session/modelChanged") {
    const modelId = (params as { modelId?: unknown }).modelId;
    if (typeof modelId === "string") {
      session.modelId = modelId;
      emitDeltas(session.threadId, [sessionStateDelta(session)]);
    }
    return;
  }

  const deltas = session.translator.onNotification(method, params);
  emitDeltas(session.threadId, deltas);

  if (method === "turn/completed") {
    for (const waiter of session.interruptWaiters) {
      waiter();
    }
    session.interruptWaiters.clear();
  }
}

/**
 * MSP re-issues an unsettled approval or prompt as a server-to-client request
 * after a resume. The authoritative answer always travels back on the command
 * plane, so the request itself only needs an ack.
 */
function handleMuseRequest(
  host: MuseHost,
  method: string,
  params: unknown,
): void {
  const session = sessionFor(params);
  if (session === null || session.host !== host) {
    return;
  }
  if (method === "approval/request") {
    openApprovalInteraction(session, params);
    return;
  }
  if (method === "userInput/request") {
    openUserInputInteraction(session, params);
  }
}

function sessionStateDelta(session: MuseSession): ThreadDelta {
  return {
    kind: "extension.state",
    extensionKind: MUSE_SESSION_EXTENSION_KIND,
    payload: {
      approvalMode: session.approvalMode,
      modelId: session.modelId,
      museHome: session.host.museHome,
      serverVersion: session.host.serverVersion,
      sessionLogPath: session.sessionLogPath,
    },
  };
}

function openApprovalInteraction(session: MuseSession, params: unknown): void {
  const parsed = mspApprovalRequestParamsSchema.safeParse(params);
  if (!parsed.success) {
    return;
  }
  const request = parsed.data;
  if (session.pendingApprovals.has(request.approvalId)) {
    return;
  }
  const payload = approvalPayloadFromMsp(request);
  if (payload === null) {
    return;
  }
  session.pendingApprovals.set(request.approvalId, request);

  void sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
    providerThreadId: session.sessionId,
    threadId: session.threadId,
    turnId: request.turnId,
    payload,
    providerNativeIds: true,
  })
    .then((resolution) => {
      session.pendingApprovals.delete(request.approvalId);
      return decideApproval(session, request, resolution);
    })
    .catch(() => {
      session.pendingApprovals.delete(request.approvalId);
    });
}

async function decideApproval(
  session: MuseSession,
  request: MspApprovalRequestParams,
  resolution: unknown,
): Promise<void> {
  const decision =
    typeof resolution === "object" &&
    resolution !== null &&
    "decision" in resolution
      ? (resolution as { decision: string }).decision
      : "deny";
  const choiceId = chooseApprovalChoiceId(
    request.availableChoices,
    decision === "allow_once" || decision === "allow_for_session"
      ? decision
      : "deny",
  );
  if (choiceId === null) {
    return;
  }
  try {
    await session.host.connection.request({
      method: MSP_METHODS.approvalDecide,
      params: {
        commandId: uuidV7(),
        sessionId: session.sessionId,
        approvalId: request.approvalId,
        requirementId: request.currentRequirementId,
        choiceId,
      },
      resultSchema: mspEmptyResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    /**
     * A decision that lost a race is already settled by whoever won it; every
     * other failure is reported on the timeline by the turn itself.
     */
    if (
      !(error instanceof MspRequestError) ||
      error.kind !== "approvalAlreadyResolved"
    ) {
      emitDeltas(session.threadId, [
        {
          kind: "provider.warning",
          summary: "Muse rejected an approval decision",
          details: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
  }
}

function openUserInputInteraction(session: MuseSession, params: unknown): void {
  const parsed = mspUserInputRequestParamsSchema.safeParse(params);
  if (!parsed.success) {
    return;
  }
  const request = parsed.data;
  if (session.pendingUserInputs.has(request.userInputId)) {
    return;
  }
  const payload = userQuestionPayloadFromMsp(request);
  if (payload === null) {
    return;
  }
  session.pendingUserInputs.set(request.userInputId, request);

  void sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
    providerThreadId: session.sessionId,
    threadId: session.threadId,
    turnId: request.turnId,
    payload,
    providerNativeIds: true,
  })
    .then((resolution) => {
      session.pendingUserInputs.delete(request.userInputId);
      return settleUserInput(session, request, resolution);
    })
    .catch(() => {
      session.pendingUserInputs.delete(request.userInputId);
    });
}

async function settleUserInput(
  session: MuseSession,
  request: MspUserInputRequestParams,
  resolution: unknown,
): Promise<void> {
  const settlement = userInputSettlementFromResolution(
    request,
    resolution as PendingInteractionResolution,
  );
  try {
    await session.host.connection.request({
      method: settlement.method,
      params: {
        commandId: uuidV7(),
        sessionId: session.sessionId,
        userInputId: request.userInputId,
        ...(settlement.answers === undefined
          ? {}
          : { answers: settlement.answers }),
        ...(settlement.clarification === undefined
          ? {}
          : { clarification: settlement.clarification }),
        ...(settlement.reason === undefined ? {} : { reason: settlement.reason }),
      },
      resultSchema: mspEmptyResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  } catch {
    /** A settled prompt needs no second answer; the turn reports the outcome. */
  }
}

async function turnInputParts(
  input: readonly PromptInput[],
): Promise<{ type: "text" | "image"; [key: string]: unknown }[]> {
  const parts: { type: "text" | "image"; [key: string]: unknown }[] = [];
  for (const item of input) {
    switch (item.type) {
      case "text":
        if (item.text !== "") {
          parts.push({ type: "text", text: item.text });
        }
        break;
      case "localImage": {
        try {
          const bytes = await readFile(item.path);
          parts.push({
            type: "image",
            base64Data: bytes.toString("base64"),
            mediaType: mimeTypeFromExtension(item.path) ?? "image/png",
          });
        } catch {
          parts.push({ type: "text", text: `@${item.path}` });
        }
        break;
      }
      case "localFile":
        parts.push({ type: "text", text: `@${item.path}` });
        break;
      case "image":
        parts.push({ type: "text", text: item.url });
        break;
    }
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

function reasoningEffortFor(level: string | undefined): string | undefined {
  if (level === undefined) {
    return undefined;
  }
  return MUSE_REASONING_EFFORTS[level as keyof typeof MUSE_REASONING_EFFORTS];
}

function approvalModeFor(permissionMode: string): string {
  return (
    MUSE_APPROVAL_MODES[permissionMode as keyof typeof MUSE_APPROVAL_MODES] ??
    "onRequest"
  );
}

async function reconcileSessionOptions(
  session: MuseSession,
  options: { model?: string; permissionMode: string },
): Promise<void> {
  const approvalMode = approvalModeFor(options.permissionMode);
  if (approvalMode !== session.approvalMode) {
    await session.host.connection.request({
      method: MSP_METHODS.sessionSetApprovalMode,
      params: {
        commandId: uuidV7(),
        sessionId: session.sessionId,
        mode: approvalMode,
      },
      resultSchema: mspEmptyResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    session.approvalMode = approvalMode;
  }
  if (options.model !== undefined && options.model !== session.modelId) {
    await session.host.connection.request({
      method: MSP_METHODS.sessionSetModel,
      params: {
        commandId: uuidV7(),
        sessionId: session.sessionId,
        model: { modelId: options.model },
      },
      resultSchema: mspCommandAckSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    session.modelId = options.model;
  }
}

function registerSession(args: {
  threadId: string;
  sessionId: string;
  host: MuseHost;
  cwd: string;
  approvalMode: string;
  modelId: string | null;
  sessionLogPath: string | null;
}): MuseSession {
  const previous = sessions.get(args.threadId);
  if (previous !== undefined) {
    sessionsByMuseId.delete(previous.sessionId);
    previous.host.threadIds.delete(args.threadId);
  }
  const session: MuseSession = {
    threadId: args.threadId,
    sessionId: args.sessionId,
    host: args.host,
    cwd: args.cwd,
    translator: new MuseTranslator({ cwd: args.cwd }),
    approvalMode: args.approvalMode,
    modelId: args.modelId,
    sessionLogPath: args.sessionLogPath,
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    interruptWaiters: new Set(),
  };
  sessions.set(args.threadId, session);
  sessionsByMuseId.set(args.sessionId, session);
  args.host.threadIds.add(args.threadId);
  cancelIdleShutdown(args.host);

  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: args.threadId,
    providerThreadId: args.sessionId,
  });
  emitDeltas(args.threadId, [
    { kind: "session.reset" },
    sessionStateDelta(session),
  ]);
  return session;
}

async function authRecoveryIfUnauthenticated(): Promise<void> {
  const credentials = await readMuseCredentials();
  if (credentials === null || credentials.expired) {
    throw new BridgeRecoveryError({
      code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      message:
        credentials === null
          ? "Muse Code is not signed in. Run `muse login` on this machine."
          : "The Muse Code session expired. Run `muse login` on this machine.",
      recovery: {
        kind: "authRequired",
        message: "Muse Code needs a sign-in before it can start a session.",
        retryable: false,
      },
    });
  }
}

/**
 * Muse's catalog labels a model with its own id. BB strips the declared brand
 * prefix from what it shows, so an id becomes a title here and reads as
 * "Spark 1.3 Contributor" in the picker.
 */
export function museModelDisplayName(entry: {
  modelId: string;
  displayLabel: string;
}): string {
  if (entry.displayLabel !== entry.modelId) {
    return entry.displayLabel;
  }
  return entry.modelId
    .split("-")
    .map((part) =>
      /^[a-z]/u.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part,
    )
    .reduce((label, part) => {
      const separator = /^[0-9]/u.test(part) && /[0-9]$/u.test(label) ? "." : " ";
      return label === "" ? part : `${label}${separator}${part}`;
    }, "");
}

function modelFromCatalog(entry: MspModelCatalogEntry): AvailableModel {
  const contextLimit =
    entry.contextLimit === null
      ? ""
      : ` · ${Math.round(entry.contextLimit / 1_000)}K context`;
  return {
    id: entry.modelId,
    model: entry.modelId,
    displayName: museModelDisplayName(entry),
    description: entry.description ?? `Muse Spark${contextLimit}`,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast, shallow reasoning." },
      { reasoningEffort: "medium", description: "Balanced reasoning." },
      { reasoningEffort: "high", description: "Muse Code's default effort." },
      { reasoningEffort: "xhigh", description: "Muse's deepest reasoning." },
    ],
    defaultReasoningEffort: MUSE_DEFAULT_REASONING_LEVEL,
    isDefault: entry.isDefault,
  };
}

async function listModels(cwd: string): Promise<AvailableModel[]> {
  const host = await ensureHost({
    posture: postureFrom({}),
    cwd,
    recordThreadId: null,
  });
  const result = await host.connection.request({
    method: MSP_METHODS.modelList,
    resultSchema: mspModelListResultSchema,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const models: AvailableModel[] = [];
  for (const raw of result.models) {
    const parsed = mspModelCatalogEntrySchema.safeParse(raw);
    if (parsed.success) {
      models.push(modelFromCatalog(parsed.data));
    }
  }
  if (models.length > 0 && !models.some((model) => model.isDefault)) {
    models[0] = { ...models[0], isDefault: true };
  }
  return models;
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({
    jsonrpc: "2.0",
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      message: `Invalid params for ${method}`,
      data: issues,
    },
  });
}

function requireSession(threadId: string): MuseSession {
  const session = sessions.get(threadId);
  if (session === undefined) {
    throw new Error(
      `No Muse session for thread ${threadId}; send thread/start or thread/resume first`,
    );
  }
  return session;
}

type RequestHandler = (id: JsonRpcId, params: unknown) => Promise<void> | void;

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "tip",
        approvalEnforcedBy: "runtime",
        steerMode: "inject",
        skills: { configure: false },
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: async (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    await authRecoveryIfUnauthenticated();
    io.sendResult(id, {
      models: await listModels(parsed.data.cwd ?? process.cwd()),
      selectedOnlyModels: [],
    });
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: async (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerHealth,
        parsed.error.issues,
      );
      return;
    }
    io.sendResult(id, await getMuseProviderHealth());
  },

  [BRIDGE_REQUEST_METHODS.providerUsage]: async (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerUsage,
        parsed.error.issues,
      );
      return;
    }
    const options = parseProviderOptions(parsed.data.providerOptions);
    io.sendResult(
      id,
      await getMuseProviderUsage({
        tokenBudget: options.tokenBudget ?? null,
        planLabel: options.planLabel ?? null,
      }),
    );
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationStatus]: async (id, params) => {
    const parsed = providerInstallationStatusParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerInstallationStatus,
        parsed.error.issues,
      );
      return;
    }
    io.sendResult(id, await getMuseInstallationStatus());
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationRun]: async (id, params) => {
    const parsed = providerInstallationRunParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerInstallationRun,
        parsed.error.issues,
      );
      return;
    }
    io.sendResult(id, await getMuseInstallationRun(parsed.data.action));
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: async (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      return;
    }
    const { threadId, cwd, options, input } = parsed.data;
    await authRecoveryIfUnauthenticated();
    const providerOptions = parseProviderOptions(options.providerOptions);
    const host = await ensureHost({
      posture: postureFrom(providerOptions),
      cwd,
      envVars: options.envVars,
      recordThreadId: threadId,
      threadId,
      dynamicTools: parsed.data.dynamicTools,
    });
    const approvalMode = approvalModeFor(options.permissionMode);
    const result = await host.connection.request({
      method: MSP_METHODS.sessionStart,
      params: {
        commandId: uuidV7(),
        workspaceRoot: cwd,
        approvalMode,
        ...(options.model === undefined ? {} : { modelId: options.model }),
      },
      resultSchema: mspSessionStartResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const session = registerSession({
      threadId,
      sessionId: result.session.sessionId,
      host,
      cwd,
      approvalMode,
      modelId: result.session.modelId,
      sessionLogPath: result.session.path === "" ? null : result.session.path,
    });
    io.sendResult(id, {
      providerThreadId: session.sessionId,
      sessionRestorable: result.session.path !== "",
    });
    if (input !== undefined && input.length > 0) {
      await submitTurn({ session, input, options });
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: async (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadResume,
        parsed.error.issues,
      );
      return;
    }
    const { threadId, cwd, options, providerThreadId } = parsed.data;
    await authRecoveryIfUnauthenticated();
    const providerOptions = parseProviderOptions(options.providerOptions);
    const host = await ensureHost({
      posture: postureFrom(providerOptions),
      cwd,
      envVars: options.envVars,
      recordThreadId: threadId,
      threadId,
      dynamicTools: parsed.data.dynamicTools,
    });
    let result;
    try {
      result = await host.connection.request({
        method: MSP_METHODS.sessionResume,
        params: {
          commandId: uuidV7(),
          sessionId: providerThreadId,
          excludeItems: true,
        },
        resultSchema: mspSessionResumeResultSchema,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      if (
        error instanceof MspRequestError &&
        (error.kind === "sessionNotFound" || error.kind === "sessionAmbiguous")
      ) {
        io.sendError(
          id,
          BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
          `Muse session ${providerThreadId} is no longer on this machine`,
        );
        return;
      }
      throw error;
    }
    const session = registerSession({
      threadId,
      sessionId: result.session.sessionId,
      host,
      cwd,
      approvalMode: result.session.approvalMode?.mode ?? "onRequest",
      modelId: result.session.modelId,
      sessionLogPath: result.session.path === "" ? null : result.session.path,
    });
    await reconcileSessionOptions(session, {
      model: options.model,
      permissionMode: options.permissionMode,
    });
    io.sendResult(id, {
      providerThreadId: session.sessionId,
      sessionRestorable: result.session.path !== "",
    });
  },

  [BRIDGE_REQUEST_METHODS.threadFork]: async (id, params) => {
    const parsed = threadForkParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadFork, parsed.error.issues);
      return;
    }
    const { threadId, cwd, options, sourceProviderThreadId } = parsed.data;
    if (parsed.data.sourceProviderCheckpointId !== undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.FORK_CHECKPOINT_UNSUPPORTED,
        "Muse forks at the tip of a session, not at a checkpoint",
      );
      return;
    }
    await authRecoveryIfUnauthenticated();
    const providerOptions = parseProviderOptions(options.providerOptions);
    const host = await ensureHost({
      posture: postureFrom(providerOptions),
      cwd,
      envVars: options.envVars,
      recordThreadId: threadId,
      threadId,
      dynamicTools: parsed.data.dynamicTools,
    });
    const result = await host.connection.request({
      method: MSP_METHODS.sessionFork,
      params: {
        commandId: uuidV7(),
        sessionId: sourceProviderThreadId,
        excludeItems: true,
      },
      resultSchema: mspSessionResumeResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const session = registerSession({
      threadId,
      sessionId: result.session.sessionId,
      host,
      cwd,
      approvalMode: result.session.approvalMode?.mode ?? "onRequest",
      modelId: result.session.modelId,
      sessionLogPath: result.session.path === "" ? null : result.session.path,
    });
    await reconcileSessionOptions(session, {
      model: options.model,
      permissionMode: options.permissionMode,
    });
    io.sendResult(id, {
      providerThreadId: session.sessionId,
      sessionRestorable: result.session.path !== "",
    });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: async (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const session = requireSession(parsed.data.threadId);
    io.sendResult(id, {});
    await submitTurn({
      session,
      input: parsed.data.input,
      options: parsed.data.options,
      clientRequestId: parsed.data.clientRequestId,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: async (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined || !session.translator.hasOpenTurn(parsed.data.expectedTurnId)) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        `Muse turn ${parsed.data.expectedTurnId} is no longer running`,
      );
      return;
    }
    const input = await turnInputParts(parsed.data.input);
    try {
      await session.host.connection.request({
        method: MSP_METHODS.turnSteer,
        params: {
          commandId: uuidV7(),
          sessionId: session.sessionId,
          expectedTurnId: parsed.data.expectedTurnId,
          input,
          ...(reasoningEffortFor(parsed.data.options.reasoningLevel) === undefined
            ? {}
            : {
                reasoningEffort: reasoningEffortFor(
                  parsed.data.options.reasoningLevel,
                ),
              }),
        },
        resultSchema: mspTurnSteerResultSchema,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      throw new BridgeRecoveryError({
        code: BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        message: error instanceof Error ? error.message : String(error),
        recovery: {
          kind: "staleTurn",
          message: "The Muse turn this steer targeted is gone.",
          retryable: false,
        },
      });
    }
    io.sendResult(id, {});
    emitDeltas(session.threadId, [
      { kind: "input.accepted", clientRequestId: parsed.data.clientRequestId },
    ]);
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: async (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const { threadId, intent, activeTurnId } = parsed.data;
    const session = sessions.get(threadId);
    if (session === undefined) {
      io.sendResult(id, {});
      return;
    }

    if (intent === "interrupt") {
      await interruptSession(session, activeTurnId);
    }

    try {
      await session.host.connection.request({
        method: MSP_METHODS.viewUnsubscribe,
        params: { sessionId: session.sessionId },
        resultSchema: mspEmptyResultSchema,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch {
      /** An unsubscribe that cannot land costs nothing: the host is going away. */
    }
    forgetSession(session);
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadDiscard]: (id, params) => {
    const parsed = threadDiscardParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadDiscard,
        parsed.error.issues,
      );
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session !== undefined) {
      forgetSession(session);
    }
    io.sendResult(id, {});
  },
};

function cancelIdleShutdown(host: MuseHost): void {
  if (host.idleTimer !== null) {
    clearTimeout(host.idleTimer);
    host.idleTimer = null;
  }
}

function scheduleIdleShutdown(host: MuseHost): void {
  cancelIdleShutdown(host);
  host.idleTimer = setTimeout(() => {
    host.idleTimer = null;
    if (host.threadIds.size > 0) {
      return;
    }
    hosts.delete(host.signature);
    host.connection.kill();
  }, HOST_IDLE_SHUTDOWN_MS);
  host.idleTimer.unref?.();
}

function forgetSession(session: MuseSession): void {
  sessions.delete(session.threadId);
  sessionsByMuseId.delete(session.sessionId);
  session.host.threadIds.delete(session.threadId);
  if (session.host.threadIds.size > 0) {
    return;
  }
  if (session.host.signature.includes("|thread:")) {
    cancelIdleShutdown(session.host);
    hosts.delete(session.host.signature);
    session.host.connection.kill();
    return;
  }
  scheduleIdleShutdown(session.host);
}

async function interruptSession(
  session: MuseSession,
  activeTurnId: string | null,
): Promise<void> {
  const openTurns = session.translator.openTurns;
  if (openTurns.length === 0) {
    return;
  }
  const settled = new Promise<void>((resolve) => {
    const waiter = () => {
      resolve();
    };
    session.interruptWaiters.add(waiter);
    const timeout = setTimeout(() => {
      session.interruptWaiters.delete(waiter);
      resolve();
    }, INTERRUPT_SETTLE_TIMEOUT_MS);
    timeout.unref?.();
  });

  try {
    await session.host.connection.request({
      method: MSP_METHODS.turnInterrupt,
      params: {
        commandId: uuidV7(),
        sessionId: session.sessionId,
        ...(activeTurnId === null ? {} : { turnId: activeTurnId }),
      },
      resultSchema: mspTurnInterruptResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  } catch {
    /** Fall through to the local settlement below. */
  }

  await settled;
  emitDeltas(
    session.threadId,
    session.translator.settleOpenTurns("interrupted", "Interrupted by bb"),
  );
}

async function submitTurn(args: {
  session: MuseSession;
  input: readonly PromptInput[];
  options: z.infer<typeof turnStartParamsSchema>["options"];
  clientRequestId?: string;
}): Promise<void> {
  const { session, options } = args;
  if (args.clientRequestId !== undefined) {
    emitDeltas(session.threadId, [
      { kind: "input.accepted", clientRequestId: args.clientRequestId },
    ]);
  }

  if (isStandaloneBuiltinCompactCommand(args.input)) {
    await compactSession(session);
    return;
  }

  try {
    await reconcileSessionOptions(session, {
      model: options.model,
      permissionMode: options.permissionMode,
    });
    const input = await turnInputParts(args.input);
    const reasoningEffort = reasoningEffortFor(options.reasoningLevel);
    await session.host.connection.request({
      method: MSP_METHODS.turnStart,
      params: {
        commandId: uuidV7(),
        sessionId: session.sessionId,
        input,
        ifBusy: "queue",
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      resultSchema: mspTurnStartResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitDeltas(session.threadId, [
      {
        kind: "provider.error",
        message,
        settlesTurn: true,
      },
      { kind: "turn.boundary", status: "failed", claimIfIdle: true, error: { message } },
    ]);
    if (error instanceof MspExitedError) {
      notify(BRIDGE_NOTIFICATION_METHODS.providerRecovery, {
        threadId: session.threadId,
        kind: "restartRecommended",
        message,
        retryable: true,
      });
    }
  }
}

async function compactSession(session: MuseSession): Promise<void> {
  try {
    await session.host.connection.request({
      method: MSP_METHODS.sessionCompact,
      params: { commandId: uuidV7(), sessionId: session.sessionId },
      resultSchema: mspCommandAckSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    emitDeltas(session.threadId, [
      { kind: "turn.open" },
      { kind: "turn.boundary", status: "completed" },
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitDeltas(session.threadId, [
      { kind: "provider.error", message, settlesTurn: true },
      { kind: "turn.open" },
      { kind: "turn.boundary", status: "failed", error: { message } },
    ]);
  }
}

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };

  if (typeof method !== "string") {
    const response = decodeBridgeJsonRpcResponse(message);
    if (response === null || typeof response.id !== "string") {
      return;
    }
    const pending = pendingRuntimeRequests.get(response.id);
    if (pending === undefined) {
      return;
    }
    pendingRuntimeRequests.delete(response.id);
    if ("error" in response) {
      pending.reject(
        new Error(response.error.message ?? "bb rejected a bridge request"),
      );
      return;
    }
    pending.resolve(response.result);
    return;
  }

  if (typeof id !== "string" && typeof id !== "number") {
    return;
  }
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    );
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => {
      await handler(request.id, request.params);
    },
  });
}

function shutdown(): void {
  toolProxy?.close();
  toolProxy = null;
  for (const host of hosts.values()) {
    cancelIdleShutdown(host);
    host.connection.kill();
  }
  hosts.clear();
  sessions.clear();
  sessionsByMuseId.clear();
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    bridgeDataDir = context.dataDir;
  },
  onClose: shutdown,
  onSigterm: shutdown,
  onSigint: shutdown,
});
