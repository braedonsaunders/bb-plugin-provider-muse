import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

/**
 * Scoped to this file: a leaked executable override would send another suite's
 * bridge at the scripted host instead of the real binary.
 */
const previousExecutable = process.env.BB_MUSE_EXECUTABLE;
const previousApiKey = process.env.META_API_KEY;
process.env.BB_MUSE_EXECUTABLE = join(fixtureDir, "fake-muse-serve.mjs");
process.env.META_API_KEY = "conformance-key";

const { handleLine } = await import("../src/provider-bridge.js");

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-muse-conformance-"));
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

afterAll(() => {
  if (previousExecutable === undefined) {
    delete process.env.BB_MUSE_EXECUTABLE;
  } else {
    process.env.BB_MUSE_EXECUTABLE = previousExecutable;
  }
  if (previousApiKey === undefined) {
    delete process.env.META_API_KEY;
  } else {
    process.env.META_API_KEY = previousApiKey;
  }
});

it("passes the canonical protocol suite", async () => {
  const report = await runBridgeConformance({
    transport: { send: handleLine, takeMessages: output.takeMessages },
    providerId: "muse",
    session: {
      cwd: workspaceDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
    },
    timeoutMs: 15_000,
  });

  output.restore();
  console.info(`muse bridge conformance:\n${formatConformanceReport(report)}`);

  const failures = report.results.filter((result) => result.status !== "pass");
  expect(failures).toEqual([]);
  expect(report.passed).toBe(true);
}, 60_000);
