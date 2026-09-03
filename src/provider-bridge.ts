import { createHash } from "node:crypto";
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
  type BridgeExecutionOptions,
  type DynamicTool,
  type PendingInteractionResolution,
  type PromptInput,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  approvalPayloadFromMsp,
  chooseApprovalChoiceId,
  userInputSettlementFromResolution,
  userQuestionPayloadFromMsp,
} from "./interactions.js";
import {
  getMuseInstallationRun,
  getMuseInstallationStatus,
  getMuseProviderHealth,
  getMuseProviderUsage,
} from "./maintenance.js";
import {
  createMspConnection,
  MspExitedError,
  MspRequestError,
  type MspConnection,
  type MspExitInfo,
} from "./msp/connection.js";
import { museExecutable } from "./msp/paths.js";
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
import { uuidV7 } from "./msp/uuid.js";
import { classifyTurnFailure } from "./recovery.js";
import {
  constructionSignature,
  createRuntime,
  noteOutboundDeltas,
  waitForTurnSettlement,
  type HostPosture,
  type MuseAttachment,
  type MuseRuntime,
  type SessionConstruction,
} from "./session.js";
import { prepareMuseConfigHome } from "./tool-proxy/config-home.js";
import {
  startToolProxyEndpoint,
  type ToolProxyEndpoint,
} from "./tool-proxy/endpoint.js";
import { MUSE_TOOL_PROXY_SCRIPT } from "./tool-proxy/script.js";
import {
  MUSE_DEFAULT_REASONING_LEVEL,
  MUSE_REASONING_EFFORTS,
  MUSE_SESSION_EXTENSION_KIND,
  museApprovalMode,
  museProviderOptionsSchema,
  type MuseProviderOptions,
} from "./vocabulary.js";

const CLIENT_NAME = "bb";
const CLIENT_VERSION = "1";
const HANDSHAKE_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 8_000;
const ZERO_WORK_SETTLEMENT_GRACE_MS = 1_500;

/**
 * A Muse session's route belongs to the process that opened it, and Muse cannot
 * replay its own encrypted reasoning across a route change. Codex kills its
 * child on release because it can resume a rollout cleanly; Muse cannot, so a
 * thread's child outlives ordinary release and is reclaimed only when bb is
 * plainly done with the thread.
 */
const ATTACHMENT_IDLE_SHUTDOWN_MS = 30 * 60_000;

type JsonRpcId = string | number;
type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

const io = createBridgeIo<OutboundMessage>();

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
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

const attachments = new Map<string, MuseAttachment>();
const attachmentsBySessionId = new Map<string, MuseAttachment>();
let runtimeSerialCounter = 0;

let bridgeDataDir: string | null = null;
let toolProxy: ToolProxyEndpoint | null = null;
let toolProxyScriptPath: string | null = null;
let maintenanceConnection: MspConnection | null = null;
let maintenanceConnectionPromise: Promise<MspConnection> | null = null;

/**
 * Drops a callback whose runtime has already been replaced, so a late reply can
 * never mutate the session that took its place.
 */
function liveRuntime(threadId: string, serial: number): MuseRuntime | null {
  const runtime = attachments.get(threadId)?.runtime ?? null;
  if (runtime === null || runtime.serial !== serial || runtime.closing) {
    return null;
  }
  return runtime;
}

/**
 * `thread/identity` precedes every delta for a session, so deltas produced
 * before the identity is known wait for it rather than racing it.
 */
function emitDeltas(
  attachment: MuseAttachment,
  deltas: readonly ThreadDelta[],
): void {
  if (deltas.length === 0) {
    return;
  }
  if (attachment.runtime !== null) {
    noteOutboundDeltas(attachment.runtime, deltas);
  }
  if (!attachment.identityAnnounced) {
    attachment.pendingPreIdentityDeltas.push(...deltas);
    return;
  }
  notify(THREAD_DELTA_NOTIFICATION_METHOD, {
    threadId: attachment.threadId,
    deltas,
  });
}

function announceIdentity(
  attachment: MuseAttachment,
  providerThreadId: string,
): void {
  if (
    attachment.providerSessionId !== null &&
    attachment.providerSessionId !== providerThreadId
  ) {
    attachmentsBySessionId.delete(attachment.providerSessionId);
  }
  attachment.providerSessionId = providerThreadId;
  attachmentsBySessionId.set(providerThreadId, attachment);
  if (attachment.identityAnnounced) {
    return;
  }
  attachment.identityAnnounced = true;
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: attachment.threadId,
    providerThreadId,
    sessionRestorable: true,
  });
  const buffered = attachment.pendingPreIdentityDeltas;
  attachment.pendingPreIdentityDeltas = [];
  if (buffered.length > 0) {
    notify(THREAD_DELTA_NOTIFICATION_METHOD, {
      threadId: attachment.threadId,
      deltas: buffered,
    });
  }
}

