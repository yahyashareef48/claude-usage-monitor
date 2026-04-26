// Claude Usage Monitor - Content Script
// Injects usage widget into the claude.ai sidebar

const WIDGET_ID = 'claude-usage-monitor-widget';
const TARGET_SELECTOR = '.relative.flex.w-full.items-center.p-2.pointer-events-auto.pt-2';
const COLLAPSED_KEY = 'cum_collapsed';

// ── Recents Filter ──────────────────────────────────────────────────────────
const FILTER_BTN_ID = 'cum-filter-btn';
const FILTER_DROPDOWN_ID = 'cum-filter-dropdown';
const FILTER_KEY = 'cum_filter';

// activeFilter: 'all' | 'none' | project-uuid string
let activeFilter = sessionStorage.getItem(FILTER_KEY) || 'all';
let projectsList = []; // { uuid, name }[]
let dropdownOpen = false;

function findRecentsHeading() {
  for (const el of document.querySelectorAll('h2')) {
    if (el.textContent.trim().startsWith('Recents')) return el;
  }
  return null;
}

function filterLabel() {
  if (activeFilter === 'all') return 'All';
  if (activeFilter === 'none') return 'No Project';
  const p = projectsList.find(p => p.uuid === activeFilter);
  return p ? p.name : 'All';
}

function tryInjectFilter() {
  if (document.getElementById(FILTER_BTN_ID)) return;
  const heading = findRecentsHeading();
  if (!heading) return;

  // Inject a small filter button inside the h2 flex row (before the Hide span)
  const btn = document.createElement('button');
  btn.id = FILTER_BTN_ID;
  btn.className = 'cum-filter-btn';
  btn.textContent = filterLabel();
  // Insert into the outer flex div (heading's parent), not inside the h2
  const outerFlex = heading.parentElement;
  if (outerFlex) {
    outerFlex.appendChild(btn);
  } else {
    heading.appendChild(btn);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown(btn);
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest(`#${FILTER_DROPDOWN_ID}`) && e.target.id !== FILTER_BTN_ID) {
      closeDropdown();
    }
  }, true);

  // Fetch projects lazily
  chrome.runtime.sendMessage({ type: 'GET_PROJECTS' }, (res) => {
    if (res?.projects) {
      projectsList = res.projects;
      // Re-render dropdown if open
      const dd = document.getElementById(FILTER_DROPDOWN_ID);
      if (dd) renderDropdownContent(dd);
    }
  });

  applyFilter(activeFilter);
}

function toggleDropdown(btn) {
  if (dropdownOpen) {
    closeDropdown();
    return;
  }
  openDropdown(btn);
}

function openDropdown(btn) {
  closeDropdown();
  dropdownOpen = true;

  const dd = document.createElement('div');
  dd.id = FILTER_DROPDOWN_ID;
  dd.className = 'cum-filter-dropdown';
  renderDropdownContent(dd);

  // Detect claude.ai theme and pass it to the dropdown
  const isLight = document.documentElement.classList.contains('light')
    || document.body.classList.contains('light')
    || document.documentElement.getAttribute('data-theme') === 'light'
    || getComputedStyle(document.documentElement).getPropertyValue('--bg-100').trim().startsWith('#f');
  dd.dataset.cumTheme = isLight ? 'light' : 'dark';

  // Attach to body as fixed, right-aligned to the outer container
  document.body.appendChild(dd);
  const heading = findRecentsHeading();
  const outerDiv = heading?.parentElement;
  const containerRect = (outerDiv ?? btn).getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();

  dd.style.position = 'fixed';
  dd.style.top = `${btnRect.bottom + 4}px`;
  dd.style.left = 'auto';
  dd.style.right = `${window.innerWidth - containerRect.right}px`;
  dd.style.width = '250px';
}

function renderDropdownContent(dd) {
  const allOptions = [
    { key: 'all', label: 'All chats' },
    { key: 'none', label: 'No project' },
    ...projectsList.map(p => ({ key: p.uuid, label: p.name })),
  ];

  const showSearch = projectsList.length > 5;

  dd.innerHTML = `
    <div class="cum-dd-header">Filter by</div>
    ${showSearch ? `<div class="cum-dd-search"><input type="text" placeholder="Search projects…" autocomplete="off"></div>` : ''}
    <div class="cum-dd-scroll">
      ${renderItems(allOptions)}
    </div>
  `;

  if (showSearch) {
    const input = dd.querySelector('.cum-dd-search input');
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      const scroll = dd.querySelector('.cum-dd-scroll');
      const filtered = allOptions.filter(o =>
        o.key === 'all' || o.key === 'none' || o.label.toLowerCase().includes(q)
      );
      scroll.innerHTML = renderItems(filtered);
      attachItemListeners(scroll);
    });
    // Prevent outside-click handler from closing on input click
    input.addEventListener('click', e => e.stopPropagation());
  }

  attachItemListeners(dd.querySelector('.cum-dd-scroll'));
}

