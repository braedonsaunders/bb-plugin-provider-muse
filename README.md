# Muse Code provider for BB

Runs [Muse Code](https://developer.meta.com/ai/products/muse-code/) — Meta's
terminal coding agent, powered by Muse Spark — as a first-class BB provider.
Threads on this provider get the same surfaces as a bundled one: streamed
timeline, tool rows, approvals, model picker, health, installation, and a
subscription usage meter.

## How it works

Muse ships an in-process protocol of its own: `muse serve` hosts sessions over
stdio and speaks the **Muse Session Protocol** (MSP) — a JSON-RPC command plane
(`session/start`, `turn/start`, `approval/decide`) plus a view stream of
notifications (`item/started`, `item/delta`, `turn/completed`,
`session/tokenUsage`). The plugin's bridge translates that stream into BB's
delta grammar, so BB's assembler mints every turn and item id and Muse's own
ids stay join keys.

One `muse serve` process hosts every session that shares a sandbox posture, and
it stays warm for a minute after the last thread detaches.

| BB | Muse |
| --- | --- |
| `thread/start` / `resume` / `fork` | `session/start` / `session/resume` / `session/fork` |
| `turn/start`, `turn/steer` | `turn/start`, `turn/steer` (injected into the running turn) |
| `thread/stop { interrupt }` | `turn/interrupt`, settled before the stop is answered |
| permission mode `accept-edits` / `auto` / `full` | approval mode `promptUnmatched` / `onRequest` / `allowAll` |
| approval prompts | `approval/requested` → `approval/decide` |
| user questions | `userInput/requested` → `answer` / `clarify` / `cancel` |
| `/compact` | `session/compact` |
| todo snapshots | `session/todoListChanged` → plan-steps rows |
| subagents | `subagent` items → delegation rows |
| bb's injected tools | an MCP server the bridge proxies back to bb |

## bb's own tools

Muse takes extra tools through MCP and `muse serve` has no per-session tool
channel, so the bridge gives each thread that carries injected tools a Muse host
of its own with a private config directory: the user's own settings and
credentials, plus one added MCP server. Muse spawns that server, the server
proxies every call back to the bridge over a token-guarded loopback socket, and
the bridge asks bb's runtime to run the tool. Your own
`~/.config/muse/settings.json` is never written to, and bb's tools never appear
in your terminal sessions.

That is what puts `mcp__bb_bridge.*` — thread mentions, decisions, findings, and
whatever your other plugins register — in front of Muse.

## Install

```sh
curl -fsSL https://dev.meta.ai/install.sh | bash   # Muse Code itself
muse login                                         # or export META_API_KEY
bb plugin install github:<owner>/bb-plugin-provider-muse
```

The provider hides itself on machines where `muse` is not installed
(`experimental_visibility: "installed"`), and BB's installation surface can run
the installer for you.

## Settings

| Setting | Meaning |
| --- | --- |
| Rolling 5-hour token budget | Tokens your plan allows per rolling window. Enables the usage meter. |
| Plan label | How the subscription is labelled in usage surfaces. |
| Load workspace skills and rules | Starts sessions with the workspace trusted. |
| Disable Muse's own sandbox | Hands sandboxing entirely to BB's permission modes. |
| Sandbox network | `proxy-only` (Muse default), `on`, or `off`. |

## Usage reporting

Meta publishes no usage endpoint for a Muse Code subscription. Verified against
the live API: `GET /v1/usage` answers 404 even with a valid key, `GET /v1/models`
carries no `x-ratelimit-*` headers, and the documented quota headers belong to
the Model API's pay-as-you-go surface — a separate billing account from the Muse
Code plan (an inference call on a subscription-less key answers
`402 billing_not_configured`). This plugin therefore measures the rolling window
from Muse's own durable session logs
(`~/.local/share/muse/sessions/<date>/<session>/session.jsonl`), where every
model completion records verbatim provider counters. That is a measurement, not
an estimate — but the *denominator* is yours to supply: without a configured
budget the provider reports the account with no meter rather than inventing a
limit. When Muse's provider actually refuses a call for quota, the durable
record carries the plan's own `resets_at`, and that wins over the local
estimate.

## Development

```sh
npm install
npm run typecheck
npm test                     # unit + conformance against a scripted MSP host
bb plugin build
```

`test/fake-muse-serve.mjs` is a scripted MSP host, so the conformance suite runs
without Meta's binary or a network call. To exercise the real thing on a
signed-in machine:

```sh
BB_MUSE_LIVE=1 npx vitest run test/live-msp.test.ts
```

`BB_MUSE_EXECUTABLE` points the bridge at a different `muse` binary;
`BB_PROVIDER_BRIDGE_RECORD_DIR` records both wire lanes for debugging.

## License

MIT
