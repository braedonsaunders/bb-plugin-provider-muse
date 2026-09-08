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
      const token = endpoint.issueToken({
        threadId: "thr_1",
        allowedTools: ["bb_probe"],
      });
      const result = await request(endpoint.port, {
        threadId: "thr_1",
        token,
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
      endpoint.issueToken({ threadId: "thr_1", allowedTools: ["bb_probe"] });
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

  it("issues a distinct token per thread and rejects a swapped thread id", async () => {
    let called = false;
    const endpoint = await startToolProxyEndpoint({
      onCall: async () => {
        called = true;
        return { ok: true, content: [] };
      },
    });
    try {
      const tokenA = endpoint.issueToken({
        threadId: "thr_a",
        allowedTools: ["bb_probe"],
      });
      const tokenB = endpoint.issueToken({
        threadId: "thr_b",
        allowedTools: ["bb_probe"],
      });
      expect(tokenA).not.toBe(tokenB);
      expect(endpoint.bindingFor(tokenA)?.threadId).toBe("thr_a");
      expect(endpoint.bindingFor(tokenB)?.threadId).toBe("thr_b");

      const swapped = (await request(endpoint.port, {
        threadId: "thr_b",
        token: tokenA,
        kind: "toolCall",
        tool: "bb_probe",
        callId: "call-1",
        arguments: {},
      })) as { ok: boolean; error?: string };
      expect(swapped).toEqual({
        ok: false,
        error: "rejected tool proxy request",
      });
      expect(called).toBe(false);
    } finally {
      endpoint.close();
    }
  });

  it("rejects a tool the token was not issued for", async () => {
    let called = false;
    const endpoint = await startToolProxyEndpoint({
      onCall: async () => {
        called = true;
        return { ok: true, content: [] };
      },
    });
    try {
      const token = endpoint.issueToken({
        threadId: "thr_1",
        allowedTools: ["bb_probe"],
      });
      const result = (await request(endpoint.port, {
        threadId: "thr_1",
        token,
        kind: "toolCall",
        tool: "bb_secret_store",
        callId: "call-1",
        arguments: {},
      })) as { ok: boolean; error?: string };
      expect(result).toEqual({
        ok: false,
        error: "rejected tool proxy request",
      });
      expect(called).toBe(false);
    } finally {
      endpoint.close();
    }
  });

  it("invalidates the previous token when the thread's tool set is reissued", async () => {
    let called = false;
    const endpoint = await startToolProxyEndpoint({
      onCall: async () => {
        called = true;
        return { ok: true, content: [] };
      },
    });
    try {
      const previous = endpoint.issueToken({
        threadId: "thr_1",
        allowedTools: ["bb_probe", "bb_old"],
      });
      const next = endpoint.issueToken({
        threadId: "thr_1",
        allowedTools: ["bb_probe"],
      });
      expect(next).not.toBe(previous);
      expect(endpoint.bindingFor(previous)).toBeNull();

      const stale = (await request(endpoint.port, {
        threadId: "thr_1",
        token: previous,
        kind: "toolCall",
        tool: "bb_probe",
        callId: "call-1",
        arguments: {},
      })) as { ok: boolean };
      expect(stale.ok).toBe(false);
      expect(called).toBe(false);

      const result = await request(endpoint.port, {
        threadId: "thr_1",
        token: next,
        kind: "toolCall",
        tool: "bb_probe",
        callId: "call-2",
        arguments: {},
      });
      expect(result).toEqual({ ok: true, content: [] });
      expect(called).toBe(true);
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
      const token = endpoint.issueToken({
        threadId: "thr_1",
        allowedTools: ["bb_probe"],
      });
      const result = (await request(endpoint.port, {
        threadId: "thr_1",
        token,
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

describe("muse serve arguments", () => {
  it("passes only sandbox-network values muse accepts", async () => {
    const { museProviderOptionsSchema } = await import("../src/vocabulary.js");
    for (const value of ["enabled", "proxy-only", "restricted"]) {
      expect(
        museProviderOptionsSchema.safeParse({ sandboxNetwork: value }).success,
      ).toBe(true);
    }
    /** `on`/`off` read naturally but Muse rejects them and the host exits 2. */
    for (const value of ["on", "off"]) {
      expect(
        museProviderOptionsSchema.safeParse({ sandboxNetwork: value }).success,
      ).toBe(false);
    }
  });
});

describe("sandbox posture", () => {
  it("keeps Muse's OS sandbox off unless it is asked for", async () => {
    const { museProviderOptionsSchema } = await import("../src/vocabulary.js");
    expect(museProviderOptionsSchema.parse({}).sandbox).toBeUndefined();
    expect(
      museProviderOptionsSchema.parse({ sandbox: "on" }).sandbox,
    ).toBe("on");
    expect(museProviderOptionsSchema.safeParse({ sandbox: "yes" }).success).toBe(
      false,
    );
  });
});

describe("declared tool names", () => {
  it("accepts the name bb declared and Muse's namespaced form of it", async () => {
    const { toolIsDeclared } = await import("../src/tool-proxy/names.js");
    expect(toolIsDeclared("bb_probe", ["bb_probe"])).toBe(true);
    expect(toolIsDeclared("mcp__bb_bridge__bb_probe", ["bb_probe"])).toBe(true);
    expect(toolIsDeclared("bb_secret_store", ["bb_probe"])).toBe(false);
    expect(toolIsDeclared("mcp__bb_bridge__bb_secret_store", ["bb_probe"])).toBe(
      false,
    );
  });
});

describe("host config isolation", () => {
  it("gives the same tool set a stable signature and a different one a new key", async () => {
    const { toolsSignature } = await import("../src/provider-bridge.js");
    const a = [
      { name: "b_tool", description: "", inputSchema: {} },
      { name: "a_tool", description: "", inputSchema: {} },
    ];
    const reordered = [a[1], a[0]];
    expect(toolsSignature(a)).toBe(toolsSignature(reordered));
    expect(toolsSignature(a)).not.toBe(
      toolsSignature([...a, { name: "c_tool", description: "", inputSchema: {} }]),
    );
  });

  it("never reuses a config directory between host instances", async () => {
    const { prepareMuseConfigHome } = await import(
      "../src/tool-proxy/config-home.js"
    );
    const root = mkdtempSync(join(tmpdir(), "bb-muse-iso-"));
    const source = join(root, "src");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "settings.json"), "{}");
    const first = await prepareMuseConfigHome({
      root: join(root, "a"),
      sourceConfigDir: source,
      mcpServer: { command: "node", args: [], env: {} },
    });
    const second = await prepareMuseConfigHome({
      root: join(root, "b"),
      sourceConfigDir: source,
      mcpServer: { command: "node", args: [], env: {} },
    });
    expect(first).not.toBe(second);
    /** The first host's configuration must survive the second being built. */
    expect(
      JSON.parse(readFileSync(join(first, "muse", "settings.json"), "utf8"))
        .mcpServers["bb-bridge"],
    ).toBeDefined();
    rmSync(root, { recursive: true, force: true });
  });
});
