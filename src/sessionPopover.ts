import * as vscode from "vscode";
import { UsageData, QuotaBucket } from "./types";

function timeAgo(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) { return "just now"; }
  if (sec < 3600) { const m = Math.floor(sec / 60); return `${m} minute${m === 1 ? "" : "s"} ago`; }
  const h = Math.floor(sec / 3600);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

function formatTimeRemaining(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) { return "resetting now"; }
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    return new Date(resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatError(raw: string): { message: string; hint: string | null } {
  if (raw.includes('401')) {
    return {
      message: 'HTTP 401 — Unauthorized: session token expired or invalid.',
      hint: 'Fix: start a new Claude Code session in your terminal (<code>claude</code>), then refresh via <strong>Ctrl+Shift+P</strong> → <em>Claude: Refresh Usage</em>. If it still fails, log out (<code>claude logout</code>) and log back in.',
    };
  }
  if (raw.includes('403')) {
    return {
      message: 'HTTP 403 — Forbidden: account may lack API access.',
      hint: 'Fix: ensure you are logged in to Claude Code with a valid Pro or Max subscription. You can log in by running <code>claude</code> in your terminal.',
    };
  }
  if (raw.includes('429')) {
    return {
      message: 'HTTP 429 — Rate limited by Anthropic API.',
      hint: 'The extension will retry automatically with backoff. No action needed.',
    };
  }
  if (raw.includes('timed out') || raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND')) {
    return {
      message: `Network error — could not reach api.anthropic.com.`,
      hint: 'Fix: check your internet connection, then refresh via <strong>Ctrl+Shift+P</strong> → <em>Claude: Refresh Usage</em>.',
    };
  }
  if (raw.includes('No OAuth token')) {
    return {
      message: 'No OAuth token found — not logged in to Claude Code.',
      hint: 'Fix: open a terminal and run <code>claude</code> to start a session. Once logged in, refresh via <strong>Ctrl+Shift+P</strong> → <em>Claude: Refresh Usage</em>.',
    };
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const inner = parsed?.error;
      if (inner?.message) {
        const prefix = raw.match(/^HTTP \d+/)?.[0];
        return { message: prefix ? `${prefix} — ${inner.message}` : inner.message, hint: null };
      }
    } catch { /* fall through */ }
  }
  return { message: raw, hint: null };
}

function barColor(pct: number, warnT: number, errT: number): string {
  if (pct >= errT)  { return "#ff6b6b"; }
  if (pct >= warnT) { return "#ffd93d"; }
  return "#51cf66";
}

function formatResetDate(iso: string): string {
  const d = new Date(iso);
  const fmt = vscode.workspace.getConfiguration('claude-usage-monitor').get<string>('clockFormat', 'auto');
  if (fmt === '24h') { return d.toLocaleString(undefined, { hour12: false }); }
  if (fmt === '12h') { return d.toLocaleString(undefined, { hour12: true }); }
  return d.toLocaleString();
}

function bucketRow(label: string, bucket: QuotaBucket, warnT: number, errT: number): string {
  const pct = bucket.utilization;
  const color = barColor(pct, warnT, errT);
  const timeLeft = formatTimeRemaining(bucket.resetsAt);
  const resetsDate = formatResetDate(bucket.resetsAt);
  return `
			<div class="bucket">
				<div class="bucket-header">
					<span class="bucket-label">${label}</span>
					<span class="bucket-pct" style="color:${color}">${pct.toFixed(1)}%</span>
				</div>
				<div class="progress"><div class="fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>
				<div class="bucket-meta">
					<span>Resets in ${timeLeft}</span>
					<span>${resetsDate}</span>
				</div>
			</div>`;
}

function readPanelConfig() {
  const cfg = vscode.workspace.getConfiguration('claude-usage-monitor');
  return {
    warnT:     cfg.get<number>('warningThreshold', 60),
    errT:      cfg.get<number>('errorThreshold', 80),
    statusBar: cfg.get<string>('statusBar', '5h'),
    colorFrom: cfg.get<string>('statusBarColorFrom', 'max'),
    clockFmt:  cfg.get<string>('clockFormat', 'auto'),
  };
}

