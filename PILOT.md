# Skill Builder pilot (OpenTag fork)

This is a **pilot** of OpenTag (CopilotKit's open "Claude-in-Slack") repurposed as
the TurboTenant **Skill Builder**. Goal: test whether a self-hosted Slack agent can
run the skill-building interview end-to-end — and, because we own the runtime,
**bypass the org GitHub policy** that's been blocking Claude-in-Slack.

## What we changed from upstream
- `runtime.ts` → `SYSTEM_PROMPT` is now the **Skill Builder interview** (was a
  Linear/Notion triage bot). Everything else upstream is untouched.
- No Linear/Notion/GitHub MCP wired yet (pilot v1). The agent interviews and emits
  a fenced skill block; you paste it after **`@skills ingest`** in #skills and the
  existing catalog bot commits it to `turbotenant/skills`. (v2: add a GitHub MCP so
  this bot commits directly — that's the step that proves the access-block bypass.)

## Honest status / caveats
- **Pre-release.** Upstream doesn't run standalone yet — per their `setup.md`, the
  dependable path today is to run this as `examples/slack` inside the CopilotKit
  monorepo (pnpm builds the adapters from source). Standalone `npm install` works
  only once `@copilotkit/bot-*` publish to npm.
- **Model = OpenAI** for the pilot. `runtime.ts` is hardcoded to the `openaiText`
  adapter (web_search is an OpenAI hosted tool). Switching to Claude means swapping
  the adapter — deferred so the pilot tests the platform, not our model surgery.
- Three processes: the **bot** (`app/`), the **runtime/agent** (`runtime.ts`),
  and optional MCP sidecars (none here).

## Run it (monorepo path — works today)
1. Create a **Slack app** from `slack-app-manifest.json` (Socket Mode). Generate the
   Bot token (`xoxb-`) and App-Level token (`xapp-`, scope `connections:write`).
   `/invite` it into a test channel (or #skills).
2. Clone the CopilotKit monorepo and drop this repo in as `examples/slack` (see
   upstream `setup.md` → "From the monorepo").
3. `cp .env.example .env` and fill in (see `.env.pilot` here for the minimal set):
   - `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`
   - `OPENAI_API_KEY`
   - leave `LINEAR_*` / `NOTION_*` blank (no MCP this pilot)
4. Two processes:
   ```
   pnpm --filter slack-example runtime    # agent backend on :8200
   pnpm --filter slack-example dev         # the Slack bot
   ```
5. In Slack: `@<bot> help me make a skill` → it interviews you → emits a fenced
   block → paste it after `@skills ingest` in #skills.

## Deploy (Railway, later)
The server listens on `$PORT` (Railway injects it). Once the monorepo build is
green locally, the same two processes deploy as Railway services. Hold until the
local run is proven — pre-release build friction is the main risk.

## What success looks like
- The bot runs the interview in Slack with the gen-UI/approval UX.
- It produces a clean, ingestible skill block.
- Then v2: wire a GitHub MCP (token we own) so it commits to `turbotenant/skills`
  directly — proving self-hosting clears the access wall that blocks Claude-in-Slack.
