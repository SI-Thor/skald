// skald — page text extraction (Readability-lite) with selection support.
//
// Strategy: never mutate the page. We score candidate containers using
// simplified Readability heuristics (text mass per paragraph-like block,
// discounted by link density, with bonuses for <article>/<main>/content-ish
// class names), pick the winner, then walk its text nodes to build:
//
//   text — the concatenated plain text, with a synthetic '\n' inserted
//          between block elements (hard sentence boundary for segmenter.js)
//   map  — [{ node, nodeOff, start, end }] mapping character ranges of
//          `text` back to (text node, offset) pairs; synthetic separators
//          have node === null.
//
// The same machinery turns a live Selection into a { text, map } pair, so
// sentence highlighting (DOM Ranges via rangeFor) works identically whether
// we are reading the article or a user selection.

'use strict';

const SKIP_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas',
  'object', 'embed', 'audio', 'video', 'select', 'option', 'input',
  'textarea', 'button', 'form', 'nav', 'aside',
].join(',');

const BLOCK_SELECTOR = 'p, pre, blockquote, h1, h2, h3, h4, h5, h6, li, dt, dd';

const CONTAINER_HINT_RE = /(article|post|entry|content|main|story|text|body)/i;

function inSkip(el) {
  try {
    return !!(el && el.closest && el.closest(SKIP_SELECTOR));
  } catch {
    return false;
  }
}

function visible(el) {
  if (!el) return false;
  try {
    if (el.closest('[hidden]')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) {
      return false;
    }
  } catch {
    /* checkVisibility unsupported — assume visible */
  }
  return true;
}

function linkDensity(el) {
  const total = (el.textContent || '').length;
  if (!total) return 0;
  let link = 0;
  for (const a of el.querySelectorAll('a')) link += (a.textContent || '').length;
  return link / total;
}

function classIdString(el) {
  const cls = typeof el.className === 'string' ? el.className : '';
  return `${el.id || ''} ${cls}`;
}

function pickContainer(doc) {
  const body = doc.body;
  if (!body) return null;

  const blocks = [];
  for (const el of body.querySelectorAll(BLOCK_SELECTOR)) {
    if (inSkip(el) || !visible(el)) continue;
    const trimmed = (el.textContent || '').trim();
    const isHeading = /^H[1-6]$/.test(el.tagName);
    const min = isHeading ? 4 : 25;
    if (trimmed.length < min) continue;
    const dens = linkDensity(el);
    if (dens > 0.5) continue;
    blocks.push({ el, weight: trimmed.length * (1 - dens) });
  }
  if (!blocks.length) return body;

  const scores = new Map();
  for (const b of blocks) {
    let node = b.el.parentElement;
    let depth = 0;
    while (node && node !== body.parentElement && depth < 5) {
      scores.set(node, (scores.get(node) || 0) + b.weight);
      node = node.parentElement;
      depth++;
    }
  }

  let best = null;
  let bestScore = -1;
  for (const [node, score] of scores) {
    let bonus = 1;
    const tag = node.tagName;
    if (tag === 'ARTICLE') bonus = 2;
    else if (tag === 'MAIN') bonus = 1.5;
    if (CONTAINER_HINT_RE.test(classIdString(node))) bonus += 0.25;
    try {
      const role = node.getAttribute('role');
      if (role === 'main' || role === 'article') bonus += 0.5;
    } catch {
      /* detached node */
    }
    const total = score * bonus;
    if (total > bestScore) {
      bestScore = total;
      best = node;
    }
  }

  if (best && (best.textContent || '').trim().length >= 250) return best;
  return body;
}

function acceptTreeNode(node) {
  const parent = node.parentElement;
  if (!parent || !node.data) return NodeFilter.FILTER_REJECT;
  if (inSkip(parent) || !visible(parent)) return NodeFilter.FILTER_REJECT;
  return NodeFilter.FILTER_ACCEPT;
}

function blockOf(node) {
  const parent = node.parentElement;
  if (!parent) return node;
  return parent.closest(BLOCK_SELECTOR) || parent;
}

