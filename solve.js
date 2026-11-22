// Fast drop-in for makefun-site 1.0.0 — written from scratch for speed.
// Returns byte-identical output to the reference (kit README + vendor code are the spec).
// Strategy: single-pass fused Markdown renderer (no token objects, bulk text runs),
// fast front matter (no whole-body split/join), ASCII fast-path slugify,
// template pre-compilation to JS functions (partial evaluation), array-join output.

export const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape & < > " '. Fast path when nothing to escape. */
export function escapeHtml(s) {
  let i = -1;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { i = k; break; }
  }
  if (i === -1) return s;
  let out = s.slice(0, i);
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    const e = ESC[c];
    out += e === undefined ? c : e;
  }
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Slug of `text`. ASCII fast path (95%+ of titles/tags/headings): NFKD is identity
 * on ASCII and there are no combining marks, so the reference's normalize+regex
 * can be skipped. Non-ASCII falls back to the reference algorithm exactly.
 */
export function slugify(text) {
  let ascii = true;
  for (let k = 0; k < text.length; k++) {
    if (text.charCodeAt(k) >= 128) { ascii = false; break; }
  }
  if (!ascii) return slugifyUnicode(text);
  let out = '';
  let gap = false;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z _
}

/** Parse one front-matter line into [key, raw] or null when it is not "key: value". */
function fmLine(line) {
  let i = 0;
  while (i < line.length && isKeyChar(line.charCodeAt(i))) i++;
  if (i === 0 || i >= line.length || line.charCodeAt(i) !== 58) return null; // no ':' after a key
  const key = line.slice(0, i);
  i++; // past ':'
  let raw;
  if (i >= line.length) raw = '';
  else if (line.charCodeAt(i) === 32) raw = line.slice(i + 1);
  else return null; // ':' not followed by ' ' or end
  // strip trailing spaces/tabs from raw
  let e = raw.length;
  while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
  if (e !== raw.length) raw = raw.slice(0, e);
  return [key, raw];
}

