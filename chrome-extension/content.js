// Claude Usage Monitor - Content Script
// Injects usage widget into the claude.ai sidebar

const WIDGET_ID = 'claude-usage-monitor-widget';
const TARGET_SELECTOR = '.relative.flex.w-full.items-center.p-2.pointer-events-auto.pt-2';
const COLLAPSED_KEY = 'cum_collapsed';

// Inline SVG logo — viewBox tightly crops the visible paths (y:175–387, x:100–452 + stroke overflow)
// so it centers properly at any size without vertical offset
const LOGO_SVG = `<svg class="cum-icon-svg" xmlns="http://www.w3.org/2000/svg" viewBox="75 150 402 237" aria-hidden="true">
  <path d="M 250 200 A 100 100 0 1 0 250 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/>
  <path d="M 402 200 A 100 100 0 1 0 402 362" stroke="#C15F3C" stroke-width="50" fill="none" stroke-linecap="round"/>
</svg>`;

let currentData = null;
let fetchedAt = null;
let isCollapsed = sessionStorage.getItem(COLLAPSED_KEY) === 'true';

// Request cached data from background on load
chrome.runtime.sendMessage({ type: 'GET_USAGE' }, (response) => {
  if (response?.usageData) {
    currentData = response.usageData;
    fetchedAt = response.fetchedAt ?? null;
    tryInjectWidget();
  }
});

// Listen for live updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'USAGE_UPDATED') {
    currentData = message.usageData;
    fetchedAt = Date.now();
    const existing = document.getElementById(WIDGET_ID);
    if (existing) {
      rerenderWidget(existing);
    } else {
      tryInjectWidget();
    }
  }
});

// Watch for SPA navigation / DOM changes
const observer = new MutationObserver(() => {
  if (!document.getElementById(WIDGET_ID)) {
    tryInjectWidget();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

function tryInjectWidget() {
  if (!currentData) return;
  const target = document.querySelector(TARGET_SELECTOR);
  if (!target) return;
  if (document.getElementById(WIDGET_ID)) return;

  const widget = document.createElement('div');
  widget.id = WIDGET_ID;
  rerenderWidget(widget);
  target.insertAdjacentElement('afterend', widget);
}

function rerenderWidget(el) {
  el.innerHTML = renderWidget(currentData, fetchedAt, isCollapsed);

  const heading = el.querySelector('.cum-heading');
  if (heading) {
    heading.addEventListener('click', (e) => {
      // Don't collapse when clicking the reload button
      if (e.target.classList.contains('cum-reload')) return;
      isCollapsed = !isCollapsed;
      sessionStorage.setItem(COLLAPSED_KEY, isCollapsed);
      rerenderWidget(el);
    });
  }

  const reloadBtn = el.querySelector('.cum-reload');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      reloadBtn.classList.add('cum-reload-spinning');
      chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' }, () => {});
    });
  }
}

function renderWidget(data, ts, collapsed) {
  const chevron = collapsed ? '▸' : '▾';

  if (collapsed) {
    const fh = data?.fiveHour;
    const pct = fh ? Math.round(fh.utilization) : null;
    const color = pct != null ? utilizationColor(pct) : '';
    const timeLeft = fh?.resetsAt ? formatTimeRemaining(fh.resetsAt) : null;

    const pctHtml = pct != null
      ? `<span class="cum-inline-summary" style="color:${color}">${pct}%</span>`
      : '';
    const resetHtml = timeLeft
      ? `<span class="cum-inline-reset">${timeLeft}</span>`
      : '';

    return `
      <div class="cum-heading cum-clickable">
        ${LOGO_SVG}
        <span class="cum-title">Plan Usage Limits</span>
        ${pctHtml}
        ${resetHtml}
        <span class="cum-chevron">${chevron}</span>
      </div>
    `;
  }

  // Expanded
  const rows = [];
  if (data?.fiveHour) rows.push(bucketRow('5-hour', data.fiveHour));
  if (data?.sevenDay) rows.push(bucketRow('7-day', data.sevenDay));
  if (data?.sevenDaySonnet) rows.push(bucketRow('7-day Sonnet', data.sevenDaySonnet));
  if (data?.sevenDayOpus) rows.push(bucketRow('7-day Opus', data.sevenDayOpus));
  if (data?.extraUsage?.isEnabled) rows.push(creditsRow(data.extraUsage));

  const rowsHtml = rows.length > 0
    ? `<div class="cum-rows">${rows.join('')}</div>`
    : '<div class="cum-no-data">No usage data available</div>';

  const footerHtml = `<div class="cum-footer">${ts ? `Updated ${timeAgo(ts)}` : ''}<button class="cum-reload" title="Refresh">↻</button></div>`;

  return `
    <div class="cum-heading cum-clickable">
      ${LOGO_SVG}
      <span class="cum-title">Plan Usage Limits</span>
      <span class="cum-chevron">${chevron}</span>
    </div>
    ${rowsHtml}
    ${footerHtml}
  `;
}

function bucketRow(label, bucket) {
  const pct = Math.round(bucket.utilization);
  const color = utilizationColor(pct);
  const timeLeft = bucket.resetsAt ? formatTimeRemaining(bucket.resetsAt) : null;
  const resetStr = timeLeft ? `<span class="cum-reset">${timeLeft}</span>` : '';

  return `
    <div class="cum-row">
      <div class="cum-row-header">
        <span class="cum-label">${label}</span>
        <span class="cum-pct" style="color:${color}">${pct}%</span>
        ${resetStr}
      </div>
      <div class="cum-bar-track">
        <div class="cum-bar-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div>
      </div>
    </div>
  `;
}

function creditsRow(extra) {
  const used = (extra.usedCredits / 100).toFixed(2);
  const limit = (extra.monthlyLimit / 100).toFixed(2);
  const pct = Math.round(extra.utilization ?? 0);
  const color = utilizationColor(pct);
  const currency = extra.currency ?? 'USD';

  return `
    <div class="cum-row">
      <div class="cum-row-header">
        <span class="cum-label">Extra Credits</span>
        <span class="cum-pct" style="color:${color}">${pct}%</span>
        <span class="cum-reset">${currency} ${used} / ${limit}</span>
      </div>
      <div class="cum-bar-track">
        <div class="cum-bar-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div>
      </div>
    </div>
  `;
}

function utilizationColor(pct) {
  if (pct >= 80) return '#e05c3a';
  if (pct >= 60) return '#d4a017';
  return '#2e9e52';
}

function formatTimeRemaining(resetsAt) {
  const diff = new Date(resetsAt) - Date.now();
  if (diff <= 0) return 'resetting…';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
