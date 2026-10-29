// skald — Lane C live-show page (ADR-0009 layer 3, "surfaces").
//
// lane.html is a plain extension PAGE (not a sidebar) opened in a tab or a
// split view from the control bar's 🎭 button — one code path for Firefox,
// Chrome and anything else that speaks MV3. The real sidebar upgrade
// (sidebar_action / chrome.sidePanel) is a later layer; see README.
//
// Traffic split:
//   - REST (create show, status poll, interject, dial, delete) rides the
//     existing background fetch proxy — 'skald:daemon-fetch' already takes a
//     baseUrl (same pattern as src/engines/daemon-engine.js).
//   - The WebSocket CANNOT ride that proxy (fetch-only), so lane.html opens
//     it directly. That is safe here because extension pages are
//     chrome-privileged origins and are NOT subject to the page-CORS rules
//     that force content scripts through the proxy. Scheme mapping:
//     http→ws, https→wss (README has the origin note).
//
// The page mirrors the lane-c-sim semantics (ADR-0009): heard turns are the
// said-aloud ledger; pending turns render dimmed "(planned)"; the interrupt
// dial is cut_now / wrap_thought / let_finish; the producer box speaks with
// repl.py shorthand (@Name routes to one character, plain text asks the
// room).
//
// Everything that touches a MESSAGE SHAPE (bubble mapping, dial list,
// WS/REST dispatch, URL building, interjection parsing) is a pure exported
// function so node can test this module directly — the DOM layer below only
// renders those view models. Module top level has zero side effects.

'use strict';

import { loadSettings } from './src/store.js';

// Cross-browser API handle; null under node (pure-logic tests import this
// module, so the lookup must stay lazy and side-effect free).
function extApi() {
  return (
    (typeof browser !== 'undefined' && browser) ||
    (typeof chrome !== 'undefined' && chrome) ||
    null
  );
}

// Reference cast from experiments/lane-c-sim/simulate.py. Voice slots are
// fixed Magpie speakers today; personas must not change when a slot's
// resolution does (docs/features/voice-slot-indirection.md).
const CAST_PRESETS = Object.freeze({
  'mia-jason': Object.freeze({
    label: 'Mia & Jason',
    cast: Object.freeze([
      Object.freeze({
        name: 'Mia',
        persona: 'Analytical, skeptical of hype, loves methodology details.',
        voice_slot: 'riva:mia',
      }),
      Object.freeze({
        name: 'Jason',
        persona: 'Energetic connector, jumps to practical takeaways.',
        voice_slot: 'riva:jason',
      }),
    ]),
  }),
});

// The interrupt dial, verbatim from the sim/ADR-0009: cut_now discards the
// prefetch buffer immediately; wrap_thought lets exactly the current turn
// complete; let_finish queues.
export const DIALS = Object.freeze([
  Object.freeze({ id: 'cut_now', label: 'Cut now', hint: 'Fade the current turn now and interject immediately' }),
  Object.freeze({ id: 'wrap_thought', label: 'Wrap thought', hint: 'Let the speaker land the current point, then pivot' }),
  Object.freeze({ id: 'let_finish', label: 'Let finish', hint: 'Let the turn finish, then deliver the interjection' }),
]);

const SESSION_KEY = 'skald.lane.showId';
const POLL_MS = 5000;
const RECONNECT_MS = 3000;

// --- pure logic (exported for node tests) -----------------------------------

const SPEAKER_COLORS = Object.freeze({
  mia: '#f5a623',
  jason: '#6fb3f2',
  producer: '#7bc96f',
});
const FALLBACK_COLORS = Object.freeze(['#c792ea', '#89ddff', '#e0af68', '#a9b7c6', '#f28779']);

/** Deterministic color per speaker; known cast pinned, others hashed. */
export function speakerColor(name) {
  const key = String(name == null ? '' : name).trim().toLowerCase();
  if (SPEAKER_COLORS[key]) return SPEAKER_COLORS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
}

