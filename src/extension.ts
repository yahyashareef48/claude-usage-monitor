import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
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

	// Do initial scan of existing files
	scanExistingFiles();

	// Register command to show popover
	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		hoverPanel.show(currentSession, planConfig);
	});

	context.subscriptions.push(statusBar, hoverPanel, showPopup);

	/**
	 * Scan existing files immediately on startup
	 */
	async function scanExistingFiles() {
		console.log('🔍 Starting initial scan...');

		for (const basePath of claudeDataPaths) {
			try {
				const projectDirs = fs.readdirSync(basePath);
				console.log(`📂 Found ${projectDirs.length} project directories in ${basePath}`);

				for (const projectDir of projectDirs) {
					const projectPath = path.join(basePath, projectDir);
					const stat = fs.statSync(projectPath);

					if (!stat.isDirectory()) {
						continue;
					}

					const files = fs.readdirSync(projectPath);
					const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
					console.log(`📄 Found ${jsonlFiles.length} JSONL files in ${projectDir}`);

					// Process the most recent file (likely the active session)
					if (jsonlFiles.length > 0) {
						const sortedFiles = jsonlFiles
							.map(f => ({
								name: f,
								path: path.join(projectPath, f),
								mtime: fs.statSync(path.join(projectPath, f)).mtime
							}))
							.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

						const mostRecent = sortedFiles[0];
						console.log(`⏰ Most recent file: ${mostRecent.name} (${mostRecent.mtime})`);

						await handleFileChange(mostRecent.path);
					}
				}
			} catch (error) {
				console.error(`Error scanning ${basePath}:`, error);
			}
		}

		console.log('✅ Initial scan complete');
	}

	/**
	 * Start monitoring Claude session files
	 */
	function startMonitoring() {
		// Claude files are named with UUIDs: {uuid}.jsonl
		const patterns = claudeDataPaths.map(p => path.join(p, '**', '*.jsonl'));

		console.log('👀 Watching patterns:', patterns);

		fileWatcher = chokidar.watch(patterns, {
			persistent: true,
			ignoreInitial: true, // We handle initial scan manually
			awaitWriteFinish: {
				stabilityThreshold: 500,
				pollInterval: 100
			}
		});

		fileWatcher.on('add', (filePath) => {
			console.log('➕ File added:', filePath);
			handleFileChange(filePath);
		});

		fileWatcher.on('change', (filePath) => {
			console.log('✏️ File changed:', filePath);
			handleFileChange(filePath);
		});

		fileWatcher.on('error', error => {
			console.error('❌ File watcher error:', error);
			statusBar.showError('File watcher error');
		});

		console.log('✅ File watcher started');
	}

	/**
	 * Handle file changes
	 */
	async function handleFileChange(filePath: string) {
		try {
			console.log('📁 Processing:', filePath);

			const messages = await parseSessionFile(filePath);
			console.log(`   └─ ${messages.length} messages parsed`);

			if (messages.length === 0) {
				console.log('   └─ ⚠️ No messages found, skipping');
				return;
			}

			const sessionId = extractSessionId(filePath);
			const metrics = calculateSessionMetrics(messages, sessionId);

			if (metrics) {
				console.log(`   └─ Tokens: ${metrics.totalTokens}, Active: ${metrics.isActive}`);

				if (metrics.isActive) {
					currentSession = metrics;
					statusBar.update(currentSession, planConfig);
					console.log('   └─ ✅ Status bar updated!');
				} else {
					console.log('   └─ ⏰ Session expired');
				}
			} else {
				console.log('   └─ ❌ No metrics calculated');
			}
		} catch (error) {
			console.error('❌ Error processing file:', error);
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
