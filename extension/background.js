// skald — background event page (classic, MV3 Firefox).
//
// Responsibilities (kept deliberately thin):
//   1. Alt+R command / toolbar click → inject the content-script bootstrap
//      (content/loader.js) plus the sentence-highlight stylesheet.
//   2. CORS-free proxy for daemon traffic: the content script cannot fetch
//      http://localhost:8000 directly, so it sends 'skald:daemon-fetch'
//      messages and this page performs the fetch using host_permissions.

'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;
const DAEMON_BASE = 'http://localhost:8000';

// Tabs where src/highlight.css is currently present. Best-effort: cleared on
// navigation (status 'loading') and tab close so a fresh page gets re-inserted.
const cssInjectedTabs = new Set();

api.tabs.onRemoved.addListener((tabId) => {
  cssInjectedTabs.delete(tabId);
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo && changeInfo.status === 'loading') {
    cssInjectedTabs.delete(tabId);
  }
});

async function injectIntoTab(tabId) {
  if (typeof tabId !== 'number') return;
  try {
    if (!cssInjectedTabs.has(tabId)) {
      await api.scripting.insertCSS({
        target: { tabId },
        files: ['src/highlight.css'],
      });
      cssInjectedTabs.add(tabId);
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

function onStartReading() {
  api.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => {
      if (tabs && tabs.length && typeof tabs[0].id === 'number') {
        return injectIntoTab(tabs[0].id);
      }
    })
    .catch((err) => console.error('[skald] tab query failed:', err));
}

api.commands.onCommand.addListener((command) => {
  if (command === 'read-aloud') onStartReading();
});

api.action.onClicked.addListener((tab) => {
  onStartReading();
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
    const url = DAEMON_BASE + String(msg.path || '/');
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