function buildHtml(data: UsageData | null, error: string | null = null): string {
  if (!data) {
    let body: string;
    if (error) {
      const { message, hint } = formatError(error);
      body = `<h3 style="color:#ff6b6b;margin-bottom:12px">Error</h3>
<p style="font-size:12px;color:var(--vscode-foreground);margin-bottom:${hint ? '10px' : '0'}">${message}</p>
${hint ? `<p style="font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.5">${hint}</p>` : ''}`;
    } else {
      body = `<h3>No data yet</h3><p>Fetching usage from Anthropic API…</p>`;
    }
    return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:40px;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background)">${body}</body></html>`;
  }

  const { warnT, errT, statusBar, colorFrom, clockFmt } = readPanelConfig();

  const eu = data.extraUsage;
  const extraSection = eu?.isEnabled
    ? `
		<div class="section">
			<div class="section-title">Extra Usage (Pay-as-you-go)</div>
			${eu.usedCredits !== null
        ? `<div class="row"><span class="label">Spent this month</span><span class="value">$${(eu.usedCredits / 100).toFixed(2)} ${eu.currency ?? ""}</span></div>`
        : ""}
			${eu.monthlyLimit !== null
        ? `<div class="row"><span class="label">Monthly limit</span><span class="value">$${(eu.monthlyLimit! / 100).toFixed(2)}</span></div>`
        : '<div class="row"><span class="label">Monthly limit</span><span class="value">No cap set</span></div>'}
			${eu.utilization !== null
        ? `<div class="row"><span class="label">Extra utilization</span><span class="value">${eu.utilization!.toFixed(1)}%</span></div>`
        : ""}
		</div>`
    : "";

  const buckets: string[] = [];
  if (data.fiveHour)          { buckets.push(bucketRow("5-Hour Window",    data.fiveHour,          warnT, errT)); }
  if (data.sevenDay)          { buckets.push(bucketRow("7-Day Window",     data.sevenDay,          warnT, errT)); }
  if (data.sevenDaySonnet)    { buckets.push(bucketRow("7-Day Sonnet",     data.sevenDaySonnet,    warnT, errT)); }
  if (data.sevenDayOpus)      { buckets.push(bucketRow("7-Day Opus",       data.sevenDayOpus,      warnT, errT)); }
  if (data.sevenDayOauthApps) { buckets.push(bucketRow("7-Day OAuth Apps", data.sevenDayOauthApps, warnT, errT)); }

  const sel = (val: string, opt: string) => val === opt ? ' selected' : '';

  const settingsSection = `
<hr>
<div class="section">
	<h2>Settings</h2>

	<div class="settings-group">
		<div class="settings-group-title">Status Bar</div>
		<div class="setting-row">
			<span class="setting-label">Display <span class="info-icon" title="Which quota window to show in the status bar text: '5h' shows the 5-hour countdown and reset time, '7d' the 7-day window, 'both' both. Applies only when the account has quota windows — pay-as-you-go-only accounts always show credit spend, and any account shows a 💳 spend indicator automatically once it enters paid overage.">ⓘ</span></span>
			<select class="setting-control" onchange="updateSetting('claude-usage-monitor.statusBar', this.value)">
				<option value="5h"${sel(statusBar, '5h')}>5-Hour window</option>
				<option value="7d"${sel(statusBar, '7d')}>7-Day window</option>
				<option value="both"${sel(statusBar, 'both')}>Both windows</option>
			</select>
		</div>
		<div class="setting-row">
			<span class="setting-label">Color from <span class="info-icon" title="Which window's usage percentage drives the status bar color. 'Highest of both' turns orange/red when either window hits a threshold — not just one.">ⓘ</span></span>
			<select class="setting-control" onchange="updateSetting('claude-usage-monitor.statusBarColorFrom', this.value)">
				<option value="5h"${sel(colorFrom, '5h')}>5-Hour window</option>
				<option value="7d"${sel(colorFrom, '7d')}>7-Day window</option>
				<option value="max"${sel(colorFrom, 'max')}>Highest of both</option>
			</select>
		</div>
	</div>

	<div class="settings-group">
		<div class="settings-group-title">Color Thresholds</div>
		<div class="setting-row">
			<span class="setting-label"><span class="color-dot" style="background:#ffd93d"></span>Warning <span class="info-icon" title="When usage reaches this percentage, the status bar turns orange.">ⓘ</span></span>
			<div class="threshold-wrap">
				<input type="number" class="setting-input" min="1" max="99" value="${warnT}"
					onchange="updateSetting('claude-usage-monitor.warningThreshold', Number(this.value))">
				<span class="threshold-pct">%</span>
			</div>
		</div>
		<div class="setting-row">
			<span class="setting-label"><span class="color-dot" style="background:#ff6b6b"></span>Error <span class="info-icon" title="When usage reaches this percentage, the status bar turns red.">ⓘ</span></span>
			<div class="threshold-wrap">
				<input type="number" class="setting-input" min="1" max="100" value="${errT}"
					onchange="updateSetting('claude-usage-monitor.errorThreshold', Number(this.value))">
				<span class="threshold-pct">%</span>
			</div>
		</div>
	</div>

	<div class="settings-group last-group">
		<div class="settings-group-title">Panel</div>
		<div class="setting-row">
			<span class="setting-label">Clock format <span class="info-icon" title="How reset times are displayed in this panel. 'Auto' follows your system locale.">ⓘ</span></span>
			<select class="setting-control" onchange="updateSetting('claude-usage-monitor.clockFormat', this.value)">
				<option value="auto"${sel(clockFmt, 'auto')}>Auto (system default)</option>
				<option value="12h"${sel(clockFmt, '12h')}>12-hour (7:44 PM)</option>
				<option value="24h"${sel(clockFmt, '24h')}>24-hour (19:44)</option>
			</select>
		</div>
	</div>
</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
	font-family: var(--vscode-font-family);
	font-size: 13px;
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
	padding: 20px;
	max-width: 480px;
}
h1 { font-size: 18px; margin-bottom: 4px; }
h2 { font-size: 16px; font-weight: 600; margin-bottom: 14px; }
.subtitle { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 20px; }
.section { margin-bottom: 20px; }
.section-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	margin-bottom: 10px;
}
.bucket { margin-bottom: 16px; }
.bucket-header { display:flex; justify-content:space-between; margin-bottom: 5px; }
.bucket-label { font-weight: 600; }
.bucket-pct { font-weight: 700; font-size: 14px; }
.progress {
	width: 100%; height: 7px;
	background: var(--vscode-editorWidget-border, #444);
	border-radius: 4px; overflow: hidden; margin-bottom: 4px;
}
.fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
.bucket-meta {
	display:flex; justify-content:space-between;
	font-size: 11px; color: var(--vscode-descriptionForeground);
}
.row {
	display:flex; justify-content:space-between;
	padding: 5px 0;
	border-bottom: 1px solid var(--vscode-panel-border);
	font-size: 12px;
}
.row:last-child { border-bottom: none; }
.label { color: var(--vscode-descriptionForeground); }
.value { font-weight: 600; }
.no-quota { color: var(--vscode-descriptionForeground); font-size: 12px; font-style: italic; }
hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0; }
.refresh-btn {
	background: none;
	border: none;
	cursor: pointer;
	color: var(--vscode-descriptionForeground);
	font-size: 11px;
	padding: 0;
	opacity: 0.7;
	transition: opacity 0.15s;
}
.refresh-btn:hover { opacity: 1; }
.settings-group { margin-bottom: 14px; }
.settings-group.last-group { margin-bottom: 0; }
.settings-group-title {
	font-size: 10px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	margin-bottom: 6px;
	padding-bottom: 4px;
	border-bottom: 1px solid var(--vscode-panel-border);
}
.setting-row {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 5px 0;
}
.setting-label {
	font-size: 12px;
	display: flex;
	align-items: center;
	gap: 6px;
}
.setting-control {
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
	border-radius: 2px;
	padding: 3px 6px;
	font-size: 12px;
	font-family: var(--vscode-font-family);
	cursor: pointer;
	outline: none;
}
.setting-control:focus { border-color: var(--vscode-focusBorder); }
.setting-input {
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, #3c3c3c);
	border-radius: 2px;
	padding: 3px 6px;
	font-size: 12px;
	width: 54px;
	text-align: right;
	font-family: var(--vscode-font-family);
	outline: none;
}
.setting-input:focus { border-color: var(--vscode-focusBorder); }
.threshold-wrap { display: flex; align-items: center; gap: 4px; }
.threshold-pct { font-size: 12px; color: var(--vscode-descriptionForeground); }
.color-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.info-icon { font-size: 11px; opacity: 0.45; cursor: help; font-style: normal; }
.info-icon:hover { opacity: 1; }
</style>
</head>
<body>
<h1>Claude Usage</h1>
<div class="subtitle" style="display:flex;align-items:center;gap:8px">
	<span>Updated ${timeAgo(data.fetchedAt)} · <span style="opacity:0.6">api.anthropic.com/api/oauth/usage</span></span>
	<button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})" title="Refresh now">↻ Refresh</button>
</div>
<script>
	const vscode = acquireVsCodeApi();
	function updateSetting(key, value) {
		vscode.postMessage({ command: 'updateSetting', key, value });
	}
</script>
${error ? (() => { const { message, hint } = formatError(error); return `<div style="margin-bottom:16px;padding:8px 12px;background:#ffd93d20;border-left:3px solid #ffd93d;border-radius:4px;font-size:12px"><strong>⚠️ Last poll failed</strong> — showing cached data<br><span style="opacity:0.8">${message}</span>${hint ? `<br><span style="opacity:0.7;font-size:11px">${hint}</span>` : ''}</div>`; })() : ''}
<div class="section">
	<div class="section-title">Quota Windows</div>
	${buckets.length > 0 ? buckets.join("") : '<div class="no-quota">No active quota windows returned.</div>'}
</div>

${extraSection}
${settingsSection}
</body>
</html>`;
}