function sessionStateDelta(attachment: MuseAttachment): ThreadDelta {
  const runtime = attachment.runtime;
  return {
    kind: "extension.state",
    extensionKind: MUSE_SESSION_EXTENSION_KIND,
    payload: {
      approvalMode: runtime?.approvalMode ?? null,
      modelId: runtime?.modelId ?? null,
      museHome: runtime?.museHome ?? null,
      serverVersion: runtime?.serverVersion ?? null,
      sessionLogPath: runtime?.sessionLogPath ?? null,
    },
  };
}

function parseProviderOptions(options: unknown): MuseProviderOptions {
  const parsed = museProviderOptionsSchema.safeParse(options ?? {});
  return parsed.success ? parsed.data : {};
}

type PermissionPolicy = {
  permissionMode: string;
  permissionScope?: string;
  approvalReviewer?: string | null;
};

function approvalModeFor(policy: PermissionPolicy): string {
  return museApprovalMode(policy);
}

function fullAccess(policy: PermissionPolicy): boolean {
  return policy.permissionScope === "full" || policy.permissionMode === "full";
}

function postureFrom(
  options: MuseProviderOptions,
  policy: PermissionPolicy,
): HostPosture {
  return {
    disableSandbox: options.sandbox !== "on" || fullAccess(policy),
    sandboxNetwork: options.sandboxNetwork ?? "enabled",
    trustWorkspace: options.trustWorkspace !== false,
  };
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

export function buildConstruction(args: {
  cwd: string;
  options: BridgeExecutionOptions;
  instructionMode: string;
  dynamicTools: readonly DynamicTool[];
}): SessionConstruction {
  const providerOptions = parseProviderOptions(args.options.providerOptions);
  return {
    cwd: args.cwd,
    posture: postureFrom(providerOptions, args.options),
    approvalMode: approvalModeFor(args.options),
    model: args.options.model,
    toolNames: args.dynamicTools.map((tool) => tool.name),
    instructionMode: args.instructionMode,
  };
}

export function toolsSignature(tools: readonly DynamicTool[]): string {
  return createHash("sha256")
    .update(JSON.stringify(tools.map((tool) => tool.name).sort()))
    .digest("hex")
    .slice(0, 12);
}

let nextConfigHomeSerial = 0;

function configHomeSerial(): string {
  nextConfigHomeSerial += 1;
  return `${process.pid}-${nextConfigHomeSerial}`;
}

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
  const attachment = attachments.get(call.threadId);
  if (attachment === undefined || attachment.providerSessionId === null) {
    return {
      ok: false as const,
      error: `bb has no live session for thread ${call.threadId}`,
    };
  }
  const result = await sendRuntimeRequest(
    BRIDGE_INBOUND_REQUEST_METHODS.toolCall,
    {
      providerThreadId: attachment.providerSessionId,
      threadId: attachment.threadId,
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

/**
 * Muse reads its MCP configuration once, at host startup, and disables MCP for
 * the whole runtime if that audit fails. A configuration directory therefore
 * belongs to the child it was written for and is never touched again.
 */
async function buildConfigHome(
  threadId: string,
  tools: readonly DynamicTool[],
): Promise<string | null> {
  if (tools.length === 0) {
    return null;
  }
  const proxy = await ensureToolProxy();
  if (proxy === null || bridgeDataDir === null || toolProxyScriptPath === null) {
    return null;
  }
  return prepareMuseConfigHome({
    root: join(
      bridgeDataDir,
      "threads",
      threadId.replace(/[^A-Za-z0-9_-]/gu, "_"),
      `${toolsSignature(tools)}-${configHomeSerial()}`,
    ),
    mcpServer: {
      command: process.execPath,
      args: [toolProxyScriptPath],
      env: {
        /** bb ships as Electron, whose binary needs this to behave as node. */
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

function spawnChild(args: {
  posture: HostPosture;
  cwd: string;
  env: NodeJS.ProcessEnv;
  recordThreadId: string | null;
  onNotification(method: string, params: unknown): void;
  onRequest(method: string, params: unknown): void;
  onExit(info: MspExitInfo): void;
}): MspConnection {
  return createMspConnection({
    command: museExecutable(process.env),
    args: serveArgs(args.posture),
    cwd: args.cwd,
    env: args.env,
    recordThreadId: args.recordThreadId,
    onNotification: args.onNotification,
    onRequest: (method, params, responder) => {
      args.onRequest(method, params);
      responder.result({});
    },
    onExit: args.onExit,
  });
}

async function handshake(connection: MspConnection): Promise<{
  museHome: string;
  serverVersion: string;
}> {
  const result = await connection.request({
    method: MSP_METHODS.initialize,
    params: {
      clientInfo: { name: CLIENT_NAME, title: "bb", version: CLIENT_VERSION },
      capabilities: { requestedCapabilities: ["userShell"] },
    },
    resultSchema: mspInitializeResultSchema,
    timeoutMs: HANDSHAKE_TIMEOUT_MS,
  });
  connection.notify("initialized");
  return { museHome: result.museHome, serverVersion: result.serverInfo.version };
}

type ConstructionRequest =
  | { kind: "start" }
  | { kind: "fresh" }
  | { kind: "resume"; providerThreadId: string }
  | { kind: "fork"; sourceProviderThreadId: string };

/**
 * Builds the live runtime for an attachment: one `muse serve` child per thread,
 * as codex runs one app-server per session, so no thread can disturb another's
 * configuration, sandbox posture, or session state.
 */
async function constructRuntime(args: {
  attachment: MuseAttachment;
  options: BridgeExecutionOptions;
  request: ConstructionRequest;
}): Promise<MuseRuntime> {
  const { attachment } = args;
  releaseRuntime(attachment, { kill: true });

  const construction = attachment.construction;
  const configHome = await buildConfigHome(
    attachment.threadId,
    attachment.dynamicTools,
  );
  attachment.configHome = configHome;

  runtimeSerialCounter += 1;
  const serial = runtimeSerialCounter;
  const connection = spawnChild({
    posture: construction.posture,
    cwd: construction.cwd,
    env: childEnv(args.options.envVars, configHome),
    recordThreadId: attachment.threadId,
    onNotification: (method, params) =>
      handleChildNotification(attachment.threadId, serial, method, params),
    onRequest: (method, params) =>
      handleChildRequest(attachment.threadId, serial, method, params),
    onExit: (info) => handleChildExit(attachment.threadId, serial, info),
  });

  const runtime = createRuntime({
    serial,
    connection,
    cwd: construction.cwd,
    approvalMode: construction.approvalMode,
  });
  attachment.runtime = runtime;

  try {
    const info = await handshake(connection);
    runtime.museHome = info.museHome;
    runtime.serverVersion = info.serverVersion;

    const session = await openSession({
      connection,
      construction,
      request: args.request,
    });
    runtime.sessionId = session.sessionId;
    runtime.modelId = session.modelId;
    runtime.approvalMode = session.approvalMode ?? construction.approvalMode;
    runtime.sessionLogPath = session.path === "" ? null : session.path;

    announceIdentity(attachment, session.sessionId);
    emitDeltas(attachment, [
      { kind: "session.reset" },
      sessionStateDelta(attachment),
    ]);
    return runtime;
  } catch (error) {
    runtime.closing = true;
    if (attachment.runtime === runtime) {
      attachment.runtime = null;
    }
    connection.kill();
    throw error;
  }
}

async function openSession(args: {
  connection: MspConnection;
  construction: SessionConstruction;
  request: ConstructionRequest;
}): Promise<{
  sessionId: string;
  modelId: string | null;
  approvalMode: string | null;
  path: string;
}> {
  const { connection, construction, request } = args;

  if (request.kind === "start" || request.kind === "fresh") {
    const result = await connection.request({
      method: MSP_METHODS.sessionStart,
      params: {
        commandId: uuidV7(),
        workspaceRoot: construction.cwd,
        approvalMode: construction.approvalMode,
        ...(construction.model === undefined
          ? {}
          : { modelId: construction.model }),
      },
      resultSchema: mspSessionStartResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    return {
      sessionId: result.session.sessionId,
      modelId: result.session.modelId,
      approvalMode: result.session.approvalMode?.mode ?? null,
      path: result.session.path,
    };
  }

  const sourceId =
    request.kind === "resume"
      ? request.providerThreadId
      : request.sourceProviderThreadId;
  const result = await connection.request({
    method:
      request.kind === "resume"
        ? MSP_METHODS.sessionResume
        : MSP_METHODS.sessionFork,
    params: { commandId: uuidV7(), sessionId: sourceId, excludeItems: true },
    resultSchema: mspSessionResumeResultSchema,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return {
    sessionId: result.session.sessionId,
    modelId: result.session.modelId,
    approvalMode: result.session.approvalMode?.mode ?? null,
    path: result.session.path,
  };
}

function releaseRuntime(
  attachment: MuseAttachment,
  options: { kill: boolean },
): void {
  const runtime = attachment.runtime;
  if (runtime === null) {
    return;
  }
  runtime.closing = true;
  attachment.runtime = null;
  if (options.kill) {
    runtime.connection.kill();
  }
}

function forgetAttachment(attachment: MuseAttachment): void {
  attachment.closing = true;
  cancelIdleShutdown(attachment);
  releaseRuntime(attachment, { kill: true });
  attachments.delete(attachment.threadId);
  if (attachment.providerSessionId !== null) {
    attachmentsBySessionId.delete(attachment.providerSessionId);
  }
}

function cancelIdleShutdown(attachment: MuseAttachment): void {
  if (attachment.idleTimer !== null) {
    clearTimeout(attachment.idleTimer);
    attachment.idleTimer = null;
  }
}

function scheduleIdleShutdown(attachment: MuseAttachment): void {
  cancelIdleShutdown(attachment);
  attachment.idleTimer = setTimeout(() => {
    attachment.idleTimer = null;
    releaseRuntime(attachment, { kill: true });
  }, ATTACHMENT_IDLE_SHUTDOWN_MS);
  attachment.idleTimer.unref?.();
}

function attachmentForParams(params: unknown): MuseAttachment | null {
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string"
    ? (attachmentsBySessionId.get(sessionId) ?? null)
    : null;
}

function handleChildNotification(
  threadId: string,
  serial: number,
  method: string,
  params: unknown,
): void {
  const runtime = liveRuntime(threadId, serial);
  const attachment = attachments.get(threadId);
  if (runtime === null || attachment === undefined) {
    return;
  }
  if (attachmentForParams(params) !== attachment) {
    return;
  }

  switch (method) {
    case "approval/requested":
      openApprovalInteraction(attachment, runtime, params);
      return;
    case "userInput/requested":
      openUserInputInteraction(attachment, runtime, params);
      return;
    case "approval/resolved": {
      const approvalId = (params as { approvalId?: unknown }).approvalId;
      if (typeof approvalId === "string") {
        runtime.pendingApprovals.delete(approvalId);
      }
      return;
    }
    case "userInput/settled": {
      const userInputId = (params as { userInputId?: unknown }).userInputId;
      if (typeof userInputId === "string") {
        runtime.pendingUserInputs.delete(userInputId);
      }
      return;
    }
    case "session/approvalModeChanged": {
      const mode = (params as { mode?: unknown }).mode;
      if (typeof mode === "string") {
        runtime.approvalMode = mode;
        emitDeltas(attachment, [sessionStateDelta(attachment)]);
      }
      return;
    }
    case "session/modelChanged": {
      const modelId = (params as { modelId?: unknown }).modelId;
      if (typeof modelId === "string") {
        runtime.modelId = modelId;
        emitDeltas(attachment, [sessionStateDelta(attachment)]);
      }
      return;
    }
    default:
      break;
  }

  if (method === "turn/completed") {
    const classified = classifyTurnFailure(params);
    if (classified.restart !== null) {
      attachment.restartBeforeNextTurn = classified.restart;
    }
    if (classified.hint !== null) {
      notify(BRIDGE_NOTIFICATION_METHODS.providerRecovery, {
        threadId: attachment.threadId,
        ...classified.hint,
      });
    }
  }

  emitDeltas(attachment, runtime.translator.onNotification(method, params));
}

function handleChildRequest(
  threadId: string,
  serial: number,
  method: string,
  params: unknown,
): void {
  const runtime = liveRuntime(threadId, serial);
  const attachment = attachments.get(threadId);
  if (runtime === null || attachment === undefined) {
    return;
  }
  if (method === "approval/request") {
    openApprovalInteraction(attachment, runtime, params);
    return;
  }
  if (method === "userInput/request") {
    openUserInputInteraction(attachment, runtime, params);
  }
}

function handleChildExit(
  threadId: string,
  serial: number,
  info: MspExitInfo,
): void {
  const runtime = liveRuntime(threadId, serial);
  const attachment = attachments.get(threadId);
  if (runtime === null || attachment === undefined) {
    return;
  }
  const message = `muse serve exited (code ${info.code ?? "null"}, signal ${
    info.signal ?? "null"
  })${info.stderrTail === "" ? "" : `: ${info.stderrTail}`}`;

  emitDeltas(attachment, runtime.translator.settleOpenTurns("failed", message));
  releaseRuntime(attachment, { kill: false });
  attachment.restartBeforeNextTurn = {
    reason: "Muse exited; bb restored the session on a fresh process",
    fresh: false,
  };
  notify(BRIDGE_NOTIFICATION_METHODS.error, {
    threadId: attachment.threadId,
    ...(attachment.providerSessionId === null
      ? {}
      : { providerThreadId: attachment.providerSessionId }),
    message,
  });
}

/**
 * Muse namespaces an MCP tool as `mcp__<server>__<tool>` (and shows it dotted),
 * so a name is matched back to the tool bb declared.
 */
export function stripMcpPrefix(tool: string): string {
  const match = /^mcp__[^_]+(?:_[^_]+)*?__(?<name>.+)$/u.exec(tool);
  if (match?.groups?.name !== undefined) {
    return match.groups.name;
  }
  const dotted = /^mcp__[A-Za-z0-9_]+\.(?<name>.+)$/u.exec(tool);
  return dotted?.groups?.name ?? tool;
}

/**
 * bb's own plumbing must not read as a decision for the user: Muse's sandbox
 * gating the loopback connection to the tool proxy this bridge started, and
 * Muse gating a tool bb injected, which bb already governs on its own side.
 */
function isBridgeInfrastructureApproval(
  attachment: MuseAttachment,
  request: MspApprovalRequestParams,
): boolean {
  const subject = request.subject;
  if (
    subject.kind === "network" &&
    (subject.host === "127.0.0.1" || subject.host === "localhost") &&
    toolProxy !== null &&
    subject.port === toolProxy.port
  ) {
    return true;
  }
  const tool = subject.toolName ?? request.toolName;
  return attachment.construction.toolNames.includes(stripMcpPrefix(tool));
}

function openApprovalInteraction(
  attachment: MuseAttachment,
  runtime: MuseRuntime,
  params: unknown,
): void {
  const parsed = mspApprovalRequestParamsSchema.safeParse(params);
  if (!parsed.success) {
    return;
  }
  const request = parsed.data;
  if (runtime.pendingApprovals.has(request.approvalId)) {
    return;
  }
  if (isBridgeInfrastructureApproval(attachment, request)) {
    void decideApproval(runtime, request, { decision: "allow_for_session" });
    return;
  }
  const payload = approvalPayloadFromMsp(request);
  if (payload === null) {
    return;
  }
  runtime.pendingApprovals.set(request.approvalId, request);

  void sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
    providerThreadId: runtime.sessionId ?? attachment.threadId,
    threadId: attachment.threadId,
    turnId: request.turnId,
    payload,
    providerNativeIds: true,
  })
    .then((resolution) => {
      runtime.pendingApprovals.delete(request.approvalId);
      return decideApproval(runtime, request, resolution);
    })
    .catch(() => {
      runtime.pendingApprovals.delete(request.approvalId);
    });
}

async function decideApproval(
  runtime: MuseRuntime,
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
  if (choiceId === null || runtime.closing) {
    return;
  }
  try {
    await runtime.connection.request({
      method: MSP_METHODS.approvalDecide,
      params: {
        commandId: uuidV7(),
        sessionId: runtime.sessionId,
        approvalId: request.approvalId,
        requirementId: request.currentRequirementId,
        choiceId,
      },
      resultSchema: mspEmptyResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (
      error instanceof MspRequestError &&
      error.kind === "approvalAlreadyResolved"
    ) {
      return;
    }
    process.stderr.write(
      `muse bridge: approval decision failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function openUserInputInteraction(
  attachment: MuseAttachment,
  runtime: MuseRuntime,
  params: unknown,
): void {
  const parsed = mspUserInputRequestParamsSchema.safeParse(params);
  if (!parsed.success) {
    return;
  }
  const request = parsed.data;
  if (runtime.pendingUserInputs.has(request.userInputId)) {
    return;
  }
  const payload = userQuestionPayloadFromMsp(request);
  if (payload === null) {
    return;
  }
  runtime.pendingUserInputs.set(request.userInputId, request);

  void sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
    providerThreadId: runtime.sessionId ?? attachment.threadId,
    threadId: attachment.threadId,
    turnId: request.turnId,
    payload,
    providerNativeIds: true,
  })
    .then((resolution) => {
      runtime.pendingUserInputs.delete(request.userInputId);
      return settleUserInput(runtime, request, resolution);
    })
    .catch(() => {
      runtime.pendingUserInputs.delete(request.userInputId);
    });
}

async function settleUserInput(
  runtime: MuseRuntime,
  request: MspUserInputRequestParams,
  resolution: unknown,
): Promise<void> {
  const settlement = userInputSettlementFromResolution(
    request,
    resolution as PendingInteractionResolution,
  );
  if (runtime.closing) {
    return;
  }
  try {
    await runtime.connection.request({
      method: settlement.method,
      params: {
        commandId: uuidV7(),
        sessionId: runtime.sessionId,
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

/**
 * bb states how an agent should behave inside it as session instructions. MSP
 * has no system-prompt slot, so they ride the first turn the way the Claude
 * bridge delivers them, with `displayText` carrying the user's own prompt so the
 * transcript shows what they wrote.
 */
export function withInstructions(
  parts: readonly { type: "text" | "image"; [key: string]: unknown }[],
  instructions: string | null,
): { type: "text" | "image"; [key: string]: unknown }[] {
  if (instructions === null || instructions.trim() === "") {
    return [...parts];
  }
  return [
    {
      type: "text",
      text: `<system_instructions>\n${instructions.trim()}\n</system_instructions>`,
    },
    ...parts,
  ];
}

function promptDisplayText(input: readonly PromptInput[]): string | undefined {
  const text = input
    .filter((item): item is Extract<PromptInput, { type: "text" }> =>
      item.type === "text",
    )
    .map((item) => item.text)
    .join("")
    .trim();
  return text === "" ? undefined : text;
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

/**
 * The one place a turn may run from. A rebuild is owed when the child is gone,
 * when a failure asked for one, or when the execution options changed in a way
 * Muse only reads at session construction — the same three reasons codex
 * rebuilds, plus Muse's inability to carry reasoning across a route change.
 */
async function liveRuntimeForTurn(args: {
  attachment: MuseAttachment;
  options: BridgeExecutionOptions;
}): Promise<MuseRuntime> {
  const { attachment } = args;
  cancelIdleShutdown(attachment);

  const nextConstruction = buildConstruction({
    cwd: attachment.cwd,
    options: args.options,
    instructionMode: attachment.construction.instructionMode,
    dynamicTools: attachment.dynamicTools,
  });
  const nextSignature = constructionSignature(nextConstruction);

  const runtime = attachment.runtime;
  const restart = attachment.restartBeforeNextTurn;
  const optionsChanged = nextSignature !== attachment.constructionSignature;

  if (
    runtime !== null &&
    !runtime.closing &&
    !runtime.connection.exited &&
    restart === null &&
    !optionsChanged
  ) {
    return runtime;
  }

  if (runtime !== null && !runtime.closing) {
    emitDeltas(
      attachment,
      runtime.translator.settleOpenTurns(
        "interrupted",
        "The Muse session was replaced",
      ),
    );
  }

  attachment.restartBeforeNextTurn = null;
  attachment.construction = nextConstruction;
  attachment.constructionSignature = nextSignature;

  const fresh = restart?.fresh === true;
  const resumeId = attachment.providerSessionId;
  const request: ConstructionRequest =
    fresh || resumeId === null
      ? { kind: "fresh" }
      : { kind: "resume", providerThreadId: resumeId };

  const reason =
    restart?.reason ??
    (optionsChanged
      ? "Execution settings changed; the Muse session was rebuilt to apply them"
      : "Muse exited; bb restored the session on a fresh process");

  const replacement = await constructRuntime({
    attachment,
    options: args.options,
    request,
  });
  notify(BRIDGE_NOTIFICATION_METHODS.sessionReplaced, {
    threadId: attachment.threadId,
    providerThreadId: replacement.sessionId,
    reason,
    contextLost: fresh,
  });
  if (fresh) {
    emitDeltas(attachment, [
      {
        kind: "provider.warning",
        summary: "Muse started a fresh session for this thread",
        details: `${reason}. Durable bb state is untouched; the in-session conversation is not.`,
      },
    ]);
  }
  return replacement;
}

let zeroWorkCounter = 0;

/**
 * A prompt the provider handles without doing work must still settle, or the
 * thread hangs on accepted input that never opens a turn.
 */
function scheduleZeroWorkSettlement(args: {
  attachment: MuseAttachment;
  runtime: MuseRuntime;
  clientRequestId: string;
}): void {
  const { attachment, runtime, clientRequestId } = args;
  const timer = setTimeout(() => {
    const live = liveRuntime(attachment.threadId, runtime.serial);
    if (live === null || live.openTurnIds.size > 0) {
      return;
    }
    zeroWorkCounter += 1;
    const providerTurnId = `zero-work-${zeroWorkCounter}`;
    emitDeltas(attachment, [
      { kind: "turn.open", providerTurnId },
      { kind: "input.accepted", clientRequestId, providerTurnId },
      { kind: "turn.boundary", providerTurnId, status: "completed" },
    ]);
  }, ZERO_WORK_SETTLEMENT_GRACE_MS);
  timer.unref?.();
}

async function submitTurn(args: {
  attachment: MuseAttachment;
  input: readonly PromptInput[];
  options: BridgeExecutionOptions;
  clientRequestId?: string;
}): Promise<void> {
  const { attachment, options } = args;
  let acceptedEmitted = false;

  try {
    const runtime = await liveRuntimeForTurn({ attachment, options });

    if (args.clientRequestId !== undefined) {
      emitDeltas(attachment, [
        { kind: "input.accepted", clientRequestId: args.clientRequestId },
      ]);
      acceptedEmitted = true;
    }

    if (isStandaloneBuiltinCompactCommand(args.input)) {
      await runtime.connection.request({
        method: MSP_METHODS.sessionCompact,
        params: { commandId: uuidV7(), sessionId: runtime.sessionId },
        resultSchema: mspCommandAckSchema,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      emitDeltas(attachment, [
        { kind: "turn.open" },
        { kind: "turn.boundary", status: "completed" },
      ]);
      return;
    }

    const instructions = attachment.pendingInstructions;
    const input = withInstructions(
      await turnInputParts(args.input),
      instructions,
    );
    const displayText =
      instructions === null ? undefined : promptDisplayText(args.input);
    const reasoningEffort = reasoningEffortFor(options.reasoningLevel);

    await runtime.connection.request({
      method: MSP_METHODS.turnStart,
      params: {
        commandId: uuidV7(),
        sessionId: runtime.sessionId,
        input,
        ifBusy: "queue",
        ...(displayText === undefined ? {} : { displayText }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      resultSchema: mspTurnStartResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    attachment.pendingInstructions = null;
    if (args.clientRequestId !== undefined) {
      scheduleZeroWorkSettlement({
        attachment,
        runtime,
        clientRequestId: args.clientRequestId,
      });
    }
  } catch (error) {
    /**
     * Accepted input that never settles leaves bb refusing every later turn on
     * the thread, so every failure on this path closes the turn — including one
     * thrown before the input was ever accepted.
     */
    const message = error instanceof Error ? error.message : String(error);
    const deltas: ThreadDelta[] = [];
    if (!acceptedEmitted && args.clientRequestId !== undefined) {
      deltas.push({
        kind: "input.accepted",
        clientRequestId: args.clientRequestId,
      });
    }
    deltas.push(
      { kind: "provider.error", message, settlesTurn: true },
      {
        kind: "turn.boundary",
        status: "failed",
        claimIfIdle: true,
        error: { message },
      },
    );
    emitDeltas(attachment, deltas);
    if (error instanceof MspExitedError) {
      notify(BRIDGE_NOTIFICATION_METHODS.providerRecovery, {
        threadId: attachment.threadId,
        kind: "restartRecommended",
        message,
        retryable: true,
      });
    }
  }
}

/**
 * Muse's catalog labels a model with its own id. bb strips the declared brand
 * prefix from what it shows, so an id becomes a title here.
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

/**
 * Model listing runs on a child of its own, as codex keeps a separate
 * app-server for it: a catalog read must never disturb, or be disturbed by, a
 * thread's session.
 */
async function maintenanceChild(cwd: string): Promise<MspConnection> {
  if (maintenanceConnection !== null && !maintenanceConnection.exited) {
    return maintenanceConnection;
  }
  if (maintenanceConnectionPromise !== null) {
    return maintenanceConnectionPromise;
  }
  const promise = (async () => {
    const connection = spawnChild({
      posture: {
        disableSandbox: true,
        sandboxNetwork: "enabled",
        trustWorkspace: false,
      },
      cwd,
      env: childEnv(undefined, null),
      recordThreadId: null,
      onNotification: () => {},
      onRequest: () => {},
      onExit: () => {
        if (maintenanceConnection === connection) {
          maintenanceConnection = null;
        }
      },
    });
    try {
      await handshake(connection);
      maintenanceConnection = connection;
      return connection;
    } catch (error) {
      connection.kill();
      throw error;
    }
  })();
  maintenanceConnectionPromise = promise;
  try {
    return await promise;
  } finally {
    if (maintenanceConnectionPromise === promise) {
      maintenanceConnectionPromise = null;
    }
  }
}

async function listModels(cwd: string): Promise<AvailableModel[]> {
  const connection = await maintenanceChild(cwd);
  const result = await connection.request({
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

function registerAttachment(args: {
  threadId: string;
  cwd: string;
  options: BridgeExecutionOptions;
  instructionMode: string;
  dynamicTools: readonly DynamicTool[];
}): MuseAttachment {
  const existing = attachments.get(args.threadId);
  if (existing !== undefined) {
    forgetAttachment(existing);
  }
  const construction = buildConstruction({
    cwd: args.cwd,
    options: args.options,
    instructionMode: args.instructionMode,
    dynamicTools: args.dynamicTools,
  });
  const instructions =
    args.options.instructions !== undefined &&
    args.options.instructions.trim() !== ""
      ? args.options.instructions
      : null;
  const attachment: MuseAttachment = {
    threadId: args.threadId,
    cwd: args.cwd,
    construction,
    constructionSignature: constructionSignature(construction),
    dynamicTools: [...args.dynamicTools],
    instructions,
    pendingInstructions: instructions,
    providerSessionId: null,
    configHome: null,
    runtime: null,
    identityAnnounced: false,
    pendingPreIdentityDeltas: [],
    restartBeforeNextTurn: null,
    idleTimer: null,
    closing: false,
  };
  attachments.set(args.threadId, attachment);
  return attachment;
}

function constructionError(id: JsonRpcId, error: unknown): void {
  io.sendError(
    id,
    BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
    error instanceof Error ? error.message : String(error),
  );
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
    const attachment = registerAttachment({
      threadId,
      cwd,
      options,
      instructionMode: parsed.data.instructionMode,
      dynamicTools: parsed.data.dynamicTools ?? [],
    });
    try {
      const runtime = await constructRuntime({
        attachment,
        options,
        request: { kind: "start" },
      });
      io.sendResult(id, {
        providerThreadId: runtime.sessionId,
        sessionRestorable: runtime.sessionLogPath !== null,
      });
    } catch (error) {
      forgetAttachment(attachment);
      constructionError(id, error);
      return;
    }
    if (input !== undefined && input.length > 0) {
      await submitTurn({ attachment, input, options });
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
    const existing = attachments.get(threadId);
    if (
      existing !== undefined &&
      existing.providerSessionId === providerThreadId &&
      existing.runtime !== null &&
      !existing.runtime.closing &&
      !existing.runtime.connection.exited
    ) {
      /**
       * This thread's own child is still live with the session loaded. Reusing
       * it keeps the route, and therefore the session's reasoning history,
       * which a resume onto a fresh process would invalidate.
       */
      cancelIdleShutdown(existing);
      io.sendResult(id, { providerThreadId, sessionRestorable: true });
      return;
    }

    const attachment = registerAttachment({
      threadId,
      cwd,
      options,
      instructionMode: parsed.data.instructionMode,
      dynamicTools: parsed.data.dynamicTools ?? [],
    });
    attachment.providerSessionId = providerThreadId;
    try {
      const runtime = await constructRuntime({
        attachment,
        options,
        request: { kind: "resume", providerThreadId },
      });
      io.sendResult(id, {
        providerThreadId: runtime.sessionId,
        sessionRestorable: runtime.sessionLogPath !== null,
      });
    } catch (error) {
      forgetAttachment(attachment);
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
      constructionError(id, error);
    }
  },

  [BRIDGE_REQUEST_METHODS.threadFork]: async (id, params) => {
    const parsed = threadForkParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadFork, parsed.error.issues);
      return;
    }
    if (parsed.data.sourceProviderCheckpointId !== undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.FORK_CHECKPOINT_UNSUPPORTED,
        "Muse forks at the tip of a session, not at a checkpoint",
      );
      return;
    }
    const { threadId, cwd, options, sourceProviderThreadId } = parsed.data;
    const attachment = registerAttachment({
      threadId,
      cwd,
      options,
      instructionMode: parsed.data.instructionMode,
      dynamicTools: parsed.data.dynamicTools ?? [],
    });
    try {
      const runtime = await constructRuntime({
        attachment,
        options,
        request: { kind: "fork", sourceProviderThreadId },
      });
      io.sendResult(id, {
        providerThreadId: runtime.sessionId,
        sessionRestorable: runtime.sessionLogPath !== null,
      });
    } catch (error) {
      forgetAttachment(attachment);
      constructionError(id, error);
    }
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: async (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const attachment = attachments.get(parsed.data.threadId);
    if (attachment === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
        `No Muse session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`,
      );
      return;
    }
    io.sendResult(id, {});
    await submitTurn({
      attachment,
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
    const attachment = attachments.get(parsed.data.threadId);
    const runtime = attachment?.runtime ?? null;
    if (
      attachment === undefined ||
      runtime === null ||
      runtime.closing ||
      runtime.connection.exited ||
      !runtime.openTurnIds.has(parsed.data.expectedTurnId)
    ) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        `Muse turn ${parsed.data.expectedTurnId} is no longer running`,
      );
      return;
    }
    try {
      const input = await turnInputParts(parsed.data.input);
      const reasoningEffort = reasoningEffortFor(
        parsed.data.options.reasoningLevel,
      );
      await runtime.connection.request({
        method: MSP_METHODS.turnSteer,
        params: {
          commandId: uuidV7(),
          sessionId: runtime.sessionId,
          expectedTurnId: parsed.data.expectedTurnId,
          input,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
        resultSchema: mspTurnSteerResultSchema,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      emitDeltas(attachment, [
        {
          kind: "input.accepted",
          clientRequestId: parsed.data.clientRequestId,
          providerTurnId: parsed.data.expectedTurnId,
        },
      ]);
      io.sendResult(id, {});
    } catch (error) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        error instanceof Error ? error.message : String(error),
        {
          recovery: {
            kind: "staleTurn",
            message: "The Muse turn this steer targeted is gone.",
            retryable: false,
          },
        },
      );
    }
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: async (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const { threadId, intent, activeTurnId } = parsed.data;
    const attachment = attachments.get(threadId);
    if (attachment === undefined) {
      io.sendResult(id, {});
      return;
    }

    if (intent === "interrupt") {
      await interruptAttachment(attachment, activeTurnId);
    }

    /**
     * `release` detaches an idle session and must fabricate nothing. The child
     * stays alive so a later turn keeps this session's route; it is reclaimed by
     * the idle timer, by `thread/discard`, or when the bridge shuts down.
     */
    scheduleIdleShutdown(attachment);
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
    const attachment = attachments.get(parsed.data.threadId);
    if (attachment !== undefined) {
      forgetAttachment(attachment);
    }
    io.sendResult(id, {});
  },
};

async function interruptAttachment(
  attachment: MuseAttachment,
  activeTurnId: string | null,
): Promise<void> {
  const runtime = attachment.runtime;
  if (runtime === null || runtime.closing || runtime.connection.exited) {
    return;
  }
  const openTurns = [...runtime.openTurnIds];
  if (openTurns.length === 0) {
    return;
  }
  const turnId = activeTurnId ?? openTurns[0];

  try {
    await runtime.connection.request({
      method: MSP_METHODS.turnInterrupt,
      params: {
        commandId: uuidV7(),
        sessionId: runtime.sessionId,
        ...(activeTurnId === null ? {} : { turnId: activeTurnId }),
      },
      resultSchema: mspTurnInterruptResultSchema,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  } catch {
    /** Settle locally below; a stop must not wait on a failed interrupt. */
  }

  const settled = await waitForTurnSettlement(
    runtime,
    turnId,
    INTERRUPT_SETTLE_TIMEOUT_MS,
  );
  if (!settled) {
    emitDeltas(
      attachment,
      runtime.translator.settleOpenTurns("interrupted", "Interrupted by bb"),
    );
  }
}

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
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
  maintenanceConnection?.kill();
  maintenanceConnection = null;
  for (const attachment of [...attachments.values()]) {
    forgetAttachment(attachment);
  }
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