/** Append one walked text-node fragment to the accumulator. */
function appendFragment(acc, node, data, nodeOff) {
  const blockEl = blockOf(node);
  if (
    acc.lastBlock &&
    blockEl !== acc.lastBlock &&
    acc.text.length &&
    !/\s$/.test(acc.text)
  ) {
    acc.text += '\n';
    acc.map.push({ node: null, nodeOff: 0, start: acc.text.length - 1, end: acc.text.length });
  }
  acc.map.push({
    node,
    nodeOff,
    start: acc.text.length,
    end: acc.text.length + data.length,
  });
  acc.text += data;
  acc.lastBlock = blockEl;
}

function walkContainer(container) {
  const acc = { text: '', map: [], lastBlock: null };
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    { acceptNode: acceptTreeNode }
  );
  let node;
  while ((node = walker.nextNode())) {
    appendFragment(acc, node, node.data, 0);
  }
  return acc;
}

function walkRange(range) {
  const acc = { text: '', map: [], lastBlock: null };
  const root =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!root) return acc;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.parentElement || !node.data) return NodeFilter.FILTER_REJECT;
      if (inSkip(node.parentElement) || !visible(node.parentElement)) {
        return NodeFilter.FILTER_REJECT;
      }
      return range.intersectsNode(node)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    let s = 0;
    let e = node.data.length;
    if (node === range.startContainer) s = range.startOffset;
    if (node === range.endContainer) e = range.endOffset;
    if (e <= s) continue;
    appendFragment(acc, node, node.data.slice(s, e), s);
  }
  return acc;
}

export function fromArticle(doc = document) {
  const container = pickContainer(doc);
  if (!container) return { text: '', map: [], title: doc.title || '' };
  const acc = walkContainer(container);
  return { ...acc, title: doc.title || '' };
}

export function fromSelection(sel) {
  if (!sel || sel.isCollapsed || typeof sel.rangeCount !== 'number') return null;
  const acc = { text: '', map: [], lastBlock: null };
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (range.collapsed) continue;
    if ((range.toString() || '').trim().length < 3) continue;
    if (acc.text.length && !/\s$/.test(acc.text)) {
      acc.text += '\n';
      acc.map.push({ node: null, nodeOff: 0, start: acc.text.length - 1, end: acc.text.length });
    }
    const part = walkRange(range);
    for (const m of part.map) {
      const shift = acc.text.length;
      acc.map.push({ ...m, start: m.start + shift, end: m.end + shift });
    }
    acc.text += part.text;
    acc.lastBlock = part.lastBlock;
  }
  if (acc.text.trim().length < 3) return null;
  return acc;
}

/**
 * Main entry: read the current selection if there is a meaningful one,
 * otherwise the extracted article.
 * @returns {{text:string, map:object[], source:'selection'|'article', title:string}}
 */
export function extract(win = window) {
  const sel = win.getSelection ? win.getSelection() : null;
  const selected = sel ? fromSelection(sel) : null;
  if (selected) return { ...selected, source: 'selection' };
  const article = fromArticle(win.document);
  return { ...article, source: 'article' };
}

/**
 * Build a DOM Range covering text offsets [start, end) of the extracted
 * text. Returns null when the range cannot be represented.
 */
export function rangeFor(map, start, end) {
  if (!map || !map.length || end <= start) return null;
  const entries = map.filter((m) => m.node && m.end > start && m.start < end);
  if (!entries.length) return null;
  const first = entries[0];
  const last = entries[entries.length - 1];
  const firstLen = first.end - first.start;
  const lastLen = last.end - last.start;
  const so = Math.min(
    Math.max(start - first.start + first.nodeOff, first.nodeOff),
    first.nodeOff + firstLen
  );
  const eo = Math.min(
    Math.max(end - last.start + last.nodeOff, last.nodeOff),
    last.nodeOff + lastLen
  );
  try {
    const range = document.createRange();
    range.setStart(first.node, so);
    range.setEnd(last.node, eo);
    return range;
  } catch {
    return null;
  }
}
