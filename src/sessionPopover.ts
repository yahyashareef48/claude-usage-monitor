import * as vscode from "vscode";
import { UsageData, QuotaBucket, UsageLimit } from "./types";
import {
  Burn,
  Store as HistoryStore,
  bindingWindow,
  burnFor,
  getStore,
  historyEnabled,
  sampleCount,
  seriesFor,
} from "./history";
import {
  allWindows,
  colorPct,
  Level,
  levelOf,
  limitLabel,
  presets,
  readColorSources,
  readIndicatorConfig,
  readStatusBarFormat,
  renderTemplate,
  sortLimits,
  templateWithDot,
  tokenValues,
} from "./windows";

function timeAgo(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) { return "just now"; }
  if (sec < 3600) { const m = Math.floor(sec / 60); return `${m} minute${m === 1 ? "" : "s"} ago`; }
  const h = Math.floor(sec / 3600);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

function formatTimeRemaining(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) { return "resetting now"; }
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    return new Date(resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatError(raw: string): { message: string; hint: string | null } {
  if (raw.includes('401')) {
    return {
      message: 'HTTP 401 — Unauthorized: session token expired or invalid.',
      hint: 'Fix: start a new Claude Code session in your terminal (<code>claude</code>), then refresh via <strong>Ctrl+Shift+P</strong> → <em>Claude: Refresh Usage</em>. If it still fails, log out (<code>claude logout</code>) and log back in.',
    };
  }
  if (raw.includes('403')) {
    return {
      message: 'HTTP 403 — Forbidden: account may lack API access.',
      hint: 'Fix: ensure you are logged in to Claude Code with a valid Pro or Max subscription. You can log in by running <code>claude</code> in your terminal.',
    };
  }
  if (raw.includes('429')) {
    return {
      message: 'HTTP 429 — Rate limited by Anthropic API.',
      hint: 'The extension will retry automatically with backoff. No action needed.',
    };
  }
  if (raw.includes('timed out') || raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND')) {
    return {
      message: `Network error — could not reach api.anthropic.com.`,
      hint: 'Fix: check your internet connection, then refresh via <strong>Ctrl+Shift+P</strong> → <em>Claude: Refresh Usage</em>.',
    };
  }
  if (raw.includes('No OAuth token')) {
    return {
      message: 'No OAuth token found — not logged in to Claude Code.',
      hint: 'Fix: open a terminal and run <code>claude</code> to start a session. Once logged in, refresh via <strong>Ctrl+Shift+P</strong> → <em>Claude: Refresh Usage</em>.',
    };
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const inner = parsed?.error;
      if (inner?.message) {
        const prefix = raw.match(/^HTTP \d+/)?.[0];
        return { message: prefix ? `${prefix} — ${inner.message}` : inner.message, hint: null };
      }
    } catch { /* fall through */ }
  }
  return { message: raw, hint: null };
}

function barColor(pct: number, warnT: number, errT: number): string {
  if (pct >= errT)  { return "#ff6b6b"; }
  if (pct >= warnT) { return "#ffd93d"; }
  return "#51cf66";
}

function formatResetDate(iso: string): string {
  const d = new Date(iso);
  const fmt = vscode.workspace.getConfiguration('claude-usage-monitor').get<string>('clockFormat', 'auto');
  if (fmt === '24h') { return d.toLocaleString(undefined, { hour12: false }); }
  if (fmt === '12h') { return d.toLocaleString(undefined, { hour12: true }); }
  return d.toLocaleString();
}

/**
 * Emits the timestamp for the webview to format, rather than formatting here.
 * Under Remote SSH / WSL / devcontainers the extension host is the *remote*
 * machine, so formatting server-side would print the server's clock — three
 * hours wrong is worse than useless for a "you run out at" time.
 */
function etaSpan(ms: number): string {
  return `<span class="eta" data-eta="${ms}"></span>`;
}

/**
 * Sparkline plus rate for one bar. Renders nothing until there is enough
 * history to say something true — a wrong ETA is worse than no ETA.
 */
const SPARK_W = 118;
const SPARK_H = 26;

/**
 * A small line chart of the window's history. Scaled to the series' own range
 * rather than to 100, so a session between 2% and 23% still shows its shape;
 * a genuinely flat series draws a flat line near the baseline.
 */
