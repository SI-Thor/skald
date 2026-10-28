// skald — content-script bootstrap (classic script, runs in the content world).
//
// The actual app is an ES module (src/main.js). Dynamic import of a
// web_accessible_resources URL works in Firefox content scripts and the
// module executes with content-script privileges (browser.*, storage).
// The module is imported once and cached on the window; every subsequent
// injection (repeated Alt+R) just calls its exported start() again.

(() => {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const MODULE_SLOT = '__skaldModulePromise';

  if (!window[MODULE_SLOT]) {
    window[MODULE_SLOT] = import(api.runtime.getURL('src/main.js')).catch(
      (err) => {
        window[MODULE_SLOT] = null;
        console.error('[skald] failed to load src/main.js:', err);
        return null;
      }
    );
  }

  window[MODULE_SLOT].then((mod) => {
    if (mod && typeof mod.start === 'function') {
      Promise.resolve(mod.start()).catch((err) => {
        console.error('[skald] start failed:', err);
      });
    }
  });
})();
