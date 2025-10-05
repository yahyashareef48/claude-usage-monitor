import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { StatusBarManager } from './statusBar';
import { SessionHoverPanel } from './sessionPopover';
import { parseSessionFile } from './sessionParser';
import { calculateSessionMetrics } from './sessionCalculator';
import { SessionMetrics, PlanConfig } from './types';

export function activate(context: vscode.ExtensionContext) {
	console.log('Claude Usage Monitor is now active!');

	// Initialize components
	const statusBar = new StatusBarManager();
	const hoverPanel = new SessionHoverPanel(context.extensionUri);

	// Configuration - Load from workspace state or default to 'pro'
	const savedPlan = context.workspaceState.get<'pro' | 'max5' | 'max20' | 'custom'>('claudeMonitor.plan', 'pro');
	const savedLimit = context.workspaceState.get<number>('claudeMonitor.tokenLimit', 44000);

	const planConfig: PlanConfig = {
		plan: savedPlan,
		tokenLimit: savedLimit
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
	 * Collect all messages from all session files across ALL projects
	 */
	async function updateMetrics() {
		try {
			console.log('🔄 Updating metrics...');

			let allMessages: Array<{message: any; filePath: string}> = [];

			// Step 1: Collect ALL messages from ALL files across ALL projects
			for (const basePath of claudeDataPaths) {
				const projectDirs = fs.readdirSync(basePath);

				for (const projectDir of projectDirs) {
					const projectPath = path.join(basePath, projectDir);

					if (!fs.statSync(projectPath).isDirectory()) {
						continue;
					}

					const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

					// Read each session file
					for (const file of files) {
						const filePath = path.join(projectPath, file);

						try {
							const messages = await parseSessionFile(filePath);

							// Add all messages with their source file
							for (const message of messages) {
								allMessages.push({ message, filePath });
							}
						} catch (err) {
							// Skip files that can't be parsed
							console.warn(`Skipping ${filePath}:`, err);
						}
					}
				}
			}

			console.log(`📊 Collected ${allMessages.length} total messages`);

			if (allMessages.length === 0) {
				console.log('   └─ ⚠️ No messages found');
				currentSession = null;
				statusBar.update(null, planConfig);
				return;
			}

			// Step 2: Extract just the messages and calculate metrics
			const justMessages = allMessages.map(m => m.message);
			const metrics = calculateSessionMetrics(justMessages, 'combined');

			if (metrics && metrics.isActive) {
				console.log(`✅ Active session found`);
				console.log(`   └─ Started: ${metrics.startTime.toLocaleString()}`);
				console.log(`   └─ Last activity: ${metrics.lastMessageTime.toLocaleString()}`);
				console.log(`   └─ Tokens: ${metrics.totalTokens}`);

				currentSession = metrics;
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

	// Helper function to update plan
	async function updatePlan(plan: 'pro' | 'max5' | 'max20' | 'custom', tokenLimit: number) {
		planConfig.plan = plan;
		planConfig.tokenLimit = tokenLimit;

		// Save to workspace state
		await context.workspaceState.update('claudeMonitor.plan', plan);
		await context.workspaceState.update('claudeMonitor.tokenLimit', tokenLimit);

		// Update UI
		statusBar.update(currentSession, planConfig);

		// Show confirmation
		vscode.window.showInformationMessage(
			`Claude plan set to ${plan.toUpperCase()} (${tokenLimit.toLocaleString()} tokens)`
		);
	}

	// Register command to show popover
	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		hoverPanel.show(currentSession, planConfig);
	});

	// Register plan selection commands
	const setPlanPro = vscode.commands.registerCommand('claude-usage-monitor.setPlanPro', () => {
		updatePlan('pro', 44000);
	});

	const setPlanMax5 = vscode.commands.registerCommand('claude-usage-monitor.setPlanMax5', () => {
		updatePlan('max5', 88000);
	});

	const setPlanMax20 = vscode.commands.registerCommand('claude-usage-monitor.setPlanMax20', () => {
		updatePlan('max20', 220000);
	});

	const setPlanCustom = vscode.commands.registerCommand('claude-usage-monitor.setPlanCustom', async () => {
		const input = await vscode.window.showInputBox({
			prompt: 'Enter custom token limit',
			placeHolder: '100000',
			validateInput: (value) => {
				const num = parseInt(value);
				if (isNaN(num) || num <= 0) {
					return 'Please enter a valid positive number';
				}
				return null;
			}
		});

		if (input) {
			const tokenLimit = parseInt(input);
			updatePlan('custom', tokenLimit);
		}
	});

	context.subscriptions.push(statusBar, hoverPanel, showPopup, setPlanPro, setPlanMax5, setPlanMax20, setPlanCustom);
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