function sparkSvg(points: number[], color: string): string {
  if (points.length < 2) {
    return `<svg class="spark" width="${SPARK_W}" height="${SPARK_H}" aria-hidden="true"></svg>`;
  }

  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const flat = hi - lo < 1;
  const top = 3;
  const bottom = SPARK_H - 4;
  const yOf = (v: number) => (flat ? bottom : bottom - ((v - lo) / (hi - lo)) * (bottom - top));
  const xOf = (i: number) => 1 + (i / (points.length - 1)) * (SPARK_W - 2);

  const line = points.map((v, i) => `${i ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  const area = `${line} L${(SPARK_W - 1).toFixed(1)},${SPARK_H} L1,${SPARK_H} Z`;
  const lastX = xOf(points.length - 1).toFixed(1);
  const lastY = yOf(points[points.length - 1]).toFixed(1);

  return `<svg class="spark" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" aria-hidden="true">
					<path d="${area}" fill="${color}" opacity="0.13"/>
					<path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
					<circle cx="${lastX}" cy="${lastY}" r="2" fill="${color}"/>
				</svg>`;
}

function burnRow(spark: string, burn: Burn | null, resetsAt: string | null, samples: number): string {
  // Nothing recorded yet for this window — say nothing rather than show an
  // empty chart. Once there is any history, always show the row so the feature
  // is visibly working while it gathers enough data to project.
  if (samples === 0) { return ""; }

  let note: string;
  if (burn && burn.ratePerHour === 0) {
    note = "idle";
  } else if (burn && burn.etaAt !== null) {
    const rate = `${burn.ratePerHour.toFixed(burn.ratePerHour < 10 ? 1 : 0)} %/hr`;
    const beatsReset = resetsAt !== null && burn.etaAt >= new Date(resetsAt).getTime();
    note = beatsReset ? `${rate} · resets first` : `${rate} · out ~${etaSpan(burn.etaAt)}`;
  } else {
    note = "measuring…";
  }
  return `<div class="burn">${spark}<span>${note}</span></div>`;
}

/** Left-hand meta line: exhausted windows say so instead of counting down. */
function resetMeta(resetsAt: string | null, pct: number): string {
  const exhausted = pct >= 100;
  if (!resetsAt) { return exhausted ? `<span class="exhausted">Exhausted</span>` : `<span></span>`; }
  const left = formatTimeRemaining(resetsAt);
  return exhausted
    ? `<span class="exhausted">Exhausted — resets in ${left}</span>`
    : `<span>Resets in ${left}</span>`;
}

function bucketRow(label: string, bucket: QuotaBucket, warnT: number, errT: number, burn = ""): string {
  const pct = bucket.utilization;
  const color = barColor(pct, warnT, errT);
  const resetsDate = formatResetDate(bucket.resetsAt);
  return `
			<div class="bucket">
				<div class="bucket-header">
					<span class="bucket-label">${label}</span>
					<span class="bucket-pct" style="color:${color}">${pct.toFixed(1)}%</span>
				</div>
				<div class="progress"><div class="fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>
				<div class="bucket-meta">
					${resetMeta(bucket.resetsAt, pct)}
					<span>${resetsDate}</span>
				</div>${burn}
			</div>`;
}

/** Severity can force a higher alert color than the numeric thresholds. */
function severityColor(severity: string | null): string | null {
  if (severity === "warning") { return "#ffd93d"; }
  if (severity === "error" || severity === "critical" || severity === "exceeded" || severity === "over_limit") { return "#ff6b6b"; }
  return null; // "normal", null, or unknown → use thresholds
}

function limitRow(l: UsageLimit, warnT: number, errT: number, burn = ""): string {
  const pct = l.percent;
  // Severity can only escalate past the thresholds, never downgrade them
  const rank = (c: string) => c === "#ff6b6b" ? 2 : c === "#ffd93d" ? 1 : 0;
  const tColor = barColor(pct, warnT, errT);
  const sColor = severityColor(l.severity);
  const color = sColor && rank(sColor) > rank(tColor) ? sColor : tColor;
  const meta = `${resetMeta(l.resetsAt, pct)}<span>${l.resetsAt ? formatResetDate(l.resetsAt) : ""}</span>`;
  return `
			<div class="bucket">
				<div class="bucket-header">
					<span class="bucket-label">${escapeHtml(limitLabel(l))}</span>
					<span class="bucket-pct" style="color:${color}">${pct.toFixed(0)}%</span>
				</div>
				<div class="progress"><div class="fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>
				<div class="bucket-meta">${meta}</div>${burn}
			</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The CC mark, sized for inline use in the status bar preview. */
const ICON_SVG = `<svg class="sb-icon" viewBox="50 140 420 290" width="17" height="12" aria-hidden="true"><path d="M 250 200 A 100 100 0 1 0 250 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/><path d="M 402 200 A 100 100 0 1 0 402 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/></svg>`;

/** Render status bar text (which carries $(codicon) refs) as preview HTML. */
function statusTextToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\$\(claude-icon\)/g, ICON_SVG)
    .replace(/\$\(warning\)/g, "⚠");
}

/**
 * `background` mode paints with VS Code's own status bar tokens, and an
 * extension cannot override them for its item alone — the editor resolves them
 * from the theme. Editing them means editing `workbench.colorCustomizations`,
 * which is global: every extension's status bar item follows.
 */
export const THEME_COLOR_KEYS = [
  { id: "statusBarItem.warningBackground", label: "Warning background", eg: "#7A6400" },
  { id: "statusBarItem.warningForeground", label: "Warning text",       eg: "#FFFFFF" },
  { id: "statusBarItem.errorBackground",   label: "Error background",   eg: "#5A1D1D" },
  { id: "statusBarItem.errorForeground",   label: "Error text",         eg: "#FFFFFF" },
] as const;

function readThemeColors(): Record<string, string> {
  const custom = vscode.workspace
    .getConfiguration()
    .get<Record<string, unknown>>("workbench.colorCustomizations") ?? {};
  const out: Record<string, string> = {};
  for (const k of THEME_COLOR_KEYS) {
    out[k.id] = typeof custom[k.id] === "string" ? (custom[k.id] as string) : "";
  }
  return out;
}

/** Swatches for the settings rows — the panel's own legend, not the user's glyphs. */
const LEVEL_DOT: Record<Level, string> = {
  normal:  "#4ec9b0",
  warning: "#ffd93d",
  error:   "#ff6b6b",
};

function readPanelConfig() {
  const cfg = vscode.workspace.getConfiguration('claude-usage-monitor');
  return {
    warnT:    cfg.get<number>('warningThreshold', 60),
    errT:     cfg.get<number>('errorThreshold', 80),
    clockFmt: cfg.get<string>('clockFormat', 'auto'),
    resetDisp: cfg.get<string>('resetDisplay', 'countdown'),
  };
}

interface PanelState {
  type: "state";
  subtitle: string;
  errorHtml: string;
  bucketsHtml: string;
  extraHtml: string;
  settingsHtml: string;
  /** Current value of every {window.field} token, for the live format preview. */
  tokens: Record<string, string>;
}

/**
 * The data-dependent fragments of the panel. These are pushed to the webview
 * over postMessage and patched into their containers, so the document itself
 * is never replaced — the active tab, the scroll position, and any control the
 * user is mid-edit all survive a poll.
 */
