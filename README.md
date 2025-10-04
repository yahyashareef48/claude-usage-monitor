# Claude Code Usage Monitor

A VS Code extension that provides real-time monitoring of Claude Code token usage, cost tracking, and session management.

![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/claude-usage-monitor)
![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/claude-usage-monitor)

## Overview

Monitor your Claude Code usage directly in VS Code. This extension reads local conversation data and displays real-time metrics including token consumption, costs, burn rate predictions, and session timing - helping you stay within your plan limits and avoid unexpected interruptions.

## Features

### 📊 Real-Time Token Tracking
- **Input tokens** - Tokens sent in your prompts
- **Output tokens** - Tokens in Claude's responses
- **Cache tokens** - Separate tracking for cache creation and reads
- **Live updates** - Automatic refresh as you use Claude Code

### 💰 Cost Calculations
- Track spending per session with model-specific pricing
- Support for Pro, Max5, Max20, and Custom plans
- Historical cost analysis

### ⏱️ Session Management
- **5-hour rolling windows** - Matches Claude Code's session limits exactly
- **Session timer** - See when your current session started and when it will reset
- **Time remaining** - Know how much time you have left
- **End time display** - Status bar shows when session expires

### 🔥 Burn Rate Predictions
- Real-time tokens-per-minute consumption
- Predict when you'll hit your limit
- Adjust usage before reaching thresholds

### 🎨 Visual Indicators
- **Color-coded status bar**
  - 🟢 Green: < 60% of limit
  - 🟡 Yellow: 60-80% of limit
  - 🔴 Red: > 80% of limit
- **Quick popover** - Click status bar for instant details
- **Smart warnings** - Alerts at 80% and 100% thresholds

## Installation

1. Install from VS Code Marketplace (coming soon)
2. Or install manually:
   ```bash
   code --install-extension claude-usage-monitor-0.0.1.vsix
   ```

## Usage

### Status Bar

The extension displays a compact status in the bottom-right corner:

```
🔥 7:30 PM - 28.1%
```

Shows:
- 🔥 Icon indicating monitoring is active
- **7:30 PM** - When your session will expire (5 hours from start)
- **28.1%** - Percentage of your token limit used

**Click the status bar** to open a quick popover with detailed metrics.

### Quick Popover

Click the status bar icon to see:
- Session timing (start, end, remaining)
- Token usage breakdown
- Burn rate and predictions
- Current plan limits

## Configuration

### Plan Settings

Configure your Claude Code plan in VS Code settings:

```json
{
  "claudeMonitor.plan": "pro",  // Options: "pro", "max5", "max20", "custom"
  "claudeMonitor.customLimitTokens": 50000,  // For custom plan
  "claudeMonitor.refreshInterval": 5  // Update interval in seconds
}
```

### Plan Limits

| Plan | Token Limit |
|------|-------------|
| **Pro** | 44,000 |
| **Max5** | 88,000 |
| **Max20** | 220,000 |
| **Custom** | User-defined |

### Custom Plan

Set a personalized token limit based on your usage patterns:

```json
{
  "claudeMonitor.plan": "custom",
  "claudeMonitor.customLimitTokens": 60000
}
```

### Data Path Override

Override Claude's data directories if needed:

```json
{
  "claudeMonitor.dataPaths": [
    "/custom/path/to/claude/projects"
  ]
}
```

Or set the `CLAUDE_CONFIG_DIR` environment variable.

## How It Works

### Data Source

Claude Code stores conversation data locally in JSONL files:
- **Windows**: `%USERPROFILE%\.claude\projects\`
- **macOS/Linux**: `~/.claude/projects/` or `~/.config/claude/projects/`

The extension monitors these files for changes and calculates metrics in real-time.

### Session Windows

Claude Code enforces **5-hour rolling sessions**. The extension:
1. Detects your first message timestamp
2. Calculates session expiry (exactly 5 hours later)
3. Tracks token usage within the active window
4. Resets when the session expires

### Token Calculation

**What counts toward your limit:**
- ✅ `input_tokens` - Your prompts
- ✅ `output_tokens` - Claude's responses

**What doesn't count:**
- ❌ `cache_creation_input_tokens` - Cache overhead
- ❌ `cache_read_input_tokens` - Cache hits

This matches Claude Code's official limit calculation.

### Privacy

All data processing happens **locally on your machine**:
- ✅ No data sent to external servers
- ✅ No telemetry or analytics
- ✅ No account required
- ✅ Reads only your local Claude files

## Requirements

- **VS Code**: 1.85.0 or higher
- **Claude Code**: Active installation with local conversation data
- **Node.js**: Only for development

## Known Issues

- File watching may have a brief delay (~1-5 seconds) on some systems
- Multiple concurrent sessions are aggregated globally (matches Claude's behavior)

## Commands

Access these via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- `Claude Monitor: Show Details` - Open detailed metrics popover
- `Claude Monitor: Refresh` - Force refresh metrics

## Development

### Building

```bash
npm install
npm run compile
```

### Packaging

```bash
npm run package  # Compile and lint
vsce package     # Create .vsix
```

### Testing

```bash
npm run test
```

### Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## Credits

Inspired by [maciek-roboblog/claude-code-usage-monitor](https://github.com/maciek-roboblog/claude-code-usage-monitor) - the original Python terminal-based monitor.

## Support

- **Issues**: [GitHub Issues](https://github.com/yahya/claude-usage-monitor/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yahya/claude-usage-monitor/discussions)

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**Enjoy coding with Claude!** 🚀
