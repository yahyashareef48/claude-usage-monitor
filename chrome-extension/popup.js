// Claude Usage Monitor - Popup Script

document.getElementById('refreshBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_USAGE' }, renderResponse);
});

chrome.runtime.sendMessage({ type: 'GET_USAGE' }, renderResponse);

function renderResponse(response) {
  const content = document.getElementById('content');
  const footer = document.getElementById('footer');

  if (!response?.usageData) {
    content.innerHTML = '<div class="no-data">Navigate to claude.ai to load data</div>';
    footer.textContent = '';
    return;
  }

  content.innerHTML = renderUsage(response.usageData);

  if (response.fetchedAt) {
    const ago = timeAgo(response.fetchedAt);
    footer.textContent = `Updated ${ago}`;
  }
}

function renderUsage(data) {
  const rows = [];

  if (data.fiveHour) rows.push(bucketRow('5-hour window', data.fiveHour));
  if (data.sevenDay) rows.push(bucketRow('7-day window', data.sevenDay));
  if (data.sevenDaySonnet) rows.push(bucketRow('7-day Sonnet', data.sevenDaySonnet));
  if (data.sevenDayOpus) rows.push(bucketRow('7-day Opus', data.sevenDayOpus));

  const hasQuota = rows.length > 0;
  const hasCredits = data.extraUsage?.isEnabled;

  if (!hasQuota && !hasCredits) {
    return '<div class="no-data">No usage data</div>';
  }

  let html = '<div class="rows">';
  html += rows.join('');

  if (hasQuota && hasCredits) {
    html += '<div class="divider"></div>';
  }

  if (hasCredits) {
    html += creditsRow(data.extraUsage);
  }

  html += '</div>';
  return html;
}

function bucketRow(label, bucket) {
  const pct = Math.round(bucket.utilization);
  const color = utilizationColor(pct);
  const timeLeft = bucket.resetsAt ? formatTimeRemaining(bucket.resetsAt) : null;
  const resetStr = timeLeft ? `<span class="reset">${timeLeft}</span>` : '';

  return `
    <div class="row">
      <div class="row-header">
        <span class="label">${label}</span>
        <span class="pct" style="color:${color}">${pct}%</span>
        ${resetStr}
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div>
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
    <div class="row">
      <div class="row-header">
        <span class="label">Extra Credits</span>
        <span class="pct" style="color:${color}">${pct}%</span>
        <span class="reset">${currency} ${used}/${limit}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div>
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

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
