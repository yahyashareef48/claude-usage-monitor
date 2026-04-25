import * as vscode from 'vscode';
import { UsageData } from './types';

function timeAgo(date: Date): string {
	const sec = Math.floor((Date.now() - date.getTime()) / 1000);
	if (sec < 60) { return 'just now'; }
	if (sec < 3600) { const m = Math.floor(sec / 60); return `${m} minute${m === 1 ? '' : 's'} ago`; }
	const h = Math.floor(sec / 3600);
	return `${h} hour${h === 1 ? '' : 's'} ago`;
}

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

		const sd  = data.sevenDay;
		const eu  = data.extraUsage;

		const bar = (p: number) => {
			const filled = Math.round(Math.min(p, 100) / 10);
			const color  = p >= 80 ? '🔴' : p >= 60 ? '🟡' : '🟢';
			return `[${('█'.repeat(filled)).padEnd(10, '—')}] ${p.toFixed(0)}% ${color}`;
		};

		const lines: string[] = [
			`$(claude-icon) **Claude Usage**`,
			`---`,
			`**5-Hour Window**`,
			`\`${bar(pct)}\``,
			`↻ Resets in **${timeLeft}**`,
		];

		if (sd) {
			lines.push(
				`\n**7-Day Window**`,
				`\`${bar(sd.utilization)}\``,
				`↻ Resets in **${formatTimeRemaining(sd.resetsAt)}**`,
			);
		}

		if (data.sevenDaySonnet) {
			lines.push(`**7-Day Sonnet** \`${bar(data.sevenDaySonnet.utilization)}\``);
		}
		if (data.sevenDayOpus) {
			lines.push(`**7-Day Opus** \`${bar(data.sevenDayOpus.utilization)}\``);
		}

		if (eu?.isEnabled && eu.usedCredits !== null) {
			const spent = (eu.usedCredits / 100).toFixed(2);
			const cap   = eu.monthlyLimit !== null ? ` / $${(eu.monthlyLimit / 100).toFixed(2)}` : '';
			lines.push(`\n**Extra Usage**  💳 $${spent}${cap} ${eu.currency ?? ''}`);
		}

		if (error) {
			lines.push(`\n⚠️ *Poll failed — showing cached data*`);
		}

		lines.push(`\n---\n_Updated ${timeAgo(data.fetchedAt)} · Click to open panel_`);

		const md = new vscode.MarkdownString(lines.join('\n\n'));
		md.supportThemeIcons = true;
		this.item.tooltip = md;
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
