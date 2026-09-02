import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordedAtToMs,
  rollingWindowResetsAt,
  scanMuseUsage,
  usageSampleFromRecord,
} from "../src/usage-scan.js";
import { credentialsFromAuthFile } from "../src/maintenance.js";

const HOUR_MS = 60 * 60 * 1_000;

function modelCompletedRecord(args: {
  atMs: number;
  input: number;
  output: number;
}): string {
  return JSON.stringify({
    schema_version: 1,
    id: "rec",
    recorded_at: args.atMs * 1_000,
    record_type: "event",
    payload_type: "runtime.session",
    payload: {
      kind: "run",
      run_id: "run-1",
      event: {
        kind: "model_completed",
        model: "muse-spark-1.3-contributor",
        duration_ms: 3_710,
        usage: {
          input_tokens: args.input,
          output_tokens: args.output,
          cached_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 12,
        },
      },
    },
  });
}

describe("record decoding", () => {
  it("reads microsecond and millisecond timestamps", () => {
    expect(recordedAtToMs(1_788_388_103_651_804)).toBe(1_788_388_103_652);
    expect(recordedAtToMs(1_788_388_103_651)).toBe(1_788_388_103_651);
    expect(recordedAtToMs("nope")).toBeNull();
  });

  it("takes usage only from a model completion", () => {
    const sample = usageSampleFromRecord(
      modelCompletedRecord({ atMs: 1_700_000_000_000, input: 100, output: 20 }),
    );
    expect(sample).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 12,
      model: "muse-spark-1.3-contributor",
    });
    expect(
      usageSampleFromRecord(
        JSON.stringify({
          recorded_at: 1,
          payload: { kind: "run", event: { kind: "model_request_configured" } },
        }),
      ),
    ).toBeNull();
    expect(usageSampleFromRecord("{ not json")).toBeNull();
  });
});

describe("rolling window scan", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bb-muse-usage-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(atMs: number, records: string[]): void {
    const day = new Date(atMs);
    const dir = join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
      `session-${atMs}`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), `${records.join("\n")}\n`);
  }

  it("counts only completions inside the window", async () => {
    const nowMs = Date.now();
    writeSession(nowMs - HOUR_MS, [
      modelCompletedRecord({ atMs: nowMs - HOUR_MS, input: 1_000, output: 200 }),
      modelCompletedRecord({
        atMs: nowMs - 9 * HOUR_MS,
        input: 9_999,
        output: 9_999,
      }),
    ]);

    const scan = await scanMuseUsage({
      sessionsDir: root,
      nowMs,
      windowMs: 5 * HOUR_MS,
    });

    expect(scan.samples).toHaveLength(1);
    expect(scan.windowTokens).toBe(1_200);
    expect(rollingWindowResetsAt(scan, 5 * HOUR_MS)).toBe(
      new Date(nowMs - HOUR_MS + 5 * HOUR_MS).toISOString(),
    );
  });

  it("returns an empty window when nothing ran", async () => {
    const scan = await scanMuseUsage({
      sessionsDir: join(root, "missing"),
      nowMs: Date.now(),
      windowMs: 5 * HOUR_MS,
    });
    expect(scan.windowTokens).toBe(0);
    expect(rollingWindowResetsAt(scan, 5 * HOUR_MS)).toBeNull();
  });
});

describe("credentials", () => {
  const authFile = {
    schema_version: 2,
    providers: {
      meta: {
        mechanism: "oauth",
        storage: "keychain",
        obtained_via: "device_code",
        api_base_url: "https://api.meta.ai/v1",
        user_email: "someone@example.com",
      },
    },
  };

  it("reads an account session", () => {
    expect(credentialsFromAuthFile(authFile, Date.now(), {})).toEqual({
      mechanism: "oauth",
      accountEmail: "someone@example.com",
      planLabel: null,
      expired: false,
    });
  });

  it("lets an environment key win over a stored session", () => {
    expect(
      credentialsFromAuthFile(authFile, Date.now(), {
        META_API_KEY: "key",
      }),
    ).toMatchObject({ mechanism: "apiKey" });
  });

  it("reports an expired session", () => {
    const expired = {
      providers: {
        meta: { mechanism: "oauth", expires_at: "2020-01-01T00:00:00Z" },
      },
    };
    expect(credentialsFromAuthFile(expired, Date.now(), {})).toMatchObject({
      expired: true,
    });
  });

  it("has no credentials when nothing is stored", () => {
    expect(credentialsFromAuthFile({}, Date.now(), {})).toBeNull();
    expect(credentialsFromAuthFile(null, Date.now(), {})).toBeNull();
  });
});
