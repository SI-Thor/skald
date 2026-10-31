// skald — background: event page (Firefox) / service worker (Chrome MV3).
//
// Responsibilities (kept deliberately thin):
//   1. Alt+R command / toolbar click → inject the content-script bootstrap
//      (content/loader.js) plus the sentence-highlight stylesheet.
//   2. CORS-free proxy for daemon traffic: the content script cannot fetch
//      http://localhost:8000 directly, so it sends 'skald:daemon-fetch'
//      messages and this context performs the fetch using host_permissions.
//   3. 'skald:open-lane' → open the Lane C live-show page (lane.html) in a
//      tab: content scripts cannot call tabs.create (ADR-0009 layer 3).
//   4. Audio brokering for Chrome (ADR-0011): Chrome kills this context
//      after ~30 s idle and its service worker has no DOM, so daemon audio
//      cannot live here. 'skald:audio-play' requests are forwarded to an
//      offscreen document (extension page, exempt from the site autoplay
//      policy) which fetches/plays; its 'skald:audio-event' replies are
//      routed back to the originating tab. Firefox never uses this path —
//      its event page keeps the classic inline playback in the content
//      script.
//
// Service-worker rule: NO state lives only in globals — Chrome may kill and
// respawn this script between any two events. Cross-event state
// (CSS-injected tabs, playId→tabId audio routes) goes through
// storage.session, with an in-memory fast path; storage.session is also
// available in Firefox MV3 (115+), so one implementation serves both.
//
// All onMessage listeners are registered synchronously at the top level —
// required for a killed service worker to wake on the event.

'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;
const DAEMON_BASE = 'http://localhost:8000';
const CSS_TABS_KEY = 'skald.cssTabs';
const AUDIO_ROUTES_KEY = 'skald.audioRoutes';

// --- session state (survives service-worker suspension) ---------------------

const session = (api.storage && api.storage.session) || null;

async function sessionGet(key, fallback) {
  if (!session) return fallback;
  try {
    const got = await session.get(key);
    return key in got ? got[key] : fallback;
  } catch {
    return fallback;
  }
}

async function sessionSet(key, value) {
  if (!session) return;
  try {
    await session.set({ [key]: value });
  } catch {
    /* best-effort; worst case is a duplicate stylesheet or a lost route */
  }
}

// --- tab bootstrap: highlight CSS + loader -----------------------------------

async function injectIntoTab(tabId) {
  if (typeof tabId !== 'number') return;
  try {
    const injected = new Set(await sessionGet(CSS_TABS_KEY, []));
    if (!injected.has(tabId)) {
      await api.scripting.insertCSS({
        target: { tabId },
        files: ['src/highlight.css'],
      });
      injected.add(tabId);
      await sessionSet(CSS_TABS_KEY, [...injected]);
    }
  } catch (err) {
    // Duplicate stylesheet is harmless; missing one just means no highlight.
    console.warn('[skald] insertCSS failed:', err && err.message);
  }
  try {
    await api.scripting.executeScript({
      target: { tabId },
      files: ['content/loader.js'],
    });
  } catch (err) {
    console.error('[skald] cannot inject into this page:', err && err.message);
  }
}

api.tabs.onRemoved.addListener(async (tabId) => {
  const injected = new Set(await sessionGet(CSS_TABS_KEY, []));
  if (injected.delete(tabId)) await sessionSet(CSS_TABS_KEY, [...injected]);
});

api.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo && changeInfo.status === 'loading') {
    const injected = new Set(await sessionGet(CSS_TABS_KEY, []));
    if (injected.delete(tabId)) await sessionSet(CSS_TABS_KEY, [...injected]);
  }
});

function onStartReading() {
  api.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => {
      if (tabs && tabs.length && typeof tabs[0].id === 'number') {
        return injectIntoTab(tabs[0].id);
      }
    })
    .catch((err) => console.error('[skald] tab query failed:', err && err.message));
}

api.commands.onCommand.addListener((command) => {
  if (command === 'read-aloud') onStartReading();
});

api.action.onClicked.addListener((tab) => {
  onStartReading();
});

// Lane C: open the live-show page in a tab (from the control bar's 🎭
// button; content scripts cannot open tabs themselves). Fire-and-forget.
api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'skald:open-lane') return undefined;
  api.tabs
    .create({ url: api.runtime.getURL('lane.html') })
    .catch((err) => console.error('[skald] cannot open lane page:', err && err.message));
  return undefined;
});

