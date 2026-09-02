import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";

/**
 * The bridge half of the tool proxy: a loopback socket the MCP servers Muse
 * spawns call back into. Muse never talks to bb directly — it calls a tool, the
 * proxy forwards the call here, and the bridge asks the runtime to run it.
 *
 * The listener binds 127.0.0.1 on an ephemeral port and every request carries a
 * per-process token plus the thread it belongs to, so one bridge process can
 * serve several threads without a call landing on the wrong one.
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

export interface ToolProxyEndpoint {
  port: number;
  token: string;
  close(): void;
}

export async function startToolProxyEndpoint(args: {
  onCall(call: ToolProxyCall): Promise<ToolProxyResult | ToolProxyFailure>;
  onError?(error: unknown): void;
}): Promise<ToolProxyEndpoint> {
  const token = randomBytes(24).toString("hex");

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
      if (!parsed.success || parsed.data.token !== token) {
        socket.end(
          `${JSON.stringify({ ok: false, error: "rejected tool proxy request" })}\n`,
        );
        return;
      }
      args
        .onCall({
          threadId: parsed.data.threadId,
          tool: parsed.data.tool,
          callId: parsed.data.callId,
          arguments: parsed.data.arguments,
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
    token,
    close: () => {
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