function renderItems(options) {
  return options.map(o => `
    <button class="cum-dd-item${o.key === activeFilter ? ' cum-dd-item-active' : ''}" data-key="${o.key}">
      ${o.key === activeFilter ? '<span class="cum-dd-check">✓</span>' : '<span class="cum-dd-check"></span>'}
      <span class="cum-dd-label">${o.label}</span>
    </button>
  `).join('');
}

function attachItemListeners(container) {
  container.querySelectorAll('.cum-dd-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      activeFilter = item.dataset.key;
      sessionStorage.setItem(FILTER_KEY, activeFilter);
      const btn = document.getElementById(FILTER_BTN_ID);
      if (btn) btn.textContent = filterLabel();
      closeDropdown();
      applyFilter(activeFilter);
    });
  });
}

function closeDropdown() {
  const dd = document.getElementById(FILTER_DROPDOWN_ID);
  if (dd) dd.remove();
  dropdownOpen = false;
}

function getConversationItems() {
  const heading = findRecentsHeading();
  if (!heading) return [];
  const container = heading.closest('div, nav, section')?.querySelector('ol, ul')
    ?? heading.parentElement?.parentElement;
  if (!container) return [];
  return Array.from(container.querySelectorAll('a[href]'));
}

function applyFilter(filter) {
  const items = getConversationItems();
  items.forEach(item => {
    const href = item.getAttribute('href') || '';
    // Extract project uuid from href like /project/{uuid}/chat/{id} or /project/{uuid}
    const projectMatch = href.match(/\/project\/([a-f0-9-]{36})/);
    const itemProjectId = projectMatch ? projectMatch[1] : null;

    let show = true;
    if (filter === 'all') {
      show = true;
    } else if (filter === 'none') {
      show = itemProjectId === null;
    } else {
      // Specific project uuid
      show = itemProjectId === filter;
    }
    item.style.display = show ? '' : 'none';
  });
}

// Re-inject and re-apply on SPA navigation / DOM changes
const filterObserver = new MutationObserver(() => {
  tryInjectFilter();
  if (document.getElementById(FILTER_BTN_ID)) {
    applyFilter(activeFilter);
  }
});
filterObserver.observe(document.body, { childList: true, subtree: true });

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

  // Switch between full and icon-only mode based on sidebar width
  const sidebar = target.closest('nav, [class*="sidebar"], [class*="Sidebar"]') ?? target.parentElement;
  if (sidebar) {
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      widget.classList.toggle('cum-icon-only', w < 100);
    });
    ro.observe(sidebar);
  }
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

  // Icon-only mode is handled via CSS .cum-icon-only class on the widget root,
  // but we embed the icon-only markup as a sibling div so no re-render is needed on resize.
  // We always render it; CSS shows/hides the right section.
  const fhIconPct = data?.fiveHour != null ? Math.round(data.fiveHour.utilization) : null;
  const iconColor = fhIconPct != null ? utilizationColor(fhIconPct) : '#2e9e52';
  const iconOnlyHtml = `
    <div class="cum-icon-only-view">
      ${LOGO_SVG}
      ${fhIconPct != null ? `<span class="cum-icon-pct" style="color:${iconColor}">${fhIconPct}%</span>` : ''}
    </div>`;

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
      ${iconOnlyHtml}
      <div class="cum-full-view">
        <div class="cum-heading cum-clickable">
          ${LOGO_SVG}
          <span class="cum-title">Plan Usage Limits</span>
          ${pctHtml}
          ${resetHtml}
          <span class="cum-chevron">${chevron}</span>
        </div>
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
    ${iconOnlyHtml}
    <div class="cum-full-view">
      <div class="cum-heading cum-clickable">
        ${LOGO_SVG}
        <span class="cum-title">Plan Usage Limits</span>
        <span class="cum-chevron">${chevron}</span>
      </div>
      ${rowsHtml}
      ${footerHtml}
    </div>
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
  if (h >= 24) {
    // Show "Sun 4:30 AM" style
    return new Date(resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
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
