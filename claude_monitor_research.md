# Research on Claude Code Usage Monitor and How to Re‑implement it in a VS Code Extension

## 1 What Claude Code Usage Monitor does

Maciek‑roboblog’s **Claude Code Usage Monitor** is an open‑source Python tool for watching token consumption while using Anthropic’s Claude Code. It replaces guesswork with a real‑time dashboard and predictions. Its core features include the following:

- **Machine‑learning‑based predictions** – The monitor uses P90 percentile calculations on historical usage to detect session limits and switch plans automatically.
- **Real‑time monitoring with a rich UI** – The terminal display updates every 0.1–20 Hz and uses colour‑coded progress bars and tables to show session progress, burn rate and cost.
- **Smart plan detection and warnings** – It automatically switches plans (Pro, Max5, Max20 or Custom) and issues multi‑level warnings as you approach token or cost limits.
- **Cost analytics and predictions** – It estimates the current cost of your session and predicts whether you will run out of tokens before the session resets.

### 1.1 How Claude Code sessions work

Claude Code’s billing is based on a **5‑hour rolling session window**; a session starts when you send your first message and expires exactly five hours later. Multiple sessions can overlap (e.g., start a session at 10:30 AM and another at 12:15 PM). Tracking overlapping sessions manually is challenging; the monitor uses this 5‑hour rule to compute active windows, track multiple sessions simultaneously and warn you before you hit a quota.

### 1.2 Where the data comes from

Claude Code stores all conversation data locally. The **ccusage** documentation (which the Python monitor internally uses) explains how the tool finds these files:

- By default, it searches two directories: `~/.config/claude/projects/` (newer versions) and `~/.claude/projects/` (legacy versions). Each project folder contains JSONL files named with a session ID.
- The environment variable `CLAUDE_CONFIG_DIR` can override the search path. When multiple paths are provided (comma‑separated), data from all valid directories is aggregated.
- The monitor’s troubleshooting guide emphasises that if no data directory is found, you may need to start a Claude Code session or set `CLAUDE_CONFIG_DIR` to the correct location.

### 1.3 Data format and parsing

Within each project’s `session-id.jsonl` file, each line is a JSON object representing an individual message. The `usage` object in the message contains token counts for:

- `input_tokens` – tokens sent by the user.
- `cache_creation_input_tokens` – tokens consumed to create cache entries.
- `cache_read_input_tokens` – tokens consumed when reading from the cache.
- `output_tokens` – tokens returned by Claude.

The aggregated session schema includes fields like `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens` and `totalCost`. This data is used to compute totals and cost per session.

### 1.4 How the monitor processes the data

1.  **Directory detection and file watching** – At startup the tool locates Claude Code’s data directory using the logic above. It then watches each JSONL file for new lines (to update token counts in real time). On Linux/macOS this is typically done using `inotify` or Python’s `watchdog` library; the monitor refresh interval is configurable (0.1–20 Hz).
2.  **Session aggregation** – Each JSONL file is parsed line‑by‑line. It extracts token counts from the `usage` object and sums them to compute `inputTokens`, `outputTokens`, `cacheCreationTokens` and `cacheReadTokens`. The tool also records the timestamp of each message to determine the session start time and group messages into the 5‑hour rolling windows.
3.  **Burn‑rate calculation** – To predict whether you will run out of tokens, the monitor looks at recent activity (typically the last 10 minutes). It computes a **burn rate** in tokens per minute and uses this to estimate how long before you hit the token limit. The `Under the Hood` section of the Apidog guide explains that the monitor analyses your token consumption over the last hour to calculate this burn rate and then predicts whether you will exhaust your tokens before the session resets.
4.  **Plan selection and custom limits** – Plans such as `pro`, `max5`, `max20` define default token limits (44 k, 88 k and 220 k respectively). The **Custom** plan analyses your past sessions (last 192 hours) to compute a personalised limit using the 90th percentile (P90) of historical consumption. The monitor automatically switches plans when it detects you exceeding the current plan’s limit.
5.  **Cost calculation** – The monitor multiplies token counts by model‑specific prices. It supports offline pricing (using cached data) and optional online pricing to fetch up‑to‑date rates. This cost is displayed alongside tokens and burn rate.
6.  **User interface** – Using the Python **Rich** library, the monitor displays a real‑time dashboard with progress bars, tables and colour‑coded warnings. The progress bars turn from green to yellow to red as you approach 60 %, 80 % and 100 % of your limit. It can also produce a compact status line: the `statusline` command reads session data from stdin, identifies the active 5‑hour block, calculates burn rates and outputs a single line showing the active model, session cost, burn rate and context usage.

## 2 Designing a VS Code extension to replicate this functionality

While Claude recently released an official VS Code extension, the monitor described above is a stand‑alone terminal tool. You can build a light‑weight VS Code extension in JavaScript/TypeScript that provides similar real‑time feedback without requiring Python. Below is a conceptual design broken down into steps.

