# Claude Code Usage Monitor - VS Code Extension

A VS Code extension that displays real-time Claude Code quota usage via the Anthropic OAuth API.

## How It Works

The extension reads the OAuth token from `~/.claude/.credentials.json` (the same file Claude Code uses) and calls `GET https://api.anthropic.com/api/oauth/usage` on an interval (`claude-usage-monitor.refreshInterval`, default 120 s, minimum 60 s), only while a window is focused, with one cache shared across windows. No local JSONL parsing or file watching.

## Architecture

```
src/
  extension.ts      # Activation, polling loop (configurable interval), command registration
  claudeConfig.ts   # Which account this window watches: config dir, Keychain account, state keys, account identity
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

**Credentials path resolution** (mirrors Claude Code's own logic, plus a setting):
1. `claude-usage-monitor.configDir` (window-scoped)
2. `$CLAUDE_CONFIG_DIR/.credentials.json`
3. `~/.claude/.credentials.json`
4. macOS fallback: Keychain item `Claude Code-credentials-<first 8 hex of sha256(config dir)>`, then the legacy unsuffixed `Claude Code-credentials` — the latter only for the default directory, since trusting it for an explicit one silently reports the other account

The Keychain item's `acct` attribute is the macOS user in every item, so it never distinguishes two logged-in Claude accounts. The service name is what does.

The setting exists because `process.env.CLAUDE_CONFIG_DIR` is always empty in the extension host: `claudeCode.environmentVariables` injects only into the Claude Code process, `terminal.integrated.env.*` only into terminals. See `src/claudeConfig.ts`.

The account's identity (e-mail, display name, organisation) is not in the usage API response — it comes from `oauthAccount` in `<config dir>/.claude.json`, read by `getAccount()` and cached against the file's mtime. Legacy `~/.claude.json` is a fallback for the default directory only, same rule as the Keychain lookup. It surfaces as the `{account}`, `{account.user}`, `{account.name}` and `{account.org}` status bar tokens, the tooltip's account line and the panel subtitle.

**globalState is shared by every window of an install**, so anything derived from an account goes through `accountScopedKey()` — the usage cache, `history.ts`, `notifications.ts`. The default config dir intentionally keeps the bare key so upgrades do not orphan existing state.

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