function buildFragments(data: UsageData | null, error: string | null, store: HistoryStore): PanelState {
  const { warnT, errT, clockFmt, resetDisp } = readPanelConfig();

  // Burn rate per window, addressed by the same keys allWindows() uses.
  const burnByKey = new Map<string, string>();
  if (data && historyEnabled()) {
    for (const w of allWindows(data)) {
      const pct = w.pct;
      burnByKey.set(
        w.key,
        burnRow(
          sparkSvg(seriesFor(store, w), barColor(pct, warnT, errT)),
          burnFor(store, w),
          w.resetsAt,
          sampleCount(store, w),
        ),
      );
    }
  }
  const burnOf = (key: string) => burnByKey.get(key) ?? "";
  const keyOfLimit = (l: UsageLimit) =>
    l.modelName ? `model:${l.modelName}` : l.kind === "session" ? "5h" : l.kind === "weekly_all" ? "7d" : l.kind;

  const binding = data && historyEnabled() ? bindingWindow(store, data) : null;
  const headline = binding
    ? `<div class="burn-headline">⚠ ${escapeHtml(binding.window.label)} projected to run out ~${etaSpan(binding.burn.etaAt!)}, before it resets</div>`
    : "";
  // Trend lines and projections are new; say so where they are actually shown.
  const betaNote = burnByKey.size > 0
    ? `<div class="burn-beta"><span class="badge">Beta</span> Trend lines and run-out estimates are new — treat the projections as a rough guide.</div>`
    : "";

  let errorHtml = "";
  if (error) {
    const { message, hint } = formatError(error);
    const lead = data
      ? "<strong>⚠️ Last poll failed</strong> — showing cached data"
      : "<strong>⚠️ Could not fetch usage</strong>";
    errorHtml = `<div class="banner">${lead}<br><span style="opacity:0.85">${message}</span>${hint ? `<br><span class="banner-hint">${hint}</span>` : ""}</div>`;
  }

  const source = `<span style="opacity:0.6">api.anthropic.com/api/oauth/usage</span>`;
  const subtitle = data ? `Updated ${timeAgo(data.fetchedAt)} · ${source}` : source;

  const eu = data?.extraUsage ?? null;
  const extraSection = eu?.isEnabled
    ? `
		<div class="section">
			<div class="section-title">Extra Usage (Pay-as-you-go)</div>
			${eu.usedCredits !== null
        ? `<div class="row"><span class="label">Spent this month</span><span class="value">$${(eu.usedCredits / 100).toFixed(2)} ${eu.currency ?? ""}</span></div>`
        : ""}
			${eu.monthlyLimit !== null
        ? `<div class="row"><span class="label">Monthly limit</span><span class="value">$${(eu.monthlyLimit! / 100).toFixed(2)}</span></div>`
        : '<div class="row"><span class="label">Monthly limit</span><span class="value">No cap set</span></div>'}
			${eu.utilization !== null
        ? `<div class="row"><span class="label">Extra utilization</span><span class="value">${eu.utilization!.toFixed(1)}%</span></div>`
        : ""}
		</div>`
    : "";

  // Prefer the newer `limits` array (covers session, weekly, and any scoped
  // per-model windows like Fable). Fall back to the legacy fields for accounts
  // that don't return `limits` — and for data revived from a pre-1.3.0 cache,
  // where `limits` is undefined.
  const limits = data ? sortLimits(data.limits ?? []) : [];
  const buckets: string[] = [];
  if (data && limits.length > 0) {
    for (const l of limits) { buckets.push(limitRow(l, warnT, errT, burnOf(keyOfLimit(l)))); }
    // Legacy windows with no equivalent limits entry (e.g. OAuth apps)
    if (data.sevenDayOauthApps) { buckets.push(bucketRow("7-Day OAuth Apps", data.sevenDayOauthApps, warnT, errT, burnOf("oauth_apps"))); }
  } else if (data) {
    if (data.fiveHour)          { buckets.push(bucketRow("5-Hour Window",    data.fiveHour,          warnT, errT, burnOf("5h"))); }
    if (data.sevenDay)          { buckets.push(bucketRow("7-Day Window",     data.sevenDay,          warnT, errT, burnOf("7d"))); }
    if (data.sevenDaySonnet)    { buckets.push(bucketRow("7-Day Sonnet",     data.sevenDaySonnet,    warnT, errT, burnOf("model:Sonnet"))); }
    if (data.sevenDayOpus)      { buckets.push(bucketRow("7-Day Opus",       data.sevenDayOpus,      warnT, errT, burnOf("model:Opus"))); }
    if (data.sevenDayOauthApps) { buckets.push(bucketRow("7-Day OAuth Apps", data.sevenDayOauthApps, warnT, errT, burnOf("oauth_apps"))); }
  }

  const bucketsHtml = betaNote + headline + (buckets.length > 0
    ? buckets.join("")
    : `<div class="no-quota">${data ? "No active quota windows returned." : "Fetching usage from the Anthropic API…"}</div>`);

  const sel = (val: string, opt: string) => val === opt ? ' selected' : '';

  /**
   * The four VS Code tokens behind `background` mode. A hex swatch and a text
   * field edit the same value; the field also takes an empty string, which is
   * the only way to hand the colour back to the theme.
   */
  const themeColorFields = () => THEME_COLOR_KEYS.map((k) => `
		<div class="setting-row">
			<span class="setting-label">${k.label}</span>
			<div class="color-pair">
				<input type="color" class="swatch" aria-label="${k.label} picker"
					value="${/^#[0-9a-fA-F]{6}$/.test(themeColors[k.id]) ? themeColors[k.id] : k.eg}"
					oninput="mirrorSwatch(this, 'tc-${k.id}')" onchange="syncSwatch(this, 'tc-${k.id}')">
				<input type="text" class="setting-input wide" spellcheck="false"
					id="tc-${k.id}" value="${escapeHtml(themeColors[k.id])}" placeholder="${k.eg} (theme default)"
					onchange="updateThemeColor('${k.id}', this.value)">
			</div>
		</div>`).join("");

  /**
   * The normal/warning/error trio, shared by the colour and emoji editors. The
   * colour rows get a picker too, but the text field stays the source of truth:
   * a picker can only say hex, and these fields also take theme colour ids and
   * the empty string.
   */
  const levelFields = (kind: 'color' | 'emoji', values: Record<Level, string>, placeholder: string) =>
    (['normal', 'warning', 'error'] as Level[]).map((l) => `
		<div class="setting-row">
			<span class="setting-label"><span class="color-dot" style="background:${LEVEL_DOT[l]}"></span>${l[0].toUpperCase()}${l.slice(1)}</span>
			<div class="color-pair">
				${kind === 'color' ? `<input type="color" class="swatch" aria-label="${l} colour picker"
					value="${/^#[0-9a-fA-F]{6}$/.test(values[l]) ? values[l] : LEVEL_DOT[l]}"
					oninput="mirrorSwatch(this, 'ind-color-${l}')" onchange="syncLevelSwatch(this, 'ind-color-${l}')">` : ''}
				<input type="text" class="setting-input wide" spellcheck="false"
					id="ind-${kind}-${l}" value="${escapeHtml(values[l])}" placeholder="${escapeHtml(placeholder)}"
					${kind === 'emoji' ? 'oninput="previewDot(this)" ' : ''}onchange="updateLevelMap('${kind}')">
			</div>
		</div>`).join("");

  const format       = readStatusBarFormat();
  const ind          = readIndicatorConfig();
  const themeColors  = readThemeColors();
  const colorSources = readColorSources().map((s) => s.toLowerCase());
  // The preview shows the glyph for the level the account is actually at, so
  // switching to emoji mode shows what the bar will really look like.
  const level: Level = data ? levelOf(colorPct(data, colorSources), ind.warnT, ind.errT) : "normal";
  const dot          = ind.emoji[level] ?? "";
  const windows      = data ? allWindows(data) : [];
  const colorAll     = colorSources.some((s) => s === "*" || s === "max-all");

  const chips = presets(data).map((p) => {
    const active = p.template === format ? " active" : "";
    return `<button class="chip${active}" data-tpl="${escapeHtml(p.template)}" onclick="applyPreset(this)">${escapeHtml(p.label)}</button>`;
  }).join("");

  const colorBoxes = windows.map((w) => {
    const checked = colorAll || colorSources.includes(w.key.toLowerCase()) ? " checked" : "";
    return `<label class="check"><input type="checkbox" value="${escapeHtml(w.key)}"${checked} onchange="updateColorSources()"> ${escapeHtml(w.label)}</label>`;
  }).join("");

  const windowKeys = [...windows.map((w) => `{${w.key}}`), "{max}"].join(" ");

  const settingsHtml = `
	<div class="settings-group">
		<div class="settings-group-title">Status Bar</div>
		<div class="setting-row">
			<span class="setting-label">Preview</span>
			<span class="sb-preview" id="sb-preview">${data ? statusTextToHtml(renderTemplate(templateWithDot(format, ind.mode), data, { dot })) : "—"}</span>
		</div>
		<div class="setting-stack">
			<span class="setting-label">Display <span class="info-icon" title="Pick a preset, or edit the format below to build your own.">ⓘ</span></span>
			<div class="chips">${chips}</div>
		</div>
		<div class="setting-stack">
			<span class="setting-label">Format</span>
			<input type="text" class="format-input" id="sb-format" spellcheck="false" value="${escapeHtml(format)}"
				oninput="previewFormat(this.value)"
				onchange="updateSetting('claude-usage-monitor.statusBarFormat', this.value)">
			<div class="hint">Windows ${escapeHtml(windowKeys)} · fields <code>.pct .reset .resetTime .resetAt .name .bar</code> · plus <code>{icon}</code> and <code>{dot}</code></div>
		</div>
	</div>

	<div class="settings-group">
		<div class="settings-group-title">Status Bar Indicator</div>
		<div class="setting-row">
			<span class="setting-label">Style <span class="info-icon" title="How the bar signals a crossed threshold. VS Code allows extensions only two background colors and picks the text color to match them, so on some themes 'Background' is hard to read — 'Text' and 'Emoji' stay legible on every theme.">ⓘ</span></span>
			<select class="setting-control" id="ind-mode" onchange="setIndicatorMode(this.value)">
				<option value="background"${sel(ind.mode, 'background')}>Background color</option>
				<option value="text"${sel(ind.mode, 'text')}>Text color</option>
				<option value="emoji"${sel(ind.mode, 'emoji')}>Emoji</option>
				<option value="none"${sel(ind.mode, 'none')}>None</option>
			</select>
		</div>

		<div class="setting-stack" id="ind-background"${ind.mode === 'background' ? '' : ' hidden'}>
			${themeColorFields()}
			<div class="hint"><strong>These are VS Code's own colors, not this extension's.</strong> They are written to <code>workbench.colorCustomizations</code> and apply to <em>every</em> extension's status bar item — VS Code resolves them itself and gives no way to scope them to one item. Use 6-digit hex; empty restores the theme's own color. Prefer <em>Text color</em> or <em>Emoji</em> above if you only want to change this extension.</div>
		</div>

		<div class="setting-stack" id="ind-colors"${ind.mode === 'text' ? '' : ' hidden'}>
			${levelFields('color', ind.colors, 'e.g. #e5c100')}
			<div class="hint">A theme color id such as <code>editorWarning.foreground</code> or <code>charts.red</code> follows light/dark themes; a literal <code>#e5c100</code> does not. Empty keeps the status bar's own color.</div>
		</div>

		<div class="setting-stack" id="ind-emoji"${ind.mode === 'emoji' ? '' : ' hidden'}>
			${levelFields('emoji', ind.emoji, 'none')}
			<div class="hint">Appended to the bar, or placed yourself with the <code>{dot}</code> token — which works in every style, so you can pair a glyph with a background. Keep the widths equal or the bar shifts as the level changes.</div>
		</div>

		<div class="setting-stack" id="color-sources">
			${colorBoxes || '<div class="hint">No windows reported yet.</div>'}
			<div class="hint">The indicator follows the highest checked window as it crosses the thresholds below.</div>
		</div>
	</div>

	<div class="settings-group">
		<div class="settings-group-title">Thresholds</div>
		<div class="setting-row">
			<span class="setting-label"><span class="color-dot" style="background:#ffd93d"></span>Warning <span class="info-icon" title="When usage reaches this percentage, the status bar shows the warning indicator.">ⓘ</span></span>
			<div class="threshold-wrap">
				<input type="number" class="setting-input" min="1" max="99" value="${warnT}"
					onchange="updateSetting('claude-usage-monitor.warningThreshold', Number(this.value))">
				<span class="threshold-pct">%</span>
			</div>
		</div>
		<div class="setting-row">
			<span class="setting-label"><span class="color-dot" style="background:#ff6b6b"></span>Error <span class="info-icon" title="When usage reaches this percentage, the status bar shows the error indicator.">ⓘ</span></span>
			<div class="threshold-wrap">
				<input type="number" class="setting-input" min="1" max="100" value="${errT}"
					onchange="updateSetting('claude-usage-monitor.errorThreshold', Number(this.value))">
				<span class="threshold-pct">%</span>
			</div>
		</div>
	</div>

	<div class="settings-group last-group">
		<div class="settings-group-title">Panel</div>
		<div class="setting-row">
			<span class="setting-label">Burn rate <span class="beta-tag">(Beta)</span> <span class="info-icon" title="Beta. Keeps a short local history of your usage to draw a trend line, estimate how fast each window is being consumed, and project when it will run out. Stored only on this machine, capped at 64 KB, and deleted when switched off.">ⓘ</span></span>
			<label class="check"><input type="checkbox"${historyEnabled() ? " checked" : ""} onchange="updateSetting('claude-usage-monitor.burnRate', this.checked)"> Track usage history</label>
		</div>
		<div class="setting-row">
			<span class="setting-label">Clock format <span class="info-icon" title="How reset times are displayed in this panel. 'Auto' follows your system locale.">ⓘ</span></span>
			<select class="setting-control" onchange="updateSetting('claude-usage-monitor.clockFormat', this.value)">
				<option value="auto"${sel(clockFmt, 'auto')}>Auto (system default)</option>
				<option value="12h"${sel(clockFmt, '12h')}>12-hour (7:44 PM)</option>
				<option value="24h"${sel(clockFmt, '24h')}>24-hour (19:44)</option>
			</select>
		</div>
		<div class="setting-row">
			<span class="setting-label">Show reset as <span class="info-icon" title="How {…reset} tokens and the status bar show when a window resets.">ⓘ</span></span>
			<select class="setting-control" onchange="updateSetting('claude-usage-monitor.resetDisplay', this.value)">
				<option value="countdown"${sel(resetDisp, 'countdown')}>Countdown (3h 37m)</option>
				<option value="clock"${sel(resetDisp, 'clock')}>Clock time (13:27)</option>
				<option value="both"${sel(resetDisp, 'both')}>Both (3h 37m (13:27))</option>
			</select>
		</div>
	</div>`;

  return {
    type: "state",
    subtitle,
    errorHtml,
    bucketsHtml,
    extraHtml: extraSection,
    settingsHtml,
    tokens: { ...tokenValues(data), dot },
  };
}

