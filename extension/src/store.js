// skald — settings persistence via browser.storage.local.
//
// Deviation from the original sketch (see README): the bar position and all
// defaults are stored in browser.storage.local rather than localStorage, so
// they survive per-site data clearing and are readable from any context.

'use strict';

const SETTINGS_KEY = 'skald.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  engine: 'system', // 'system' | 'daemon'
  voiceByEngine: {}, // { system: voiceId|null, daemon: voiceId|null }
  rate: 1.0, // 0.5 – 3.0
  volume: 1.0, // 0 – 1
  pitch: 1.0, // 0.5 – 2.0
  barPos: null, // { x, y } in CSS px, or null for default top-right
});

function storage() {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  return api && api.storage && api.storage.local;
}

export async function loadSettings() {
  try {
    const store = storage();
    if (!store) return { ...DEFAULT_SETTINGS };
    const got = await store.get(SETTINGS_KEY);
    const saved = got && got[SETTINGS_KEY];
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_SETTINGS };
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      voiceByEngine: { ...(saved.voiceByEngine || {}) },
    };
  } catch (err) {
    console.warn('[skald] settings load failed:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = {
    ...current,
    ...patch,
    voiceByEngine: {
      ...(patch && patch.voiceByEngine ? patch.voiceByEngine : current.voiceByEngine),
    },
  };
  try {
    const store = storage();
    if (store) await store.set({ [SETTINGS_KEY]: next });
  } catch (err) {
    console.warn('[skald] settings save failed:', err);
  }
  return next;
}

export function saveBarPosition(pos) {
  return saveSettings({ barPos: pos });
}
