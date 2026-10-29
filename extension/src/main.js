// skald — app wiring (ES module, loaded by content/loader.js).
//
// Owns the full flow: extract page text (selection or article) → segment
// into sentences → drive the Player engine cursor → render the ControlBar →
// highlight the current sentence via the CSS Custom Highlight API and
// scroll-into-view. Also mediates settings persistence (store.js) and the
// system/daemon engine choice, including daemon reachability fallback.

'use strict';

import { extract, rangeFor } from './extraction.js';
import { segment } from './segmenter.js';
import { Player } from './player.js';
import * as store from './store.js';
import { SystemEngine } from './engines/system-engine.js';
import { DaemonEngine } from './engines/daemon-engine.js';
import { ControlBar } from './control-bar/bar.js';

const HIGHLIGHT_NAME = 'skald-sentence';
const DAEMON_PROBE_TIMEOUT_MS = 1500;

const api = typeof browser !== 'undefined' ? browser : chrome;

let currentApp = null;
let creating = null;

// Lane C (lane.html) pulls the article this tab already extracts for
// reading ('skald:get-article', ADR-0009 layer 3). Registered at module
// scope: loader.js caches this module on the window, so repeated Alt+R
// injections never stack listeners. Same selection-or-article policy as
// reading: a live selection wins over the extracted article.
if (api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'skald:get-article') return undefined;
    try {
      const { text, source, title } = extract(window);
      return Promise.resolve({
        type: 'skald:get-article',
        ok: Boolean(text && String(text).trim().length >= 3),
        text: String(text || ''),
        source: source || 'article',
        title: title || document.title || '',
      });
    } catch (err) {
      return Promise.resolve({
        type: 'skald:get-article',
        ok: false,
        error: String((err && err.message) || err),
      });
    }
  });
}

/**
 * Entry point called from content/loader.js on every Alt+R / toolbar click.
 * First call: build the bar and start reading (selection if present, else
 * article top). Subsequent calls toggle play/pause.
 */
export async function start() {
  if (currentApp && !currentApp.closed) {
    currentApp.onCommand();
    return;
  }
  if (creating) {
    const app = await creating;
    if (app) app.onCommand();
    return;
  }
  creating = App.create()
    .then((app) => {
      currentApp = app;
      creating = null;
      return app;
    })
    .catch((err) => {
      creating = null;
      console.error('[skald] failed to start:', err);
      return null;
    });
  const app = await creating;
  if (app) app.onCommand();
}

class App {
  static async create() {
    const settings = await store.loadSettings();
    const { text, map, source } = extract(window);
    const sentences = segment(text);
    const app = new App({ settings, sentences, map, source });
    await app._init();
    return app;
  }

  constructor({ settings, sentences, map, source }) {
    this.settings = settings;
    this.sentences = sentences;
    this.map = map;
    this.source = source;
    this.closed = false;
    this.engineId = 'system';
    this.voiceId = null;
    this.engines = {};
    this.player = null;
    this.bar = null;
  }

  async _init() {
    this.engines = {
      system: new SystemEngine(),
      daemon: new DaemonEngine(),
    };
    await this.engines.system.init(); // cheap; always succeeds

    this.bar = new ControlBar({
      position: this.settings.barPos,
      onEvent: (type, payload) => this._onBarEvent(type, payload),
    });

    this.player = new Player({
      engine: this.engines.system,
      sentences: this.sentences,
      onChange: (state) => this._syncState(state),
      onSentence: (i, s) => this._highlight(i, s),
    });

    // Resolve the initial engine. If the saved engine is the daemon, wait
    // (bounded) for the probe and fall back to system voices when down.
    let engineId = this.settings.engine === 'daemon' ? 'daemon' : 'system';
    if (engineId === 'daemon') {
      const ok = await this._probeDaemon(DAEMON_PROBE_TIMEOUT_MS);
      if (!ok) engineId = 'system';
    } else {
      this._probeDaemon(0); // probe in background; bar updates when done
    }

    await this._setEngine(engineId);
    this.player.setParams({
      rate: this.settings.rate,
      volume: this.settings.volume,
      pitch: this.settings.pitch,
    });
    this._syncState(this.player.state);
    // No auto-play here: start() calls onCommand() after creation, which
    // plays the first sentence (reading starts on the user's click/Alt+R).
  }

