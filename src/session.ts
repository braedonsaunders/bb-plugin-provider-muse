import type { DynamicTool, ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import type { MspConnection } from "./msp/connection.js";
import { MuseTranslator } from "./translate.js";
import type { MspApprovalRequestParams, MspUserInputRequestParams } from "./msp/schemas.js";

/**
 * The bridge keeps the same two-layer shape the first-party bridges keep.
 *
 * An **attachment** is what bb owns: one per thread, durable for as long as bb
 * holds the thread, carrying the provider session id, the construction inputs,
 * and the reason a rebuild is owed. A **runtime** is the live `muse serve`
 * process and the loaded session inside it — disposable, replaced whenever the
 * child dies, the execution options change, or Muse refuses to carry on.
 *
 * Every asynchronous callback carries the runtime's `serial`, so a reply that
 * arrives after a replacement can be dropped instead of mutating the session
 * that took its place.
 */

export interface HostPosture {
  disableSandbox: boolean;
  sandboxNetwork: "enabled" | "proxy-only" | "restricted";
  trustWorkspace: boolean;
}

export interface SessionConstruction {
  cwd: string;
  posture: HostPosture;
  approvalMode: string;
  model: string | undefined;
  toolNames: string[];
  instructionMode: string;
}

export interface MuseRuntime {
  serial: number;
  connection: MspConnection;
  sessionId: string | null;
  museHome: string | null;
  serverVersion: string | null;
  sessionLogPath: string | null;
  approvalMode: string;
  modelId: string | null;
  translator: MuseTranslator;
  openTurnIds: Set<string>;
  turnSettledWaiters: Map<string, Array<() => void>>;
  pendingApprovals: Map<string, MspApprovalRequestParams>;
  pendingUserInputs: Map<string, MspUserInputRequestParams>;
  closing: boolean;
}

export interface MuseAttachment {
  threadId: string;
  cwd: string;
  construction: SessionConstruction;
  constructionSignature: string;
  dynamicTools: DynamicTool[];
  instructions: string | null;
  /** Delivered on the next turn, then cleared: MSP has no system-prompt slot. */
  pendingInstructions: string | null;
  providerSessionId: string | null;
  configHome: string | null;
  runtime: MuseRuntime | null;
  identityAnnounced: boolean;
  pendingPreIdentityDeltas: ThreadDelta[];
  /** Set when the next turn must rebuild; `fresh` drops the session's history. */
  restartBeforeNextTurn: { reason: string; fresh: boolean } | null;
  idleTimer: NodeJS.Timeout | null;
  closing: boolean;
}

export function constructionSignature(
  construction: SessionConstruction,
): string {
  return JSON.stringify({
    cwd: construction.cwd,
    approvalMode: construction.approvalMode,
    disableSandbox: construction.posture.disableSandbox,
    sandboxNetwork: construction.posture.sandboxNetwork,
    trustWorkspace: construction.posture.trustWorkspace,
    instructionMode: construction.instructionMode,
    tools: [...construction.toolNames].sort(),
  });
}

export function createRuntime(args: {
  serial: number;
  connection: MspConnection;
  cwd: string;
  approvalMode: string;
}): MuseRuntime {
  return {
    serial: args.serial,
    connection: args.connection,
    sessionId: null,
    museHome: null,
    serverVersion: null,
    sessionLogPath: null,
    approvalMode: args.approvalMode,
    modelId: null,
    translator: new MuseTranslator({ cwd: args.cwd }),
    openTurnIds: new Set(),
    turnSettledWaiters: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    closing: false,
  };
}

/**
 * Waits for a turn to reach its terminal, the way an interrupt has to before
 * `thread/stop` answers: after the stop is answered bb detaches the thread, so
 * anything still owed must already be on the wire.
 */
export function waitForTurnSettlement(
  runtime: MuseRuntime,
  turnId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!runtime.openTurnIds.has(turnId)) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const onSettled = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      const waiters = runtime.turnSettledWaiters.get(turnId);
      if (waiters !== undefined) {
        runtime.turnSettledWaiters.set(
          turnId,
          waiters.filter((waiter) => waiter !== onSettled),
        );
      }
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const waiters = runtime.turnSettledWaiters.get(turnId) ?? [];
    waiters.push(onSettled);
    runtime.turnSettledWaiters.set(turnId, waiters);
  });
}

/**
 * Tracks turn lifecycle on the way out so an interrupt, a child exit, or a
 * replacement can settle whatever is still open.
 */
export function noteOutboundDeltas(
  runtime: MuseRuntime,
  deltas: readonly ThreadDelta[],
): void {
  for (const delta of deltas) {
    if (delta.kind === "turn.open" && delta.providerTurnId !== undefined) {
      runtime.openTurnIds.add(delta.providerTurnId);
    }
    if (delta.kind === "turn.boundary" && delta.providerTurnId !== undefined) {
      runtime.openTurnIds.delete(delta.providerTurnId);
      const waiters = runtime.turnSettledWaiters.get(delta.providerTurnId);
      if (waiters !== undefined) {
        runtime.turnSettledWaiters.delete(delta.providerTurnId);
        for (const resolve of waiters) {
          resolve();
        }
      }
    }
  }
}
