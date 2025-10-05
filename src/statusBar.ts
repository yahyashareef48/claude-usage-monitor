import * as vscode from "vscode";
import { SessionMetrics, PlanConfig } from "./types";
import { formatTimeRemaining } from "./sessionCalculator";

/**
 * Manages the status bar item showing session information
 */
export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = "claude-usage-monitor.showPopup";
    this.statusBarItem.show();
  }

  /**
   * Update status bar with session metrics
   */
  public update(session: SessionMetrics | null, planConfig: PlanConfig) {
    if (!session) {
      this.statusBarItem.text = "$(claude-icon) No Session";
      this.statusBarItem.tooltip = "No active Claude session";
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const usagePercent = (session.totalTokens / planConfig.tokenLimit) * 100;
    const timeRemaining = session.isActive ? formatTimeRemaining(session.timeRemaining) : "Expired";
    const burnRate = Math.round(session.burnRate);

    // Build status text with time remaining and percentage
    this.statusBarItem.text = ` $(claude-icon) ${timeRemaining} - ${usagePercent.toFixed(1)}%`;

    // Build tooltip with detailed info
    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `**Claude Session Timer**\n\n` +
        `**Tokens:** ${session.totalTokens.toLocaleString()} / ${planConfig.tokenLimit.toLocaleString()} (${usagePercent.toFixed(1)}%)\n\n` +
        `**Time Remaining:** ${timeRemaining}\n\n` +
        `**Burn Rate:** ${burnRate} tokens/min\n\n` +
        `**Started:** ${session.startTime.toLocaleTimeString()}\n\n` +
        `**Ends:** ${session.sessionEndTime.toLocaleTimeString()}\n\n` +
        `_Click to view details_`
    );

    // Set color based on usage
    if (usagePercent >= 80) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        usagePercent >= 100 ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground"
      );
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  /**
   * Show a simple icon when starting up
   */
  public showInitializing() {
    this.statusBarItem.text = "$(claude-icon) Initializing...";
    this.statusBarItem.tooltip = "Claude Usage Monitor starting up...";
    this.statusBarItem.backgroundColor = undefined;
  }

  /**
   * Show error state
   */
  public showError(message: string) {
    this.statusBarItem.text = "$(claude-icon) Error";
    this.statusBarItem.tooltip = message;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  }

  /**
   * Dispose of the status bar item
   */
  public dispose() {
    this.statusBarItem.dispose();
  }
}
