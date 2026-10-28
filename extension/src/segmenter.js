// skald — sentence segmentation. Pure functions, no DOM, no extension APIs.
//
// Input is the plain-text string produced by extraction.js, where a single
// '\n' separates block elements (paragraphs, list items, headings) — those
// are hard sentence boundaries. Output is an ordered list of
// { start, end, text } with offsets into the original string, covering every
// non-empty, trimmed sentence.
//
// Two passes:
//   1. boundary scan — terminal punctuation (. ! ? …) followed by whitespace
//      or end-of-text, guarded against abbreviations and initials;
//   2. run-on hard-split — any sentence longer than maxSentenceLength is cut
//      at clause separators (; — : ', and' etc.) so a 3000-char blob without
//      periods still becomes speakable chunks.

'use strict';

const TERMINALS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", '’', '”', '‘', '”', ')', ']', '»', '〉']);

export const DEFAULT_MAX_SENTENCE = 480;
export const DEFAULT_MIN_SPLIT = 60;

const ABBREVIATIONS = new Set([
  // titles & names
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'professor', 'sr', 'jr', 'st',
  'rev', 'hon', 'pres', 'gov', 'sen', 'rep', 'gen', 'col', 'sgt', 'capt',
  'lt', 'cmdr', 'adm',
  // latin & scholarly
  'etc', 'e.g', 'eg', 'i.e', 'ie', 'viz', 'al', 'vs', 'v', 'cf', 'ca',
  'circa', 'c', 'et al', 'nb', 'n.b', 'ps', 'pp',
  // references & units
  'fig', 'figs', 'no', 'nos', 'vol', 'vols', 'ch', 'chap', 'sec', 'ed',
  'eds', 'p', 'op', 'cit', 'ibid', 'est', 'approx', 'min', 'max', 'misc',
  // months & days
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april',
  'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
  'oct', 'october', 'nov', 'november', 'dec', 'december',
  'mon', 'monday', 'tue', 'tues', 'tuesday', 'wed', 'wednesday', 'thu',
  'thur', 'thurs', 'thursday', 'fri', 'friday', 'sat', 'saturday', 'sun',
  'sunday',
  // organisations & addresses
  'inc', 'ltd', 'llc', 'plc', 'co', 'corp', 'dept', 'univ', 'assn', 'bros',
  'ave', 'avenue', 'blvd', 'rd', 'road', 'ct', 'hwy', 'pkwy', 'sq',
  'u.s', 'u.k', 'u.n', 'u.s.a', 'e.g.i', 'a.m', 'p.m',
]);

// Ordered by preference: earlier patterns produce cleaner clause cuts.
const SPLIT_PATTERNS = [
  /;\s/g,
  /\s[—–]\s/g,
  /:\s/g,
  /,\s(?:and|but|or|nor|which|while|although|though|whereas|so|yet|because)\s/gi,
  /,\s/g,
];

function skipWs(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function trimEndWs(text, start, end) {
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end;
}

// Word characters immediately before position i (the terminal char).
function chunkBefore(text, i, maxChars = 16) {
  let s = i;
  while (s > 0 && /[A-Za-z0-9.\-]/.test(text[s - 1]) && i - s < maxChars) s--;
  return text.slice(s, i);
}

/**
 * Should the terminal run ending at text[j] (closers through text[k]) NOT
 * count as a sentence boundary?
 */
function isProtected(text, i, j, k) {
  const chunk = chunkBefore(text, i);
  if (!chunk) return false;
  const lower = chunk.toLowerCase();
  const base = lower.replace(/\.+$/, '');

  // Single initial: "John A. Smith"
  if (/^[a-z]$/.test(base)) return true;
  // Initialisms: "U.S.", "e.g.", "J.F.K."
  if (/^([a-z]\.)+[a-z]$/.test(lower)) return true;
  // Known abbreviation: "Mr.", "Dr.", "approx." …
  if (ABBREVIATIONS.has(base)) return true;

  // List numbering like "1. first" at the start of a line: keep the marker
  // with its item instead of producing a bare "1." sentence.
  if (/^\d{1,2}$/.test(base)) {
    const chunkStart = i - chunk.length;
    if (chunkStart <= 0 || text[chunkStart - 1] === '\n') return true;
  }
  return false;
}

function pushSentence(out, text, start, end) {
  const e = trimEndWs(text, start, end);
  if (e <= start) return;
  out.push({ start, end: e, text: text.slice(start, e) });
}

function findCut(text, s, e, minLen) {
  const lo = s + Math.min(minLen, Math.max(1, Math.floor((e - s) / 4)));
  const hi = e - 1;
  for (const re of SPLIT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index >= e) break;
      const cut = m.index + m[0].length;
      if (cut >= lo && cut <= hi) return cut;
      if (m.index > hi) break;
    }
  }
  return -1;
}

function splitRunOn(out, text, s, e, maxLen, minLen) {
  if (e - s <= maxLen) {
    out.push({ start: s, end: e, text: text.slice(s, e) });
    return;
  }
  let cut = findCut(text, s, e, minLen);
  if (cut < 0) {
    // No clause separator: hard-cut at the whitespace nearest the limit.
    const target = Math.min(s + maxLen, e - 1);
    let idx = -1;
    for (let i = target; i > s + 20; i--) {
      if (/\s/.test(text[i])) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      for (let i = target; i < e; i++) {
        if (/\s/.test(text[i])) {
          idx = i;
          break;
        }
      }
    }
    cut = idx > s ? idx : target;
  }
  splitRunOn(out, text, s, cut, maxLen, minLen);
  splitRunOn(out, text, skipWs(text, cut), e, maxLen, minLen);
}

/**
 * Segment `text` into sentences.
 * @returns {{start:number, end:number, text:string}[]}
 */
export function segment(text, opts = {}) {
  const out = [];
  if (!text) return out;
  const maxLen = Number.isFinite(opts.maxSentenceLength)
    ? opts.maxSentenceLength
    : DEFAULT_MAX_SENTENCE;
  const minLen = Number.isFinite(opts.minSplitLength)
    ? opts.minSplitLength
    : DEFAULT_MIN_SPLIT;

  const n = text.length;
  const raw = [];
  let start = skipWs(text, 0);
  let i = start;

  while (i < n) {
    const ch = text[i];
    if (ch === '\n') {
      pushSentence(raw, text, start, i);
      i = skipWs(text, i);
      start = i;
      continue;
    }
    if (TERMINALS.has(ch)) {
      let j = i;
      while (j + 1 < n && TERMINALS.has(text[j + 1])) j++; // "..." "!?" "…"
      let k = j;
      while (k + 1 < n && CLOSERS.has(text[k + 1])) k++; // quotes/brackets
      const atEnd = k + 1 >= n;
      const next = atEnd ? '' : text[k + 1];
      // Continuation rule: a terminal followed by whitespace and then a
      // lowercase letter is not a sentence end ("He paused... then went on",
      // «dit-il» style clauses, "Five… end"). End-of-text always ends.
      let continuesLowercase = false;
      if (!atEnd && /\s/.test(next)) {
        const after = text[skipWs(text, k + 1)];
        continuesLowercase = !!after && /[a-zà-þ]/.test(after);
      }
      if ((atEnd || /\s/.test(next)) && !continuesLowercase && !isProtected(text, i, j, k)) {
        pushSentence(raw, text, start, k + 1);
        i = skipWs(text, k + 1);
        start = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  pushSentence(raw, text, start, n);

  for (const s of raw) {
    splitRunOn(out, text, s.start, s.end, maxLen, minLen);
  }
  return out;
}
