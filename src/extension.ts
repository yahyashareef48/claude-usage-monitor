import * as vscode from 'vscode';
import { fetchUsageData } from './usageClient';
import { StatusBarManager } from './statusBar';
import { UsagePanel } from './sessionPopover';
import { maybeNotify } from './notifications';
import { recordHistory, resetHistoryCache } from './history';
import { accountScopedKey, affectsAccount } from './claudeConfig';
import { UsageData } from './types';

const POLL_INTERVAL_MS = 2  * 60_000; // 2 minutes
const CACHE_TTL_MS     = 115_000;     // treat cache as fresh if < ~2min old
const BACKOFF_STEPS_MS = [
	4  * 60_000,  // 1st error → wait 4 min
	8  * 60_000,  // 2nd error → wait 8 min
	16 * 60_000,  // 3rd+ error → wait 16 min
];

// Versioned key: pre-1.3.0 builds wrote a UsageData without `limits` to the
// unversioned key. Sharing a key across versions let an older co-installed
// build feed limits-free data to a newer one, blanking the per-model bars.
//
// Account-scoped, and read through a function rather than a const, because the
// configured account can change while the window is open — see claudeConfig.
const cacheKey = () => accountScopedKey('claudeUsage.cache.v2');

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

/**
 * Keys written by earlier versions. Bumping a key's version orphans the old
 * blob, which would otherwise sit in global storage forever.
 */
const LEGACY_KEYS = [
	'claudeUsage.cache',
	'claudeUsage.history.v1',
	'claudeUsage.history.v2',
	'claudeUsage.notified.v1',
];

function dropLegacyKeys(memento: vscode.Memento) {
	for (const key of LEGACY_KEYS) {
		if (memento.get(key) !== undefined) { void memento.update(key, undefined); }
	}
}

export function activate(context: vscode.ExtensionContext) {
	dropLegacyKeys(context.globalState);

	const statusBar = new StatusBarManager();
	const panel     = new UsagePanel(context.extensionUri, context.globalState);

	let currentData:  UsageData | null = null;
	let currentError: string | null    = null;
	let errorCount    = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let windowFocused = true;

	function applyState(data: UsageData | null, error: string | null) {
		if (data) { currentData = data; } // keep last good data on error
		currentError = error;
		if (currentData) {
			// Record before rendering so the panel sees this poll in its history.
			recordHistory(context.globalState, currentData);
			statusBar.update(currentData, error);
			panel.update(currentData, error);
			void maybeNotify(context.globalState, currentData);
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
		const cached = reviveCache(context.globalState.get<CacheEntry>(cacheKey()));
		if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
			errorCount = cached.error ? errorCount : 0;
			applyState(cached.data, cached.error);
			return;
		}

		try {
			const data = await fetchUsageData();
			errorCount = 0;
			const entry: CacheEntry = { data, error: null, fetchedAt: Date.now() };
			await context.globalState.update(cacheKey(), entry);
			applyState(data, null);
		} catch (err) {
			errorCount++;
			const error = err instanceof Error ? err.message : String(err);
			const entry: CacheEntry = { data: null, error, fetchedAt: Date.now() };
			await context.globalState.update(cacheKey(), entry);
			applyState(null, error);
			console.error('[Claude Usage Monitor]', error);
		}
	}

	// On startup: show cached data immediately, then fetch if stale
	const cached = reviveCache(context.globalState.get<CacheEntry>(cacheKey()));
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

	// Pointing the window at a different account invalidates everything derived
	// from the old one, so drop it and refetch rather than waiting for the poll.
	const onConfig = vscode.workspace.onDidChangeConfiguration((e) => {
		if (!affectsAccount(e)) { return; }
		resetHistoryCache();
		currentData = null;
		if (timer) { clearTimeout(timer); timer = null; }
		statusBar.showInitializing();
		refresh().then(() => scheduleNext());
	});

	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		panel.show(currentData, currentError);
	});

	const refreshCmd = vscode.commands.registerCommand('claude-usage-monitor.refresh', async () => {
		if (timer) { clearTimeout(timer); timer = null; }
		// Force a real fetch by clearing the cache
		await context.globalState.update(cacheKey(), undefined);
		await refresh();
		scheduleNext();
	});

	context.subscriptions.push(
		{ dispose: () => { if (timer) { clearTimeout(timer); } } },
		statusBar,
		panel,
		onFocus,
		onConfig,
		showPopup,
		refreshCmd,
	);
}

export function deactivate() {}
