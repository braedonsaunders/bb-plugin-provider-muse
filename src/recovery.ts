import type { ProviderRecoveryHint } from "@get-bb/plugin-sdk/provider-bridge";
import { mspTurnCompletedParamsSchema } from "./msp/schemas.js";

/**
 * MSP types a turn failure only as broadly as `modelError`, so the condition a
 * client must act on lives in the message. The first-party bridges match text
 * here too — codex keeps regexes for its auth and rate-limit wording — because
 * the alternative is treating an expired login as an ordinary failure. The
 * matches stay narrow and drive a typed hint, never a fabricated result.
 */

const AUTH_PATTERN =
  /\b(?:40[13]|unauthori[sz]ed|authentication failed|oauth|not authenticated|sign[- ]?in)\b/i;
const RATE_LIMIT_PATTERN =
  /\b(?:429|rate[-\s]?limit(?:ed)?|quota|usage limit|resets_at|billing)\b/i;
const INCOMPATIBLE_HISTORY_PATTERN =
  /provider-private history is incompatible|reasoning replay .* provider attribution/i;

export interface TurnFailureClassification {
  /** A rebuild is owed before the next turn. */
  restart: { reason: string; fresh: boolean } | null;
  /** A typed hint bb's runtime acts on. */
  hint: ProviderRecoveryHint | null;
}

export function classifyTurnFailure(
  params: unknown,
): TurnFailureClassification {
  const parsed = mspTurnCompletedParamsSchema.safeParse(params);
  if (!parsed.success || parsed.data.terminal !== "failed") {
    return { restart: null, hint: null };
  }
  const message = parsed.data.error?.message ?? parsed.data.reason ?? "";
  if (message === "") {
    return { restart: null, hint: null };
  }

  /**
   * Muse cannot replay its own encrypted reasoning once the session's route
   * changes, and the offending item stays in the session, so only a session
   * without that history can run again.
   */
  if (INCOMPATIBLE_HISTORY_PATTERN.test(message)) {
    return {
      restart: {
        reason:
          "Muse could not replay this session's reasoning history after its route changed, so bb started a fresh session",
        fresh: true,
      },
      hint: null,
    };
  }

  if (AUTH_PATTERN.test(message)) {
    return {
      restart: {
        reason: "Muse session restarted after an authentication failure",
        fresh: false,
      },
      hint: { kind: "authRequired", message, retryable: false },
    };
  }

  if (RATE_LIMIT_PATTERN.test(message)) {
    return {
      restart: null,
      hint: { kind: "rateLimited", message, retryable: false },
    };
  }

  return { restart: null, hint: null };
}
