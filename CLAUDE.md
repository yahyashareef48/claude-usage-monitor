# Claude Code Usage Monitor - VS Code Extension

A VS Code extension that displays real-time Claude Code quota usage via the Anthropic OAuth API.

## How It Works

The extension reads the OAuth token from `~/.claude/.credentials.json` (the same file Claude Code uses) and calls `GET https://api.anthropic.com/api/oauth/usage` every 30 seconds. No local JSONL parsing or file watching.

## Architecture

```
src/
  extension.ts      # Activation, 30s polling loop, command registration
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
  sevenDaySonnet: QuotaBucket | null;
  sevenDayOpus: QuotaBucket | null;
  sevenDayOauthApps: QuotaBucket | null;
  extraUsage: ExtraUsage | null;
  fetchedAt: Date;
}

interface QuotaBucket {
  utilization: number; // percentage 0-100
  resetsAt: string;    // ISO 8601
}
```

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
