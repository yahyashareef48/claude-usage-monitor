// Claude Usage Monitor - Background Service Worker
// Intercepts claude.ai API requests to extract orgId, then polls usage every 2 minutes

const POLL_INTERVAL_MINUTES = 2;
const USAGE_ALARM = 'pollUsage';

let orgId = null;

// On install/startup, restore orgId from storage and set up alarm
chrome.runtime.onInstalled.addListener(async () => {
  const { orgId: stored } = await chrome.storage.session.get('orgId');
  if (stored) orgId = stored;
  scheduleAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  const { orgId: stored } = await chrome.storage.session.get('orgId');
  if (stored) orgId = stored;
  scheduleAlarm();
});

function scheduleAlarm() {
  chrome.alarms.get(USAGE_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(USAGE_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === USAGE_ALARM) {
    fetchAndStore();
  }
});

// Intercept any claude.ai API request to extract orgId
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (orgId) return; // Already have it

    const url = details.url;

    // Try to get orgId from URL (e.g. /api/organizations/{id}/*)
    const urlMatch = url.match(/\/api\/organizations\/([a-f0-9-]{36})/);
    if (urlMatch) {
      setOrgId(urlMatch[1]);
      return;
    }

    // Try to get orgId from lastActiveOrg cookie
    const cookieHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'cookie'
    )?.value;
    if (cookieHeader) {
      const cookieMatch = cookieHeader.match(/lastActiveOrg=([a-f0-9-]{36})/);
      if (cookieMatch) {
        setOrgId(cookieMatch[1]);
      }
    }
  },
  { urls: ['*://claude.ai/api/*'] },
  ['requestHeaders']
);

async function setOrgId(id) {
  if (orgId === id) return;
  orgId = id;
  await chrome.storage.session.set({ orgId: id });
  // Immediately fetch now that we have an orgId
  fetchAndStore();
  // Ensure alarm is running
  scheduleAlarm();
}

async function fetchAndStore() {
  // Always read from storage — in-memory orgId is lost when service worker goes idle
  if (!orgId) {
    const stored = await chrome.storage.session.get('orgId');
    orgId = stored.orgId ?? null;
  }
  if (!orgId) return;

  try {
    const cookie = await chrome.cookies.get({
      url: 'https://claude.ai',
      name: 'sessionKey',
    });

    if (!cookie) {
      console.warn('[Claude Usage Monitor] sessionKey cookie not found');
      return;
    }

    const response = await fetch(
      `https://claude.ai/api/organizations/${orgId}/usage`,
      {
        headers: {
          cookie: `sessionKey=${cookie.value}`,
          'content-type': 'application/json',
          'anthropic-client-platform': 'web_claude_ai',
        },
      }
    );

    if (!response.ok) {
      console.warn(`[Claude Usage Monitor] API error ${response.status}`);
      return;
    }

    const raw = await response.json();
    const usageData = parseUsageData(raw);

    await chrome.storage.session.set({
      usageData,
      fetchedAt: Date.now(),
    });

    // Notify all claude.ai tabs
    const tabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'USAGE_UPDATED', usageData }).catch(() => {
        // Tab may not have content script ready yet, ignore
      });
    }
  } catch (err) {
    console.error('[Claude Usage Monitor] Fetch error:', err);
  }
}

function parseUsageData(raw) {
  return {
    fiveHour: parseQuotaBucket(raw.five_hour),
    sevenDay: parseQuotaBucket(raw.seven_day),
    sevenDaySonnet: parseQuotaBucket(raw.seven_day_sonnet),
    sevenDayOpus: parseQuotaBucket(raw.seven_day_opus),
    sevenDayOauthApps: parseQuotaBucket(raw.seven_day_oauth_apps),
    extraUsage: parseExtraUsage(raw.extra_usage),
  };
}

function parseQuotaBucket(raw) {
  if (!raw) return null;
  return {
    utilization: raw.utilization ?? 0,
    resetsAt: raw.resets_at ?? null,
  };
}

function parseExtraUsage(raw) {
  if (!raw) return null;
  return {
    isEnabled: raw.is_enabled ?? false,
    monthlyLimit: raw.monthly_limit ?? null,
    usedCredits: raw.used_credits ?? null,
    utilization: raw.utilization ?? null,
    currency: raw.currency ?? null,
  };
}

async function fetchProjects() {
  if (!orgId) {
    const stored = await chrome.storage.session.get('orgId');
    orgId = stored.orgId ?? null;
  }
  if (!orgId) return [];

  const cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'sessionKey' });
  if (!cookie) return [];

  const response = await fetch(
    `https://claude.ai/api/organizations/${orgId}/projects?include_harmony_projects=true&limit=30&order_by=latest_chat`,
    {
      headers: {
        cookie: `sessionKey=${cookie.value}`,
        'content-type': 'application/json',
        'anthropic-client-platform': 'web_claude_ai',
      },
    }
  );
  if (!response.ok) return [];
  const raw = await response.json();
  // Filter out archived projects, return uuid + name
  return (Array.isArray(raw) ? raw : [])
    .filter(p => !p.archived_at)
    .map(p => ({ uuid: p.uuid, name: p.name }));
}

// Handle messages from content scripts / popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_USAGE') {
    chrome.storage.session.get(['usageData', 'fetchedAt', 'orgId']).then((data) => {
      sendResponse(data);
    });
    return true;
  }
  if (message.type === 'FORCE_REFRESH') {
    fetchAndStore().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'GET_PROJECTS') {
    fetchProjects().then(projects => sendResponse({ projects }));
    return true;
  }
});
