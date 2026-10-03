# Claude Code Usage Monitor - VS Code Extension

A VS Code extension that displays real-time Claude Code quota usage via the Anthropic OAuth API.

## How It Works

The extension reads the OAuth token from `~/.claude/.credentials.json` (the same file Claude Code uses) and calls `GET https://api.anthropic.com/api/oauth/usage` on an interval (`claude-usage-monitor.refreshInterval`, default 120 s, minimum 60 s), only while a window is focused, with one cache shared across windows. Before each poll it also reads Claude Code's own saved reading (`cachedUsageUtilization` in `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`, legacy `<config dir>/.config.json` first) and uses whichever is newer, skipping the request when Claude Code's is fresh. Read-only, account-checked, and any surprise falls back to the API. No local JSONL parsing or file watching.

## Architecture

```
src/
  extension.ts      # Activation, polling loop (configurable interval), command registration
  usageClient.ts    # Credentials reading + HTTPS call to /api/oauth/usage
  statusBar.ts      # Status bar item: "69% · 2h 14m" with color coding
  sessionPopover.ts # Webview panel with progress bars for all quota windows
  types.ts          # UsageData, QuotaBucket, ExtraUsage interfaces
```

## Key Types

```typescript
interface UsageData {
  fiveHour: QuotaBucket | null;
  sevenDay: QuotaBucket | null;
  sevenDaySonnet: QuotaBucket | null;      // legacy — null on current accounts
  sevenDayOpus: QuotaBucket | null;        // legacy — null on current accounts
  sevenDayOauthApps: QuotaBucket | null;
  limits?: UsageLimit[];                   // newer source of truth; undefined when revived from pre-1.3.0 cache
  extraUsage: ExtraUsage | null;
  fetchedAt: Date;
}

interface QuotaBucket {
  utilization: number; // percentage 0-100
  resetsAt: string;    // ISO 8601
}

interface UsageLimit {   // one entry of the API's `limits` array, parsed generically
  kind: string;          // "session" | "weekly_all" | "weekly_scoped" | future kinds
  group: string | null;  // "session" | "weekly"
  percent: number;       // 0-100 int
  severity: string | null;
  resetsAt: string | null;
  isActive: boolean;     // NOTE: scoped entries report false while still meaningful — never filter on it
  modelName: string | null; // scope.model.display_name, e.g. "Fable" — the only model handle (scope.model.id is null)
  surface: string | null;
}
```

The per-model quota fields (`seven_day_sonnet` etc.) went stale upstream because they were hardcoded; per-model usage now lives in the API's `limits` array. **Parse `limits` generically — never hardcode a model name.** The popover renders from `limits` when non-empty (legacy fields as fallback), and `usageClient` synthesizes `fiveHour`/`sevenDay` from `session`/`weekly_all` entries when the legacy fields are null so the status bar keeps working.

## API

**Endpoint:** `GET https://api.anthropic.com/api/oauth/usage`

**Required headers:**
- `Authorization: Bearer <accessToken from ~/.claude/.credentials.json>`
- `anthropic-beta: oauth-2025-04-20`

**Credentials path resolution** (mirrors Claude Code's own logic):
1. `$CLAUDE_CONFIG_DIR/.credentials.json`
2. `~/.claude/.credentials.json`

## Commands

- `claude-usage-monitor.showPopup` — open the usage panel
- `claude-usage-monitor.refresh` — force immediate API poll

## Development

```bash
npm run compile   # type-check + lint + bundle
npm run watch     # incremental rebuild
```

Press `F5` to launch the Extension Development Host.

## For Claude Code Assistants

Use the `memory-bank/` folder (if present) to maintain context across sessions.