/** The panel's static shell — written to the webview exactly once, then patched. */
function buildShell(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
	font-family: var(--vscode-font-family);
	font-size: 13px;
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
	padding: 24px;
	max-width: 960px;
	margin: 0 auto;
}
/* Wide panels get multiple columns of bars instead of one tall stack. */
#quota-windows {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
	column-gap: 28px;
}
/* Extra Usage tracks the same columns, so it lines up under the bars instead
   of stretching its label and value to opposite edges of the panel. */
#extra-usage {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
	column-gap: 28px;
}
/* Settings groups flow into columns so the tab fills the panel, while each
   group keeps a form-width row instead of stretching label away from control. */
#settings-content {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
	column-gap: 32px;
	align-items: start;
}
#settings-content .settings-group { min-width: 0; }
h1 { font-size: 18px; }
h2 { font-size: 16px; font-weight: 600; margin-bottom: 14px; }
.page-header { margin-bottom: 12px; }
.title-row { display: flex; align-items: center; gap: 8px; }
.title-row .refresh-btn { margin-left: auto; }
.logo { flex-shrink: 0; }
.subtitle { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; }
.tabs {
	display: flex;
	gap: 2px;
	border-bottom: 1px solid var(--vscode-panel-border);
	margin-bottom: 18px;
}
.tab {
	background: none;
	border: none;
	border-bottom: 2px solid transparent;
	color: var(--vscode-descriptionForeground);
	font-family: inherit;
	font-size: 12px;
	padding: 6px 12px;
	margin-bottom: -1px;
	cursor: pointer;
}
.tab:hover { color: var(--vscode-foreground); }
.tab.active {
	color: var(--vscode-foreground);
	font-weight: 600;
	border-bottom-color: #C15F3C;
}
.tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -2px; }
.tab-panel[hidden] { display: none; }
.banner {
	margin-bottom: 16px;
	padding: 8px 12px;
	background: #ffd93d20;
	border-left: 3px solid #ffd93d;
	border-radius: 4px;
	font-size: 12px;
}
.banner-hint { opacity: 0.7; font-size: 11px; }
.section { margin-bottom: 20px; }
.section-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	margin-bottom: 10px;
}
.bucket { margin-bottom: 16px; }
.bucket-header { display:flex; justify-content:space-between; margin-bottom: 5px; }
.bucket-label { font-weight: 600; }
.bucket-pct { font-weight: 700; font-size: 14px; }
.progress {
	width: 100%; height: 7px;
	background: var(--vscode-editorWidget-border, #444);
	border-radius: 4px; overflow: hidden; margin-bottom: 4px;
}
.fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
.bucket-meta {
	display:flex; justify-content:space-between;
	font-size: 11px; color: var(--vscode-descriptionForeground);
}
.row {
	display:flex; justify-content:space-between;
	padding: 5px 0;
	border-bottom: 1px solid var(--vscode-panel-border);
	font-size: 12px;
}
.row:last-child { border-bottom: none; }
.label { color: var(--vscode-descriptionForeground); }
.value { font-weight: 600; }
.no-quota { color: var(--vscode-descriptionForeground); font-size: 12px; font-style: italic; }
.exhausted { color: #ff6b6b; font-weight: 600; }
.burn {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-top: 4px;
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
}
.spark { flex-shrink: 0; display: block; overflow: visible; }
.beta-tag { color: #C15F3C; font-weight: 600; }
.badge {
	font-size: 9px;
	font-weight: 700;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: #C15F3C;
	border: 1px solid #C15F3C;
	border-radius: 3px;
	padding: 0 4px;
	vertical-align: 1px;
}
.burn-beta {
	grid-column: 1 / -1;
	margin-bottom: 10px;
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
}
.burn-headline {
	grid-column: 1 / -1;
	margin-bottom: 14px;
	padding: 7px 11px;
	background: #ffd93d18;
	border-left: 3px solid #ffd93d;
	border-radius: 4px;
	font-size: 12px;
}
hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0; }
.refresh-btn {
	background: none;
	border: none;
	cursor: pointer;
	color: var(--vscode-descriptionForeground);
	font-size: 11px;
	padding: 0;
	opacity: 0.7;
	transition: opacity 0.15s;
}
.refresh-btn:hover { opacity: 1; }
.settings-group { margin-bottom: 14px; }
.settings-group.last-group { margin-bottom: 0; }
.settings-group-title {
	font-size: 10px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	margin-bottom: 6px;
	padding-bottom: 4px;
	border-bottom: 1px solid var(--vscode-panel-border);
}
.setting-row {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 5px 0;
}
.setting-label {
	font-size: 12px;
	display: flex;
	align-items: center;
	gap: 6px;
}
.setting-control {
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
	border-radius: 2px;
	padding: 3px 6px;
	font-size: 12px;
	font-family: var(--vscode-font-family);
	cursor: pointer;
	outline: none;
	max-width: 100%;
}
.setting-control:focus { border-color: var(--vscode-focusBorder); }
.setting-input {
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, #3c3c3c);
	border-radius: 2px;
	padding: 3px 6px;
	font-size: 12px;
	width: 54px;
	text-align: right;
	font-family: var(--vscode-font-family);
	outline: none;
}
.setting-input:focus { border-color: var(--vscode-focusBorder); }
.setting-input.invalid { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
.setting-input.wide { width: 150px; text-align: left; }
.color-pair { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.swatch {
	width: 26px;
	height: 22px;
	padding: 0;
	border: 1px solid var(--vscode-input-border, #3c3c3c);
	border-radius: 2px;
	background: none;
	cursor: pointer;
}
.setting-input::placeholder { color: var(--vscode-input-placeholderForeground, #888); opacity: 0.7; }
.setting-stack { display: flex; flex-direction: column; gap: 6px; padding: 7px 0; }
/* An author display rule outranks the UA sheet, so [hidden] needs saying again. */
.setting-stack[hidden] { display: none; }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
.hint code {
	font-family: var(--vscode-editor-font-family, monospace);
	background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
	border-radius: 3px;
	padding: 0 3px;
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
	background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.18));
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	border: 1px solid transparent;
	border-radius: 999px;
	padding: 3px 11px;
	font-family: inherit;
	font-size: 11px;
	cursor: pointer;
}
.chip:hover { border-color: var(--vscode-focusBorder); }
.chip.active { background: #C15F3C; color: #fff; font-weight: 600; }
.format-input {
	width: 100%;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, #3c3c3c);
	border-radius: 2px;
	padding: 5px 7px;
	font-size: 12px;
	font-family: var(--vscode-editor-font-family, monospace);
	outline: none;
}
.format-input:focus { border-color: var(--vscode-focusBorder); }
.sb-preview {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	background: var(--vscode-statusBar-background, rgba(127,127,127,0.18));
	border-radius: 3px;
	padding: 2px 8px;
	font-size: 12px;
	white-space: nowrap;
}
.sb-icon { flex-shrink: 0; }
.check { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
/* Native checkboxes default to the browser accent (purple), which reads as
   foreign in every VS Code theme — match the panel's own accent instead. */
.check input {
	cursor: pointer;
	margin: 0;
	accent-color: #C15F3C;
}
.threshold-wrap { display: flex; align-items: center; gap: 4px; }
.threshold-pct { font-size: 12px; color: var(--vscode-descriptionForeground); }
.color-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.info-icon { font-size: 11px; opacity: 0.45; cursor: help; font-style: normal; }
.info-icon:hover { opacity: 1; }
</style>
</head>
<body>
<header class="page-header">
	<div class="title-row">
		<svg class="logo" viewBox="50 140 420 290" width="26" height="18" aria-hidden="true">
			<path d="M 250 200 A 100 100 0 1 0 250 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/>
			<path d="M 402 200 A 100 100 0 1 0 402 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/>
		</svg>
		<h1>Claude Usage</h1>
		<button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})" title="Refresh now">↻ Refresh</button>
	</div>
	<div class="subtitle" id="subtitle"></div>
</header>

<div class="tabs" role="tablist" aria-label="Panel sections">
	<button class="tab active" role="tab" id="tab-usage" aria-controls="panel-usage" aria-selected="true" onclick="setTab('usage')">Usage</button>
	<button class="tab" role="tab" id="tab-settings" aria-controls="panel-settings" aria-selected="false" tabindex="-1" onclick="setTab('settings')">Settings</button>
</div>

<div class="tab-panel" id="panel-usage" role="tabpanel" aria-labelledby="tab-usage">
	<div id="error-banner"></div>
	<div class="section">
		<div class="section-title">Quota Windows</div>
		<div id="quota-windows"></div>
	</div>
	<div id="extra-usage"></div>
</div>

<div class="tab-panel" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
	<div id="settings-content"></div>
</div>

<script>
	const vscode = acquireVsCodeApi();
	const TABS = ['usage', 'settings'];

	const ICON_MARK = '@@ICON@@';
	const ICON_SVG  = ${JSON.stringify(ICON_SVG)};
	var TOKENS = {};

	function updateSetting(key, value) {
		vscode.postMessage({ command: 'updateSetting', key, value });
	}

	function esc(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	// Same substitution the extension does, over the token values it sent, so
	// the preview cannot drift from what the status bar will actually render.
	function renderPreview(tpl) {
		// Mirrors templateWithDot(): in emoji mode a format with no {dot} gets one.
		var modeEl = document.getElementById('ind-mode');
		if (modeEl && modeEl.value === 'emoji' && !/\{\s*dot\s*\}/i.test(String(tpl))) {
			tpl = String(tpl) + ' {dot}';
		}
		var filled = String(tpl).replace(/\\{\\{|\\}\\}|\\{([^{}]*)\\}/g, function (m, expr) {
			if (m === '{{') { return '{'; }
			if (m === '}}') { return '}'; }
			var key = String(expr).trim().toLowerCase();
			if (key === 'icon') { return ICON_MARK; }
			return TOKENS[key] != null ? TOKENS[key] : '';
		});
		var parts = filled.split('·').map(function (p) {
			return p.replace(/\\s+/g, ' ').trim();
		}).filter(function (p) { return p.length > 0; });

		// Mirrors collapse() in windows.ts: an icon-only segment earns no separator.
		var bare = function (s) { return s.split(ICON_MARK).join('').trim(); };
		var out  = '';
		for (var i = 0; i < parts.length; i++) {
			if (!out) { out = parts[i]; }
			else if (bare(out) === '' || bare(parts[i]) === '') { out += ' ' + parts[i]; }
			else { out += ' · ' + parts[i]; }
		}
		out = out.replace(/^[\\s·/|,-]+/, '').replace(/[\\s·/|,-]+$/, '');
		return esc(out).split(ICON_MARK).join(ICON_SVG);
	}

	function previewFormat(tpl) {
		var el = document.getElementById('sb-preview');
		if (el) { el.innerHTML = renderPreview(tpl) || '—'; }
	}

	function applyPreset(btn) {
		var tpl   = btn.getAttribute('data-tpl');
		var input = document.getElementById('sb-format');
		if (input) { input.value = tpl; }
		previewFormat(tpl);
		var chips = document.querySelectorAll('.chip');
		for (var i = 0; i < chips.length; i++) { chips[i].classList.toggle('active', chips[i] === btn); }
		updateSetting('claude-usage-monitor.statusBarFormat', tpl);
	}

	// Switch the visible editor immediately. The extension re-sends the whole
	// settings fragment when the write lands, but not while focus is still in
	// the panel — and after picking from a dropdown, it is.
	function setIndicatorMode(mode) {
		var back   = document.getElementById('ind-background');
		var colors = document.getElementById('ind-colors');
		var emoji  = document.getElementById('ind-emoji');
		if (back)   { back.hidden   = mode !== 'background'; }
		if (colors) { colors.hidden = mode !== 'text'; }
		if (emoji)  { emoji.hidden  = mode !== 'emoji'; }
		refreshPreview();
		updateSetting('claude-usage-monitor.statusBarIndicator', mode);
	}

	// Object settings are written whole, so all three levels go together.
	function updateLevelMap(kind) {
		var levels = ['normal', 'warning', 'error'];
		var out = {};
		for (var i = 0; i < levels.length; i++) {
			var el = document.getElementById('ind-' + kind + '-' + levels[i]);
			out[levels[i]] = el ? el.value : '';
		}
		updateSetting(
			kind === 'emoji' ? 'claude-usage-monitor.statusBarEmoji' : 'claude-usage-monitor.statusBarColors',
			out
		);
	}

	// A colour picker fires input on every movement inside the dialog, so the
	// field mirrors continuously and only the committed value is written.
	function mirrorSwatch(picker, fieldId) {
		var field = document.getElementById(fieldId);
		if (field) { field.value = picker.value; field.classList.remove('invalid'); }
	}

	function syncSwatch(picker, fieldId) {
		mirrorSwatch(picker, fieldId);
		updateThemeColor(fieldId.slice('tc-'.length), picker.value);
	}

	// Same picker, but these three write one object setting of our own.
	function syncLevelSwatch(picker, fieldId) {
		mirrorSwatch(picker, fieldId);
		updateLevelMap('color');
	}

	function updateThemeColor(id, value) {
		var v = String(value).trim();
		if (v && !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
			// Anything else lands in settings.json as an invalid colour and is
			// silently ignored by VS Code, which looks like a broken control.
			var field = document.getElementById('tc-' + id);
			if (field) { field.classList.add('invalid'); }
			return;
		}
		var field2 = document.getElementById('tc-' + id);
		if (field2) { field2.classList.remove('invalid'); }
		var patch = {};
		patch[id] = v;
		vscode.postMessage({ command: 'updateThemeColors', patch: patch });
	}

	// Typing a glyph updates the preview before the setting is committed.
	function previewDot(input) {
		TOKENS.dot = input.value;
		refreshPreview();
	}

	function refreshPreview() {
		var fmt = document.getElementById('sb-format');
		previewFormat(fmt ? fmt.value : '');
	}

	function updateColorSources() {
		var boxes = document.querySelectorAll('#color-sources input[type=checkbox]');
		var vals  = [];
		for (var i = 0; i < boxes.length; i++) {
			if (boxes[i].checked) { vals.push(boxes[i].value); }
		}
		updateSetting('claude-usage-monitor.statusBarColorFrom', vals);
	}

	function setTab(name) {
		for (var i = 0; i < TABS.length; i++) {
			var t  = TABS[i];
			var on = t === name;
			var el = document.getElementById('tab-' + t);
			el.classList.toggle('active', on);
			el.setAttribute('aria-selected', on ? 'true' : 'false');
			el.tabIndex = on ? 0 : -1;
			document.getElementById('panel-' + t).hidden = !on;
		}
		vscode.setState({ activeTab: name });
	}

	document.querySelector('.tabs').addEventListener('keydown', function (e) {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') { return; }
		var i = TABS.indexOf(String(document.activeElement.id).replace('tab-', ''));
		if (i < 0) { return; }
		var next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
		setTab(next);
		document.getElementById('tab-' + next).focus();
	});

	// Projected times arrive as epoch ms and are formatted here, in the viewer's
	// own timezone — the extension host may be a remote machine.
	function formatEtas(root) {
		var els = root.querySelectorAll('[data-eta]');
		for (var i = 0; i < els.length; i++) {
			var ms = Number(els[i].getAttribute('data-eta'));
			if (!isFinite(ms)) { continue; }
			var d = new Date(ms);
			els[i].textContent = (ms - Date.now() < 20 * 3600000)
				? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
				: d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
		}
	}

	// Never redraw a control while the user is editing it.
	function settingsFocused() {
		var el = document.activeElement;
		return !!el && document.getElementById('panel-settings').contains(el);
	}

	window.addEventListener('message', function (e) {
		var m = e.data;
		if (!m || m.type !== 'state') { return; }
		TOKENS = m.tokens || {};
		document.getElementById('subtitle').innerHTML      = m.subtitle;
		document.getElementById('error-banner').innerHTML  = m.errorHtml;
		var quota = document.getElementById('quota-windows');
		quota.innerHTML = m.bucketsHtml;
		formatEtas(quota);
		document.getElementById('extra-usage').innerHTML   = m.extraHtml;
		if (!settingsFocused()) {
			document.getElementById('settings-content').innerHTML = m.settingsHtml;
		}
	});

	var saved = vscode.getState();
	setTab(saved && saved.activeTab ? saved.activeTab : 'usage');
	// The webview is torn down when hidden; ask for the current state on every load.
	vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
}

/**
 * Merge a patch into `workbench.colorCustomizations`, touching only the keys
 * this panel owns. An empty value deletes its key rather than writing "" —
 * that is what restores the theme's own colour.
 */
async function writeThemeColors(patch: Record<string, unknown>) {
  const owned = new Set<string>(THEME_COLOR_KEYS.map((k) => k.id));
  const cfg   = vscode.workspace.getConfiguration();
  // get() returns the merged value; writing that back to Global would copy any
  // workspace-level entries into user settings. Extend the global object only.
  const base  = cfg.inspect<Record<string, unknown>>("workbench.colorCustomizations")?.globalValue ?? {};
  const next  = { ...base };

  let touched = false;
  for (const [id, value] of Object.entries(patch)) {
    if (!owned.has(id) || typeof value !== "string") { continue; }
    const v = value.trim();
    if (v) { next[id] = v; } else { delete next[id]; }
    touched = true;
  }
  if (!touched) { return; }

  await cfg.update("workbench.colorCustomizations", next, vscode.ConfigurationTarget.Global);
}

export class UsagePanel {
  private panel: vscode.WebviewPanel | undefined;
  private lastData: UsageData | null = null;
  private lastError: string | null = null;
  private configSub: vscode.Disposable;

  constructor(private extensionUri: vscode.Uri, private memento: vscode.Memento) {
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claude-usage-monitor')
        || e.affectsConfiguration('workbench.colorCustomizations')) { this.post(); }
    });
  }

  /**
   * Push the current state to the webview. The shell HTML is written once, at
   * creation — replacing it on every poll is what used to reset the active tab
   * and wipe whatever the user was typing into a settings field.
   */
  private post() {
    this.panel?.webview.postMessage(
      buildFragments(this.lastData, this.lastError, getStore(this.memento)),
    );
  }

  public show(data: UsageData | null, error: string | null = null) {
    if (data) { this.lastData = data; }
    this.lastError = error;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, true);
      this.post();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "claudeUsage",
      "Claude Usage",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "icon.png");
    // Register before the shell is written, so the webview's 'ready' can't race us.
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'ready') {
        // Fresh webview load (first open, or a reload after being hidden).
        this.post();
      } else if (msg.command === 'refresh') {
        vscode.commands.executeCommand('claude-usage-monitor.refresh');
      } else if (msg.command === 'updateSetting') {
        // The config listener re-posts once the write lands.
        await vscode.workspace.getConfiguration().update(
          msg.key, msg.value, vscode.ConfigurationTarget.Global
        );
      } else if (msg.command === 'updateThemeColors') {
        await writeThemeColors(msg.patch ?? {});
      }
    });
    this.panel.webview.html = buildShell();
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  public update(data: UsageData | null, error: string | null = null) {
    if (data) { this.lastData = data; }
    this.lastError = error;
    this.post();
  }

  public dispose() {
    this.panel?.dispose();
    this.configSub.dispose();
  }
}
