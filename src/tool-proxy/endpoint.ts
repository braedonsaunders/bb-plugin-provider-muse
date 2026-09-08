import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import { toolIsDeclared } from "./names.js";

/**
 * The bridge half of the tool proxy: a loopback socket the MCP servers Muse
 * spawns call back into. Muse never talks to bb directly — it calls a tool, the
 * proxy forwards the call here, and the bridge asks the runtime to run it.
 *
 * The listener binds 127.0.0.1 on an ephemeral port. Each thread that carries
 * injected tools receives its own server-side token, minted for that thread
 * and the tool names it was attached with. A request whose token, thread id,
 * or tool does not match that binding is refused before the call is forwarded.
 */

const bridgeRequestSchema = z
  .object({
    threadId: z.string().min(1),
    token: z.string().min(1),
    kind: z.literal("toolCall"),
    tool: z.string().min(1),
    callId: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .loose();

export interface ToolProxyCall {
  threadId: string;
  tool: string;
  callId: string;
  arguments: Record<string, unknown>;
  token: string;
}

export interface ToolProxyResult {
  ok: true;
  content: { type: "text"; text: string }[] | unknown[];
  isError?: boolean;
}

export interface ToolProxyFailure {
  ok: false;
  error: string;
}

export interface ToolProxyTokenBinding {
  threadId: string;
  allowedTools: ReadonlySet<string>;
}

export interface ToolProxyEndpoint {
  port: number;
  issueToken(args: {
    threadId: string;
    allowedTools: readonly string[];
  }): string;
  revokeThread(threadId: string): void;
  bindingFor(token: string): ToolProxyTokenBinding | null;
  close(): void;
}

const REJECTED = { ok: false, error: "rejected tool proxy request" } as const;

export async function startToolProxyEndpoint(args: {
  onCall(call: ToolProxyCall): Promise<ToolProxyResult | ToolProxyFailure>;
  onError?(error: unknown): void;
}): Promise<ToolProxyEndpoint> {
  const tokens = new Map<string, { threadId: string; allowedTools: Set<string> }>();

  function bindingFor(token: string): ToolProxyTokenBinding | null {
    const binding = tokens.get(token);
    return binding === undefined ? null : binding;
  }

  function revokeThread(threadId: string): void {
    for (const [token, binding] of tokens) {
      if (binding.threadId === threadId) {
        tokens.delete(token);
      }
    }
  }

  function issueToken(issue: {
    threadId: string;
    allowedTools: readonly string[];
  }): string {
    revokeThread(issue.threadId);
    const token = randomBytes(24).toString("hex");
    tokens.set(token, {
      threadId: issue.threadId,
      allowedTools: new Set(issue.allowedTools),
    });
    return token;
  }

  function authorized(
    token: string,
    threadId: string,
    tool: string,
  ): boolean {
    const binding = tokens.get(token);
    return (
      binding !== undefined &&
      binding.threadId === threadId &&
      toolIsDeclared(tool, binding.allowedTools)
    );
  }

  const server: Server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = "";
      const parsed = bridgeRequestSchema.safeParse(safeJson(line));
      if (
        !parsed.success ||
        !authorized(parsed.data.token, parsed.data.threadId, parsed.data.tool)
      ) {
        socket.end(`${JSON.stringify(REJECTED)}\n`);
        return;
      }
      args
        .onCall({
          threadId: parsed.data.threadId,
          tool: parsed.data.tool,
          callId: parsed.data.callId,
          arguments: parsed.data.arguments,
          token: parsed.data.token,
        })
        .then((result) => {
          socket.end(`${JSON.stringify(result)}\n`);
        })
        .catch((error: unknown) => {
          args.onError?.(error);
          socket.end(
            `${JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })}\n`,
          );
        });
    });
    socket.on("error", (error) => {
      args.onError?.(error);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.unref();

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("tool proxy endpoint did not bind a TCP port");
  }

  return {
    port: address.port,
    issueToken,
    revokeThread,
    bindingFor,
    close: () => {
      tokens.clear();
      server.close();
    },
  };
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