function stringOf(raw, key) {
  if (raw.charCodeAt(0) === 34) { // starts with '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: `key "${key}": a quoted string is not closed` };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        out += n;
        i++;
      } else if (c === '"') return { error: `key "${key}": a quoted string holds a stray quote` };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `key "${key}": a bare string opens on [` };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return stringOf(raw, key);
    case 'date': {
      // YYYY-MM-DD, real day 1970-01-01..2099-12-31
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      let ok = true;
      for (let k = 0; k < 10; k++) {
        if (k === 4 || k === 7) continue;
        const c = raw.charCodeAt(k);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
      const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let k = 0; k < parts.length; k++) {
        const t = parts[k].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[k] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let k = 0; k < raw.length; k++) {
        const c = raw.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      // [a-z0-9]+(-[a-z0-9]+)*
      let k = 0;
      const isAlnum = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
      while (k < raw.length && isAlnum(raw.charCodeAt(k))) k++;
      if (k === 0) return { error: 'key "slug": not a slug' };
      while (k < raw.length) {
        if (raw.charCodeAt(k) !== 45) return { error: 'key "slug": not a slug' };
        k++;
        const start = k;
        while (k < raw.length && isAlnum(raw.charCodeAt(k))) k++;
        if (k === start) return { error: 'key "slug": not a slug' };
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Avoids splitting the whole body: only the front-matter
 * region is scanned line by line; the body is a single slice.
 */
export function parseFrontMatter(text) {
  // first line must be exactly '---'
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // find the closing '---' line
  let pos = nl === -1 ? text.length : nl + 1;
  let closeLine = -1; // line number (1-based) of the closing '---'
  let lineNo = 1; // the opening '---' is line 1
  let closeStart = -1; // index where the closing line starts
  let bodyStart = -1;
  while (pos <= text.length) {
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 ? text.length : eol;
    lineNo++;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeLine = lineNo;
      closeStart = pos;
      bodyStart = eol === -1 ? text.length : eol + 1;
      break;
    }
    if (eol === -1) break;
    pos = eol + 1;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // scan front-matter lines (between the opening '---' and the closing one)
  let p = nl === -1 ? text.length : nl + 1;
  let ln = 1;
  while (p < closeStart) {
    const eol = text.indexOf('\n', p);
    const end = eol === -1 ? closeStart : Math.min(eol, closeStart);
    ln++;
    const line = text.slice(p, end);
    if (!isFmBlankOrComment(line)) {
      const m = fmLine(line);
      if (m === null) return { error: `line ${ln} is not "key: value"` };
      const key = m[0];
      const raw = m[1];
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (eol === -1 || eol >= closeStart) break;
    p = eol + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

function isFmBlankOrComment(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 35) return true; // '#'
  if (c0 === 32 || c0 === 9) {
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE_TABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE_TABLE[ch.charCodeAt(0)] = 1;
function isEscapable(code) { return code < 128 && ESCAPABLE_TABLE[code] === 1; }

function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** Fence-open language, or null. Line starts with ``` then lang then only spaces/tabs. */
function fenceOpen(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length && isLangChar(line.charCodeAt(k))) k++;
  const lang = line.slice(3, k);
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return lang;
}

function fenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's {depth, text}, or null. */
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  let k = depth;
  if (k >= line.length) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  let e = line.length;
  while (e > k && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === k) return null;
  return { depth, text: line.slice(k, e) };
}

function isHR(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  const isDash = c0 === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45;
  const isStar = c0 === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42;
  if (!isDash && !isStar) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function bulletOf(line) {
  if (line.length >= 2) {
    const c = line.charCodeAt(0);
    if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  }
  return null;
}

function orderedOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
  if (k === 0 || k > 9) return null;
  if (k + 1 >= line.length) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return [Number(line.slice(0, k)), line.slice(k + 2)];
}

const CONTINUED = /^ {2,}\S/;

function endsParagraph(line) {
  const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c0 === -1) return true;
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;
const MARKUP_RE = /[\\`*\[]/;
const ANY_SPECIAL_RE = /[\\`*[&<>"']/;

/** `s` rendered inline. Fast paths for plain/escape-only text; char scan otherwise. */
export function inline(s, env) {
  if (!ANY_SPECIAL_RE.test(s)) return s;
  if (!MARKUP_RE.test(s)) return escapeHtml(s);
  const out = [];
  const n = s.length;
  let i = 0;
  let run = 0; // start of the pending plain run
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        if (run < i) out.push(s.slice(run, i));
        const d = s[i + 1];
        out.push(ESC[d] === undefined ? d : ESC[d]);
        i += 2;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) { // backtick
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) { // '*'
      if (i + 1 < n && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (run < i) out.push(s.slice(run, i));
          out.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>');
          i = j + 2;
          run = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<em>', inline(s.slice(i + 1, j), env), '</em>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) { // '['
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (run < i) out.push(s.slice(run, i));
      out.push(ESC[s[i]]);
      i++;
      run = i;
      continue;
    }
    i++;
  }
  if (run < n) out.push(s.slice(run, n));
  return out.join('');
}

/**
 * `src` rendered: { html, toc, excerpt }. Fused single pass: lines straight to HTML,
 * no token objects.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1) { i++; continue; } // empty line
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
      // indented text: a paragraph line (fall through)
    } else if (c0 === 96) { // '`'
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        let code = '';
        for (let k = 0; k < body.length; k++) code += escapeHtml(body[k]) + '\n';
        out.push(`<pre><code${cls}>${code}</code></pre>\n`);
        continue;
      }
      // not a fence: paragraph (fall through)
    } else if (c0 === 35) { // '#'
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        const html = inline(hd.text, env);
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
      // not a heading: paragraph (fall through)
    } else if (c0 === 45 || c0 === 42) { // '-' or '*'
      if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const bb = bulletOf(l);
          if (bb !== null) { items.push([trimLine(bb)]); i++; continue; }
          if (CONTINUED.test(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
          break;
        }
        let html = '<ul>\n';
        for (let k = 0; k < items.length; k++) html += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
        html += '</ul>\n';
        out.push(html);
        continue;
      }
      // not HR or bullet: paragraph (fall through)
    } else if (c0 === 62) { // '>'
      const inner = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') inner.push(l);
        i++;
      }
      if (inner.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit
      const o = orderedOf(line);
      if (o !== null) {
        const startNum = o[0];
        const items = [];
        while (i < n) {
          const l = lines[i];
          const oo = orderedOf(l);
          if (oo !== null) { items.push([trimLine(oo[1])]); i++; continue; }
          if (CONTINUED.test(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
          break;
        }
        const open = startNum !== 1 ? `<ol start="${startNum}">` : '<ol>';
        let html = open + '\n';
        for (let k = 0; k < items.length; k++) html += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
        html += '</ol>\n';
        out.push(html);
        continue;
      }
      // not an ordered list: paragraph (fall through)
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) { body.push(trimLine(lines[i])); i++; }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

export const INCLUDE_DEPTH = 8;

export class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isOnlySpacesTabs(src, lineStart, open) && isOnlySpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function isOnlySpacesTabs(s, a, b) {
  for (let k = a; k < b; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template value helpers (shared with generated code) ---

/** Own property `name` of object `v`, else undefined. */
function seg(v, name) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, name) ? v[name] : undefined;
}

function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(txt).join(', ');
  return '';
}

function tru(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// --- template compiler: nodes -> JS function via new Function ---

/** JS expression resolving `path` in the current env `E`. */
function pathExpr(path) {
  let e = `E.${path[0]}`;
  for (let k = 1; k < path.length; k++) e = `seg(${e},${JSON.stringify(path[k])})`;
  return e;
}

let tmpCounter = 0;

function genNodes(nodes, out) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(`o+=${JSON.stringify(n.text)};`);
    } else if (n.kind === 'var') {
      out.push(`o+=esc(txt(${pathExpr(n.path)}));`);
    } else if (n.kind === 'raw') {
      out.push(`o+=txt(${pathExpr(n.path)});`);
    } else if (n.kind === 'if') {
      const cond = n.not ? `!tru(${pathExpr(n.path)})` : `tru(${pathExpr(n.path)})`;
      out.push(`if(${cond}){`);
      genNodes(n.then, out);
      if (n.else !== null) {
        out.push('}else{');
        genNodes(n.else, out);
      }
      out.push('}');
    } else if (n.kind === 'for') {
      const id = tmpCounter++;
      const vn = JSON.stringify(n.name);
      out.push(`{const _x${id}=${pathExpr(n.path)};if(Array.isArray(_x${id})){const _h${id}=${vn} in E,_o${id}=E[${vn}],_g${id}="loop" in E,_q${id}=E.loop;const _l${id}={index:0,first:false,last:false,length:_x${id}.length};E.loop=_l${id};for(let _k${id}=0;_k${id}<_x${id}.length;_k${id}++){E[${vn}]=_x${id}[_k${id}];_l${id}.index=_k${id}+1;_l${id}.first=_k${id}===0;_l${id}.last=_k${id}===_x${id}.length-1;`);
      genNodes(n.body, out);
      out.push(`}if(_h${id})E[${vn}]=_o${id};else delete E[${vn}];if(_g${id})E.loop=_q${id};else delete E.loop;}}`);
    } else if (n.kind === 'include') {
      const id = tmpCounter++;
      out.push(`if(D<${INCLUDE_DEPTH}){const _f${id}=T.get(${JSON.stringify(n.name)});if(_f${id})o+=_f${id}(E,T,D+1,esc,txt,tru,seg);}`);
    }
  }
}

/**
 * Compile parsed nodes to a render function (E, T, D, esc, txt, tru, seg) -> string.
 * Falls back to a tree-walking interpreter when code generation is unavailable.
 */
export function compileTemplate(nodes) {
  const parts = ['let o="";'];
  tmpCounter = 0;
  genNodes(nodes, parts);
  parts.push('return o;');
  const src = parts.join('');
  try {
    return new Function('E', 'T', 'D', 'esc', 'txt', 'tru', 'seg', src);
  } catch {
    return interpretTemplate(nodes);
  }
}

/** Tree-walking interpreter (fallback when new Function is unavailable). */
function interpretTemplate(nodes) {
  const render = (E, T, D) => {
    const o = [];
    walk(nodes, E, T, D, o);
    return o.join('');
  };
  return function (E, T, D, esc, txtFn, truFn, segFn) {
    return render(E, T, D);
  };
}

function walk(nodes, E, T, D, o) {
  for (const n of nodes) {
    if (n.kind === 'text') o.push(n.text);
    else if (n.kind === 'var') o.push(escapeHtml(txt(lookupPath(E, n.path))));
    else if (n.kind === 'raw') o.push(txt(lookupPath(E, n.path)));
    else if (n.kind === 'if') {
      const v = tru(lookupPath(E, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) walk(branch, E, T, D, o);
    } else if (n.kind === 'for') {
      const xs = lookupPath(E, n.path);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const E2 = Object.assign(Object.create(null), E, { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } });
        walk(n.body, E2, T, D, o);
      }
    } else if (n.kind === 'include') {
      const f = T.get(n.name);
      if (f !== undefined && D < INCLUDE_DEPTH) o.push(f(E, T, D + 1, escapeHtml, txt, tru, seg));
    }
  }
}

function lookupPath(E, path) {
  let v = E[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A null-prototype env object from a plain object. */
function mkEnv(obj) {
  return Object.assign(Object.create(null), obj);
}

// ---------------------------------------------------------------- build pipeline

function wordsOf(text) {
  // Single pass; whitespace = ASCII [\t\n\v\f\r ] plus the Unicode spaces of \s.
  let count = 0;
  let inWord = false;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    let isWS;
    if (c < 128) {
      isWS = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
    } else {
      isWS = c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    }
    if (isWS) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(s);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function build(input) {
  // Templates, parsed in code-unit order of name; one that does not parse is reported.
  const report = [];
  const templates = new Map(); // name -> compiled render fn
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, code-unit order of path; .md sources have \r\n made \n.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter + refusal checks, in order.
  const kept = [];
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set();
  for (let k = 0; k < statics.length; k++) staticPaths.add(statics[k].path);
  const broken = new Set();
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags: grouped by slug, named as first met in collection order, ordered by count then slug.
  const bySlug = new Map();
  const ownTagsOf = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push([name, slug]);
      }
    }
    return out;
  };
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.tagRefs = [];
    const own = ownTagsOf(p);
    for (let j = 0; j < own.length; j++) {
      const name = own[j][0];
      const slug = own[j][1];
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    if (s.post) continue;
    const own = ownTagsOf(s);
    s.tagRefs = new Array(own.length);
    for (let j = 0; j < own.length; j++) {
      const name = own[j][0];
      const slug = own[j][1];
      s.tagRefs[j] = bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const cards = new Map();
  const cardOf = (s) => {
    let c = cards.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cards.set(s, c);
    return c;
  };
  for (let k = 0; k < posts.length; k++) cardOf(posts[k]);
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const E = mkEnv(Object.assign({ site, tags: allTags, recent }, vars));
    return fn(E, templates, 0, escapeHtml, txt, tru, seg);
  };
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let k = 0; k < statics.length; k++) {
    const f = statics[k];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = sources.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
