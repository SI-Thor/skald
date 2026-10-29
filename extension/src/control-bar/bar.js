// skald — the in-tab control bar (ADR-0004).
//
// Closed shadow DOM; page CSS cannot reach inside (:host { all: initial }
// blocks host-level styling) and a top z-index keeps it on top. Three rows:
//   1 (always visible): grip ⠿ | ⏮ ▶/⏸ ⏹ ⏭ | 🔈 volume | speed + live
//     readout | ⋯ | ✕
//   2 (⋯ expanded):   Engine dropdown + Voice dropdown
//   3 (⋯ expanded 2): Pitch slider | Save as defaults | 🎭 Lane C show
//     | Detach to window (disabled stub in v0)
// ⋯ cycles 0 → 1 → 2 → 0 rows; the main row never hides.
// Dragging (grip or empty bar area) moves the host with viewport clamping;
// the final position is emitted as a 'position' event (persisted by main.js
// via browser.storage.local — disclosed deviation from localStorage).

'use strict';

import { createSlider } from './sliders.js';

const GLYPH = {
  grip: '⠿',
  prev: '⏮',
  play: '▶',
  pause: '⏸',
  stop: '⏹',
  next: '⏭',
  more: '⋯',
  close: '✕',
};

const ENGINE_OPTIONS = [
  { id: 'system', label: 'System voices' },
  { id: 'daemon', label: 'skald daemon' },
];

// Minimal inline fallback in case bar.css cannot be fetched.
const FALLBACK_CSS = [
  ':host{all:initial;position:fixed;z-index:2147483647;width:max-content;}',
  '.skald-bar{display:flex;flex-direction:column;background:#1b2030;color:#e8ebf2;',
  'border:1px solid #39415a;border-radius:10px;font:12px system-ui,sans-serif;',
  'user-select:none;}',
  '.skald-row{display:flex;align-items:center;gap:6px;padding:5px 8px;}',
  '.skald-row-engine,.skald-row-tuning{display:none;}',
  '.skald-bar[data-expanded="1"] .skald-row-engine{display:flex;}',
  '.skald-bar[data-expanded="2"] .skald-row-engine,',
  '.skald-bar[data-expanded="2"] .skald-row-tuning{display:flex;}',
  '.skald-btn{width:26px;height:26px;border:none;background:transparent;',
  'color:#e8ebf2;cursor:pointer;font-size:13px;}',
  'select{background:#242b3f;color:#e8ebf2;}',
].join('');

export class ControlBar {
  /**
   * @param {object} [opts]
   * @param {{x:number,y:number}|null} [opts.position] persisted bar position
   * @param {(type:string, payload?:any)=>void} [opts.onEvent]
   */
  constructor({ position = null, onEvent = () => {} } = {}) {
    this._onEvent = onEvent;
    this._expanded = 0;
    this._state = {
      playing: false,
      status: 'idle',
      index: 0,
      total: 0,
      rate: 1,
      volume: 1,
      pitch: 1,
      engineId: 'system',
      voices: [],
      voiceId: null,
      daemonAvailable: false,
      error: null,
    };
    this._buildDom(position);
    this._loadCss();
  }

  _emit(type, payload) {
    try {
      this._onEvent(type, payload);
    } catch (err) {
      console.error('[skald] bar event handler failed:', err);
    }
  }

  _label(text, title = '') {
    const el = document.createElement('span');
    el.className = 'skald-label';
    el.textContent = text;
    if (title) el.title = title;
    return el;
  }

