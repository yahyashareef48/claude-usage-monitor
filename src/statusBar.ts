import * as vscode from 'vscode';
import { getAccount } from './claudeConfig';
import { UsageData } from './types';
import {
	allWindows,
	blockedWindow,
	colorPct,
	formatTimeRemaining,
	IndicatorConfig,
	Level,
	levelOf,
	readColorSources,
	readIndicatorConfig,
	readStatusBarFormat,
	renderTemplate,
	templateWithDot,
	TOOLTIP_EMOJI,
} from './windows';

interface StatusBarConfig {
	format:       string;
	colorSources: string[];
	ind:          IndicatorConfig;
}

function readConfig(): StatusBarConfig {
	return {
		format:       readStatusBarFormat(),
		colorSources: readColorSources(),
		ind:          readIndicatorConfig(),
	};
}

function timeAgo(date: Date): string {
	const sec = Math.floor((Date.now() - date.getTime()) / 1000);
	if (sec < 60) { return 'just now'; }
	if (sec < 3600) { const m = Math.floor(sec / 60); return `${m} minute${m === 1 ? '' : 's'} ago`; }
	const h = Math.floor(sec / 3600);
	return `${h} hour${h === 1 ? '' : 's'} ago`;
}

const BACKGROUNDS: Record<Level, vscode.ThemeColor | undefined> = {
	normal:  undefined,
	warning: new vscode.ThemeColor('statusBarItem.warningBackground'),
	error:   new vscode.ThemeColor('statusBarItem.errorBackground'),
};

/** A dotted identifier is a theme colour id; anything else is a literal CSS colour. */
function themeOrCss(value: string): string | vscode.ThemeColor | undefined {
	const v = value.trim();
	if (!v) { return undefined; }
	return /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/.test(v) ? new vscode.ThemeColor(v) : v;
}

export class StatusBarManager {
	private item: vscode.StatusBarItem;
	private lastData:  UsageData | null = null;
	private lastError: string | null    = null;
	private lastFatal: string | null    = null;
	private configSub: vscode.Disposable;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'claude-usage-monitor.showPopup';
		this.item.show();

		// Repaint on every settings change, including from the error state — a
		// colour setting that only lands on the next poll reads as broken.
		this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('claude-usage-monitor')) { return; }
			if (this.lastFatal)     { this.showError(this.lastFatal); }
			else if (this.lastData) { this.update(this.lastData, this.lastError); }
		});
	}

	/**
	 * Paint the level. VS Code overrides `color` whenever a background is set,
	 * so a custom tint is only ours to give once the background is dropped —
	 * and in emoji mode neither is touched: the glyph lives in the text.
	 */
	private applyIndicator(ind: IndicatorConfig, level: Level) {
		if (ind.mode === 'background') {
			this.item.backgroundColor = BACKGROUNDS[level];
			this.item.color = undefined;
			return;
		}
		this.item.backgroundColor = undefined;
		this.item.color = ind.mode === 'text' ? themeOrCss(ind.colors[level]) : undefined;
	}

	public update(data: UsageData, error: string | null = null) {
		this.lastData  = data;
		this.lastError = error;
		this.lastFatal = null;

		const windows = allWindows(data);
		if (windows.length === 0) {
			this.item.text = '$(claude-icon) No data';
			this.item.tooltip = 'No quota windows returned from API';
			this.item.backgroundColor = undefined;
			this.item.color = undefined;
			return;
		}

		const { format, colorSources, ind } = readConfig();

		// Being blocked is the one state worth overriding a custom format for:
		// the only thing that matters then is when work can resume.
		const blocked = blockedWindow(data);
		const level: Level = blocked
			? 'error'
			: error
				? 'warning'
				: levelOf(colorPct(data, colorSources), ind.warnT, ind.errT);
		const dot = ind.emoji[level] ?? '';

		if (blocked) {
			const what  = blocked.key === '5h' ? 'blocked' : `${blocked.name} blocked`;
			const when  = blocked.resetsAt ? ` · ${formatTimeRemaining(blocked.resetsAt)}` : '';
			const glyph = ind.mode === 'emoji' && dot ? ` ${dot}` : '';
			this.item.text = `$(claude-icon) ${what}${when}${glyph}${error ? ' $(warning)' : ''}`;
		} else {
			const body = renderTemplate(templateWithDot(format, ind.mode), data, { dot });
			this.item.text = `${body || '$(claude-icon)'}${error ? ' $(warning)' : ''}`;
		}
		this.applyIndicator(ind, level);

		const bar = (p: number) => {
			const filled = Math.round(Math.min(p, 100) / 10);
			const lvl    = levelOf(p, ind.warnT, ind.errT);
			const color  = ind.emoji[lvl] || TOOLTIP_EMOJI[lvl];
			return `[${('█'.repeat(filled)).padEnd(10, '—')}] ${p.toFixed(0)}% ${color}`;
		};

		const lines: string[] = [`$(claude-icon) **Claude Usage**`];

		// Which account these numbers belong to. Worth a line even when the status
		// bar text does not carry {account}: with two windows on two accounts the
		// percentages alone are indistinguishable.
		const account = getAccount();
		if (account?.email) {
			// Personal orgs are named "<e-mail>'s Organization", which says nothing twice.
			const org = account.organizationName;
			const suffix = org && !org.startsWith(account.email) ? ` · ${org}` : '';
			lines.push(`$(account) ${account.email}${suffix}`);
		}

		lines.push(`---`);

		// One entry per window the account reports — per-model and pay-as-you-go
		// included, since they all come from the same normalised list.
		for (const w of windows) {
			if (w.money) {
				const cap = w.money.limit ? ` / ${w.money.limit}` : '';
				lines.push(`**${w.label}**  💳 ${w.money.spent}${cap} ${data.extraUsage?.currency ?? ''}`.trim());
			} else if (w.resetsAt) {
				lines.push(`**${w.label}**\n\n\`${bar(w.pct)}\`\n\n↻ Resets in **${formatTimeRemaining(w.resetsAt)}**`);
			} else {
				lines.push(`**${w.label}**\n\n\`${bar(w.pct)}\``);
			}
		}

		if (error) {
			lines.push(`⚠️ *Poll failed — showing cached data*`);
		}

		lines.push(`---\n_Updated ${timeAgo(data.fetchedAt)} · Click to open panel_`);

		const md = new vscode.MarkdownString(lines.join('\n\n'));
		md.supportThemeIcons = true;
		this.item.tooltip = md;
	}

	public showInitializing() {
		this.lastFatal = null;
		this.item.text = '$(claude-icon) Connecting…';
		this.item.tooltip = 'Fetching Claude usage data…';
		this.item.backgroundColor = undefined;
		this.item.color = undefined;
	}

	public showError(message: string) {
		this.lastFatal = message;
		const ind   = readIndicatorConfig();
		const glyph = ind.mode === 'emoji' && ind.emoji.error ? ` ${ind.emoji.error}` : '';
		this.item.text = `$(claude-icon) Error${glyph}`;
		this.applyIndicator(ind, 'error');

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
