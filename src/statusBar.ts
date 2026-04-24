import * as vscode from 'vscode';
import { UsageData } from './types';

function formatTimeRemaining(resetsAt: string): string {
	const ms = new Date(resetsAt).getTime() - Date.now();
	if (ms <= 0) { return 'resetting'; }
	const totalMin = Math.floor(ms / 60_000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function utilizationColor(pct: number): vscode.ThemeColor | undefined {
	if (pct >= 80) { return new vscode.ThemeColor('statusBarItem.errorBackground'); }
	if (pct >= 60) { return new vscode.ThemeColor('statusBarItem.warningBackground'); }
	return undefined;
}

export class StatusBarManager {
	private item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'claude-usage-monitor.showPopup';
		this.item.show();
	}

	public update(data: UsageData, error: string | null = null) {
		const fh = data.fiveHour;
		if (!fh) {
			this.item.text = '$(claude-icon) No data';
			this.item.tooltip = 'No 5-hour quota data returned from API';
			this.item.backgroundColor = undefined;
			return;
		}

		const pct = fh.utilization;
		const timeLeft = formatTimeRemaining(fh.resetsAt);

		this.item.text = error
			? `$(claude-icon) ${pct.toFixed(0)}% · ${timeLeft} $(warning)`
			: `$(claude-icon) ${pct.toFixed(0)}% · ${timeLeft}`;
		this.item.backgroundColor = error
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: utilizationColor(pct);

		const sd = data.sevenDay;
		const eu = data.extraUsage;

		const lines: string[] = [
			`**5-hour window:** ${pct.toFixed(1)}% used — resets in ${timeLeft}`,
		];
		if (sd) {
			lines.push(`**7-day window:** ${sd.utilization.toFixed(1)}% — resets ${formatTimeRemaining(sd.resetsAt)}`);
		}
		if (data.sevenDaySonnet) {
			lines.push(`**7-day Sonnet:** ${data.sevenDaySonnet.utilization.toFixed(1)}%`);
		}
		if (data.sevenDayOpus) {
			lines.push(`**7-day Opus:** ${data.sevenDayOpus.utilization.toFixed(1)}%`);
		}
		if (eu?.isEnabled && eu.usedCredits !== null) {
			const credits = (eu.usedCredits / 100).toFixed(2);
			lines.push(`**Extra usage:** $${credits} ${eu.currency ?? ''}`);
		}
		if (error) {
			lines.push(`⚠️ **Poll error:** ${error}`);
		}
		lines.push(`_Click for details · Updated ${data.fetchedAt.toLocaleTimeString()}_`);

		this.item.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
	}

	public showInitializing() {
		this.item.text = '$(claude-icon) Connecting…';
		this.item.tooltip = 'Fetching Claude usage data…';
		this.item.backgroundColor = undefined;
	}

	public showError(message: string) {
		this.item.text = '$(claude-icon) Error';
		this.item.tooltip = message;
		this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
	}

	public dispose() {
		this.item.dispose();
	}
}
