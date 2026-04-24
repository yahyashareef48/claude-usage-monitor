# Claude Code Usage Monitor

A VS Code extension that shows your real-time Claude Code quota usage directly in the status bar — powered by the official Anthropic OAuth usage API.

![Full screen overview](https://raw.githubusercontent.com/yahyashareef48/claude-usage-monitor/refs/heads/master/resources/image1.png)

## How It Works

The extension authenticates using the OAuth token that Claude Code already stores locally at `~/.claude/.credentials.json`. It polls `GET https://api.anthropic.com/api/oauth/usage` every 2 minutes (only when the window is focused) and displays the results without any additional login or configuration.

## Features

- **Status bar** — shows your 5-hour window utilization % and time until reset, color-coded green/yellow/red
- **Usage panel** — click the status bar to open a full panel with progress bars for every active quota window
- **Extra usage** — displays pay-as-you-go credit spend if enabled on your account
- **Zero config** — reads your existing Claude Code credentials automatically

## Status Bar

![Status bar chip](https://raw.githubusercontent.com/yahyashareef48/claude-usage-monitor/refs/heads/master/resources/image2.png)

```
☁ 69% · 2h 14m
```

- **69%** — percentage of your 5-hour quota used
- **2h 14m** — time until the 5-hour window resets
- Hover for a tooltip with all active quota windows

Colors:
- Green — < 60%
- Yellow — 60–80%
- Red — > 80%

## Usage Panel

![Usage detail panel](https://raw.githubusercontent.com/yahyashareef48/claude-usage-monitor/refs/heads/master/resources/image3.png)

Click the status bar item (or run **Claude: Show Usage** from the Command Palette) to open a panel showing:

- **5-Hour Window** — your primary rolling quota with a progress bar and reset time
- **7-Day Window** — weekly quota utilization
- **7-Day Sonnet / Opus** — model-specific weekly quotas (when applicable)
- **Extra Usage** — pay-as-you-go credits spent this month (when enabled)

## Commands

| Command | Description |
|---------|-------------|
| `Claude: Show Usage` | Open the usage panel |
| `Claude: Refresh Usage` | Force an immediate API poll |

## Requirements

- VS Code 1.104.0 or higher
- Claude Code installed and logged in (so `~/.claude/.credentials.json` exists)
- Internet connection (to reach `api.anthropic.com`)

## Data Source

All data comes from the Anthropic API — the same source Claude Code itself uses for its internal quota display. No local JSONL parsing or file watching is involved.

The credentials file path follows Claude Code's own resolution logic:
1. `$CLAUDE_CONFIG_DIR/.credentials.json` if the env var is set
2. `~/.claude/.credentials.json` otherwise

## Privacy

- No data is collected or sent anywhere other than `api.anthropic.com`
- The OAuth token is read from disk and used only for the usage API call
- No telemetry

## License

MIT
