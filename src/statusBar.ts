import * as vscode from 'vscode';
import { ExtraUsage, QuotaBucket, UsageData } from './types';

type StatusBarMode = '5h' | '7d' | 'both';
type ColorSource   = '5h' | '7d' | 'max';

interface StatusBarConfig {
	mode:             StatusBarMode;
	colorSource:      ColorSource;
	warningThreshold: number;
	errorThreshold:   number;
}

function readConfig(): StatusBarConfig {
	const cfg = vscode.workspace.getConfiguration('claude-usage-monitor');
	return {
		mode:             cfg.get<StatusBarMode>('statusBar', '5h'),
		colorSource:      cfg.get<ColorSource>('statusBarColorFrom', 'max'),
		warningThreshold: cfg.get<number>('warningThreshold', 60),
		errorThreshold:   cfg.get<number>('errorThreshold', 80),
	};
}

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
	if (h >= 24) {
		return new Date(resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
	}
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function utilizationColor(pct: number, warnT: number, errT: number): vscode.ThemeColor | undefined {
	if (pct >= errT)  { return new vscode.ThemeColor('statusBarItem.errorBackground'); }
	if (pct >= warnT) { return new vscode.ThemeColor('statusBarItem.warningBackground'); }
	return undefined;
}

function hasSpend(eu: ExtraUsage | null): eu is ExtraUsage {
	return !!eu && eu.isEnabled && eu.usedCredits !== null;
}

function formatSpend(eu: ExtraUsage): string {
	const spent = ((eu.usedCredits ?? 0) / 100).toFixed(2);
	const cap   = eu.monthlyLimit !== null ? ` / $${(eu.monthlyLimit / 100).toFixed(2)}` : '';
	const cur   = eu.currency ? ` ${eu.currency}` : '';
	return `$${spent}${cap}${cur}`;
}

function renderPayText(eu: ExtraUsage, withWarning: boolean): string {
	const suffix = withWarning ? ' $(warning)' : '';
	const pct    = eu.utilization !== null ? `${eu.utilization.toFixed(0)}% · ` : '';
	return `$(claude-icon) 💳 ${pct}${formatSpend(eu)}${suffix}`;
}

function pickColorPct(
	colorSource: ColorSource,
	fh: QuotaBucket,
	sd: QuotaBucket | null,
): number {
	switch (colorSource) {
		case '5h':  return fh.utilization;
		case '7d':  return sd ? sd.utilization : fh.utilization;
		case 'max': return sd ? Math.max(fh.utilization, sd.utilization) : fh.utilization;
	}
}

function renderText(
	mode: StatusBarMode,
	fh: QuotaBucket,
	sd: QuotaBucket | null,
	eu: ExtraUsage | null,
	withWarning: boolean,
): string {
	const suffix = withWarning ? ' $(warning)' : '';
	// Surface pay-as-you-go spend inline once credits are actually being used, so
	// overage on a regular plan is never hidden behind the quota windows.
	const overage = hasSpend(eu) && (eu.usedCredits ?? 0) > 0
		? ` · 💳 $${((eu.usedCredits ?? 0) / 100).toFixed(2)}`
		: '';
	const fhPct  = fh.utilization.toFixed(0);
	const fhTime = formatTimeRemaining(fh.resetsAt);

	if (mode === '7d' && sd) {
		const sdPct  = sd.utilization.toFixed(0);
		const sdTime = formatTimeRemaining(sd.resetsAt);
		return `$(claude-icon) 7d ${sdPct}% · ${sdTime}${overage}${suffix}`;
	}

	if (mode === 'both' && sd) {
		const sdPct = sd.utilization.toFixed(0);
		return `$(claude-icon) 5h ${fhPct}% (${fhTime}) · 7d ${sdPct}%${overage}${suffix}`;
	}

	// '5h' mode, or '7d'/'both' fallback when sevenDay is missing
	return `$(claude-icon) ${fhPct}% · ${fhTime}${overage}${suffix}`;
}

export class StatusBarManager {
	private item: vscode.StatusBarItem;
	private lastData:  UsageData | null = null;
	private lastError: string | null    = null;
	private configSub: vscode.Disposable;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'claude-usage-monitor.showPopup';
		this.item.show();

		this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration('claude-usage-monitor.statusBar') ||
				e.affectsConfiguration('claude-usage-monitor.statusBarColorFrom') ||
				e.affectsConfiguration('claude-usage-monitor.warningThreshold') ||
				e.affectsConfiguration('claude-usage-monitor.errorThreshold')
			) {
				if (this.lastData) {
					this.update(this.lastData, this.lastError);
				}
			}
		});
	}

	public update(data: UsageData, error: string | null = null) {
		this.lastData  = data;
		this.lastError = error;

		const { mode, colorSource, warningThreshold, errorThreshold } = readConfig();
		const fh = data.fiveHour;
		const sd = data.sevenDay;
		const eu = data.extraUsage;

		// Decide status bar text + which percentage drives the background color.
		// Pay-as-you-go-only accounts return no quota windows (fh === null), so
		// fall back to the credit display whenever spend data is available.
		let colorPct: number | null;
		if (fh) {
			this.item.text = renderText(mode, fh, sd, eu, !!error);
			colorPct = pickColorPct(colorSource, fh, sd);
		} else if (hasSpend(eu)) {
			this.item.text = renderPayText(eu, !!error);
			colorPct = eu.utilization;
		} else {
			this.item.text = '$(claude-icon) No data';
			this.item.tooltip = 'No quota or usage data returned from API';
			this.item.backgroundColor = error
				? new vscode.ThemeColor('statusBarItem.warningBackground')
				: undefined;
			return;
		}

		this.item.backgroundColor = error
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: (colorPct !== null ? utilizationColor(colorPct, warningThreshold, errorThreshold) : undefined);

		const bar = (p: number) => {
			const filled = Math.round(Math.min(p, 100) / 10);
			const color  = p >= errorThreshold ? '🔴' : p >= warningThreshold ? '🟡' : '🟢';
			return `[${('█'.repeat(filled)).padEnd(10, '—')}] ${p.toFixed(0)}% ${color}`;
		};

		const lines: string[] = [
			`$(claude-icon) **Claude Usage**`,
			`---`,
		];

		if (fh) {
			lines.push(
				`**5-Hour Window**`,
				`\`${bar(fh.utilization)}\``,
				`↻ Resets in **${formatTimeRemaining(fh.resetsAt)}**`,
			);
		}

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
		this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');

		let displayMsg = message;
		let hint: string | null = null;
		if (message.includes('401')) {
			displayMsg = 'HTTP 401 — Token expired or invalid.';
			hint = 'Fix: run `claude` in terminal to start a session, then Ctrl+Shift+P → Claude: Refresh Usage. Or: `claude logout` and log back in.';
		} else if (message.includes('403')) {
			displayMsg = 'HTTP 403 — Account lacks API access.';
			hint = 'Fix: ensure you are logged in to Claude Code with a Pro or Max subscription.';
		} else if (message.includes('429')) {
			displayMsg = 'HTTP 429 — Rate limited.';
			hint = 'The extension will retry automatically.';
		} else if (message.includes('timed out') || message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
			displayMsg = 'Network error — cannot reach api.anthropic.com.';
			hint = 'Fix: check your internet connection, then Ctrl+Shift+P → Claude: Refresh Usage.';
		} else if (message.includes('No OAuth token')) {
			displayMsg = 'Not logged in to Claude Code.';
			hint = 'Fix: run `claude` in terminal to log in, then Ctrl+Shift+P → Claude: Refresh Usage.';
		}

		const md = new vscode.MarkdownString(
			hint
				? `**Error:** ${displayMsg}\n\n${hint}`
				: `**Error:** ${displayMsg}`
		);
		md.supportThemeIcons = true;
		this.item.tooltip = md;
	}

	public dispose() {
		this.item.dispose();
		this.configSub.dispose();
	}
}