/** WS/REST turn {speaker,text,seq} → bubble view model; null if unusable. */
export function turnToBubble(turn, kind = 'heard') {
  if (!turn || typeof turn !== 'object') return null;
  const speaker = String(turn.speaker == null ? '' : turn.speaker).trim() || 'PRODUCER';
  // Careful: Number(null) === 0, and null seq is meaningful (local producer
  // echo) — only coerce genuinely present, numeric seq values.
  let seq = null;
  if (turn.seq != null && turn.seq !== '') {
    const n = Number(turn.seq);
    if (Number.isFinite(n)) seq = n;
  }
  return {
    speaker,
    text: String(turn.text == null ? '' : turn.text).trim(),
    seq,
    kind: kind === 'pending' ? 'pending' : 'heard',
    color: speakerColor(speaker),
  };
}

function normalizeTurns(list, kind) {
  if (!Array.isArray(list)) return [];
  return list.map((t) => turnToBubble(t, kind)).filter(Boolean);
}

/** Fresh show state (the said-aloud ledger + steering status). */
export function initialShowState() {
  return { heard: [], pending: [], discardedCount: 0, llmCalls: null, statusText: '', dial: null };
}

export function isDialId(id) {
  return DIALS.some((d) => d.id === id);
}

/**
 * Pure reducer for every message shape the show can deliver:
 *   WS  {type:'snapshot', heard, pending}      — server truth, authoritative
 *   WS  {type:'turn_heard', turn}              — said-aloud ledger append
 *   WS  {type:'status', ...}                   — free-form steering status
 *   WS/REST {type:'dial', dial}                — interrupt dial position
 *   REST {type:'snapshot', ...} (via restStatusToEvent)
 * Returns a NEW state; never mutates the input. Heard turns dedupe by seq.
 */
export function reduceShowState(state, event) {
  const next = { ...state, heard: state.heard, pending: state.pending };
  switch (event && event.type) {
    case 'snapshot': {
      next.heard = normalizeTurns(event.heard, 'heard');
      next.pending = normalizeTurns(event.pending, 'pending');
      if (event.discarded_count != null) next.discardedCount = Number(event.discarded_count) || 0;
      const llm = metricsToLlmCalls(event.metrics);
      if (llm != null) next.llmCalls = llm;
      if (isDialId(event.dial)) next.dial = event.dial;
      break;
    }
    case 'turn_heard': {
      const turn = turnToBubble(event.turn, 'heard');
      if (!turn) break;
      const idx = turn.seq != null ? next.heard.findIndex((t) => t.seq === turn.seq) : -1;
      if (idx >= 0) {
        const heard = next.heard.slice();
        heard[idx] = turn;
        next.heard = heard;
      } else {
        next.heard = next.heard.concat(turn);
      }
      // Once heard, a turn is no longer planned.
      next.pending = next.pending.filter((p) => turn.seq == null || p.seq !== turn.seq);
      break;
    }
    case 'status': {
      next.statusText = statusTextOf(event);
      const llm = metricsToLlmCalls(event.metrics);
      if (llm != null) next.llmCalls = llm;
      break;
    }
    case 'dial': {
      if (isDialId(event.dial)) next.dial = event.dial;
      break;
    }
    default:
      break;
  }
  return next;
}

/** GET /v1/shows/{id} body → the WS 'snapshot' event shape (one reducer). */
export function restStatusToEvent(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    type: 'snapshot',
    heard: b.heard_turns,
    pending: b.pending,
    discarded_count: b.discarded_count,
    metrics: b.metrics,
    dial: b.dial,
  };
}

/** POST /v1/shows body → show id, tolerating contract-adjacent spellings. */
export function showIdFromCreate(body) {
  if (!body || typeof body !== 'object') return null;
  const id = body.show_id != null ? body.show_id : body.showId != null ? body.showId : body.id;
  const s = id == null ? '' : String(id);
  return s ? s : null;
}