  _probeDaemon(timeoutMs = 0) {
    const engine = this.engines.daemon;
    let probe = engine.init().then((ok) => {
      if (this.closed) return ok;
      this.bar.setState({ daemonAvailable: engine.available });
      if (!ok && this.engineId === 'daemon') {
        // Daemon died under us mid-session: fall back to system voices.
        this._setEngine('system');
      } else if (ok && this.engineId === 'daemon') {
        this._refreshVoices();
      }
      return ok;
    });
    if (timeoutMs > 0) {
      probe = Promise.race([
        probe,
        new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    }
    return probe;
  }

  async _setEngine(id) {
    const engine = this.engines[id];
    if (!engine) return;
    this.engineId = id;
    this.player.setEngine(engine);
    this.bar.setState({ engineId: id });
    await this._refreshVoices();
  }

  async _refreshVoices() {
    const engine = this.engines[this.engineId];
    if (!engine) return;
    const voices = await engine.listVoices();
    let voiceId = this.settings.voiceByEngine[this.engineId] || null;
    if (!voices.some((v) => v.id === voiceId)) {
      voiceId = voices.length ? voices[0].id : null;
    }
    this.voiceId = voiceId;
    this.player.setParams({ voiceId });
    this.bar.setState({ voices, voiceId });
  }

  _syncState(state) {
    if (this.closed || !this.bar) return;
    this.bar.setState({
      playing: state.status === 'playing',
      status: state.status,
      index: state.index + 1,
      total: state.total,
      error: state.error,
    });
  }

  _highlight(index, sentence) {
    if (typeof Highlight === 'undefined' || !('highlights' in (CSS || {}))) return;
    try {
      const range = this.map ? rangeFor(this.map, sentence.start, sentence.end) : null;
      if (range) {
        CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
        const rect = range.getBoundingClientRect();
        if (rect && (rect.top < 80 || rect.bottom > window.innerHeight - 120)) {
          const el =
            range.startContainer.nodeType === Node.ELEMENT_NODE
              ? range.startContainer
              : range.startContainer.parentElement;
          if (el && el.scrollIntoView) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      } else {
        CSS.highlights.delete(HIGHLIGHT_NAME);
      }
    } catch (err) {
      // highlighting is best-effort; never break playback over it
    }
  }

  _clearHighlight() {
    try {
      if ('highlights' in (CSS || {})) CSS.highlights.delete(HIGHLIGHT_NAME);
    } catch {
      /* ignore */
    }
  }

  /** Alt+R pressed again: toggle play/pause. */
  onCommand() {
    if (this.closed) return;
    this.player.toggle();
  }

  _close() {
    if (this.closed) return;
    this.closed = true;
    this.player.dispose();
    this._clearHighlight();
    this.bar.remove();
    if (currentApp === this) currentApp = null;
  }

  async _onBarEvent(type, payload) {
    switch (type) {
      case 'toggle':
        this.player.toggle();
        break;
      case 'prev':
        this.player.prev();
        break;
      case 'next':
        this.player.next();
        break;
      // v0 deviation (disclosed): ⏹ and ✕ both stop playback AND close the bar.
      case 'stop':
      case 'close':
        this._close();
        break;
      case 'rate':
        this.player.setParams({ rate: payload });
        break;
      case 'volume':
        this.player.setParams({ volume: payload });
        break;
      case 'pitch':
        this.player.setParams({ pitch: payload });
        break;
      case 'engine':
        if (payload === 'daemon' && !this.engines.daemon.available) {
          await this._probeDaemon(DAEMON_PROBE_TIMEOUT_MS);
        }
        if (payload === 'daemon' && !this.engines.daemon.available) break;
        await this._setEngine(payload);
        break;
      case 'voice':
        this.voiceId = payload;
        this.player.setParams({ voiceId: payload });
        break;
      case 'save-defaults':
        await store.saveSettings({
          engine: this.engineId,
          voiceByEngine: {
            ...this.settings.voiceByEngine,
            [this.engineId]: this.voiceId,
          },
          rate: this.player.opts.rate,
          volume: this.player.opts.volume,
          pitch: this.player.opts.pitch,
        });
        break;
      case 'position':
        this.settings = await store.saveBarPosition(payload);
        break;
      case 'open-lane':
        // Content scripts cannot call tabs.create; background does it.
        api.runtime.sendMessage({ type: 'skald:open-lane' }).catch(() => {});
        break;
      default:
        break;
    }
  }
}
