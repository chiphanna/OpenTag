/**
 * Agent backend for the Slack triage assistant.
 *
 * This is the brain behind the Slack bridge: a single CopilotKit
 * `BuiltInAgent` (LLM + MCP) served over AG-UI by a `CopilotSseRuntime`.
 * It replaces the old vendored Python/LangGraph showcase backend — there
 * is no Python, no `langgraph dev`, no A2UI middleware. Everything is a
 * few dozen lines of TypeScript.
 *
 * What it does
 * ------------
 * The agent connects to **Linear** and **Notion** via their MCP servers
 * and acts as an on-call / triage assistant inside Slack: it pulls and
 * files Linear issues, finds Notion runbooks, and writes incident
 * threads up as Notion postmortems. The data access is entirely MCP —
 * the agent discovers the available tools (list/search/create issues,
 * search/create pages) from each server at runtime.
 *
 * The Slack-side primitives (read_thread, the confirm_write HITL picker,
 * the issue/page Block Kit components) are forwarded to the agent as
 * client-provided tools by the bridge on every run — see `app/index.ts`.
 *
 * Auth & deployment
 * -----------------
 * Every connection is env-driven, so the same process runs locally and
 * deployed — only the env differs (see `.env.example`):
 *
 *   - Linear: the hosted MCP accepts a raw API key as a bearer token, so
 *     we connect straight to `LINEAR_MCP_URL` with `LINEAR_API_KEY`.
 *   - Notion: run the official `@notionhq/notion-mcp-server` as a
 *     Streamable-HTTP sidecar (`pnpm notion-mcp` locally, a second
 *     process/container in prod) and point `NOTION_MCP_URL` /
 *     `NOTION_MCP_AUTH_TOKEN` at it.
 *
 * A server is only wired up when its credentials are present, so the bot
 * runs Linear-only, Notion-only, or both.
 *
 * Exposed route (the bridge's `AGENT_URL`):
 *   POST http://localhost:8200/api/copilotkit/agent/triage/run
 */
import "dotenv/config";
import { createServer } from "node:http";
import {
  BuiltInAgent,
  CopilotSseRuntime,
  convertInputToTanStackAI,
} from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { chat } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";
import { webSearchTool } from "@tanstack/ai-openai/tools";
import { createMCPClient } from "@tanstack/ai-mcp";

const LINEAR_TEAM_KEY = process.env["LINEAR_TEAM_KEY"] ?? "CPK";

/**
 * HTTP MCP transports (Linear hosted + Notion sidecar), each carrying a static
 * `Authorization: Bearer`. TanStack AI's `chat()` connects these per run and
 * closes them when the run ends (its `mcp.connection: "close"` default), so we
 * just describe the transports here and create fresh clients inside the agent
 * factory on each turn.
 */