export class UsagePanel {
  private panel: vscode.WebviewPanel | undefined;
  private lastData: UsageData | null = null;
  private lastError: string | null = null;
  private configSub: vscode.Disposable;

  constructor(private extensionUri: vscode.Uri) {
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claude-usage-monitor') && this.panel) {
        this.panel.webview.html = buildHtml(this.lastData, this.lastError);
      }
    });
  }

  public show(data: UsageData | null, error: string | null = null) {
    if (data) { this.lastData = data; }
    this.lastError = error;
    const html = buildHtml(this.lastData, this.lastError);

    if (this.panel) {
      this.panel.webview.html = html;
      this.panel.reveal(vscode.ViewColumn.One, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "claudeUsage",
      "Claude Usage",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png");
    this.panel.webview.html = html;
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'refresh') {
        vscode.commands.executeCommand('claude-usage-monitor.refresh');
      } else if (msg.command === 'updateSetting') {
        await vscode.workspace.getConfiguration().update(
          msg.key, msg.value, vscode.ConfigurationTarget.Global
        );
        if (this.panel) {
          this.panel.webview.html = buildHtml(this.lastData, this.lastError);
        }
      }
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  public update(data: UsageData | null, error: string | null = null) {
    if (data) { this.lastData = data; }
    this.lastError = error;
    if (this.panel) {
      this.panel.webview.html = buildHtml(this.lastData, this.lastError);
    }
  }

  public dispose() {
    this.panel?.dispose();
    this.configSub.dispose();
  }
}
