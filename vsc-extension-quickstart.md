# Development Guide

## Project Structure

```
src/
  extension.ts       # Activation, polling loop, command registration
  usageClient.ts     # Reads ~/.claude/.credentials.json, calls /api/oauth/usage
  statusBar.ts       # Status bar item (utilization % + time to reset)
  sessionPopover.ts  # Webview panel with full quota breakdown
  types.ts           # UsageData, QuotaBucket, ExtraUsage interfaces
```

## Running Locally

Press `F5` to launch the Extension Development Host. The extension activates immediately on startup and polls the API every 30 seconds.

To force a refresh during development, run **Claude: Refresh Usage** from the Command Palette.

## Building

```bash
npm install
npm run compile     # type-check + lint + bundle
npm run watch       # incremental rebuild on save
```

## Packaging

```bash
npm run package     # production bundle
vsce package        # outputs .vsix
```

## API Reference

**Endpoint:** `GET https://api.anthropic.com/api/oauth/usage`

**Required headers:**
```
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
```

**Response shape:**
```json
{
  "five_hour":          { "utilization": 69.0, "resets_at": "ISO8601" },
  "seven_day":          { "utilization": 11.0, "resets_at": "ISO8601" },
  "seven_day_sonnet":   null,
  "seven_day_opus":     null,
  "seven_day_oauth_apps": null,
  "extra_usage": {
    "is_enabled": true,
    "used_credits": 3336.0,
    "monthly_limit": null,
    "utilization": null,
    "currency": "USD"
  }
}
```

`utilization` is a percentage (0–100), not a fraction.

## Credentials Location

Mirrors Claude Code's own resolution:
1. `$CLAUDE_CONFIG_DIR/.credentials.json`
2. `~/.claude/.credentials.json`
