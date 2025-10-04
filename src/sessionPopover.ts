import * as vscode from 'vscode';
import { SessionMetrics, PlanConfig } from './types';
import { formatTimeRemaining, formatDateTime, getStatusColor, estimateTimeToLimit } from './sessionCalculator';

/**
 * Show a quick pick popover with session details (similar to Copilot's UI)
 */
export function showSessionPopover(session: SessionMetrics | null, planConfig: PlanConfig) {
	if (!session) {
		vscode.window.showQuickPick(['No active session. Start a conversation with Claude Code to begin tracking.'], {
			title: '$(claude-icon) Claude Session Monitor',
			placeHolder: 'No active session'
		});
		return;
	}

	const usagePercent = (session.totalTokens / planConfig.tokenLimit) * 100;
	const timeToLimit = estimateTimeToLimit(session.totalTokens, planConfig.tokenLimit, session.burnRate);

	const items: vscode.QuickPickItem[] = [
		{
			label: '$(clock) Session Timing',
			kind: vscode.QuickPickItemKind.Separator
		},
		{
			label: `Started: ${formatDateTime(session.startTime)}`,
			description: ''
		},
		{
			label: `Ends: ${formatDateTime(session.sessionEndTime)}`,
			description: session.isActive ? `in ${formatTimeRemaining(session.timeRemaining)}` : '(Expired)'
		},
		{
			label: `Time Remaining: ${session.isActive ? formatTimeRemaining(session.timeRemaining) : 'Expired'}`,
			description: session.isActive ? '✓ Active' : '⚠️ Expired'
		},
		{
			label: '',
			kind: vscode.QuickPickItemKind.Separator
		},
		{
			label: '$(graph) Token Usage',
			kind: vscode.QuickPickItemKind.Separator
		},
		{
			label: `Total: ${session.totalTokens.toLocaleString()} / ${planConfig.tokenLimit.toLocaleString()}`,
			description: `${usagePercent.toFixed(1)}%`,
			detail: getUsageBar(usagePercent)
		},
		{
			label: `Input Tokens: ${session.inputTokens.toLocaleString()}`,
			description: ''
		},
		{
			label: `Output Tokens: ${session.outputTokens.toLocaleString()}`,
			description: ''
		},
		{
			label: `Cache Creation: ${session.cacheCreationTokens.toLocaleString()}`,
			description: ''
		},
		{
			label: `Cache Reads: ${session.cacheReadTokens.toLocaleString()}`,
			description: ''
		},
		{
			label: `Messages: ${session.messages}`,
			description: ''
		},
		{
			label: '',
			kind: vscode.QuickPickItemKind.Separator
		},
		{
			label: '$(flame) Performance',
			kind: vscode.QuickPickItemKind.Separator
		},
		{
			label: `Burn Rate: ${Math.round(session.burnRate)} tokens/min`,
			description: ''
		}
	];

	// Add time to limit if applicable
	if (timeToLimit && session.isActive) {
		items.push({
			label: `Est. Time to Limit: ${formatTimeRemaining(timeToLimit)}`,
			description: '⏱️'
		});
	}

	// Add warning if high usage
	if (usagePercent >= 80) {
		items.push({
			label: '',
			kind: vscode.QuickPickItemKind.Separator
		});
		items.push({
			label: usagePercent >= 100 ? '$(error) Limit Reached!' : '$(warning) High Usage Warning',
			description: `${usagePercent.toFixed(1)}%`,
			detail: `You've used ${usagePercent.toFixed(1)}% of your ${planConfig.plan.toUpperCase()} plan limit.`
		});
	}

	const quickPick = vscode.window.createQuickPick();
	quickPick.title = `$(claude-icon) Claude Session Monitor`;
	quickPick.placeholder = `Session ${session.isActive ? 'active' : 'expired'} • ${session.totalTokens.toLocaleString()} tokens used`;
	quickPick.items = items;
	quickPick.canSelectMany = false;

	// Close when user clicks away or presses Escape
	quickPick.onDidHide(() => quickPick.dispose());

	quickPick.show();
}

/**
 * Generate a simple text-based progress bar
 */
function getUsageBar(percent: number): string {
	const barLength = 30;
	const filled = Math.round((percent / 100) * barLength);
	const empty = barLength - filled;

	const bar = '█'.repeat(filled) + '░'.repeat(empty);

	let color = '🟢';
	if (percent >= 80) {
		color = '🔴';
	} else if (percent >= 60) {
		color = '🟡';
	}

	return `${color} ${bar}`;
}
