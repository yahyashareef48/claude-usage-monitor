import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { StatusBarManager } from './statusBar';
import { showSessionPopover } from './sessionPopover';
import { parseSessionFile, extractSessionId } from './sessionParser';
import { calculateSessionMetrics } from './sessionCalculator';
import { SessionMetrics, PlanConfig } from './types';

export function activate(context: vscode.ExtensionContext) {
	console.log('Claude Usage Monitor is now active!');

	// Initialize components
	const statusBar = new StatusBarManager();

	// Configuration
	const planConfig: PlanConfig = {
		plan: 'pro',
		tokenLimit: 44000
	};

	// State
	let currentSession: SessionMetrics | null = null;
	let fileWatcher: chokidar.FSWatcher | null = null;

	statusBar.showInitializing();

	// Find Claude data directories
	const claudeDataPaths = getClaudeDataPaths();

	if (claudeDataPaths.length === 0) {
		statusBar.showError('Claude data directory not found');
		vscode.window.showWarningMessage(
			'Claude data directory not found. Make sure Claude Code is installed and has been used at least once.'
		);
		return;
	}

	// Start monitoring
	startMonitoring();

	// Register command to show popover
	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		showSessionPopover(currentSession, planConfig);
	});

	context.subscriptions.push(statusBar, showPopup);

	/**
	 * Start monitoring Claude session files
	 */
	function startMonitoring() {
		// Claude files are named with UUIDs: {uuid}.jsonl
		const patterns = claudeDataPaths.map(p => path.join(p, '**', '*.jsonl'));

		fileWatcher = chokidar.watch(patterns, {
			persistent: true,
			ignoreInitial: false,
			awaitWriteFinish: {
				stabilityThreshold: 500,
				pollInterval: 100
			}
		});

		fileWatcher.on('add', handleFileChange);
		fileWatcher.on('change', handleFileChange);

		fileWatcher.on('error', error => {
			console.error('File watcher error:', error);
			statusBar.showError('File watcher error');
		});

		console.log('Monitoring Claude data paths:', claudeDataPaths);
	}

	/**
	 * Handle file changes
	 */
	async function handleFileChange(filePath: string) {
		try {
			console.log('Processing file:', filePath);

			const messages = await parseSessionFile(filePath);
			const sessionId = extractSessionId(filePath);

			const metrics = calculateSessionMetrics(messages, sessionId);

			if (metrics && metrics.isActive) {
				currentSession = metrics;
				statusBar.update(currentSession, planConfig);
			}
		} catch (error) {
			console.error('Error processing file:', error);
		}
	}

	/**
	 * Clean up on deactivation
	 */
	context.subscriptions.push({
		dispose: () => {
			fileWatcher?.close();
		}
	});
}

/**
 * Get Claude data directory paths
 */
function getClaudeDataPaths(): string[] {
	const paths: string[] = [];

	// Check environment variable first
	const envPath = process.env.CLAUDE_CONFIG_DIR;
	if (envPath) {
		const projectsPath = path.join(envPath, 'projects');
		if (fs.existsSync(projectsPath)) {
			paths.push(projectsPath);
		}
	}

	// Standard paths
	const homeDir = os.homedir();
	const standardPaths = [
		path.join(homeDir, '.config', 'claude', 'projects'),
		path.join(homeDir, '.claude', 'projects')
	];

	for (const p of standardPaths) {
		if (fs.existsSync(p) && !paths.includes(p)) {
			paths.push(p);
		}
	}

	return paths;
}

export function deactivate() {}
