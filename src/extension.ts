import * as vscode from 'vscode';
import { fetchUsageData } from './usageClient';
import { StatusBarManager } from './statusBar';
import { UsagePanel } from './sessionPopover';
import { UsageData } from './types';

const POLL_INTERVAL_MS = 30_000;

export function activate(context: vscode.ExtensionContext) {
	const statusBar = new StatusBarManager();
	const panel = new UsagePanel(context.extensionUri);

	let currentData: UsageData | null = null;
	let currentError: string | null = null;

	statusBar.showInitializing();

	async function refresh() {
		try {
			currentData = await fetchUsageData();
			currentError = null;
			statusBar.update(currentData);
			panel.update(currentData, null);
		} catch (err) {
			currentError = err instanceof Error ? err.message : String(err);
			statusBar.showError(currentError);
			panel.update(null, currentError);
			console.error('[Claude Usage Monitor]', currentError);
		}
	}

	refresh();
	const interval = setInterval(refresh, POLL_INTERVAL_MS);

	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		panel.show(currentData, currentError);
	});

	const refreshCmd = vscode.commands.registerCommand('claude-usage-monitor.refresh', () => {
		refresh();
	});

	context.subscriptions.push(
		{ dispose: () => clearInterval(interval) },
		statusBar,
		panel,
		showPopup,
		refreshCmd,
	);
}

export function deactivate() {}
