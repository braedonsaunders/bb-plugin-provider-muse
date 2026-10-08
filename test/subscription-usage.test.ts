import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  createMuseUsageStore,
  museUsageWindows,
  parseSubscriptionUsage,
} from "../src/subscription-usage.js";
import { getMuseProviderUsage } from "../src/maintenance.js";

const HOUR_MS = 60 * 60 * 1_000;
const NOW = Date.parse("2026-10-08T23:43:00.000Z");
const fixtureDir = dirname(fileURLToPath(import.meta.url));

/** Verbatim `usage/changed` params from Muse Code 1.4.4. */
const READING = {
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791520983000 },
  weekly: { usedPercent: 40, resetsAtMs: 1791763200000 },
  tier: "27681631238169137",
  observedAtMs: 1791502984748,
};

describe("museUsageWindows", () => {
  it("names the short window from its length and keeps the reported resets", () => {
    const usage = parseSubscriptionUsage(READING)!;
    expect(museUsageWindows(usage, NOW)).toEqual([
      {
        label: "5-hour limit",
        usedPercent: 0,
        resetsAt: new Date(1791520983000).toISOString(),
      },
      {
        label: "Weekly limit",
        usedPercent: 40,
        resetsAt: new Date(1791763200000).toISOString(),
      },
    ]);
  });

  it("clamps an over-quota reading instead of drawing past the meter", () => {
    const usage = parseSubscriptionUsage({
      ...READING,
      window: { ...READING.window, usedPercent: 140 },
    })!;
    expect(museUsageWindows(usage, NOW)[0]!.usedPercent).toBe(100);
  });

  it("reports a lapsed window as unspent rather than as its old number", () => {
    const usage = parseSubscriptionUsage({
      ...READING,
      window: { ...READING.window, usedPercent: 90 },
      weekly: { usedPercent: 75, resetsAtMs: NOW - HOUR_MS },
    })!;
    const later = READING.window.resetsAtMs + HOUR_MS;
    const [window, weekly] = museUsageWindows(usage, later);
    expect(window).toEqual({ label: "5-hour limit", usedPercent: 0, resetsAt: null });
    expect(weekly!.usedPercent).toBe(0);
    expect(weekly!.resetsAt).toBe(
      new Date(NOW - HOUR_MS + 7 * 24 * HOUR_MS).toISOString(),
    );
  });

  it("rejects payloads that are not a full reading", () => {
    expect(parseSubscriptionUsage({})).toBeNull();
    expect(parseSubscriptionUsage({ ...READING, weekly: undefined })).toBeNull();
    expect(parseSubscriptionUsage(null)).toBeNull();
  });
});

