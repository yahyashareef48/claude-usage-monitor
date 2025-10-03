# Claude Code Usage Monitor - VS Code Extension

A VS Code extension that provides real-time monitoring of Claude Code token usage, cost tracking, and session management.

## Overview

This extension monitors your Claude Code usage by reading local conversation data and displaying real-time metrics in VS Code. It helps you track token consumption, costs, and avoid hitting session limits.

## Features

- **Real-time token tracking** - Monitor input, output, cache creation, and cache read tokens
- **Cost calculations** - Track spending per session with model-specific pricing
- **Burn rate predictions** - See tokens-per-minute consumption and predict when limits will be reached
- **Session management** - Track 5-hour rolling windows with support for overlapping sessions
- **Plan support** - Configure for Pro (44k), Max5 (88k), Max20 (220k), or Custom limits
- **Visual indicators** - Color-coded status bar (green/yellow/red) based on usage thresholds
- **Dashboard view** - Rich webview with charts and detailed metrics

## How It Works

### Data Source

Claude Code stores conversation data locally in JSONL files at:
- `~/.config/claude/projects/` (newer versions)
- `~/.claude/projects/` (legacy versions)

You can override these paths using the `CLAUDE_CONFIG_DIR` environment variable.

### Session Windows

Claude Code uses **5-hour rolling sessions**. A session starts with your first message and expires exactly 5 hours later. The extension tracks these windows and calculates:

- Total tokens used in the active session
- Time remaining until session reset
- Burn rate (tokens per minute) based on recent activity
- Predicted time until limit is reached

### Token Types

Each message includes usage data for:
- `input_tokens` - User-sent tokens
- `cache_creation_input_tokens` - Cache creation overhead
- `cache_read_input_tokens` - Cache reads (discounted)
- `output_tokens` - Claude's response tokens

## Configuration

### Settings

- `claudeMonitor.plan` - Plan type: `pro`, `max5`, `max20`, or `custom`
- `claudeMonitor.customLimitTokens` - Custom token limit (for custom plan)
- `claudeMonitor.refreshInterval` - Update interval in seconds (default: 5)
- `claudeMonitor.dataPaths` - Override Claude data directories

### Plan Limits

| Plan | Token Limit |
|------|-------------|
| Pro | 44,000 |
| Max5 | 88,000 |
| Max20 | 220,000 |
| Custom | P90 percentile of your historical usage |

### Custom Plan

The Custom plan analyzes your session history (last 192 hours) and sets a limit at the 90th percentile (P90) of your token consumption. This provides a personalized limit based on your actual usage patterns.

## Usage

### Status Bar

The extension displays a compact status in the bottom-left corner:
```
$(flame) Claude: 12,345 / 44,000 (28.1%) – 3h 45m left – 42 tpm
```

Colors indicate usage level:
- **Green** - < 60% of limit
- **Yellow** - 60-80% of limit
- **Red** - > 80% of limit

### Commands

- `Monitor: Show Dashboard` - Open detailed metrics webview
- `Monitor: Start` - Begin monitoring
- `Monitor: Stop` - Pause monitoring
- `Monitor: Refresh` - Force refresh metrics

### Warnings

The extension shows notifications when:
- 80% of token limit reached (warning)
- 100% of token limit reached (error)

## Architecture

### File Watching

Uses `chokidar` to monitor JSONL files in Claude projects directories. When files are added or modified, metrics are recalculated.

### Parsing

1. Read each `session-id.jsonl` file line-by-line
2. Extract `usage` object from each message
3. Sum token counts and record timestamps
4. Group messages into 5-hour session windows
5. Calculate aggregated metrics per session

### Burn Rate Calculation

Analyzes token consumption over the last 10 minutes to compute tokens-per-minute. This rate is used to predict:
- Whether you'll hit the limit before session reset
- Estimated time until limit is reached

### Cost Calculation

Multiplies token counts by model-specific prices. Supports:
- Offline pricing (cached rates)
- Optional online pricing updates

## Integration with ccusage

Optionally, the extension can leverage the existing [`ccusage`](https://github.com/maciek-roboblog/ccusage) CLI:

```bash
npx ccusage blocks --json --active
npx ccusage statusline --json
```

This offloads aggregation to the battle-tested Python library while the extension focuses on VS Code integration.

## Development

### For Claude Code Assistants

When working on this project, **use the `memory-bank/` folder** to maintain project memory across sessions. This is a living documentation system that helps maintain context and track progress.

**How to use Memory Bank:**

1. At the start of each session, read all files in `memory-bank/` to understand current project state
2. Create and update markdown files in `memory-bank/` to document:
   - Features being built (what, why, how, status)
   - Active development context (current focus, recent changes, next steps)
   - Technical decisions and architectural patterns
   - Progress tracking (completed, in-progress, planned)
   - Any blockers or important notes

3. Keep files updated as you work - this serves as your project memory
4. Use `@memory-bank/filename.md` syntax in conversations to reference specific memory files
5. As features are completed, document user-facing details and implementation stories in `blog.md` for Medium publication

**The memory bank structure is flexible** - organize files in whatever way makes sense for tracking this project. Common patterns include files for features, decisions, progress tracking, and technical context, but adapt as needed.

### Structure

```
src/
  extension.ts       # Main activation and commands
  sessionParser.ts   # JSONL parsing logic
  metricsCalculator.ts # Token/cost calculations
  statusBar.ts       # Status bar item management
  dashboard.ts       # Webview dashboard
  types.ts          # TypeScript interfaces
```

### Key Interfaces

```typescript
interface SessionMetrics {
  totalTokens: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  messages: number;
  startTime: Date;
  lastMessageTime: Date;
  burnRate: number;
}
```

### Testing

1. Create test session files in `~/.config/claude/projects/test-project/`
2. Populate with sample JSONL data
3. Run extension in debug mode
4. Verify metrics calculations and UI updates

## Privacy

All data processing happens **locally**. The extension:
- Only reads files on your machine
- Does not send data to any external servers
- Does not collect telemetry or analytics

## Troubleshooting

### No data showing

1. Verify Claude Code data directory exists:
   ```bash
   ls ~/.config/claude/projects/
   ```
2. Check `CLAUDE_CONFIG_DIR` environment variable
3. Ensure you have an active Claude Code session

### Incorrect metrics

1. Check refresh interval setting
2. Verify JSONL files are valid JSON
3. Look for errors in VS Code Developer Tools

## Credits

Inspired by [maciek-roboblog/claude-code-usage-monitor](https://github.com/maciek-roboblog/claude-code-usage-monitor) - the original Python terminal-based monitor.

## License

MIT
