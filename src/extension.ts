import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('Claude Usage Monitor is now active!');

	// Create status bar item with Claude icon on the right side
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);

	// Set the custom Claude icon
	statusBarItem.text = '$(claude-icon)';
	statusBarItem.tooltip = 'Claude Usage Monitor';
	statusBarItem.command = 'claude-usage-monitor.showPopup';
	statusBarItem.show();

	// Register command to show popup
	const showPopup = vscode.commands.registerCommand('claude-usage-monitor.showPopup', () => {
		vscode.window.showInformationMessage('Hello World');
	});

	context.subscriptions.push(statusBarItem, showPopup);
}

export function deactivate() {}
