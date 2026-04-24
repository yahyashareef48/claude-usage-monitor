import * as vscode from 'vscode';
import { UsageData, QuotaBucket } from './types';

function formatTimeRemaining(resetsAt: string): string {
	const ms = new Date(resetsAt).getTime() - Date.now();
	if (ms <= 0) { return 'resetting now'; }
	const totalMin = Math.floor(ms / 60_000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function barColor(pct: number): string {
	if (pct >= 80) { return '#ff6b6b'; }
	if (pct >= 60) { return '#ffd93d'; }
	return '#51cf66';
}

function bucketRow(label: string, bucket: QuotaBucket): string {
	const pct = bucket.utilization;
	const color = barColor(pct);
	const timeLeft = formatTimeRemaining(bucket.resetsAt);
	const resetsDate = new Date(bucket.resetsAt).toLocaleString();
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

function buildHtml(data: UsageData | null, error: string | null = null): string {
	if (!data) {
		const body = error
			? `<h3 style="color:#ff6b6b;margin-bottom:12px">Error</h3><p style="font-family:monospace;font-size:12px;word-break:break-word;color:var(--vscode-foreground)">${error}</p>`
			: `<h3>No data yet</h3><p>Fetching usage from Anthropic API…</p>`;
		return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:40px;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background)">${body}</body></html>`;
	}

	const eu = data.extraUsage;
	const extraSection = eu?.isEnabled ? `
		<div class="section">
			<div class="section-title">Extra Usage (Pay-as-you-go)</div>
			${eu.usedCredits !== null ? `
			<div class="row"><span class="label">Spent this month</span><span class="value">$${(eu.usedCredits / 100).toFixed(2)} ${eu.currency ?? ''}</span></div>
			` : ''}
			${eu.monthlyLimit !== null ? `
			<div class="row"><span class="label">Monthly limit</span><span class="value">$${(eu.monthlyLimit! / 100).toFixed(2)}</span></div>
			` : '<div class="row"><span class="label">Monthly limit</span><span class="value">No cap set</span></div>'}
			${eu.utilization !== null ? `
			<div class="row"><span class="label">Extra utilization</span><span class="value">${eu.utilization!.toFixed(1)}%</span></div>
			` : ''}
		</div>` : '';

	const buckets: string[] = [];
	if (data.fiveHour)       { buckets.push(bucketRow('5-Hour Window', data.fiveHour)); }
	if (data.sevenDay)       { buckets.push(bucketRow('7-Day Window', data.sevenDay)); }
	if (data.sevenDaySonnet) { buckets.push(bucketRow('7-Day Sonnet', data.sevenDaySonnet)); }
	if (data.sevenDayOpus)   { buckets.push(bucketRow('7-Day Opus', data.sevenDayOpus)); }
	if (data.sevenDayOauthApps) { buckets.push(bucketRow('7-Day OAuth Apps', data.sevenDayOauthApps)); }

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
</style>
</head>
<body>
<h1>Claude Usage</h1>
<div class="subtitle">Updated ${data.fetchedAt.toLocaleTimeString()} · Source: api.anthropic.com/api/oauth/usage</div>

<div class="section">
	<div class="section-title">Quota Windows</div>
	${buckets.length > 0 ? buckets.join('') : '<div class="no-quota">No active quota windows returned.</div>'}
</div>

${extraSection}
</body>
</html>`;
}

export class UsagePanel {
	private panel: vscode.WebviewPanel | undefined;

	constructor(_extensionUri: vscode.Uri) {}

	public show(data: UsageData | null, error: string | null = null) {
		if (this.panel) {
			this.panel.webview.html = buildHtml(data, error);
			this.panel.reveal(vscode.ViewColumn.One, true);
			return;
		}
		this.panel = vscode.window.createWebviewPanel(
			'claudeUsage',
			'Claude Usage',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{ enableScripts: false, retainContextWhenHidden: false },
		);
		this.panel.webview.html = buildHtml(data, error);
		this.panel.onDidDispose(() => { this.panel = undefined; });
	}

	public update(data: UsageData | null, error: string | null = null) {
		if (this.panel) {
			this.panel.webview.html = buildHtml(data, error);
		}
	}

	public dispose() {
		this.panel?.dispose();
	}
}
