import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSettings,
  prepareMuseConfigHome,
} from "../src/tool-proxy/config-home.js";
import { startToolProxyEndpoint } from "../src/tool-proxy/endpoint.js";

describe("muse config overlay", () => {
  let root: string;
  let sourceDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bb-muse-cfg-"));
    sourceDir = join(root, "source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "settings.json"),
      JSON.stringify({ schema_version: 1, model: "muse-spark-1.3" }),
    );
    writeFileSync(join(sourceDir, "auth.json"), JSON.stringify({ providers: {} }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the user's settings and adds only the bridge server", async () => {
    const settings = await buildSettings(sourceDir, {
      command: "/usr/bin/node",
      args: ["/tmp/proxy.mjs"],
      env: { BB_MUSE_TOOL_PORT: "1234" },
    });
    expect(settings.model).toBe("muse-spark-1.3");
    expect(settings.mcpServers).toEqual({
      "bb-bridge": {
        command: "/usr/bin/node",
        args: ["/tmp/proxy.mjs"],
        env: { BB_MUSE_TOOL_PORT: "1234" },
      },
    });
  });

  it("preserves a user's own MCP servers beside the bridge", async () => {
    writeFileSync(
      join(sourceDir, "settings.json"),
      JSON.stringify({ mcpServers: { mine: { command: "x", args: [] } } }),
    );
    const settings = await buildSettings(sourceDir, {
      command: "node",
      args: [],
      env: {},
    });
    expect(Object.keys(settings.mcpServers as object).sort()).toEqual([
      "bb-bridge",
      "mine",
    ]);
  });

  it("links credentials into the private config directory", async () => {
    const xdgHome = await prepareMuseConfigHome({
      root: join(root, "home"),
      sourceConfigDir: sourceDir,
      mcpServer: { command: "node", args: ["/tmp/proxy.mjs"], env: {} },
    });
    const configDir = join(xdgHome, "muse");
    expect(JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8"))).toEqual(
      { providers: {} },
    );
    const written = JSON.parse(
      readFileSync(join(configDir, "settings.json"), "utf8"),
    );
    expect(written.mcpServers["bb-bridge"].command).toBe("node");
    /** The real settings file must be left exactly as the user wrote it. */
    expect(
      JSON.parse(readFileSync(join(sourceDir, "settings.json"), "utf8")),
    ).toEqual({ schema_version: 1, model: "muse-spark-1.3" });
  });

  it("rebuilds cleanly over a previous run", async () => {
    const home = join(root, "home");
    await prepareMuseConfigHome({
      root: home,
      sourceConfigDir: sourceDir,
      mcpServer: { command: "node", args: [], env: {} },
    });
    const xdgHome = await prepareMuseConfigHome({
      root: home,
      sourceConfigDir: sourceDir,
      mcpServer: { command: "node2", args: [], env: {} },
    });
    const written = JSON.parse(
      readFileSync(join(xdgHome, "muse", "settings.json"), "utf8"),
    );
    expect(written.mcpServers["bb-bridge"].command).toBe("node2");
  });
});

describe("tool proxy endpoint", () => {
  function request(port: number, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(payload)}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.includes("\n")) {
          socket.end();
          resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
        }
      });
      socket.on("error", reject);
    });
  }

  it("runs a call for the thread that owns it", async () => {
    const seen: string[] = [];
    const endpoint = await startToolProxyEndpoint({
      onCall: async (call) => {
        seen.push(`${call.threadId}:${call.tool}`);
        return { ok: true, content: [{ type: "text", text: "done" }] };
      },
    });
    try {
      const result = await request(endpoint.port, {
        threadId: "thr_1",
        token: endpoint.token,
        kind: "toolCall",
        tool: "bb_probe",
        callId: "call-1",
        arguments: { a: 1 },
      });
      expect(result).toEqual({
        ok: true,
        content: [{ type: "text", text: "done" }],
      });
      expect(seen).toEqual(["thr_1:bb_probe"]);
    } finally {
      endpoint.close();
    }
  });

  it("refuses a call carrying the wrong token", async () => {
    let called = false;
    const endpoint = await startToolProxyEndpoint({
      onCall: async () => {
        called = true;
        return { ok: true, content: [] };
      },
    });
    try {
      const result = (await request(endpoint.port, {
        threadId: "thr_1",
        token: "wrong",
        kind: "toolCall",
        tool: "bb_probe",
        callId: "call-1",
        arguments: {},
      })) as { ok: boolean };
      expect(result.ok).toBe(false);
      expect(called).toBe(false);
    } finally {
      endpoint.close();
    }
  });

  it("answers a failing tool with its error instead of hanging", async () => {
    const endpoint = await startToolProxyEndpoint({
      onCall: async () => {
        throw new Error("bb said no");
      },
      onError: () => {},
    });
    try {
      const result = (await request(endpoint.port, {
        threadId: "thr_1",
        token: endpoint.token,
        kind: "toolCall",
        tool: "bb_probe",
        callId: "call-1",
        arguments: {},
      })) as { ok: boolean; error: string };
      expect(result).toEqual({ ok: false, error: "bb said no" });
    } finally {
      endpoint.close();
    }
  });
});
