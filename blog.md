# How to Track Claude Token Usage in Real Time with a VS Code Extension

## 1: Setting Up the Status Bar with Custom Icons

### The Challenge

I wanted to build a VS Code extension that monitors Claude Code token usage with a clean, recognizable icon in the status bar. Simple enough, right? Not quite.

### The Icon Problem

VS Code status bars don't support custom SVG icons directly. You're limited to:

- Built-in codicons (like `$(sparkle)`, `$(hubot)`)
- Text/Unicode/Emoji characters

But I wanted the actual Claude icon - that distinctive geometric pattern that represents the AI.

### The Solution: Custom Icon Fonts

After research, I discovered VS Code's `contributes.icons` API allows custom icons via **font files**. Here's the process:

1. **Convert SVG to Font**: Used [Glyphter.com](https://www.glyphter.com/) to convert the Claude SVG logo into a `.woff` font file
2. **Map to Character**: Glyphter mapped the icon to the "^" character (`\005E` in Unicode)
3. **Register in package.json**:

```json
"contributes": {
  "icons": {
    "claude-icon": {
      "description": "Claude AI icon",
      "default": {
        "fontPath": "./resources/Glyphter.woff",
        "fontCharacter": "\\005E"
      }
    }
  }
}
```

4. **Use in Status Bar**:

```typescript
statusBarItem.text = "$(claude-icon)";
statusBarItem.show();
```

### Key Learnings

- VS Code extensions can't use SVG directly in status bars
- Custom icons require conversion to font format (.woff, .ttf)
- The icon ID in package.json must match the syntax in code: `$(icon-id)`
- Status bar alignment: `Left` vs `Right` matters for UX

### What's Next

- ✅ Implement actual token usage monitoring
- ✅ Add click handler to show detailed metrics
- ✅ Parse Claude's local JSONL session files
- Calculate costs and burn rates

### Tech Stack

- TypeScript
- VS Code Extension API
- Custom icon fonts via Glyphter
- Status bar API for persistent UI presence

---

## 2: How to Parse Claude's Local Session Files

### The Challenge

Claude Code stores conversation data locally in JSONL (JSON Lines) files, but finding and parsing them isn't straightforward. The files are scattered across project directories with unpredictable names and nested data structures.

### Finding the Files

Claude Code stores session data in:
```
~/.claude/projects/{project-directory}/{uuid}.jsonl
```

Each project gets its own directory (named after the workspace path), and each session is a UUID-based file like `c26cf239-e94b-4bf8-bfad-9e36872caf2d.jsonl`.

**The discovery process:**

```typescript
function getClaudeDataPaths(): string[] {
  const homeDir = os.homedir();
  return [
    path.join(homeDir, '.config', 'claude', 'projects'),
    path.join(homeDir, '.claude', 'projects')
  ].filter(p => fs.existsSync(p));
}
```

### Parsing JSONL Files

Each line in the file is a separate JSON object representing one message in the conversation. But here's the tricky part - the structure is **nested**:

```json
{
  "type": "assistant",
  "timestamp": "2025-10-04T11:24:54.135Z",
  "sessionId": "c26cf239-...",
  "message": {
    "id": "msg_01...",
    "role": "assistant",
    "usage": {
      "input_tokens": 7,
      "cache_creation_input_tokens": 464,
      "cache_read_input_tokens": 37687,
      "output_tokens": 176
    }
  }
}
```

**The gotcha:** Not every line is a message! Some are summaries or metadata. You need to filter:

```typescript
for await (const line of readlineInterface) {
  const parsed = JSON.parse(line);

  // Skip non-message entries
  if (parsed.type === 'summary' || !parsed.message) {
    continue;
  }

  // Extract the nested message
  const msg = parsed.message;
  const usage = msg.usage; // Here's the token data!
}
```

### Key Learnings

- **JSONL files** have one JSON object per line (not a JSON array)
- **Nested structure** - usage data is in `parsed.message.usage`, not at the root
- **Summary entries** exist and must be filtered out
- **UUID filenames** - no predictable naming like `session-*.jsonl`

---

## 3: How to Build a Real-Time Session Monitor with Interval Polling

### The Challenge

I initially tried using `chokidar` for file watching, but it was unreliable - events wouldn't trigger consistently, especially on startup. The extension showed "No active session" even when Claude Code was actively running.

### Why File Watching Failed

File watchers in VS Code extensions face several issues:

1. **Initial scan problems** - `ignoreInitial: false` didn't always trigger
2. **Event timing** - Files might update before the watcher is ready
3. **Complexity** - Managing watchers, handlers, and cleanup is error-prone

### The Simple Solution: Interval Polling

Instead of reacting to file changes, just **check periodically**:

```typescript
async function updateMetrics() {
  let allMessages = [];

  // Step 1: Collect ALL messages from ALL projects
  for (const basePath of claudeDataPaths) {
    const projectDirs = fs.readdirSync(basePath);

    for (const projectDir of projectDirs) {
      const projectPath = path.join(basePath, projectDir);
      const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const messages = await parseSessionFile(filePath);

        // Collect ALL messages (we'll dedupe and filter later)
        allMessages.push(...messages);
      }
    }
  }

  // Step 2: Deduplicate by message ID (messages can appear in multiple files)
  const uniqueMessages = Array.from(
    new Map(allMessages.map(m => [m.id, m])).values()
  );

  // Step 3: Calculate metrics for the active session
  const metrics = calculateSessionMetrics(uniqueMessages, 'global');

  if (metrics && metrics.isActive) {
    statusBar.update(metrics, planConfig);
  }
}

// Update immediately on activation
updateMetrics();

// Update every 5 seconds
const interval = setInterval(updateMetrics, 5000);
```

### Why This Works Better

- **Reliability** - No missed events, always reads fresh data
- **Simplicity** - No file watcher setup/teardown
- **Debuggability** - Easy to log exactly what's happening
- **Performance** - 5-second intervals are fine for this use case
- **User-specific tracking** - Sessions aren't project-specific, they're user-specific, so we check ALL files and pick the most recently active one

### Calculating Session Windows

Claude Code uses **5-hour rolling sessions**. The key insight: you need to group messages into 5-hour windows and find the active one:

```typescript
const SESSION_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours

function calculateSessionMetrics(messages: ClaudeMessage[]) {
  // Step 1: Deduplicate messages by ID
  const uniqueMessages = Array.from(
    new Map(messages.map(m => [m.id, m])).values()
  );

  // Step 2: Filter to only today's messages
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMessages = uniqueMessages.filter(
    m => new Date(m.timestamp) >= today
  );

  // Step 3: Group into 5-hour windows
  const sets = groupIntoFiveHourSets(todayMessages);

  // Step 4: Find the window that contains the current time
  const now = new Date();
  const activeSet = sets.find(
    set => now >= set.startTime && now <= set.endTime
  );

  if (!activeSet) {
    return null; // No active session
  }

  return {
    startTime: activeSet.startTime,
    sessionEndTime: activeSet.endTime,
    isActive: true,
    timeRemaining: activeSet.endTime.getTime() - now.getTime(),
    ...calculateTokens(activeSet.messages)
  };
}

function groupIntoFiveHourSets(messages: ClaudeMessage[]): SessionSet[] {
  const sets = [];
  let currentSet = null;

  for (const message of messages) {
    const msgTime = new Date(message.timestamp);

    if (!currentSet) {
      // Start first set
      currentSet = {
        startTime: msgTime,
        endTime: new Date(msgTime.getTime() + SESSION_DURATION_MS),
        messages: [message]
      };
    } else if (msgTime <= currentSet.endTime) {
      // Message belongs to current set
      currentSet.messages.push(message);
    } else {
      // Message is outside current set - save and start new
      sets.push(currentSet);
      currentSet = {
        startTime: msgTime,
        endTime: new Date(msgTime.getTime() + SESSION_DURATION_MS),
        messages: [message]
      };
    }
  }

  if (currentSet) {
    sets.push(currentSet);
  }

  return sets;
}
```

### Burn Rate Calculation

Track how fast you're consuming tokens by analyzing the last 10 minutes:

```typescript
const BURN_RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function calculateBurnRate(messages: ClaudeMessage[], now: Date): number {
  const windowStart = now.getTime() - BURN_RATE_WINDOW_MS;
  const recentMessages = messages.filter(
    msg => new Date(msg.timestamp).getTime() >= windowStart
  );

  const totalTokens = recentMessages.reduce(
    (sum, msg) => sum + calculateTokensFromUsage(msg.usage), 0
  );

  const elapsedMinutes = BURN_RATE_WINDOW_MS / (60 * 1000);
  return totalTokens / elapsedMinutes; // tokens per minute
}
```

### Critical Gotchas

**1. Message Deduplication is Essential**

Messages can appear in multiple session files! Without deduplication:
- Same message counted multiple times
- Token counts inflated by 30-50%
- Misleading usage metrics

**Solution:**
```typescript
const uniqueMessages = Array.from(
  new Map(messages.map(m => [m.id, m])).values()
);
```

**2. Sessions Are Global, Not Per-Project**

Claude Code limits apply across **ALL projects globally**:
- Don't track per-workspace
- Combine messages from all `~/.claude/projects/*` directories
- Track single global 5-hour session

**3. Only Today's Messages Matter**

For accurate "current session" tracking:
- Filter to messages from today (00:00:00 onwards)
- Group those into 5-hour windows
- Find the window containing the current time
- If no window overlaps, return "No active session"

**4. Cache Tokens Don't Count**

Token limits only include:
- `input_tokens`
- `output_tokens`

These do NOT count:
- `cache_creation_input_tokens`
- `cache_read_input_tokens`

Cache tokens affect **cost** but not **rate limits**!

### Key Learnings

- **Polling beats watching** for this use case - simpler and more reliable
- **Deduplication is mandatory** - Messages appear in multiple files
- **Today-only filtering** - Group messages from today into 5-hour windows
- **Sessions are global** - Not per-project, track across all workspaces
- **Cache tokens don't count** - Only input + output count toward limits
- **Window-based sessions** - Find the 5-hour window containing current time
- **Burn rate** helps predict when you'll hit limits

---

## 4: How to Create a Copilot-Style Hover Panel

### The Challenge

I wanted a compact popup panel (like GitHub Copilot's status panel) that appears when you click the status bar icon. VS Code doesn't have a native "hover panel" API, so I had to get creative.

### Option 1: QuickPick (Didn't Work)

My first attempt used `vscode.window.createQuickPick()`:

```typescript
const quickPick = vscode.window.createQuickPick();
quickPick.items = [
  { label: '$(clock) Session Timing', kind: QuickPickItemKind.Separator },
  { label: `Started: ${startTime}` },
  // ...
];
quickPick.show();
```

**The problem:** This looks like a command palette dropdown, not a compact info panel. It's centered in the screen and feels jarring.

### Option 2: Webview Panel (The Solution)

Use a compact webview panel with `preserveFocus: true`:

```typescript
const panel = vscode.window.createWebviewPanel(
  'claudeSessionHover',
  'Claude Session',
  { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
  { enableScripts: false, retainContextWhenHidden: false }
);

panel.webview.html = getHtmlContent(session, planConfig);
```

### Styling for Compactness

Key CSS tricks to make it feel like a popup:

```css
body {
  font-family: var(--vscode-font-family);
  font-size: 13px;
  padding: 16px;
  max-width: 400px; /* Keeps it compact */
}

.section {
  margin-bottom: 16px;
}

.row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 12px;
}

/* Use VS Code theme variables */
color: var(--vscode-foreground);
background: var(--vscode-editor-background);
border-bottom: 1px solid var(--vscode-panel-border);
```

### Progress Bar with Dynamic Colors

Show usage with a visual progress bar:

```typescript
const statusColor = getStatusColor(usagePercent);

function getStatusColor(usagePercent: number): string {
  if (usagePercent >= 80) return '#ff6b6b'; // Red
  else if (usagePercent >= 60) return '#ffd93d'; // Yellow
  return '#51cf66'; // Green
}
```

```html
<div class="progress">
  <div class="progress-fill" style="
    width: ${Math.min(usagePercent, 100)}%;
    background: ${statusColor};
  "></div>
</div>
```

### Managing Panel State

Only create the panel once, then reuse it:

```typescript
export class SessionHoverPanel {
  private panel: vscode.WebviewPanel | undefined;

  public show(session: SessionMetrics, planConfig: PlanConfig) {
    if (this.panel) {
      // Panel exists, just update content
      this.panel.webview.html = this.getHtmlContent(session, planConfig);
      this.panel.reveal(vscode.ViewColumn.One, true);
    } else {
      // Create new panel
      this.panel = vscode.window.createWebviewPanel(...);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }
  }
}
```

### Key Learnings

- **preserveFocus: true** - Keeps the panel lightweight and non-intrusive
- **VS Code theme variables** - Make it look native (`var(--vscode-*)`)
- **Max-width constraint** - Prevents the panel from filling the screen
- **Single instance** - Reuse the panel instead of creating new ones
- **No scripts needed** - Static HTML is enough for display

---

## What's Next

- Add configuration settings for different plan types (Pro, Max5, Max20)
- Implement cost calculations based on token prices
- Add desktop notifications at usage thresholds
- Support tracking multiple simultaneous sessions
- Historical usage graphs and analytics

### Final Tech Stack

- TypeScript
- VS Code Extension API
- Custom icon fonts (Glyphter)
- Interval-based file polling
- Webview panels for UI
- JSONL parsing with readline