describe("createMuseUsageStore", () => {
  it("keeps the newest reading and survives a restart through its file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-muse-usage-"));
    try {
      const path = join(dir, "nested", "subscription-usage.json");
      const store = createMuseUsageStore(() => path);
      store.record({ ...READING, observedAtMs: 20 });
      store.record({ ...READING, observedAtMs: 10, tier: "stale" });
      store.record({ nonsense: true });
      expect((await store.latest())?.observedAtMs).toBe(20);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(JSON.parse(readFileSync(path, "utf8")).observedAtMs).toBe(20);

      const restarted = createMuseUsageStore(() => path);
      expect((await restarted.latest())?.tier).toBe(READING.tier);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees a reading another worker saved after it last looked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-muse-usage-"));
    try {
      const path = join(dir, "subscription-usage.json");
      const answering = createMuseUsageStore(() => path);
      const observing = createMuseUsageStore(() => path);
      answering.record({ ...READING, observedAtMs: 5 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await answering.latest())?.observedAtMs).toBe(5);

      observing.record({ ...READING, observedAtMs: 9 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await answering.latest())?.observedAtMs).toBe(9);

      /** A late, older reading never overwrites the saved newer one. */
      const stale = createMuseUsageStore(() => path);
      stale.record({ ...READING, observedAtMs: 7 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(JSON.parse(readFileSync(path, "utf8")).observedAtMs).toBe(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves from memory when there is nowhere to save", async () => {
    const store = createMuseUsageStore(() => null);
    expect(await store.latest()).toBeNull();
    store.record(READING);
    expect((await store.latest())?.observedAtMs).toBe(READING.observedAtMs);
  });
});

describe("getMuseProviderUsage", () => {
  const env = {
    ...process.env,
    BB_MUSE_EXECUTABLE: join(fixtureDir, "fake-muse-serve.mjs"),
    META_API_KEY: "usage-key",
  };

  it("reports the plan's own meters whenever a reading exists", async () => {
    const result = await getMuseProviderUsage({
      env,
      nowMs: NOW,
      tokenBudget: 1_000,
      subscription: parseSubscriptionUsage(READING),
    });
    expect(result.usage).toMatchObject({
      status: "ok",
      windows: [
        { label: "5-hour limit", usedPercent: 0 },
        { label: "Weekly limit", usedPercent: 40 },
      ],
    });
  });

  it("shows no meter without a reading or a budget", async () => {
    const result = await getMuseProviderUsage({ env, nowMs: NOW });
    expect(result.usage).toMatchObject({ status: "ok", windows: [] });
  });
});

const previousExecutable = process.env.BB_MUSE_EXECUTABLE;
const previousApiKey = process.env.META_API_KEY;

afterAll(() => {
  for (const [name, value] of [
    ["BB_MUSE_EXECUTABLE", previousExecutable],
    ["META_API_KEY", previousApiKey],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

it("answers provider usage with the meters a thread's host pushed", async () => {
  process.env.BB_MUSE_EXECUTABLE = join(fixtureDir, "fake-muse-serve.mjs");
  process.env.META_API_KEY = "usage-key";
  const { handleLine } = await import("../src/provider-bridge.js");
  const harness = createBridgeJsonRpcTestHarness(handleLine);
  const workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-usage-live-"));
  const options = {
    model: "muse-spark-1.3",
    permissionMode: "auto",
    permissionScope: "workspace",
    approvalReviewer: "automatic",
    permissionEscalation: "ask",
  } as const;
  try {
    harness.sendRequest(1, "initialize", {
      protocolVersion: 1,
      client: { name: "bb", version: "1" },
    });
    await harness.waitForResponse(1);

    harness.sendRequest(2, "provider/usage", { providerId: "muse" });
    const before = (await harness.waitForResponse(2)) as {
      result?: { usage?: { windows?: unknown[] } };
    };
    expect(before.result?.usage?.windows).toEqual([]);

    const threadId = `thr_${randomUUID().slice(0, 8)}`;
    harness.sendRequest(3, "thread/start", {
      threadId,
      cwd: workspaceDir,
      instructionMode: "append",
      options,
    });
    const started = (await harness.waitForResponse(3)) as {
      result?: { providerThreadId?: string };
    };
    harness.sendRequest(4, "turn/start", {
      threadId,
      providerThreadId: started.result?.providerThreadId ?? "",
      clientRequestId: "creq_usagezzzzz",
      input: [{ type: "text", text: "hello" }],
      options,
    });
    await harness.waitForResponse(4);

    let windows: Array<{ label: string; usedPercent: number }> = [];
    const deadline = Date.now() + 15_000;
    let id = 10;
    while (Date.now() < deadline && windows.length === 0) {
      await harness.flushWork();
      await new Promise((resolve) => setTimeout(resolve, 50));
      harness.takeMessages();
      id += 1;
      harness.sendRequest(id, "provider/usage", { providerId: "muse" });
      const response = (await harness.waitForResponse(id)) as {
        result?: { usage?: { windows?: typeof windows } };
      };
      windows = response.result?.usage?.windows ?? [];
    }
    expect(windows).toMatchObject([
      { label: "5-hour limit", usedPercent: 12 },
      { label: "Weekly limit", usedPercent: 40 },
    ]);
  } finally {
    harness.restore();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}, 30_000);
