// Claude Usage Monitor - Content Script
// Injects usage widget into the claude.ai sidebar

const WIDGET_ID = 'claude-usage-monitor-widget';
const TARGET_SELECTOR = '.relative.flex.w-full.items-center.p-2.pointer-events-auto.pt-2';

let currentData = null;

// Request cached data from background on load
chrome.runtime.sendMessage({ type: 'GET_USAGE' }, (response) => {
  if (response?.usageData) {
    currentData = response.usageData;
    tryInjectWidget();
  }
});

// Listen for live updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'USAGE_UPDATED') {
    currentData = message.usageData;
    const existing = document.getElementById(WIDGET_ID);
    if (existing) {
      updateWidget(existing, currentData);
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

  // Don't inject twice
  if (document.getElementById(WIDGET_ID)) return;

  const widget = buildWidget(currentData);
  target.insertAdjacentElement('afterend', widget);
}

function buildWidget(data) {
  const el = document.createElement('div');
  el.id = WIDGET_ID;
  el.innerHTML = renderWidget(data);
  return el;
}

function updateWidget(el, data) {
  el.innerHTML = renderWidget(data);
}

function renderWidget(data) {
  const rows = [];

  if (data.fiveHour) {
    rows.push(bucketRow('5-hour', data.fiveHour));
  }
  if (data.sevenDay) {
    rows.push(bucketRow('7-day', data.sevenDay));
  }
  if (data.sevenDaySonnet) {
    rows.push(bucketRow('7-day Sonnet', data.sevenDaySonnet));
  }
  if (data.sevenDayOpus) {
    rows.push(bucketRow('7-day Opus', data.sevenDayOpus));
  }
  if (data.extraUsage?.isEnabled) {
    rows.push(creditsRow(data.extraUsage));
  }

  if (rows.length === 0) {
    return '<div class="cum-no-data">No usage data available</div>';
  }

  const iconUrl = chrome.runtime.getURL('icons/icon48.png');
  return `
    <div class="cum-heading">
      <img class="cum-icon" src="${iconUrl}" alt="">
      Plan Usage Limits
    </div>
    <div class="cum-rows">${rows.join('')}</div>
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
  if (pct >= 80) return '#ff6b6b';
  if (pct >= 60) return '#ffd93d';
  return '#6bcb77';
}

function formatTimeRemaining(resetsAt) {
  const diff = new Date(resetsAt) - Date.now();
  if (diff <= 0) return 'resetting…';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
