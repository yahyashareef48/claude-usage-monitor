import * as vscode from 'vscode';
import { SessionMetrics, PlanConfig } from './types';
import { formatTimeRemaining, formatDateTime, getStatusColor, estimateTimeToLimit } from './sessionCalculator';

/**
 * Manages a compact hover panel (Copilot-style)
 */
export class SessionHoverPanel {
	private panel: vscode.WebviewPanel | undefined;

	constructor(private extensionUri: vscode.Uri) {}

	public show(session: SessionMetrics | null, planConfig: PlanConfig) {
		if (this.panel) {
			this.panel.webview.html = this.getHtmlContent(session, planConfig);
			this.panel.reveal(vscode.ViewColumn.One, true);
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'claudeSessionHover',
			'Claude Session',
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
			{
				enableScripts: false,
				retainContextWhenHidden: false
			}
		);

		this.panel.webview.html = this.getHtmlContent(session, planConfig);

		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
	}

	public dispose() {
		this.panel?.dispose();
	}

	private getHtmlContent(session: SessionMetrics | null, planConfig: PlanConfig): string {
		if (!session) {
			return this.getNoSessionHtml();
		}

		const usagePercent = (session.totalTokens / planConfig.tokenLimit) * 100;
		const statusColor = getStatusColor(usagePercent);
		const timeToLimit = estimateTimeToLimit(session.totalTokens, planConfig.tokenLimit, session.burnRate);

		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: var(--vscode-font-family);
			font-size: 13px;
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			padding: 16px;
			max-width: 400px;
		}
		.header {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 16px;
			padding-bottom: 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.badge {
			padding: 2px 8px;
			border-radius: 10px;
			font-size: 11px;
			font-weight: 600;
			background: ${statusColor}20;
			color: ${statusColor};
			border: 1px solid ${statusColor};
		}
		.section {
			margin-bottom: 16px;
		}
		.section-title {
			font-size: 11px;
			font-weight: 600;
			color: var(--vscode-descriptionForeground);
			text-transform: uppercase;
			margin-bottom: 8px;
		}
		.row {
			display: flex;
			justify-content: space-between;
			padding: 6px 0;
			font-size: 12px;
		}
		.label {
			color: var(--vscode-descriptionForeground);
		}
		.value {
			font-weight: 500;
		}
		.progress {
			width: 100%;
			height: 6px;
			background: var(--vscode-editor-background);
			border-radius: 3px;
			overflow: hidden;
			margin: 8px 0;
		}
		.progress-fill {
			height: 100%;
			background: ${statusColor};
			width: ${Math.min(usagePercent, 100)}%;
		}
		.warning {
			padding: 8px 12px;
			background: #ffd93d20;
			border-left: 3px solid #ffd93d;
			border-radius: 4px;
			font-size: 12px;
			margin-top: 12px;
		}
		.error {
			padding: 8px 12px;
			background: #ff6b6b20;
			border-left: 3px solid #ff6b6b;
			border-radius: 4px;
			font-size: 12px;
			margin-top: 12px;
		}
	</style>
</head>
<body>
	<div class="header">
		<strong>Claude Session</strong>
		<span class="badge">${session.isActive ? 'Active' : 'Expired'}</span>
	</div>

	<div class="section">
		<div class="section-title">Session Timing</div>
		<div class="row">
			<span class="label">Started</span>
			<span class="value">${formatDateTime(session.startTime)}</span>
		</div>
		<div class="row">
			<span class="label">Ends</span>
			<span class="value">${formatDateTime(session.sessionEndTime)}</span>
		</div>
		<div class="row">
			<span class="label">Time Left</span>
			<span class="value">${session.isActive ? formatTimeRemaining(session.timeRemaining) : 'Expired'}</span>
		</div>
	</div>

	<div class="section">
		<div class="section-title">Token Usage</div>
		<div class="row">
			<span class="label">Total</span>
			<span class="value">${session.totalTokens.toLocaleString()} / ${planConfig.tokenLimit.toLocaleString()}</span>
		</div>
		<div class="progress">
			<div class="progress-fill"></div>
		</div>
		<div class="row" style="margin-top: 4px;">
			<span class="label">Usage</span>
			<span class="value">${usagePercent.toFixed(1)}%</span>
		</div>
	</div>

	<div class="section">
		<div class="section-title">Details</div>
		<div class="row">
			<span class="label">Input</span>
			<span class="value">${session.inputTokens.toLocaleString()}</span>
		</div>
		<div class="row">
			<span class="label">Output</span>
			<span class="value">${session.outputTokens.toLocaleString()}</span>
		</div>
		<div class="row">
			<span class="label">Cache Creation</span>
			<span class="value">${session.cacheCreationTokens.toLocaleString()}</span>
		</div>
		<div class="row">
			<span class="label">Cache Reads</span>
			<span class="value">${session.cacheReadTokens.toLocaleString()}</span>
		</div>
		<div class="row">
			<span class="label">Burn Rate</span>
			<span class="value">${Math.round(session.burnRate)} tokens/min</span>
		</div>
		${timeToLimit ? `
		<div class="row">
			<span class="label">Est. Time to Limit</span>
			<span class="value">${formatTimeRemaining(timeToLimit)}</span>
		</div>
		` : ''}
	</div>

	${usagePercent >= 80 ? `
	<div class="${usagePercent >= 100 ? 'error' : 'warning'}">
		<strong>${usagePercent >= 100 ? '⚠️ Limit Reached' : '⚠️ High Usage'}</strong><br>
		${usagePercent.toFixed(1)}% of ${planConfig.plan.toUpperCase()} plan used
	</div>
	` : ''}
</body>
</html>`;
	}

	private getNoSessionHtml(): string {
		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<style>
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-descriptionForeground);
			background: var(--vscode-editor-background);
			padding: 40px 20px;
			text-align: center;
		}
		h3 { margin-bottom: 8px; }
	</style>
</head>
<body>
	<h3>No Active Session</h3>
	<p>Start a conversation with Claude Code to begin tracking.</p>
</body>
</html>`;
	}
}

// Legacy function for compatibility
export function showSessionPopover(session: SessionMetrics | null, planConfig: PlanConfig) {
	// This will be replaced by the panel in extension.ts
}
