import * as vscode from 'vscode';
import { fetchUsageData } from './usageClient';
import { StatusBarManager } from './statusBar';
import { UsagePanel } from './sessionPopover';
import { UsageData } from './types';

const POLL_INTERVAL_MS = 2  * 60_000; // 2 minutes
const CACHE_TTL_MS     = 115_000;     // treat cache as fresh if < ~2min old
const BACKOFF_STEPS_MS = [
	4  * 60_000,  // 1st error → wait 4 min
	8  * 60_000,  // 2nd error → wait 8 min
	16 * 60_000,  // 3rd+ error → wait 16 min
];

const CACHE_KEY = 'claudeUsage.cache';

interface CacheEntry {
	data:      UsageData | null;
	error:     string | null;
	fetchedAt: number; // Date.now()
}

function reviveCache(raw: CacheEntry | undefined): CacheEntry | null {
	if (!raw) { return null; }
	// Rehydrate fetchedAt on the nested data object if present
	if (raw.data) {
		raw.data.fetchedAt = new Date(raw.data.fetchedAt);
	}
	return raw;
}

export function activate(context: vscode.ExtensionContext) {
	const statusBar = new StatusBarManager();
	const panel     = new UsagePanel(context.extensionUri);

	let currentData:  UsageData | null = null;
	let currentError: string | null    = null;
	let errorCount    = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let windowFocused = true;

	function applyState(data: UsageData | null, error: string | null) {
		currentData  = data;
		currentError = error;
		if (data) {
			statusBar.update(data);
			panel.update(data, null);
		} else {
			statusBar.showError(error ?? 'Unknown error');
			panel.update(null, error);
		}
	}

	function scheduleNext() {
		if (!windowFocused) { return; } // don't poll in background

		const delay = errorCount === 0
			? POLL_INTERVAL_MS
			: BACKOFF_STEPS_MS[Math.min(errorCount - 1, BACKOFF_STEPS_MS.length - 1)];

		timer = setTimeout(async () => {
			await refresh();
			scheduleNext();
		}, delay);
	}

	async function refresh() {
		// Check global cache first — skip fetch if another window just did it
		const cached = reviveCache(context.globalState.get<CacheEntry>(CACHE_KEY));
		if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
			errorCount = cached.error ? errorCount : 0;
			applyState(cached.data, cached.error);
			return;
		}

		try {
			const data = await fetchUsageData();
			errorCount = 0;
			const entry: CacheEntry = { data, error: null, fetchedAt: Date.now() };
			await context.globalState.update(CACHE_KEY, entry);
			applyState(data, null);
		} catch (err) {
			errorCount++;
			const error = err instanceof Error ? err.message : String(err);
			const entry: CacheEntry = { data: null, error, fetchedAt: Date.now() };
			await context.globalState.update(CACHE_KEY, entry);
			applyState(null, error);
			console.error('[Claude Usage Monitor]', error);
		}
	}

	// On startup: show cached data immediately, then fetch if stale
	const cached = reviveCache(context.globalState.get<CacheEntry>(CACHE_KEY));
	if (cached) {
		applyState(cached.data, cached.error);
		const age = Date.now() - cached.fetchedAt;
		if (age < CACHE_TTL_MS) {
			// Cache is fresh — delay first fetch to fill remaining TTL
			timer = setTimeout(() => {
				refresh().then(() => scheduleNext());
			}, CACHE_TTL_MS - age);
		} else {
			refresh().then(() => scheduleNext());
		}
	} else {
		statusBar.showInitializing();
		refresh().then(() => scheduleNext());
	}

	const onFocus = vscode.window.onDidChangeWindowState((state) => {
		windowFocused = state.focused;
		if (state.focused) {
			// Window came back into focus — cancel any pending timer and refresh immediately
			if (timer) { clearTimeout(timer); timer = null; }
			refresh().then(() => scheduleNext());
		} else {
			// Window lost focus — cancel the pending timer
			if (timer) { clearTimeout(timer); timer = null; }
		}
	});

	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		panel.show(currentData, currentError);
	});

	const refreshCmd = vscode.commands.registerCommand('claude-usage-monitor.refresh', async () => {
		if (timer) { clearTimeout(timer); timer = null; }
		// Force a real fetch by clearing the cache
		await context.globalState.update(CACHE_KEY, undefined);
		await refresh();
		scheduleNext();
	});

	context.subscriptions.push(
		{ dispose: () => { if (timer) { clearTimeout(timer); } } },
		statusBar,
		panel,
		onFocus,
		showPopup,
		refreshCmd,
	);
}

export function deactivate() {}
