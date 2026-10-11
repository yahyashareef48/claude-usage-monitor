import * as vscode from 'vscode';
import { UsageData } from './types';
import { accountScopedKey } from './claudeConfig';
import { QuotaWindow, allWindows, formatTimeRemaining, resetMs, sameCycle } from './windows';

/**
 * Threshold notifications. The status bar turning red is easy to miss while
 * you are heads-down in a file, so crossing a threshold says so once — and
 * only once per window per reset cycle, because an extension that nags every
 * poll gets uninstalled.
 */

/** Account-scoped: one account going quiet must not mute the other. */
const stateKey = () => accountScopedKey('claudeUsage.notified.v2');

/** Highest level already announced for a window, and the cycle it applies to. */
interface Announced { at: number | null; level: number; }

const enum Level { none = 0, warning = 1, error = 2, blocked = 3 }

function levelOf(w: QuotaWindow, warnT: number, errT: number): Level {
	if (w.pct >= 100)  { return Level.blocked; }
	if (w.pct >= errT)  { return Level.error; }
	if (w.pct >= warnT) { return Level.warning; }
	return Level.none;
}


function show(w: QuotaWindow, level: Level) {
	const when = w.resetsAt ? ` — resets in ${formatTimeRemaining(w.resetsAt)}` : '';
	const message = level === Level.blocked
		? `Claude ${w.label} exhausted${when}`
		: `Claude ${w.label} at ${Math.round(w.pct)}%${when}`;

	const open = 'Open panel';
	const shown = level >= Level.error
		? vscode.window.showWarningMessage(message, open)
		: vscode.window.showInformationMessage(message, open);

	shown.then((choice) => {
		if (choice === open) { vscode.commands.executeCommand('claude-usage-monitor.showPopup'); }
	});
}

export async function maybeNotify(memento: vscode.Memento, data: UsageData): Promise<void> {
	const cfg  = vscode.workspace.getConfiguration('claude-usage-monitor');
	const mode = cfg.get<string>('notifications', 'error');
	if (mode === 'off') { return; }

	const warnT    = cfg.get<number>('warningThreshold', 60);
	const errT     = cfg.get<number>('errorThreshold', 80);
	const minLevel = mode === 'all' ? Level.warning : Level.error;

	const seen = memento.get<Record<string, Announced>>(stateKey()) ?? {};
	const due: Array<[QuotaWindow, Level]> = [];

	// Rebuilt from the live windows each poll, so entries for windows the API
	// stops reporting fall away and the record stays bounded by window count.
	const next: Record<string, Announced> = {};

	for (const w of allWindows(data)) {
		const at   = resetMs(w.resetsAt);
		const prev = seen[w.key];
		// Carry the announced level forward only within the same cycle; a real
		// reset re-arms it. Compared with a tolerance, because `resets_at` wobbles
		// either side of a minute boundary between responses.
		const already = prev && sameCycle(prev.at, at) ? prev.level : Level.none;

		const level = levelOf(w, warnT, errT);
		const worth = level >= minLevel ? level : Level.none;
		next[w.key] = { at, level: Math.max(already, worth) };

		if (worth > already) { due.push([w, level]); }
	}

	if (due.length === 0 && JSON.stringify(next) === JSON.stringify(seen)) { return; }

	// Record before showing: globalState is shared across windows, so writing
	// first keeps a second window from repeating the same notification.
	await memento.update(stateKey(), next);
	for (const [w, level] of due) { show(w, level); }
}