  _btn(glyph, title) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'skald-btn';
    el.textContent = glyph;
    el.title = title;
    el.setAttribute('aria-label', title);
    return el;
  }

  _select(ariaLabel) {
    const el = document.createElement('select');
    el.setAttribute('aria-label', ariaLabel);
    return el;
  }

  _row(className) {
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  _buildDom(position) {
    this.host = document.createElement('div');
    this.host.setAttribute('data-skald-bar', '');
    const shadow = this.host.attachShadow({ mode: 'closed' });
    this.shadowRoot = shadow;

    this._styleEl = document.createElement('style');
    this._styleEl.textContent = FALLBACK_CSS;
    shadow.appendChild(this._styleEl);

    this.barEl = document.createElement('div');
    this.barEl.className = 'skald-bar';
    this.barEl.setAttribute('data-expanded', '0');
    this.barEl.setAttribute('role', 'toolbar');
    this.barEl.setAttribute('aria-label', 'skald reader controls');

    // Row 1 — always visible.
    const row1 = this._row('skald-row skald-row-main');
    this._grip = this._btn(GLYPH.grip, 'Drag to move the bar');
    this._grip.classList.add('skald-grip');
    this._grip.removeAttribute('aria-label');

    this._prevBtn = this._btn(GLYPH.prev, 'Previous sentence');
    this._playBtn = this._btn(GLYPH.play, 'Play');
    this._stopBtn = this._btn(GLYPH.stop, 'Stop and close');
    this._nextBtn = this._btn(GLYPH.next, 'Next sentence');

    this._volumeSlider = createSlider({
      min: 0,
      max: 1,
      step: 0.05,
      value: 1,
      width: 72,
      title: 'Volume',
      onInput: (v) => this._emit('volume', v),
    });
    this._rateSlider = createSlider({
      min: 0.5,
      max: 3,
      step: 0.1,
      value: 1,
      width: 110,
      readout: true,
      format: (v) => `${v.toFixed(1)}x`,
      title: 'Speed (0.5x – 3.0x)',
      onInput: (v) => this._emit('rate', v),
    });

    this._moreBtn = this._btn(GLYPH.more, 'More controls (engine, voice, pitch)');
    this._closeBtn = this._btn(GLYPH.close, 'Stop and close');

    row1.append(
      this._grip,
      this._prevBtn,
      this._playBtn,
      this._stopBtn,
      this._nextBtn,
      this._label('🔈', 'Volume'),
      this._volumeSlider.el,
      this._rateSlider.el,
      this._moreBtn,
      this._closeBtn
    );

    // Row 2 — engine + voice.
    const row2 = this._row('skald-row skald-row-engine');
    this._engineSelect = this._select('Speech engine');
    this._voiceSelect = this._select('Voice');
    row2.append(
      this._label('Engine'),
      this._engineSelect,
      this._label('Voice'),
      this._voiceSelect
    );

    // Row 3 — pitch, save defaults, Lane C show, detach stub.
    const row3 = this._row('skald-row skald-row-tuning');
    this._pitchSlider = createSlider({
      min: 0.5,
      max: 2,
      step: 0.05,
      value: 1,
      width: 90,
      readout: true,
      format: (v) => v.toFixed(2),
      title: 'Pitch',
      onInput: (v) => this._emit('pitch', v),
    });
    this._saveBtn = this._btn('Save as defaults', 'Save engine, voice, speed, volume and pitch');
    this._saveBtn.classList.add('skald-btn-text');
    this._laneBtn = this._btn('🎭', 'Lane C show');
    this._laneBtn.classList.add('skald-btn-text');
    this._detachBtn = this._btn('Detach to window', 'Detach to window (not implemented in v0)');
    this._detachBtn.classList.add('skald-btn-text');
    this._detachBtn.disabled = true;
    row3.append(
      this._label('Pitch'),
      this._pitchSlider.el,
      this._saveBtn,
      this._laneBtn,
      this._detachBtn
    );

    this.barEl.append(row1, row2, row3);
    shadow.appendChild(this.barEl);

    (document.body || document.documentElement).appendChild(this.host);

    this._wireEvents();
    this._applyPosition(position);
    this._rebuildEngineOptions();
    this._rebuildVoiceOptions();
    this.setState({});
  }

  _wireEvents() {
    this._prevBtn.addEventListener('click', () => this._emit('prev'));
    this._playBtn.addEventListener('click', () => this._emit('toggle'));
    this._stopBtn.addEventListener('click', () => this._emit('stop'));
    this._nextBtn.addEventListener('click', () => this._emit('next'));
    this._closeBtn.addEventListener('click', () => this._emit('close'));

    this._moreBtn.addEventListener('click', () => {
      // ⋯ cycles: main row → +engine/voice → +pitch row → collapse.
      this._expanded = (this._expanded + 1) % 3;
      this.barEl.setAttribute('data-expanded', String(this._expanded));
    });

    this._engineSelect.addEventListener('change', () => {
      this._emit('engine', this._engineSelect.value);
    });
    this._voiceSelect.addEventListener('change', () => {
      this._emit('voice', this._voiceSelect.value);
    });

    this._saveBtn.addEventListener('click', () => {
      this._emit('save-defaults');
      this._flashSaved();
    });

    this._laneBtn.addEventListener('click', () => this._emit('open-lane'));

    this.barEl.addEventListener('pointerdown', (e) => this._onPointerDown(e));
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    const grip = target.closest('.skald-grip');
    // Drag from the grip or from empty bar chrome; never from controls.
    if (!grip && target.closest('button, input, select, option, label, .skald-slider')) {
      return;
    }
    e.preventDefault();
    const rect = this.host.getBoundingClientRect();
    const originX = e.clientX;
    const originY = e.clientY;
    const baseX = rect.left;
    const baseY = rect.top;

    const clampX = (x) => {
      const w = this.host.getBoundingClientRect().width || 320;
      return Math.min(Math.max(4, x), Math.max(4, window.innerWidth - w - 4));
    };
    const clampY = (y) => {
      const h = this.host.getBoundingClientRect().height || 44;
      return Math.min(Math.max(4, y), Math.max(4, window.innerHeight - h - 4));
    };

    const move = (ev) => {
      this.host.style.left = `${clampX(baseX + ev.clientX - originX)}px`;
      this.host.style.top = `${clampY(baseY + ev.clientY - originY)}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this._emit('position', {
        x: parseFloat(this.host.style.left) || 0,
        y: parseFloat(this.host.style.top) || 0,
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _applyPosition(position) {
    const place = () => {
      const rect = this.host.getBoundingClientRect();
      const w = rect.width || 340;
      const h = rect.height || 44;
      let x =
        position && Number.isFinite(position.x) ? position.x : window.innerWidth - w - 16;
      let y = position && Number.isFinite(position.y) ? position.y : 16;
      x = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - w - 4));
      y = Math.min(Math.max(4, y), Math.max(4, window.innerHeight - h - 4));
      this.host.style.left = `${x}px`;
      this.host.style.top = `${y}px`;
    };
    if (this.host.isConnected) requestAnimationFrame(place);
    else place();
  }

  async _loadCss() {
    try {
      const api = typeof browser !== 'undefined' ? browser : chrome;
      const url = api.runtime.getURL('src/control-bar/bar.css');
      const res = await fetch(url);
      if (res.ok) this._styleEl.textContent = await res.text();
    } catch (err) {
      console.warn('[skald] bar.css fetch failed, using fallback:', err);
    }
  }

  _rebuildEngineOptions() {
    const s = this._state;
    this._engineSelect.textContent = '';
    for (const opt of ENGINE_OPTIONS) {
      const el = document.createElement('option');
      el.value = opt.id;
      let label = opt.label;
      let disabled = false;
      if (opt.id === 'daemon' && !s.daemonAvailable) {
        label = `${opt.label} (unreachable)`;
        disabled = true;
      }
      el.textContent = label;
      if (disabled) {
        el.disabled = true;
        if (s.engineId !== 'daemon') el.selected = false;
      }
      this._engineSelect.appendChild(el);
    }
    // Never leave the select on a disabled option (daemon down while
    // selected): show it but keep it non-actionable by re-selecting system.
    if (s.engineId === 'daemon' && !s.daemonAvailable) {
      const daemonOption = this._engineSelect.querySelector('option[value="daemon"]');
      if (daemonOption) daemonOption.disabled = false; // visible, still marked unreachable
    }
    this._engineSelect.value = s.engineId || 'system';
  }

  _rebuildVoiceOptions() {
    const s = this._state;
    this._voiceSelect.textContent = '';
    if (!s.voices.length) {
      const el = document.createElement('option');
      el.value = '';
      el.textContent = 'No voices';
      el.disabled = true;
      el.selected = true;
      this._voiceSelect.appendChild(el);
      this._voiceSelect.value = '';
      return;
    }
    for (const v of s.voices) {
      const el = document.createElement('option');
      el.value = v.id;
      const name = v.name.length > 42 ? `${v.name.slice(0, 41)}…` : v.name;
      el.textContent = v.tier ? `${name} · ${v.tier}` : name;
      this._voiceSelect.appendChild(el);
    }
    const has = s.voices.some((v) => v.id === s.voiceId);
    this._voiceSelect.value = has ? s.voiceId : s.voices[0].id;
  }

  _flashSaved() {
    const original = 'Save as defaults';
    this._saveBtn.textContent = 'Saved ✓';
    this._saveBtn.classList.add('skald-saved-flash');
    setTimeout(() => {
      if (!this.host.isConnected) return;
      this._saveBtn.textContent = original;
      this._saveBtn.classList.remove('skald-saved-flash');
    }, 900);
  }

  /**
   * Push state into the bar. Recognized keys: playing, status, index, total,
   * rate, volume, pitch, engineId, voices, voiceId, daemonAvailable, error.
   */
  setState(patch = {}) {
    Object.assign(this._state, patch);
    const s = this._state;

    this._playBtn.textContent = s.playing ? GLYPH.pause : GLYPH.play;
    const nothing = !s.total;
    this._playBtn.disabled = nothing;
    this._prevBtn.disabled = nothing;
    this._nextBtn.disabled = nothing;
    this._playBtn.title = nothing
      ? 'Nothing to read on this page'
      : s.playing
        ? `Pause — sentence ${Math.min(s.index, s.total)}/${s.total}`
        : `Play — sentence ${Math.min(s.index, s.total)}/${s.total}`;

    this._rateSlider.set(s.rate);
    this._volumeSlider.set(s.volume);
    this._pitchSlider.set(s.pitch);

    if ('daemonAvailable' in patch || 'engineId' in patch) {
      this._rebuildEngineOptions();
    } else {
      this._engineSelect.value = s.engineId || 'system';
    }
    if ('voices' in patch || 'voiceId' in patch) {
      this._rebuildVoiceOptions();
    } else if (s.voices.length && s.voiceId != null) {
      const has = s.voices.some((v) => v.id === s.voiceId);
      this._voiceSelect.value = has ? s.voiceId : this._voiceSelect.value;
    }

    if (s.error) this.barEl.title = `skald: ${s.error}`;
    else this.barEl.removeAttribute('title');
  }

  remove() {
    if (this.host.parentNode) this.host.parentNode.removeChild(this.host);
  }
}