// --- daemon fetch proxy -----------------------------------------------------

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    );
  }
  return btoa(binary);
}

api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'skald:daemon-fetch') return undefined;
  const run = (async () => {
    // Server URL: prefer the caller's configured base (engine reads settings);
    // validate scheme — this is what makes LAN harnessing possible while
    // never allowing file:, etc. through the proxy.
    let base = String(msg.baseUrl || DAEMON_BASE);
    if (!/^https?:\/\//i.test(base)) base = DAEMON_BASE;
    const url = base.replace(/\/+$/, '') + String(msg.path || '/');
    const init = {
      method: msg.method || 'GET',
      headers: msg.headers || {},
    };
    if (msg.bodyText != null) init.body = msg.bodyText;
    try {
      const res = await fetch(url, init);
      const contentType = res.headers.get('content-type') || '';
      const isTextual =
        contentType.startsWith('text/') || contentType.includes('json');
      if (isTextual) {
        return {
          ok: res.ok,
          status: res.status,
          contentType,
          bodyText: await res.text(),
        };
      }
      return {
        ok: res.ok,
        status: res.status,
        contentType,
        bodyBase64: arrayBufferToBase64(await res.arrayBuffer()),
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: String((err && err.message) || err),
      };
    }
  })();
  run.catch(() => {}); // never leave a rejected promise unobserved
  return run;
});

// --- offscreen audio broker (Chrome only; see header) ------------------------

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play read-aloud speech when the page cannot (Chrome autoplay policy / no DOM in the service worker).',
    });
  }
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return undefined;

  // Capability probe from the content script: chrome.offscreen /
  // runtime.getContexts exist only in extension contexts (this one), never
  // in content scripts, so the engine asks here whether offscreen playback
  // is available (true on Chrome's service worker, false on Firefox).
  if (msg.type === 'skald:offscreen-capability') {
    return Promise.resolve({
      ok: typeof chrome !== 'undefined' && !!(chrome.offscreen && chrome.runtime && chrome.runtime.getContexts),
    });
  }

  if (msg.type === 'skald:audio-play') {
    const run = (async () => {
      const tabId = sender && sender.tab && sender.tab.id;
      if (typeof tabId !== 'number') {
        return { ok: false, error: 'audio-play: no source tab' };
      }
      try {
        await ensureOffscreen();
        // Route map must live in storage.session: this worker can be killed
        // mid-playback and the offscreen 'ended' event needs the target tab.
        const routes = await sessionGet(AUDIO_ROUTES_KEY, {});
        routes[msg.playId] = tabId;
        await sessionSet(AUDIO_ROUTES_KEY, routes);
        await chrome.runtime.sendMessage({
          type: 'skald:offscreen-play',
          playId: msg.playId,
          mode: msg.mode, // 'blob' | 'stream'
          mime: msg.mime,
          bodyBase64: msg.bodyBase64,
          url: msg.url,
          body: msg.body,
          volume: msg.volume,
          rate: msg.rate,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    })();
    run.catch(() => {});
    return run;
  }

  if (msg.type === 'skald:audio-control') {
    // Pause/resume/stop/volume for the single active offscreen playback.
    chrome.runtime
      .sendMessage({
        type: 'skald:offscreen-control',
        action: msg.action,
        value: msg.value,
      })
      .catch(() => {});
    return undefined;
  }

  if (msg.type === 'skald:audio-event' && sender.url === chrome.runtime.getURL(OFFSCREEN_URL)) {
    // From the offscreen document → forward to the tab that started the play.
    const run = (async () => {
      const routes = await sessionGet(AUDIO_ROUTES_KEY, {});
      const tabId = routes[msg.playId];
      if (typeof tabId !== 'number') return undefined;
      if (msg.event === 'ended' || msg.event === 'error') {
        delete routes[msg.playId];
        await sessionSet(AUDIO_ROUTES_KEY, routes);
      }
      try {
        await chrome.tabs.sendMessage(tabId, msg);
      } catch (err) {
        // Tab navigated/closed mid-playback; nothing to deliver to.
        console.warn('[skald] audio event undeliverable:', err && err.message);
      }
      return undefined;
    })();
    run.catch(() => {});
    return undefined; // offscreen does not need a reply
  }

  return undefined;
});