interface McpHttpTransport {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

/** A transport plus the human label we surface when it's up or down. */
interface LabeledTransport {
  name: string;
  transport: McpHttpTransport;
}

function mcpTransports(): LabeledTransport[] {
  const transports: LabeledTransport[] = [];
  if (process.env["LINEAR_API_KEY"]) {
    transports.push({
      name: "Linear",
      transport: {
        type: "http",
        url: process.env["LINEAR_MCP_URL"] ?? "https://mcp.linear.app/mcp",
        headers: { Authorization: `Bearer ${process.env["LINEAR_API_KEY"]}` },
      },
    });
  }
  if (process.env["NOTION_MCP_AUTH_TOKEN"]) {
    transports.push({
      name: "Notion",
      transport: {
        type: "http",
        url: process.env["NOTION_MCP_URL"] ?? "http://127.0.0.1:3001/mcp",
        headers: {
          Authorization: `Bearer ${process.env["NOTION_MCP_AUTH_TOKEN"]}`,
        },
      },
    });
  }
  return transports;
}

/** Max time to wait for an MCP server to connect before giving up on it. */
const MCP_CONNECT_TIMEOUT_MS = 8000;

/**
 * Connect one MCP client without ever taking the run down with it. A server
 * that's misconfigured (bad key), down (sidecar not running), or hanging must
 * NOT abort the turn — the agent should keep working with whatever else is
 * available. We race the connect against a timeout and swallow a late failure
 * so it can't surface as an unhandled rejection after we've moved on.
 */
async function connectMcp(transport: McpHttpTransport) {
  const connecting = createMCPClient({ transport });
  connecting.catch(() => {}); // late reject (post-timeout) must not crash the process
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`)),
      MCP_CONNECT_TIMEOUT_MS,
    );
    timer.unref?.(); // don't keep the process alive on the timer alone
  });
  try {
    return await Promise.race([connecting, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

if (mcpTransports().length === 0) {
  console.warn(
    "[slack-runtime] No MCP servers configured. Set LINEAR_API_KEY and/or " +
      "NOTION_MCP_AUTH_TOKEN in .env — without them the bot can chat and " +
      "search the web but can't read or write Linear/Notion.",
  );
}

const SYSTEM_PROMPT = [
  "You are the Skill Builder for TurboTenant's skills catalog, living in a Slack workspace.",
  "Your job: interview a teammate to turn their working AI workflow into a reusable catalog skill.",
  "",
  "Run the interview ONE question at a time; wait for each answer before the next:",
  "1) What does it do (one sentence — what clog does it clear)?",
  "2) When would someone reach for it (the trigger situation)?",
  "3) What does it need (tools / data / access — or nothing)?",
  "4) Paste the actual prompt or steps you run (or a link if it's a hosted tool / repo).",
  "5) An example (optional): what you type and what you get back.",
  "6) Your name (for the Owner field), and confirm the kebab-case name.",
  "",
  "When you have enough, produce the finished skill as ONE fenced code block in EXACTLY this format:",
  "---",
  "name: <kebab-case-name>",
  "description: <one line>",
  "tags: <comma, separated>",
  "---",
  "# <name>",
  "<the prompt / steps, or a 2-line how-to + link for a tool/repo>",
  "",
  "Then tell the user, verbatim: 'Paste that block after `@skills ingest` in #skills and the bot will save it to the catalog. It will be findable via `@skills find <name>`.'",
  "",
  "To act on the Slack conversation (e.g. 'package what we discussed'), call read_thread to fetch the",
  "real messages first — never invent content. Keep it friendly and non-technical; the person may be",
  "in marketing, CX, or ops. Do not catalog throwaway one-offs or generic prompts; if it duplicates an",
  "obvious existing skill, say so.",
].join("\n");

// OpenAI-only here: web search is an OpenAI hosted (provider) tool, so this
// agent runs on the OpenAI Responses API via TanStack AI's `openaiText`
// adapter. Override the model with AGENT_MODEL (a bare OpenAI id, or
// "openai/<id>" — the prefix is stripped); defaults to gpt-5.5. The cast is
// needed because AGENT_MODEL is dynamic and `openaiText` types its argument to
// the known OpenAI model literals.
const model = (process.env["AGENT_MODEL"] ?? "openai/gpt-5.5").replace(
  /^openai\//,
  "",
) as Parameters<typeof openaiText>[0];

// Factory mode: we own the LLM call (TanStack AI `chat()`); BuiltInAgent owns
// the AG-UI run lifecycle and converts TanStack's stream into AG-UI events.
// `chat()` runs the multi-turn tool loop, the OpenAI `web_search` provider
// tool, and the MCP tools — discovering MCP tools and closing the connections
// when the run ends. The big triage prompt is prepended as a system prompt,
// ahead of any system/context/state prompts derived from the run input.
const agent = new BuiltInAgent({
  type: "tanstack",
  factory: async (ctx) => {
    const {
      messages,
      systemPrompts,
      tools: clientTools,
    } = convertInputToTanStackAI(ctx.input);

    // Connect each MCP server independently so one bad/unreachable server can't
    // kill the turn. Failures are dropped (the agent runs with whatever else is
    // up) and noted so the model only tells the user a source is down if they
    // actually ask for it — see `availabilityNote` below.
    const transports = mcpTransports();
    const settled = await Promise.allSettled(
      transports.map((t) => connectMcp(t.transport)),
    );
    const clients: Array<Awaited<ReturnType<typeof connectMcp>>> = [];
    const unavailable: string[] = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        clients.push(result.value);
      } else {
        unavailable.push(transports[i]!.name);
        console.error(
          `[slack-runtime] MCP "${transports[i]!.name}" unavailable this turn:`,
          (result.reason as Error)?.message ?? result.reason,
        );
      }
    });

    // Tell the model which sources are down THIS turn so it degrades gracefully:
    // keep answering with everything that works, and only surface the outage if
    // the user's request needs the missing source (never invent data).
    const isAre = unavailable.length > 1 ? "are" : "is";
    const itsTheir = unavailable.length > 1 ? "their" : "its";
    const availabilityNote =
      unavailable.length > 0
        ? `\n\nDATA SOURCE STATUS: ${unavailable.join(" and ")} ${isAre} ` +
          `temporarily UNAVAILABLE this turn (connection failed), so ${itsTheir} ` +
          `tools are not loaded. Everything else — web search, rendering cards/` +
          `charts, reading the Slack thread — still works normally. ONLY if the ` +
          `user asks for something that needs ${unavailable.join(" or ")}, tell ` +
          `them that source is temporarily unreachable and to try again shortly; ` +
          `never invent data or claim a write/read succeeded.`
        : "";

    return chat({
      adapter: openaiText(model),
      messages,
      systemPrompts: [SYSTEM_PROMPT + availabilityNote, ...systemPrompts],
      // `web_search` is an OpenAI provider tool (run server-side by OpenAI);
      // `clientTools` are the bot's frontend tools (issue/page cards, charts,
      // confirm_write HITL) forwarded on every run — passed as client-side
      // tools so the model can call them and the bot renders/gates them via
      // the AG-UI client-tool round-trip. MCP tools come in via `mcp` below.
      tools: [
        webSearchTool({ type: "web_search" }),
        ...(clientTools as never[]),
      ],
      ...(clients.length > 0 ? { mcp: { clients } } : {}),
      // TanStack AI needs the full AbortController (not just the signal).
      abortController: ctx.abortController,
    });
  },
});

const runtime = new CopilotSseRuntime({
  agents: { triage: agent },
});

const listener = createCopilotNodeListener({
  runtime,
  basePath: "/api/copilotkit",
  cors: true,
});

const port = Number(process.env["PORT"] ?? 8200);
createServer(listener).listen(port, () => {
  console.log(
    `[slack-runtime] listening on http://localhost:${port}/api/copilotkit/agent/triage/run`,
  );
  const connected = [
    process.env["LINEAR_API_KEY"] ? "Linear" : null,
    process.env["NOTION_MCP_AUTH_TOKEN"] ? "Notion" : null,
  ].filter(Boolean);
  console.log(
    `[slack-runtime] agent "triage" ready · MCP: ${
      connected.length ? connected.join(", ") : "none"
    }`,
  );
});
