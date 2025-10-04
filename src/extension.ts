import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { StatusBarManager } from './statusBar';
import { SessionHoverPanel } from './sessionPopover';
import { parseSessionFile, extractSessionId } from './sessionParser';
import { calculateSessionMetrics } from './sessionCalculator';
import { SessionMetrics, PlanConfig } from './types';

export function activate(context: vscode.ExtensionContext) {
	console.log('Claude Usage Monitor is now active!');

	// Initialize components
	const statusBar = new StatusBarManager();
	const hoverPanel = new SessionHoverPanel(context.extensionUri);

	// Configuration
	const planConfig: PlanConfig = {
		plan: 'pro',
		tokenLimit: 44000
	};

	// State
	let currentSession: SessionMetrics | null = null;

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

	/**
	 * Find and process the most recent session file
	 */
	async function updateMetrics() {
		try {
			console.log('🔄 Updating metrics...');

			for (const basePath of claudeDataPaths) {
				const projectDirs = fs.readdirSync(basePath);

				for (const projectDir of projectDirs) {
					const projectPath = path.join(basePath, projectDir);

					if (!fs.statSync(projectPath).isDirectory()) {
						continue;
					}

					const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

					if (files.length === 0) {
						continue;
					}

					// Get most recently modified file
					const sortedFiles = files
						.map(f => ({
							path: path.join(projectPath, f),
							mtime: fs.statSync(path.join(projectPath, f)).mtime
						}))
						.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

					const mostRecent = sortedFiles[0].path;
					console.log('📄 Processing:', mostRecent);

					const messages = await parseSessionFile(mostRecent);
					console.log(`   └─ ${messages.length} messages`);

					if (messages.length === 0) {
						continue;
					}

					const sessionId = extractSessionId(mostRecent);
					const metrics = calculateSessionMetrics(messages, sessionId);

					if (metrics && metrics.isActive) {
						console.log(`   └─ ✅ Active session: ${metrics.totalTokens} tokens`);
						currentSession = metrics;
						statusBar.update(currentSession, planConfig);
						return; // Found active session
					}
				}
			}

			// No active session found
			console.log('   └─ ⚠️ No active session');
			currentSession = null;
			statusBar.update(null, planConfig);

		} catch (error) {
			console.error('❌ Error updating metrics:', error);
		}
	}

	// Update immediately
	updateMetrics();

	// Update every 5 seconds
	const interval = setInterval(updateMetrics, 5000);

	context.subscriptions.push({
		dispose: () => clearInterval(interval)
	});

	// Register command to show popover
	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		hoverPanel.show(currentSession, planConfig);
	});

	context.subscriptions.push(statusBar, hoverPanel, showPopup);
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
