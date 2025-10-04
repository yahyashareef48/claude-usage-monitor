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
	 * Find and process the most recent active session across ALL projects
	 */
	async function updateMetrics() {
		try {
			console.log('🔄 Updating metrics...');

			let allActiveSessions: Array<{metrics: SessionMetrics; filePath: string}> = [];

			// Check ALL project directories for active sessions
			for (const basePath of claudeDataPaths) {
				const projectDirs = fs.readdirSync(basePath);

				for (const projectDir of projectDirs) {
					const projectPath = path.join(basePath, projectDir);

					if (!fs.statSync(projectPath).isDirectory()) {
						continue;
					}

					const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

					// Check each session file
					for (const file of files) {
						const filePath = path.join(projectPath, file);

						try {
							const messages = await parseSessionFile(filePath);

							if (messages.length === 0) {
								continue;
							}

							const sessionId = extractSessionId(filePath);
							const metrics = calculateSessionMetrics(messages, sessionId);

							if (metrics && metrics.isActive) {
								allActiveSessions.push({ metrics, filePath });
							}
						} catch (err) {
							// Skip files that can't be parsed
							console.warn(`Skipping ${filePath}:`, err);
						}
					}
				}
			}

			console.log(`📊 Found ${allActiveSessions.length} active session(s)`);

			if (allActiveSessions.length > 0) {
				// Pick the session with the most recent activity
				const mostRecent = allActiveSessions.sort(
					(a, b) => b.metrics.lastMessageTime.getTime() - a.metrics.lastMessageTime.getTime()
				)[0];

				console.log(`✅ Most recent active session: ${mostRecent.filePath}`);
				console.log(`   └─ Last activity: ${mostRecent.metrics.lastMessageTime.toLocaleString()}`);
				console.log(`   └─ Tokens: ${mostRecent.metrics.totalTokens}`);

				currentSession = mostRecent.metrics;
				statusBar.update(currentSession, planConfig);
			} else {
				console.log('   └─ ⚠️ No active sessions');
				currentSession = null;
				statusBar.update(null, planConfig);
			}

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
