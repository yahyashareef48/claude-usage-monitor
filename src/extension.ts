import * as vscode from 'vscode';
import { fetchUsageData } from './usageClient';
import { StatusBarManager } from './statusBar';
import { UsagePanel } from './sessionPopover';
import { UsageData } from './types';

const POLL_INTERVAL_MS  = 60_000;       // normal: 1 minute
const BACKOFF_STEPS_MS  = [
	2  * 60_000,  // 1st error  → wait 2 min
	4  * 60_000,  // 2nd error  → wait 4 min
	8  * 60_000,  // 3rd error  → wait 8 min
	16 * 60_000,  // 4th+ error → wait 16 min
];

export function activate(context: vscode.ExtensionContext) {
	const statusBar = new StatusBarManager();
	const panel     = new UsagePanel(context.extensionUri);

	let currentData:  UsageData | null = null;
	let currentError: string | null    = null;
	let errorCount    = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function scheduleNext() {
		const delay = errorCount === 0
			? POLL_INTERVAL_MS
			: BACKOFF_STEPS_MS[Math.min(errorCount - 1, BACKOFF_STEPS_MS.length - 1)];

		timer = setTimeout(async () => {
			await refresh();
			scheduleNext();
		}, delay);
	}

	async function refresh() {
		try {
			currentData  = await fetchUsageData();
			currentError = null;
			errorCount   = 0;
			statusBar.update(currentData);
			panel.update(currentData, null);
		} catch (err) {
			errorCount++;
			currentError = err instanceof Error ? err.message : String(err);
			statusBar.showError(currentError);
			panel.update(null, currentError);
			console.error('[Claude Usage Monitor]', currentError);
		}
	}

	// Initial fetch then start the loop
	refresh().then(() => scheduleNext());

	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		panel.show(currentData, currentError);
	});

	const refreshCmd = vscode.commands.registerCommand('claude-usage-monitor.refresh', async () => {
		if (timer) { clearTimeout(timer); timer = null; }
		await refresh();
		scheduleNext();
	});

	context.subscriptions.push(
		{ dispose: () => { if (timer) { clearTimeout(timer); } } },
		statusBar,
		panel,
		showPopup,
		refreshCmd,
	);
}

export function deactivate() {}
