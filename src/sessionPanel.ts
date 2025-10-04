import * as vscode from 'vscode';
import { SessionMetrics, PlanConfig } from './types';
import { formatTimeRemaining, formatDateTime, getStatusColor, estimateTimeToLimit } from './sessionCalculator';

/**
 * Manages the webview panel showing session details
 */
export class SessionPanel {
	private panel: vscode.WebviewPanel | undefined;
	private disposables: vscode.Disposable[] = [];

	constructor(private extensionUri: vscode.Uri) {}

	/**
	 * Show the session panel with current metrics
	 */
	public show(session: SessionMetrics | null, planConfig: PlanConfig) {
		if (this.panel) {
			// Panel already exists, just update and reveal
			this.panel.webview.html = this.getHtmlContent(session, planConfig);
			this.panel.reveal();
		} else {
			// Create new panel
			this.panel = vscode.window.createWebviewPanel(
				'claudeSessionPanel',
				'Claude Session Timer',
				vscode.ViewColumn.One,
				{
					enableScripts: true,
					retainContextWhenHidden: true
				}
			);

			this.panel.webview.html = this.getHtmlContent(session, planConfig);

			// Handle panel disposal
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.disposables.forEach(d => d.dispose());
				this.disposables = [];
			}, null, this.disposables);
		}
	}

	/**
	 * Update the panel content if it's visible
	 */
	public update(session: SessionMetrics | null, planConfig: PlanConfig) {
		if (this.panel) {
			this.panel.webview.html = this.getHtmlContent(session, planConfig);
		}
	}

	/**
	 * Close the panel
	 */
	public dispose() {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	/**
	 * Generate HTML content for the panel
	 */
	private getHtmlContent(session: SessionMetrics | null, planConfig: PlanConfig): string {
		if (!session) {
			return this.getNoSessionHtml();
		}

		const usagePercent = (session.totalTokens / planConfig.tokenLimit) * 100;
		const statusColor = getStatusColor(usagePercent);
		const timeToLimit = estimateTimeToLimit(session.totalTokens, planConfig.tokenLimit, session.burnRate);

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Claude Session Timer</title>
	<style>
		body {
			padding: 20px;
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
		}
		.header {
			margin-bottom: 30px;
		}
		.header h1 {
			margin: 0 0 10px 0;
			font-size: 24px;
		}
		.status-badge {
			display: inline-block;
			padding: 4px 12px;
			border-radius: 12px;
			font-size: 12px;
			font-weight: 600;
			background-color: ${statusColor}20;
			color: ${statusColor};
			border: 1px solid ${statusColor};
		}
		.section {
			margin-bottom: 25px;
			padding: 15px;
			background-color: var(--vscode-editor-inactiveSelectionBackground);
			border-radius: 6px;
		}
		.section h2 {
			margin: 0 0 15px 0;
			font-size: 16px;
			color: var(--vscode-foreground);
		}
		.metric-row {
			display: flex;
			justify-content: space-between;
			padding: 8px 0;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.metric-row:last-child {
			border-bottom: none;
		}
		.metric-label {
			font-weight: 500;
			color: var(--vscode-descriptionForeground);
		}
		.metric-value {
			font-weight: 600;
			color: var(--vscode-foreground);
		}
		.progress-bar {
			width: 100%;
			height: 8px;
			background-color: var(--vscode-editor-background);
			border-radius: 4px;
			overflow: hidden;
			margin-top: 10px;
		}
		.progress-fill {
			height: 100%;
			background-color: ${statusColor};
			transition: width 0.3s ease;
		}
		.warning {
			padding: 12px;
			background-color: #ffd93d20;
			border-left: 3px solid #ffd93d;
			border-radius: 4px;
			margin-top: 15px;
		}
		.error {
			padding: 12px;
			background-color: #ff6b6b20;
			border-left: 3px solid #ff6b6b;
			border-radius: 4px;
			margin-top: 15px;
		}
	</style>
</head>
<body>
	<div class="header">
		<h1>Claude Session Timer</h1>
		<span class="status-badge">${session.isActive ? 'Active' : 'Expired'}</span>
	</div>

	<div class="section">
		<h2>⏰ Session Timing</h2>
		<div class="metric-row">
			<span class="metric-label">Started</span>
			<span class="metric-value">${formatDateTime(session.startTime)}</span>
		</div>
		<div class="metric-row">
			<span class="metric-label">Ends</span>
			<span class="metric-value">${formatDateTime(session.sessionEndTime)}</span>
		</div>
		<div class="metric-row">
			<span class="metric-label">Time Remaining</span>
			<span class="metric-value">${session.isActive ? formatTimeRemaining(session.timeRemaining) : 'Expired'}</span>
		</div>
		<div class="metric-row">
			<span class="metric-label">Last Activity</span>
			<span class="metric-value">${formatDateTime(session.lastMessageTime)}</span>
		</div>
	</div>

	<div class="section">
		<h2>📊 Token Usage</h2>
		<div class="metric-row">
			<span class="metric-label">Total Tokens</span>
			<span class="metric-value">${session.totalTokens.toLocaleString()} / ${planConfig.tokenLimit.toLocaleString()}</span>
		</div>
		<div class="progress-bar">
			<div class="progress-fill" style="width: ${Math.min(usagePercent, 100)}%"></div>
		</div>
		<div class="metric-row" style="margin-top: 15px;">
			<span class="metric-label">Input Tokens</span>
			<span class="metric-value">${session.inputTokens.toLocaleString()}</span>
		</div>
		<div class="metric-row">
			<span class="metric-label">Output Tokens</span>
			<span class="metric-value">${session.outputTokens.toLocaleString()}</span>
		</div>
		<div class="metric-row">
			<span class="metric-label">Cache Creation</span>
			<span class="metric-value">${session.cacheCreationTokens.toLocaleString()}</span>
		</div>
		<div class="metric-row">
			<span class="metric-label">Cache Reads</span>
			<span class="metric-value">${session.cacheReadTokens.toLocaleString()}</span>
		</div>
		<div class="metric-row">
			<span class="metric-label">Messages</span>
			<span class="metric-value">${session.messages}</span>
		</div>
	</div>

	<div class="section">
		<h2>🔥 Performance</h2>
		<div class="metric-row">
			<span class="metric-label">Burn Rate</span>
			<span class="metric-value">${Math.round(session.burnRate)} tokens/min</span>
		</div>
		<div class="metric-row">
			<span class="metric-label">Usage</span>
			<span class="metric-value">${usagePercent.toFixed(1)}%</span>
		</div>
		${timeToLimit ? `
		<div class="metric-row">
			<span class="metric-label">Est. Time to Limit</span>
			<span class="metric-value">${formatTimeRemaining(timeToLimit)}</span>
		</div>
		` : ''}
	</div>

	${usagePercent >= 80 ? `
	<div class="${usagePercent >= 100 ? 'error' : 'warning'}">
		<strong>⚠️ ${usagePercent >= 100 ? 'Limit Reached!' : 'High Usage Warning'}</strong><br>
		You've used ${usagePercent.toFixed(1)}% of your ${planConfig.plan.toUpperCase()} plan limit (${planConfig.tokenLimit.toLocaleString()} tokens).
		${session.isActive ? ` Session resets in ${formatTimeRemaining(session.timeRemaining)}.` : ' Session has expired.'}
	</div>
	` : ''}

	<script>
		// Auto-refresh every 5 seconds
		setTimeout(() => {
			window.location.reload();
		}, 5000);
	</script>
</body>
</html>`;
	}

	/**
	 * HTML for when no session is active
	 */
	private getNoSessionHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Claude Session Timer</title>
	<style>
		body {
			padding: 40px;
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			display: flex;
			align-items: center;
			justify-content: center;
			min-height: 200px;
		}
		.empty-state {
			text-align: center;
		}
		.empty-state h2 {
			margin-bottom: 10px;
			color: var(--vscode-descriptionForeground);
		}
	</style>
</head>
<body>
	<div class="empty-state">
		<h2>No Active Session</h2>
		<p>Start a conversation with Claude Code to begin tracking.</p>
	</div>
</body>
</html>`;
	}
}