/** Tolerant read of the llm-call counter out of an unspecified metrics blob. */
export function metricsToLlmCalls(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  for (const key of ['llm_calls', 'llmCalls', 'llm_calls_total', 'llmCallsTotal']) {
    const v = metrics[key];
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Free-form {type:'status'} → one display line. */
export function statusTextOf(event) {
  if (typeof event.text === 'string' && event.text.trim()) return event.text.trim();
  const rest = { ...event };
  delete rest.type;
  if (!Object.keys(rest).length) return '';
  try {
    return JSON.stringify(rest);
  } catch {
    return 'status update';
  }
}

/** Status strip line: ledger counts + (when known) llm calls. */
export function formatStatus({ heard, pending, discarded, llmCalls }) {
  const parts = [`heard ${heard}`, `planned ${pending}`, `discarded ${discarded}`];
  if (llmCalls != null) parts.push(`llm calls ${llmCalls}`);
  return parts.join(' · ');
}

/** Settings serverUrl → usable http(s) base (bare host gets http://). */
export function httpBaseUrl(serverUrl) {
  const s = String(serverUrl == null ? '' : serverUrl).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(s)) return s;
  return s ? `http://${s}` : 'http://localhost:8000';
}

/** ws(s):// URL of the show stream: http→ws, https→wss. */
export function wsUrlFor(serverUrl, showId) {
  const wsBase = httpBaseUrl(serverUrl).replace(/^http/i, 'ws');
  return `${wsBase}/v1/shows/${encodeURIComponent(String(showId))}/ws`;
}

/**
 * Resolve the stream URL: prefer the daemon's own ws_url (absolute ws(s)/
 * http(s) or a root-relative path), fall back to constructing it from the
 * configured server URL + show id.
 */
export function resolveWsUrl(rawWsUrl, serverUrl, showId) {
  const s = String(rawWsUrl == null ? '' : rawWsUrl).trim();
  if (/^wss?:\/\//i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s.replace(/^http/i, 'ws');
  if (s.startsWith('/')) {
    const origin = httpBaseUrl(serverUrl).match(/^https?:\/\/[^/]+/i);
    return `${(origin ? origin[0] : '').replace(/^http/i, 'ws')}${s}`;
  }
  return wsUrlFor(serverUrl, showId);
}

/**
 * Producer input → interject payload, with the repl.py shorthand:
 * "@Mia what about the data?" addresses one character; plain text asks
 * the room.
 */
export function parseInterjection(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const m = text.match(/^@([\w.-]+)\s+([\s\S]+)$/);
  if (m) return { text: m[2].trim(), address: m[1] };
  return { text };
}

// --- REST via the background proxy -------------------------------------------

async function daemonFetch({ baseUrl, path, method = 'GET', body = null }) {
  const api = extApi();
  const msg = { type: 'skald:daemon-fetch', baseUrl, path, method, headers: {} };
  if (body != null) {
    msg.headers['content-type'] = 'application/json';
    msg.bodyText = JSON.stringify(body);
  }
  let res;
  try {
    res = await api.runtime.sendMessage(msg);
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  }
  return res || { ok: false, status: 0, error: 'no response from background' };
}

// --- page wiring (DOM lives only below this line) ----------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

class LaneApp {
  constructor(doc = document) {
    this.settings = { serverUrl: 'http://localhost:8000' };
    this.showId = null;
    this.ws = null;
    this.wsUrl = null;
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.state = initialShowState();

    this._connEl = doc.getElementById('conn');
    this._endBtn = doc.getElementById('end');
    this._castSel = doc.getElementById('cast');
    this._llmSel = doc.getElementById('llm');
    this._startBtn = doc.getElementById('start');
    this._hintEl = doc.getElementById('hint');
    this._errorEl = doc.getElementById('error');
    this._transcriptEl = doc.getElementById('transcript');
    this._dialEl = doc.getElementById('dial');
    this._formEl = doc.getElementById('interject-form');
    this._inputEl = doc.getElementById('interject');
    this._statusEl = doc.getElementById('status');
  }

  async init() {
    for (const [id, preset] of Object.entries(CAST_PRESETS)) {
      const opt = el('option', null, preset.label);
      opt.value = id;
      this._castSel.appendChild(opt);
    }
    for (const d of DIALS) {
      const btn = el('button', null, d.label);
      btn.type = 'button';
      btn.dataset.dial = d.id;
      btn.title = d.hint;
      btn.setAttribute('aria-pressed', 'false');
      this._dialEl.appendChild(btn);
    }
    this._dialEl.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-dial]') : null;
      if (btn) this._onDial(btn.dataset.dial);
    });
    this._startBtn.addEventListener('click', () => this._startShow());
    this._endBtn.addEventListener('click', () => this._onEndClick());
    this._formEl.addEventListener('submit', (e) => this._onInterject(e));

    try {
      this.settings = await loadSettings();
    } catch (err) {
      console.warn('[skald] lane settings load failed:', err);
    }
    this._hintEl.textContent = `server: ${this.settings.serverUrl}`;
    this._setConn('idle');
    this._renderAll();
    await this._reattachOrIdle();
  }

  // -- session lifecycle ------------------------------------------------------

  async _startShow() {
    this._setError('');
    this._setConn('connecting');
    this._startBtn.disabled = true;
    try {
      const article = await this._getActiveArticle();
      const preset = CAST_PRESETS[this._castSel.value] || Object.values(CAST_PRESETS)[0];
      const body = {
        article: article.text,
        cast: preset.cast.map((c) => ({ ...c })),
        llm: this._llmSel.value === 'openai' ? 'openai' : 'scripted',
      };
      const created = await this._daemonJson('/v1/shows', 'POST', body);
      const showId = showIdFromCreate(created);
      if (!showId) throw new Error('daemon returned no show_id (contract mismatch)');
      this.showId = showId;
      this._rememberSession(showId);
      this.state = initialShowState();
      this.wsUrl = resolveWsUrl(created && created.ws_url, this.settings.serverUrl, showId);
      this._renderAll();
      this._startPolling();
      this._connectWs(this.wsUrl);
      this._endBtn.hidden = false;
      this._startBtn.hidden = true;
      const title = article.title ? ` — ${article.title}` : '';
      this._hintEl.textContent = `on air · show ${showId} · source: ${article.source}${title}`;
    } catch (err) {
      this._setConn('idle');
      this._startBtn.disabled = false;
      this._setError(String((err && err.message) || err));
    }
  }

  async _onEndClick() {
    const id = this.showId;
    if (id) {
      try {
        await this._daemonJson(`/v1/shows/${encodeURIComponent(id)}`, 'DELETE');
      } catch (err) {
        console.warn('[skald] DELETE show failed:', (err && err.message) || err);
      }
    }
    this._endShow('');
  }

  _endShow(note) {
    this.showId = null; // first: onclose must not schedule a reconnect
    this._forgetSession();
    this._stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.state = initialShowState();
    this._renderAll();
    this._setConn('idle');
    this._endBtn.hidden = true;
    this._startBtn.hidden = false;
    this._startBtn.disabled = false;
    if (note) this._hintEl.textContent = note;
  }

  /** Reload-friendly: reattach to the show this tab already started. */
  async _reattachOrIdle() {
    let id = null;
    try {
      id = sessionStorage.getItem(SESSION_KEY);
    } catch {
      /* storage can be unavailable; session-less is fine */
    }
    if (!id) return;
    try {
      const body = await this._daemonJson(`/v1/shows/${encodeURIComponent(id)}`, 'GET');
      this.showId = id;
      this.wsUrl = wsUrlFor(this.settings.serverUrl, id);
      this._applyEvent(restStatusToEvent(body));
      this._startPolling();
      this._connectWs(this.wsUrl);
      this._endBtn.hidden = false;
      this._startBtn.hidden = true;
      this._hintEl.textContent = `reattached · show ${id}`;
    } catch (err) {
      console.warn('[skald] lane reattach failed:', (err && err.message) || err);
      this._forgetSession();
    }
  }

  _rememberSession(id) {
    try {
      sessionStorage.setItem(SESSION_KEY, id);
    } catch {
      /* ignore */
    }
  }

  _forgetSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  // -- article from the active tab ----------------------------------------------

  /**
   * Ask the in-page skald app (src/main.js, 'skald:get-article') for the
   * article it already extracts for reading. Tries the active tab first,
   * then the rest of the window — only tabs with the content script answer,
   * so the lane tab itself (and every non-skald page) rejects harmlessly.
   */
  async _getActiveArticle() {
    const api = extApi();
    const tabs = await api.tabs.query({ currentWindow: true });
    const ordered = tabs
      .filter((t) => typeof t.id === 'number' && !t.discarded)
      .sort((a, b) => (b.active === a.active ? a.index - b.index : b.active ? 1 : -1))
      .slice(0, 10);
    for (const tab of ordered) {
      try {
        const res = await Promise.race([
          api.tabs.sendMessage(tab.id, { type: 'skald:get-article' }),
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout')), 1500);
            if (timer.unref) timer.unref();
          }),
        ]);
        if (res && res.ok && res.text && String(res.text).trim().length >= 3) {
          return {
            text: String(res.text),
            source: res.source || 'article',
            title: res.title || '',
          };
        }
      } catch {
        /* no receiver in this tab — try the next one */
      }
    }
    throw new Error(
      'No article found — open the article tab and press Alt+R once (loads the in-page skald script), then start the show.'
    );
  }

  // -- REST -----------------------------------------------------------------

  async _daemonJson(path, method = 'GET', body = null) {
    const res = await daemonFetch({ baseUrl: this.settings.serverUrl, path, method, body });
    if (!res.ok) {
      const err = new Error(`${method} ${path} failed: ${res.error || `HTTP ${res.status || '???'}`}`);
      err.status = res.status || 0;
      throw err;
    }
    if (!res.bodyText) return null;
    try {
      return JSON.parse(res.bodyText);
    } catch {
      const err = new Error(`${method} ${path}: non-JSON body from daemon`);
      err.status = res.status || 0;
      throw err;
    }
  }

  async _onInterject(e) {
    e.preventDefault();
    const parsed = parseInterjection(this._inputEl.value);
    if (!parsed.text) return;
    if (!this.showId) {
      this._setError('No show running — start one first.');
      return;
    }
    this._inputEl.disabled = true;
    try {
      await this._daemonJson(`/v1/shows/${encodeURIComponent(this.showId)}/interject`, 'POST', parsed);
      this._inputEl.value = '';
      this._setError('');
      // Immediate feedback: the producer is a character too. The next server
      // snapshot re-reconciles the ledger either way.
      this._applyEvent({ type: 'turn_heard', turn: { speaker: 'PRODUCER', text: parsed.text, seq: null } });
    } catch (err) {
      this._setError(String((err && err.message) || err));
    } finally {
      this._inputEl.disabled = false;
      this._inputEl.focus();
    }
  }

  async _onDial(id) {
    if (!this.showId || !isDialId(id)) return;
    const prev = this.state.dial;
    this._applyEvent({ type: 'dial', dial: id }); // optimistic
    try {
      await this._daemonJson(`/v1/shows/${encodeURIComponent(this.showId)}/dial`, 'POST', { dial: id });
      this._setError('');
    } catch (err) {
      this._applyEvent({ type: 'dial', dial: prev });
      this._setError(`dial failed: ${(err && err.message) || err}`);
    }
  }

  // -- status poll ------------------------------------------------------------

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this._pollOnce(), POLL_MS);
    this._pollOnce();
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async _pollOnce() {
    if (!this.showId) return;
    try {
      const body = await this._daemonJson(`/v1/shows/${encodeURIComponent(this.showId)}`, 'GET');
      this._applyEvent(restStatusToEvent(body));
      this._setError('');
    } catch (err) {
      if (err && err.status === 404) {
        this._endShow(`show ended server-side (404)`);
        return;
      }
      console.warn('[skald] status poll failed:', (err && err.message) || err);
    }
  }

  // -- WebSocket ----------------------------------------------------------------

  _connectWs(url) {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.warn('[skald] lane WebSocket refused:', err);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) this._setConn('live');
    };
    ws.onmessage = (e) => this._onWsMessage(e);
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded or ended
      this.ws = null;
      if (!this.showId) return;
      this._setConn('reconnecting');
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.showId && !this.ws) this._connectWs(url);
        }, RECONNECT_MS);
      }
    };
  }

  _onWsMessage(e) {
    let msg;
    try {
      msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
    } catch {
      console.warn('[skald] lane WS: non-JSON frame ignored');
      return;
    }
    if (msg && typeof msg === 'object') this._applyEvent(msg);
  }

  // -- rendering -----------------------------------------------------------------

  _applyEvent(event) {
    this.state = reduceShowState(this.state, event);
    this._renderEvent(event);
  }

  _renderEvent(event) {
    const type = event && event.type;
    if (type === 'snapshot') {
      this._renderTranscript();
      this._renderStatus();
      this._renderDial();
    } else if (type === 'turn_heard') {
      this._renderTurnHeard();
      this._renderStatus();
    } else if (type === 'status') {
      this._renderStatus();
    } else if (type === 'dial') {
      this._renderDial();
    }
  }

  _renderAll() {
    this._renderTranscript();
    this._renderStatus();
    this._renderDial();
  }

  _renderStatus() {
    const s = this.state;
    let line = formatStatus({
      heard: s.heard.length,
      pending: s.pending.length,
      discarded: s.discardedCount,
      llmCalls: s.llmCalls,
    });
    if (s.statusText) line += ` — ${s.statusText}`;
    this._statusEl.textContent = line;
  }

  _renderDial() {
    for (const btn of this._dialEl.querySelectorAll('button[data-dial]')) {
      btn.setAttribute('aria-pressed', String(this.state.dial === btn.dataset.dial));
    }
  }

  /** Rebuild the whole ledger view (snapshot path). */
  _renderTranscript() {
    const stick = this._stickToBottom();
    this._transcriptEl.textContent = '';
    if (!this.state.heard.length && !this.state.pending.length) {
      this._transcriptEl.appendChild(el('div', 'lane-empty', 'No turns yet — start the show and the transcript fills in as lines are said aloud.'));
    }
    for (const turn of this.state.heard) this._transcriptEl.appendChild(this._bubble(turn));
    for (const turn of this.state.pending) this._transcriptEl.appendChild(this._bubble(turn));
    stick.restore();
  }

  /** Incremental ledger append (turn_heard path). */
  _renderTurnHeard() {
    const last = this.state.heard[this.state.heard.length - 1];
    if (!last) return;
    const stick = this._stickToBottom();
    const empty = this._transcriptEl.querySelector('.lane-empty');
    if (empty) empty.remove();
    if (last.seq != null) {
      // Replace any stale render of the same seq (heard or pending).
      for (const stale of this._transcriptEl.querySelectorAll(`[data-seq="${last.seq}"]`)) stale.remove();
    }
    const pendingStale = this.state.pending.find((p) => p.text === last.text && p.speaker === last.speaker);
    if (pendingStale && pendingStale.seq != null) {
      for (const stale of this._transcriptEl.querySelectorAll(`[data-seq="${pendingStale.seq}"]`)) stale.remove();
    }
    this._transcriptEl.appendChild(this._bubble(last));
    stick.restore();
  }

  _bubble(turn) {
    const wrap = el('div', 'lane-bubble' + (turn.kind === 'pending' ? ' pending' : ''));
    if (turn.seq != null) wrap.dataset.seq = String(turn.seq);
    if (turn.speaker.toUpperCase() === 'PRODUCER') wrap.classList.add('self');
    wrap.style.borderLeftColor = turn.color;
    const who = el('span', 'lane-who', turn.speaker + (turn.kind === 'pending' ? ' (planned)' : ''));
    who.style.color = turn.color;
    wrap.append(who, el('p', 'lane-text', turn.text));
    return wrap;
  }

  /** Keep the view pinned to the newest turn unless the user scrolled up. */
  _stickToBottom() {
    const t = this._transcriptEl;
    const near = t.scrollHeight - t.scrollTop - t.clientHeight < 48;
    return { restore: () => { if (near) t.scrollTop = t.scrollHeight; } };
  }

  _setConn(state) {
    if (!this._connEl) return;
    this._connEl.dataset.state = state;
    this._connEl.textContent = state;
  }

  _setError(message) {
    if (!this._errorEl) return;
    if (message) {
      this._errorEl.textContent = message;
      this._errorEl.hidden = false;
    } else {
      this._errorEl.textContent = '';
      this._errorEl.hidden = true;
    }
  }
}

// --- page bootstrap (browser only; node imports this module for tests) -------

if (typeof document !== 'undefined' && document.getElementById('transcript')) {
  const lane = new LaneApp();
  lane.init().catch((err) => console.error('[skald] lane init failed:', err));
}