### 2.1 Determine the data source

1.  **Locate Claude data directories.** On activation, the extension should check the environment variable `CLAUDE_CONFIG_DIR`. If it is set, split it on commas and use each path; otherwise, search both `~/.config/claude/projects/` and `~/.claude/projects/`. Use the Node `os.homedir()` API to expand `~`.
2.  **Watch the directories for changes.** Use the [`chokidar`](https://www.npmjs.com/package/chokidar) library or `fs.watch` to monitor the `projects` folder recursively. When a new `session-id.jsonl` file appears or an existing file is appended to, trigger a refresh.

### 2.2 Parsing Claude logs in JavaScript

1.  **Read JSONL files.** For each `session-id.jsonl` file in each project directory, open a read stream using `fs.createReadStream`. Use a line parser (e.g., `readline`) to handle each JSON‑encoded line.
2.  **Extract token counts.** Each line contains a `message` object with a nested `usage` object. Extract `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` and `output_tokens`. Sum these to compute total tokens for the message. Record the timestamp (if present) to determine when the message occurred.
3.  **Group by session.** The session ID is encoded in the filename and in each log line. Use it to aggregate messages per session; compute session start time (timestamp of the first message) and track the current 5‑hour window. For overlapping sessions, maintain separate aggregates and display whichever session the user is currently interacting with.
4.  **Aggregate metrics.** For each session window compute:

    - **Total tokens:** sum of input, cache creation, cache read and output tokens.
    - **Messages count** and **models used** (if the message object contains model details).
    - **Cost:** multiply token counts by per‑model prices (create a table of current prices; allow offline mode or fetch from an API if available).
    - **Burn rate:** compute tokens per minute based on messages in the last 10 minutes.
    - **Time remaining:** `5 hrs – (current_time – session_start)`.

5.  **Plan and limits.** Provide configuration options in the extension’s `package.json` contributions for selecting the plan (Pro, Max5, Max20 or Custom). Each plan defines a token limit (44 k, 88 k and 220 k tokens respectively). For the Custom plan implement a simple heuristic: compute the 90th percentile of total tokens across the last `n` sessions (e.g., 8 days) as a personalised limit. Alternatively, call `npx ccusage session --json` to let the ccusage library provide the aggregated totals and simply read its JSON output.

### 2.3 Displaying information in VS Code

1.  **Status bar item.** Use `vscode.window.createStatusBarItem` to display concise metrics: tokens used vs. limit, percentage used, time remaining and burn rate. Colour the status bar text based on thresholds: green (< 60 %), yellow (60–80 %) or red (> 80 %).

2.  **Webview dashboard.** For a richer display, register a command (`Monitor: Show Dashboard`) that opens a `vscode.WebviewPanel`. In the webview’s HTML include JavaScript (e.g., Chart.js) to render progress bars and line charts showing token consumption over time. Update the webview via the VS Code webview messaging API when new metrics arrive.
3.  **Configuration UI.** Define extension settings in `contributes.configuration` (e.g., plan selection, custom limit, refresh interval, timezone). Provide a command to change these settings quickly.
4.  **Commands.** Implement commands like `monitor.start`, `monitor.stop`, `monitor.refresh` to control monitoring. Use `context.subscriptions.push` to ensure file watchers and intervals are disposed when the extension is deactivated.
5.  **Notifications and warnings.** When usage crosses certain thresholds (e.g., 80 % of limit), show a `vscode.window.showWarningMessage`. At 100 % show a `showErrorMessage` and optionally stop monitoring.

### 2.4 Optional: call `ccusage` directly

Rather than re‑implementing token aggregation yourself, you can leverage the existing `ccusage` CLI:

1.  **Install ccusage as a dependency.** Add it to the extension’s `package.json` as a dependency or use `npx ccusage` (bundled with Node). On activation, test whether the command is available; if not, prompt the user to install it.
2.  **Invoke ccusage commands.** Use `child_process.spawn` to run commands like `ccusage blocks --json --active --refresh-interval 5`. The `blocks` command provides data for current 5‑hour windows; use `--json` to get machine‑readable output. Parse the JSON to update the status bar and dashboard.
3.  **Statusline integration.** The ccusage `statusline` command is designed to output a compact line summarising model, session cost, burn rate and context usage. You can periodically run `ccusage statusline --json` (or read its normal output) and display it in VS Code’s status bar.

### 2.5 Sample skeleton of a VS Code extension (TypeScript)

```ts
// src/extension.ts
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as chokidar from "chokidar";

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

let statusBarItem: vscode.StatusBarItem;
let watcher: chokidar.FSWatcher;
let refreshInterval: NodeJS.Timeout;

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.text = "Claude Monitor: waiting…";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Load configuration
  const config = vscode.workspace.getConfiguration("claudeMonitor");
  const plan = config.get<string>("plan", "pro");
  const customLimit = config.get<number>("customLimitTokens", 0);
  const refreshSec = config.get<number>("refreshInterval", 5);
  const dataPaths = determineDataDirs();

  // Start watching files
  watcher = chokidar.watch(
    dataPaths.map((p) => path.join(p, "projects", "**/*.jsonl")),
    { ignoreInitial: false }
  );
  watcher.on("add", () => refreshMetrics(plan, customLimit));
  watcher.on("change", () => refreshMetrics(plan, customLimit));

  // Periodic refresh for burn rate
  refreshInterval = setInterval(() => refreshMetrics(plan, customLimit), refreshSec * 1000);

  context.subscriptions.push({
    dispose: () => {
      watcher.close();
      clearInterval(refreshInterval);
    },
  });

  refreshMetrics(plan, customLimit);
}

function determineDataDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) {
    return env.split(",");
  }
  const home = os.homedir();
  return [path.join(home, ".config", "claude"), path.join(home, ".claude")];
}

async function refreshMetrics(plan: string, customLimit: number) {
  // parse all session files and compute metrics
  const sessions = await loadSessions();
  const activeSession = getActiveSession(sessions);
  if (!activeSession) {
    statusBarItem.text = "Claude Monitor: no active session";
    return;
  }
  const limit = getLimit(plan, customLimit, sessions);
  const percent = Math.min((activeSession.totalTokens / limit) * 100, 100);
  const timeRemaining = 5 * 60 * 60 * 1000 - (Date.now() - activeSession.startTime.getTime());
  const burnRate = activeSession.burnRate;

  // Update status bar
  const color = percent < 60 ? "green" : percent < 80 ? "yellow" : "red";
  statusBarItem.text = `$(flame) Claude: ${activeSession.totalTokens.toLocaleString()} / ${limit.toLocaleString()} (${percent.toFixed(
    1
  )}%) – ${formatDuration(timeRemaining)} left – ${burnRate.toFixed(0)} tpm`;
  statusBarItem.color = new vscode.ThemeColor(color);
}

async function loadSessions(): Promise<SessionMetrics[]> {
  // Scan directories and parse JSONL files; compute SessionMetrics for each session
  // This is pseudo‑code; implement caching for efficiency
  const sessions: SessionMetrics[] = [];
  // … read files, parse lines using readline to accumulate metrics …
  return sessions;
}

function getActiveSession(sessions: SessionMetrics[]): SessionMetrics | undefined {
  // Choose the session whose 5‑hour window includes the current time
  const now = Date.now();
  return sessions.find((s) => now - s.startTime.getTime() < 5 * 60 * 60 * 1000);
}

function getLimit(plan: string, customLimit: number, sessions: SessionMetrics[]): number {
  switch (plan.toLowerCase()) {
    case "max5":
      return 88000;
    case "max20":
      return 220000;
    case "custom":
      // compute P90 of session totals
      const totals = sessions.map((s) => s.totalTokens).sort((a, b) => a - b);
      const p = Math.floor(0.9 * (totals.length - 1));
      return totals[p] || customLimit || 44000;
    case "pro":
    default:
      return 44000;
  }
}

function formatDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

export function deactivate() {}
```

This sample omits error handling, caching and cost calculation, but it shows how to watch Claude Code data, parse JSONL logs, compute session metrics and display them in VS Code. You can extend it with a webview dashboard, plan settings and cost calculations.

### 2.6 Testing and packaging

1.  Create a new VS Code extension project using `yo code` and choose the TypeScript template.
2.  Copy the skeleton above into `src/extension.ts` and adjust the `package.json` to define configuration options (`claudeMonitor.plan`, `customLimitTokens`, `refreshInterval`).
3.  Install dependencies (`chokidar`, optionally `ccusage`) and build the extension.
4.  Test the extension locally by installing it into VS Code (`code --extensionDevelopmentPath=`). Open a workspace where you use Claude Code; start some sessions to populate `~/.config/claude/projects`. Observe the status bar and webview updates.
5.  Package and publish the extension to the Visual Studio Marketplace once you are satisfied.

## 3 Summary

The **Claude Code Usage Monitor** reads local session logs written by the Claude Code IDE. It detects the correct data directory, parses JSONL files to extract token usage and timestamps, groups messages into 5‑hour billing windows and computes metrics such as total tokens, cost, burn rate and time remaining. It presents this information in a terminal UI with colour‑coded progress bars and predictions. For a VS Code extension, you can reuse the same data source and computations: watch the `projects` folder, parse JSONL logs, compute metrics, and update a status bar item or webview. Optionally call the `ccusage` CLI for heavy‑duty analysis. By following the steps above you can deliver a simple, install‑and‑use monitoring extension that integrates seamlessly with the Claude Code developer experience.
