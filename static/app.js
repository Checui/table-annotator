/* Table annotation tool: browser side. No libraries, no build step.
 *
 * Table model: {nRows, nCols, cells: [{r, c, rs, cs, text, header, unclear, edited, padded, bbox, polygon, box_by}]}
 * box_by: who made the box: 'model' (pre-annotation), 'grid' (the grid tool) or 'hand' (drawn or adjusted).
 * bbox [x0, y0, x1, y1] and polygon [[x, y], ...] are in pixels of the table image.
 * Every grid slot is covered by exactly one cell (checked before each save, here and on the server).
 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => esc(s).replace(/"/g, '&quot;');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ann.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('ann.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
const MAX_SPAN = 100;
const SCHEMA = 'haikido-table-annotation/1';

const S = {
  batch: null, tasks: [], annotator: LS.get('annotator', ''), filter: LS.get('filter', 'mine'), search: '',
  view: 'home',
  tid: null, detail: null, model: null, slots: null, meta: null,
  sel: { ar: 0, ac: 0, er: 0, ec: 0 },
  editing: null, undo: [], redo: [], dirty: false, saveTimer: null, saving: false, conflict: false,
  imports: {}, active: { seconds: 0, last: Date.now() },
};

// ------------------------------------------------------------------------------------------
// Server API

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) { const err = new Error((body && body.error) || res.statusText); err.status = res.status; err.body = body; throw err; }
  return body;
}
const q = () => 'annotator=' + encodeURIComponent(S.annotator);

// ------------------------------------------------------------------------------------------
// Model: import, export, checks

function newCell(r, c, rs = 1, cs = 1, text = '', extra = {}) {
  return Object.assign({ r, c, rs, cs, text, header: false, unclear: false, edited: false, padded: false, bbox: null, polygon: null, box_by: null }, extra);
}
function emptyModel(nRows, nCols) {
  const cells = [];
  for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) cells.push(newCell(r, c));
  return { nRows, nCols, cells };
}
function cloneModel(m) {
  return { nRows: m.nRows, nCols: m.nCols, cells: m.cells.map(c => Object.assign({}, c, { bbox: c.bbox ? c.bbox.slice() : null, polygon: c.polygon ? c.polygon.map(p => p.slice()) : null })) };
}
function slotsOf(m) {
  const s = [];
  for (let r = 0; r < m.nRows; r++) s.push(new Int32Array(m.nCols).fill(-1));
  m.cells.forEach((c, i) => {
    for (let r = c.r; r < c.r + c.rs; r++) for (let k = c.c; k < c.c + c.cs; k++) {
      if (r < m.nRows && k < m.nCols) s[r][k] = s[r][k] === -1 ? i : -2;
    }
  });
  return s;
}
function checkModel(m) {
  const s = slotsOf(m);
  for (let r = 0; r < m.nRows; r++) for (let k = 0; k < m.nCols; k++) if (s[r][k] < 0) return `slot ${r},${k} ${s[r][k] === -1 ? 'empty' : 'covered twice'}`;
  for (const c of m.cells) if (c.r + c.rs > m.nRows || c.c + c.cs > m.nCols || c.rs < 1 || c.cs < 1) return 'cell outside the grid';
  return null;
}
function sortCells(m) { m.cells.sort((a, b) => a.r - b.r || a.c - b.c); return m; }
function cleanText(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

/* Superscript, subscript, formulas: the text of a cell may hold <sup>…</sup> and <sub>…</sub> (as in the models' HTML
   and in the saved HTML) and $…$ formulas in LaTeX (drawn with KaTeX, static/vendor/katex, no internet needed).
   As in Pandoc, a $ opens a formula only when no space follows it and closes one only when no space comes before it
   and no digit after it, so "$5 and $10" stays text; \$ is always a dollar sign. Everything else is plain text. */
const RICH_TAGS = ['sup', 'sub'];
const RICH_RE = /<(\/?)(sup|sub)>/g;
function mathSplit(s) {  // → [['text', s] | ['math', tex]]
  const out = [];
  let i = 0, from = 0;
  const closeAt = k => { for (let j = k + 2; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === '$') return /\s/.test(s[j - 1]) || /\d/.test(s[j + 1] || '') ? -1 : j; } return -1; };
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '$' && s[i + 1] && !/[\s$]/.test(s[i + 1])) {
      const j = closeAt(i);
      if (j > i) { if (i > from) out.push(['text', s.slice(from, i)]); out.push(['math', s.slice(i + 1, j)]); i = from = j + 1; continue; }
    }
    i++;
  }
  if (from < s.length) out.push(['text', s.slice(from)]);
  return out;
}
function richTokens(text) {  // → [['text', s] | ['open', tag] | ['close', tag] | ['math', tex]]
  const out = [];
  for (const [k, s] of mathSplit(String(text || ''))) {
    if (k === 'math') { out.push([k, s]); continue; }
    let last = 0, m;
    RICH_RE.lastIndex = 0;
    while ((m = RICH_RE.exec(s))) {
      if (m.index > last) out.push(['text', s.slice(last, m.index)]);
      out.push([m[1] ? 'close' : 'open', m[2]]);
      last = RICH_RE.lastIndex;
    }
    if (last < s.length) out.push(['text', s.slice(last)]);
  }
  return out;
}
const MATH_CACHE = new Map();
function mathHTML(tex) {  // a formula drawn by KaTeX; its LaTeX shows on hover
  let h = MATH_CACHE.get(tex);
  if (h === undefined) {
    try {
      h = window.katex ? katex.renderToString(tex, { throwOnError: false, output: 'html', strict: 'ignore', trust: false, maxExpand: 200 }) : null;
    } catch (e) { h = null; }
    h = `<span class="math${h ? '' : ' raw'}" title="${escAttr('$' + tex + '$')}">${h || esc('$' + tex + '$')}</span>`;
    if (MATH_CACHE.size > 2000) MATH_CACHE.clear();
    MATH_CACHE.set(tex, h);
  }
  return h;
}
function richBalanced(text) {  // tags opened and closed in order, none inside itself, no empty pair
  const out = [], open = [];
  for (const [k, v] of richTokens(text)) {
    if (k === 'text' || k === 'math') { out.push([k, v]); continue; }
    if (k === 'open') { if (!open.includes(v)) { open.push(v); out.push(['open', v]); } continue; }
    const at = open.lastIndexOf(v);
    if (at < 0) continue;  // a closing tag with nothing open: dropped
    while (open.length > at) out.push(['close', open.pop()]);
  }
  while (open.length) out.push(['close', open.pop()]);
  for (let changed = true; changed;) {  // <sup></sup> → nothing
    changed = false;
    for (let i = 0; i + 1 < out.length; i++) if (out[i][0] === 'open' && out[i + 1][0] === 'close' && out[i][1] === out[i + 1][1]) { out.splice(i, 2); changed = true; break; }
  }
  return out;
}
/* Fractions are LaTeX ($\frac{1}{2}$): a fraction character typed, pasted, picked in Symbols or found
   in an imported table becomes its formula; a whole number before it stays outside (3½ → 3$\frac{1}{2}$). */
const FRACTIONS = { '½': [1, 2], '⅓': [1, 3], '⅔': [2, 3], '¼': [1, 4], '¾': [3, 4], '⅕': [1, 5], '⅖': [2, 5], '⅗': [3, 5], '⅘': [4, 5], '⅙': [1, 6], '⅚': [5, 6], '⅐': [1, 7], '⅛': [1, 8], '⅜': [3, 8], '⅝': [5, 8], '⅞': [7, 8], '⅑': [1, 9], '⅒': [1, 10] };
const FRACTION_RE = /[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]/g;
function fracTex(ch) { const f = FRACTIONS[ch]; return f ? `$\\frac{${f[0]}}{${f[1]}}$` : null; }
function fracToTex(text) { return mathSplit(String(text || '')).map(([k, v]) => k === 'math' ? '$' + v + '$' : v.replace(FRACTION_RE, fracTex)).join(''); }
function normText(text) { return tidyRich(fracToTex(cleanText(text))); }  // the text of a cell as it is kept
function tidyRich(text) { return richBalanced(text).map(([k, v]) => k === 'text' ? v : k === 'math' ? '$' + v + '$' : k === 'open' ? `<${v}>` : `</${v}>`).join(''); }
function richHTML(text, deco = esc, math = mathHTML) { return richBalanced(text).map(([k, v]) => k === 'text' ? deco(v) : k === 'math' ? math(v) : k === 'open' ? `<${v}>` : `</${v}>`).join(''); }
function plainText(text) { return String(text || '').replace(RICH_RE, ''); }
function richTextOf(node) {  // the text of an HTML cell, its <sup>/<sub> kept, <br> = space
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.nodeType === 1) {
      const t = n.tagName.toLowerCase();
      if (t === 'br') out += ' ';
      else if (RICH_TAGS.includes(t)) out += `<${t}>${richTextOf(n)}</${t}>`;
      else out += richTextOf(n);
    }
  }
  return out;
}

/* First <table>…</table> of a model answer (same rule as score_task_a.extract_table). */
function extractTable(raw) {
  const re = /<(\/?)table\b[^>]*>/gi;
  let m, start = -1, depth = 0;
  while ((m = re.exec(raw))) {
    if (start < 0) { if (m[1]) continue; start = m.index; depth = 1; continue; }
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { html: raw.slice(start, re.lastIndex), truncated: false, rest: raw.slice(re.lastIndex) };
  }
  if (start < 0) return null;
  return { html: raw.slice(start), truncated: true, rest: '' };
}

/* HTML table (any model answer) -> model + notes for the annotator. */
function modelFromHTML(raw) {
  const notes = [];
  const ext = extractTable(raw);
  if (!ext) return { model: null, notes: ['no <table> in this answer'] };
  if (ext.truncated) notes.push('answer cut off (no </table>)');
  if (/<table\b/i.test(ext.rest)) notes.push('answer has more than one table: the first is used');
  const html = ext.html;  // <sup>/<sub> are kept (32<sup>5</sup> stays; score_task_a.py reads it as 32.5)
  const doc = new DOMParser().parseFromString('<!doctype html><html><body>' + html + '</body></html>', 'text/html');
  const table = doc.querySelector('table');
  if (!table) return { model: null, notes: notes.concat(['table could not be read']) };
  const trs = Array.from(table.querySelectorAll('tr')).filter(tr => tr.closest('table') === table);
  if (table.querySelector('table')) notes.push('nested table: its text is kept in the outer cell');
  const occ = [];  // occ[r][c] = true when taken
  const cells = [];
  let clipped = 0;
  const taken = (r, c) => occ[r] && occ[r][c];
  trs.forEach((tr, r) => {
    let c = 0;
    for (const td of Array.from(tr.children)) {
      const tag = td.tagName.toLowerCase();
      if (tag !== 'td' && tag !== 'th') continue;
      while (taken(r, c)) c++;
      let rs = parseInt(td.getAttribute('rowspan') || '1', 10), cs = parseInt(td.getAttribute('colspan') || '1', 10);
      if (!(rs >= 1)) rs = 1; if (!(cs >= 1)) cs = 1;
      if (rs > MAX_SPAN || cs > MAX_SPAN) { clipped++; rs = Math.min(rs, MAX_SPAN); cs = Math.min(cs, MAX_SPAN); }
      cells.push(newCell(r, c, rs, cs, normText(richTextOf(td)), { header: tag === 'th', bbox: boxAttr(td) }));
      for (let i = r; i < r + rs; i++) { occ[i] = occ[i] || []; for (let k = c; k < c + cs; k++) occ[i][k] = true; }
      c += cs;
    }
  });
  let nRows = trs.length;
  if (!nRows || !cells.length) return { model: null, notes: notes.concat(['the table has no cells']) };
  // rowspans running past the last row are cut, as browsers do
  for (const cell of cells) if (cell.r + cell.rs > nRows) { cell.rs = nRows - cell.r; clipped++; }
  let nCols = 0;
  for (const cell of cells) nCols = Math.max(nCols, cell.c + cell.cs);
  const m = { nRows, nCols, cells };
  // ragged rows: fill the missing slots with empty cells, marked "padded"
  const s = slotsOf(m);
  let padded = 0;
  for (let r = 0; r < nRows; r++) for (let k = 0; k < nCols; k++) if (s[r][k] === -1) { cells.push(newCell(r, k, 1, 1, '', { padded: true })); padded++; }
  // overlapping spans (invalid HTML): shrink the later cell
  let fixed = 0;
  for (let guard = 0; guard < 5 && checkModel(m); guard++) { fixed += resolveOverlaps(m); }
  if (padded) notes.push(`${padded} cell${padded > 1 ? 's' : ''} added to short rows (striped)`);
  if (clipped) notes.push(`${clipped} span${clipped > 1 ? 's' : ''} cut to fit`);
  if (fixed) notes.push(`${fixed} overlapping span${fixed > 1 ? 's' : ''} fixed`);
  return { model: sortCells(m), notes };
}
function boxAttr(td) {
  let v = td.getAttribute('data-bbox') || td.getAttribute('bbox');
  if (!v) { const t = (td.getAttribute('title') || '').match(/bbox\s+([-\d.\s,]+)/); v = t && t[1]; }
  if (!v) return null;
  const n = String(v).replace(/[[\]()]/g, ' ').trim().split(/[\s,;]+/).map(Number);
  return n.length === 4 && n.every(isFinite) ? n : null;
}
function resolveOverlaps(m) {
  let fixed = 0;
  const owner = [];
  for (let r = 0; r < m.nRows; r++) owner.push(new Int32Array(m.nCols).fill(-1));
  const keep = [];
  for (const c of m.cells) {
    let clash = false;
    for (let r = c.r; r < c.r + c.rs && !clash; r++) for (let k = c.c; k < c.c + c.cs; k++) if (owner[r][k] >= 0) { clash = true; break; }
    if (clash) { c.rs = 1; c.cs = 1; fixed++; if (owner[c.r][c.c] >= 0) continue; }
    for (let r = c.r; r < c.r + c.rs; r++) for (let k = c.c; k < c.c + c.cs; k++) owner[r][k] = keep.length;
    keep.push(c);
  }
  m.cells = keep;
  const s = slotsOf(m);
  for (let r = 0; r < m.nRows; r++) for (let k = 0; k < m.nCols; k++) if (s[r][k] === -1) m.cells.push(newCell(r, k, 1, 1, '', { padded: true }));
  return fixed;
}
const BOX_BY = ['model', 'grid', 'hand'];
/* Our own JSON (saved annotations, or pre-annotations with boxes). repair (a model's answer): rows and columns
   computed when missing, cells outside the grid enlarge it, missing cells are added (striped), overlaps fixed, as
   for a model's HTML. Also read: row_span / col_span, bbox_2d / box_2d, content [{text}] (lines). A model's "uncertain" is not
   taken as Unclear: that mark is the annotator's. */
function modelFromJSON(obj, repair = false) {
  let list = Array.isArray(obj.cells) ? obj.cells : [];
  const notes = [];
  if (repair) {
    const n = list.length;
    list = list.filter(c => c && typeof c === 'object' && Number.isInteger(+c.row) && Number.isInteger(+c.col) && +c.row >= 0 && +c.col >= 0);
    if (list.length < n) notes.push(`${n - list.length} cell${n - list.length > 1 ? 's' : ''} without a row and column left out`);
  }
  const span = v => { v = Math.round(+(v ?? 1)); return v >= 1 ? (repair ? Math.min(v, MAX_SPAN) : v) : 1; };
  const box = v => Array.isArray(v) && v.length === 4 && v.every(x => isFinite(+x)) ? v.map(Number) : null;
  const textOf = c => c.text != null ? String(c.text) : Array.isArray(c.content) ? c.content.map(l => (l && typeof l === 'object' ? l.text : l) || '').join(' ') : '';
  const cells = list.map(c => newCell(+c.row, +c.col, span(c.rowspan ?? c.row_span), span(c.colspan ?? c.col_span), repair ? normText(textOf(c)) : String(c.text || ''), {
    header: !!c.header, unclear: !!c.unclear, edited: !!c.edited,
    bbox: box(c.bbox) || box(c.bbox_2d) || box(c.box_2d),
    polygon: Array.isArray(c.polygon) && c.polygon.length > 2 ? c.polygon.map(p => [+p[0], +p[1]]) : null,
  }));
  for (const [k, c] of list.entries()) {
    const x = cells[k];
    if (x.polygon) x.bbox = bboxOf(x.polygon);
    x.box_by = !x.bbox ? null : BOX_BY.includes(c.box_by) ? c.box_by : c.box_edited ? 'hand' : 'model';
  }
  const m = { nRows: +obj.n_rows, nCols: +obj.n_cols, cells };
  if (repair) {
    if (!cells.length) return { model: null, notes: notes.concat(['the table has no cells']) };
    for (const [key, ext, word] of [['nRows', c => c.r + c.rs, 'rows'], ['nCols', c => c.c + c.cs, 'columns']]) {
      const need = Math.max(...cells.map(ext));
      if (!(m[key] >= 1)) m[key] = need;
      else if (need > m[key]) { notes.push(`${need - m[key]} ${word} added for cells outside the ${m[key]} given`); m[key] = need; }
    }
    if (m.nRows > 1000 || m.nCols > 300) return { model: null, notes: notes.concat([`too big for a table: ${m.nRows} rows, ${m.nCols} columns`]) };
    // a span running over a cell the model also lists: the span is cut there (both cells and their text kept)
    const anchor = new Set(cells.map(c => c.r + ',' + c.c));
    let cut = 0;
    for (const c of cells) {
      const hit = (r, k) => (r !== c.r || k !== c.c) && anchor.has(r + ',' + k);
      let cs = c.cs, rs = c.rs;
      for (let k = 1; k < cs; k++) { let h = false; for (let r = c.r; r < c.r + rs; r++) if (hit(r, c.c + k)) h = true; if (h) { cs = k; break; } }
      for (let j = 1; j < rs; j++) { let h = false; for (let k = c.c; k < c.c + cs; k++) if (hit(c.r + j, k)) h = true; if (h) { rs = j; break; } }
      if (cs !== c.cs || rs !== c.rs) { c.cs = cs; c.rs = rs; cut++; }
    }
    const s = slotsOf(m);
    let padded = 0, fixed = 0;
    for (let r = 0; r < m.nRows; r++) for (let k = 0; k < m.nCols; k++) if (s[r][k] === -1) { cells.push(newCell(r, k, 1, 1, '', { padded: true })); padded++; }
    for (let guard = 0; guard < 5 && checkModel(m); guard++) fixed += resolveOverlaps(m);
    if (cut) notes.push(`${cut} merged cell${cut > 1 ? 's' : ''} cut where another cell starts`);
    if (padded) notes.push(`${padded} missing cell${padded > 1 ? 's' : ''} added (striped)`);
    if (fixed) notes.push(`${fixed} cell${fixed > 1 ? 's' : ''} at the same place left out`);
  }
  const err = checkModel(m);
  return { model: err ? null : sortCells(m), notes: err ? notes.concat(['JSON table is not a valid grid: ' + err]) : notes };
}
/* A model's JSON answer: a ```json fence or text around the object is left out; an answer cut off is read up to its
   last whole cell (noted "answer cut off", like an HTML answer without </table>). */
function parseAnswerJSON(raw) {
  let t = String(raw).replace(/^\uFEFF/, '');
  if (!/^\s*[{[]/.test(t)) { const f = t.match(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)(?:```|$)/i); if (f) t = f[1]; }
  const a = t.indexOf('{');
  if (a < 0) throw new Error('no JSON in this answer');
  t = t.slice(a);
  const end = t.lastIndexOf('}');
  let first;
  try { return { obj: JSON.parse(t.slice(0, end + 1)), cut: false }; } catch (e) { first = e; }
  const k = t.indexOf('"cells"');
  if (k < 0) throw first;
  for (let p = t.lastIndexOf('}'), tries = 0; p > k && tries < 600; p = t.lastIndexOf('}', p - 1), tries++) {
    try { return { obj: JSON.parse(t.slice(0, p + 1) + ']}'), cut: true }; } catch (e) { /* not the end of a cell */ }
  }
  throw first;
}
function modelFromAnswerJSON(raw) {
  const { obj, cut } = parseAnswerJSON(raw);
  if (!obj || !Array.isArray(obj.cells)) {
    const html = findTableHTML(obj);
    if (html) return modelFromHTML(html);
    return { model: null, notes: ['no "cells" in this JSON'] };
  }
  const res = modelFromJSON(obj, true);
  if (cut) res.notes.unshift('answer cut off: read up to its last whole cell');
  return res;
}
function importSource(src) {
  if (!S.imports[src]) {
    const p = S.detail.pre[src];
    let res;
    try { res = p.kind === 'json' ? modelFromAnswerJSON(p.text) : modelFromHTML(p.text); }
    catch (e) { res = { model: null, notes: ['could not read: ' + e.message] }; }
    if (res.model) scaleBoxes(res, (S.batch.box_formats || {})[src]);
    S.imports[src] = res;
  }
  return S.imports[src];
}

/* Boxes of a source given in another unit: norm1000 = [x0, y0, x1, y1] on 0-1000, gemini = [ymin, xmin, ymax, xmax] on 0-1000. */
function scaleBoxes(res, fmt) {
  const boxed = res.model.cells.filter(c => c.bbox);
  if (!fmt || fmt === 'pixels' || !boxed.length) return;
  const size = S.detail.image_size;
  if (!size) { boxed.forEach(c => { c.bbox = null; c.polygon = null; }); res.notes.push('boxes dropped: image size unknown'); return; }
  const [W, H] = size, sx = W / 1000, sy = H / 1000;
  for (const c of boxed) {
    const b = fmt === 'gemini' ? [c.bbox[1], c.bbox[0], c.bbox[3], c.bbox[2]] : c.bbox;
    c.bbox = [b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy].map(v => Math.round(v * 10) / 10);
    if (c.polygon) c.polygon = c.polygon.map(p => fmt === 'gemini' ? [p[1] * sx, p[0] * sy] : [p[0] * sx, p[1] * sy]);
  }
}

function toHTML(m) {
  const s = slotsOf(m);
  const lines = ['<table>'];
  for (let r = 0; r < m.nRows; r++) {
    let row = '<tr>';
    for (let k = 0; k < m.nCols; k++) {
      const c = m.cells[s[r][k]];
      if (c.r !== r || c.c !== k) continue;
      const tag = c.header ? 'th' : 'td';
      row += `<${tag}${c.rs > 1 ? ` rowspan="${c.rs}"` : ''}${c.cs > 1 ? ` colspan="${c.cs}"` : ''}>${richHTML(c.text, esc, v => esc('$' + v + '$'))}</${tag}>`;
    }
    lines.push(row + '</tr>');
  }
  lines.push('</table>');
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------------------------------
// Model: editing operations. Each returns true if the table changed.

function rectOfSel() {
  const { ar, ac, er, ec } = S.sel;
  return expandRect({ r0: Math.min(ar, er), c0: Math.min(ac, ec), r1: Math.max(ar, er), c1: Math.max(ac, ec) });
}
function expandRect(rect) {
  const m = S.model, s = S.slots;
  let { r0, c0, r1, c1 } = rect, changed = true;
  while (changed) {
    changed = false;
    for (let r = r0; r <= r1; r++) for (let k = c0; k <= c1; k++) {
      const c = m.cells[s[r][k]];
      if (c.r < r0) { r0 = c.r; changed = true; }
      if (c.c < c0) { c0 = c.c; changed = true; }
      if (c.r + c.rs - 1 > r1) { r1 = c.r + c.rs - 1; changed = true; }
      if (c.c + c.cs - 1 > c1) { c1 = c.c + c.cs - 1; changed = true; }
    }
  }
  return { r0, c0, r1, c1 };
}
/* The 4 outer corners of the boxes of merged cells (top-left, top-right, bottom-right, bottom-left). */
function mergedQuad(parts) {
  const pts = parts.filter(c => c.bbox).flatMap(c => c.polygon && c.polygon.length > 2 ? c.polygon
    : [[c.bbox[0], c.bbox[1]], [c.bbox[2], c.bbox[1]], [c.bbox[2], c.bbox[3]], [c.bbox[0], c.bbox[3]]]);
  const pick = f => pts.reduce((b, q) => (f(q) > f(b) ? q : b)).slice();
  return [pick(q => -q[0] - q[1]), pick(q => q[0] - q[1]), pick(q => q[0] + q[1]), pick(q => q[1] - q[0])];
}
function cellsInRect(rect) {
  const s = S.slots, seen = new Set();
  for (let r = rect.r0; r <= rect.r1; r++) for (let k = rect.c0; k <= rect.c1; k++) seen.add(s[r][k]);
  return Array.from(seen).sort((a, b) => a - b);
}
function activeIndex() { return S.slots[S.sel.ar][S.sel.ac]; }

const OPS = {
  merge() {
    const rect = rectOfSel(), idx = cellsInRect(rect), m = S.model;
    if (idx.length < 2) return toast('Select two or more cells to merge (Shift + arrows, or drag).'), false;
    const parts = idx.map(i => m.cells[i]).sort((a, b) => a.r - b.r || a.c - b.c);
    const text = parts.map(c => c.text).filter(Boolean).join(' ');
    const boxes = parts.map(c => c.bbox).filter(Boolean);
    const bys = new Set(parts.filter(c => c.bbox).map(c => c.box_by));
    const merged = newCell(rect.r0, rect.c0, rect.r1 - rect.r0 + 1, rect.c1 - rect.c0 + 1, text, {
      header: parts.some(c => c.header), unclear: parts.some(c => c.unclear), edited: true,
      bbox: boxes.length ? [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))] : null,
      polygon: parts.some(c => c.bbox && c.polygon && c.polygon.length > 2) ? mergedQuad(parts) : null,
      box_by: boxes.length ? (bys.size === 1 ? [...bys][0] : 'hand') : null,
    });
    const drop = new Set(idx);
    m.cells = m.cells.filter((_, i) => !drop.has(i));
    m.cells.push(merged);
    S.sel = { ar: rect.r0, ac: rect.c0, er: rect.r0, ec: rect.c0 };
    return 'merge';
  },
  split() {
    const m = S.model, rect = rectOfSel();
    const targets = cellsInRect(rect).map(i => m.cells[i]).filter(c => c.rs > 1 || c.cs > 1);
    if (!targets.length) return toast('Nothing to split: select a merged cell.'), false;
    // with grid lines for this table, each part gets its box from the lines; otherwise the parts have no box
    const g = IV.w && gridOK(S.meta.grid_lines) ? S.meta.grid_lines : null;
    for (const c of targets) {
      m.cells.splice(m.cells.indexOf(c), 1);
      for (let r = c.r; r < c.r + c.rs; r++) for (let k = c.c; k < c.c + c.cs; k++) {
        const first = r === c.r && k === c.c;
        const part = newCell(r, k, 1, 1, first ? c.text : '', { header: c.header, unclear: first && c.unclear, edited: true });
        if (g && c.bbox) {
          const P = [crossPt(g.h[r], g.v[k]), crossPt(g.h[r], g.v[k + 1]), crossPt(g.h[r + 1], g.v[k + 1]), crossPt(g.h[r + 1], g.v[k])];
          setBox(part, bboxOf(P), isPoly(c) ? P : null, 'grid');
        }
        m.cells.push(part);
      }
    }
    return 'split';
  },
  'row-above'() { return insertLine('row', rectOfSel().r0); },
  'row-below'() { const r = rectOfSel(); return insertLine('row', r.r1 + 1); },
  'col-left'() { return insertLine('col', rectOfSel().c0); },
  'col-right'() { const r = rectOfSel(); return insertLine('col', r.c1 + 1); },
  'del-rows'() { const r = rectOfSel(); return deleteLines('row', r.r0, r.r1); },
  'del-cols'() { const r = rectOfSel(); return deleteLines('col', r.c0, r.c1); },
  header() { return toggleFlag('header'); },
  unclear() { return toggleFlag('unclear'); },
  clear() {
    let n = 0;
    for (const i of cellsInRect(rectOfSel())) { const c = S.model.cells[i]; if (c.text || c.padded) { c.text = ''; c.edited = true; c.padded = false; n++; } }
    return n ? 'clear' : false;
  },
};
const AX = { row: { p: 'r', s: 'rs', n: 'nRows' }, col: { p: 'c', s: 'cs', n: 'nCols' } };
function insertLine(axis, at) {
  const m = S.model, a = AX[axis], o = axis === 'row' ? AX.col : AX.row;
  for (const c of m.cells) {
    if (c[a.p] >= at) c[a.p]++;
    else if (c[a.p] + c[a.s] > at) { c[a.s]++; c.edited = true; }
  }
  m[a.n]++;
  const s = slotsOf(m);
  for (let k = 0; k < m[o.n]; k++) {
    const rr = axis === 'row' ? at : k, cc = axis === 'row' ? k : at;
    if (s[rr][cc] === -1) m.cells.push(newCell(rr, cc, 1, 1, '', { edited: true }));
  }
  if (axis === 'row') { S.sel.ar = S.sel.er = at; } else { S.sel.ac = S.sel.ec = at; }
  return 'insert_' + axis;
}
function deleteLines(axis, from, to) {
  const m = S.model, a = AX[axis], n = to - from + 1;
  if (n >= m[a.n]) return toast(`A table needs at least one ${axis === 'row' ? 'row' : 'column'}.`), false;
  const keep = [];
  for (const c of m.cells) {
    const top = c[a.p], bot = c[a.p] + c[a.s] - 1;
    const overlap = Math.max(0, Math.min(bot, to) - Math.max(top, from) + 1);
    const left = c[a.s] - overlap;
    if (left === 0) continue;
    if (top > to) c[a.p] -= n; else if (top >= from) c[a.p] = from;
    if (overlap) { c[a.s] = left; c.edited = true; }
    keep.push(c);
  }
  m.cells = keep;
  m[a.n] -= n;
  const last = m[a.n] - 1;
  if (axis === 'row') { S.sel.ar = S.sel.er = Math.min(from, last); } else { S.sel.ac = S.sel.ec = Math.min(from, last); }
  return 'delete_' + axis;
}
/* Delete the selected cells: the cells on their right move left ('left'), or the cells below move up ('up'), and
   empty cells fill the end of those rows / columns. The boxes stay where they are on the image (they mark places),
   unless moveBoxes: then each box moves with its text. */
function deleteCells(dir, rect, moveBoxes) {
  const m = S.model, left = dir === 'left';
  const [p, ps, q, qs] = left ? ['c', 'cs', 'r', 'rs'] : ['r', 'rs', 'c', 'cs'];
  const q0 = left ? rect.r0 : rect.c0, q1 = left ? rect.r1 : rect.c1, p0 = left ? rect.c0 : rect.r0, p1 = left ? rect.c1 : rect.r1;
  const n = p1 - p0 + 1, N = left ? m.nCols : m.nRows;
  const band = m.cells.filter(c => c[q] <= q1 && c[q] + c[qs] - 1 >= q0 && c[p] + c[ps] - 1 >= p0);
  if (band.some(c => c[q] < q0 || c[q] + c[qs] - 1 > q1))
    return toast(`A merged cell goes beyond the selected ${left ? 'rows' : 'columns'}: split it first, or select all of it.`, 5000), false;
  if (band.some(c => (c[p] < p0) || (c[p] <= p1 && c[p] + c[ps] - 1 > p1)))
    return toast('A merged cell is only partly selected: split it first, or select all of it.', 5000), false;
  const boxAt = new Map();
  if (!moveBoxes) for (const c of band) if (c.bbox) boxAt.set(c.r + ',' + c.c, { bbox: c.bbox, polygon: c.polygon, by: c.box_by });
  const gone = new Set(band.filter(c => c[p] <= p1));
  m.cells = m.cells.filter(c => !gone.has(c));
  for (const c of band) if (c[p] > p1) { c[p] -= n; c.edited = true; }
  const sl = slotsOf(m);
  for (let k = q0; k <= q1; k++) for (let j = N - n; j < N; j++) {
    const r = left ? k : j, cc = left ? j : k;
    if (sl[r][cc] === -1) m.cells.push(newCell(r, cc, 1, 1, '', { edited: true }));
  }
  if (!moveBoxes) for (const c of m.cells) {
    if (c[q] < q0 || c[q] > q1 || c[p] < p0) continue;
    const b = boxAt.get(c.r + ',' + c.c);
    if (b) setBox(c, b.bbox, b.polygon, b.by || 'model'); else setBox(c, null, null);
  }
  S.sel = { ar: rect.r0, ac: rect.c0, er: rect.r0, ec: rect.c0 };
  return 'delete_cells_' + dir;
}
function deleteCellsDialog() {
  const rect = rectOfSel(), m = S.model, cells = cellsInRect(rect).map(i => m.cells[i]);
  const name = `${colName(rect.c0)}${rect.r0 + 1}` + (rect.r0 !== rect.r1 || rect.c0 !== rect.c1 ? `:${colName(rect.c1)}${rect.r1 + 1}` : '');
  const rows = rect.r0 === rect.r1 ? `row ${rect.r0 + 1}` : `rows ${rect.r0 + 1}–${rect.r1 + 1}`;
  const cols = rect.c0 === rect.c1 ? `column ${colName(rect.c0)}` : `columns ${colName(rect.c0)}–${colName(rect.c1)}`;
  const boxes = m.cells.some(c => c.bbox);
  openModal(`<h2>Delete ${cells.length === 1 ? 'the cell' : 'the cells'} ${name}?</h2>
    <p>${plural(cells.length, 'cell')}, ${cells.filter(c => c.text).length} with text. You can undo with Ctrl+Z.</p>
    <div class="choices">
      <label><input type="radio" name="dc" value="left" checked> Move the cells on the right to the left (${rows} get empty cells at the end)</label>
      <label><input type="radio" name="dc" value="up"> Move the cells below up (${cols} get empty cells at the bottom)</label>
      <label><input type="radio" name="dc" value="rows"> Delete the whole ${rows}</label>
      <label><input type="radio" name="dc" value="cols"> Delete the whole ${cols}</label>
    </div>
    ${boxes ? `<label><input type="checkbox" id="dc-boxes"${LS.get('dcboxes', false) ? ' checked' : ''}> The boxes move with their text (unticked: the boxes stay where they are on the image)</label>` : ''}
    <div class="actions"><button data-close>Cancel</button><button class="primary danger-bg" id="dc-ok">Delete</button></div>`);
  $('#dc-ok').onclick = () => {
    const how = $('input[name=dc]:checked').value, mb = !!($('#dc-boxes') && $('#dc-boxes').checked);
    if ($('#dc-boxes')) LS.set('dcboxes', mb);
    closeModal();
    if (how === 'rows') return apply('del-rows', OPS['del-rows']);
    if (how === 'cols') return apply('del-cols', OPS['del-cols']);
    apply('del-cells', () => deleteCells(how, rect, mb));
  };
}
function toggleFlag(flag) {
  const cells = cellsInRect(rectOfSel()).map(i => S.model.cells[i]);
  const on = !cells.every(c => c[flag]);
  cells.forEach(c => { c[flag] = on; });
  return flag;
}
function setCellText(i, text) {
  const c = S.model.cells[i];
  text = normText(text);
  if (c.text === text) return false;
  c.text = text; c.edited = true; c.padded = false;
  return 'text';
}

/* Run an operation with undo, re-render and autosave. */
function snapshot() { return { model: cloneModel(S.model), sel: Object.assign({}, S.sel), from: S.meta.started_from }; }
function restore(st) { S.model = st.model; S.sel = st.sel; S.meta.started_from = st.from; }
function apply(name, fn) {
  endAssign(); polyCancel();  // cell indices change
  const before = snapshot();
  let kind, err;
  try { kind = fn(); } catch (e) { kind = 'error'; err = e.message; console.error(e); }
  if (!kind) { restore(before); refreshSlots(); return false; }
  sortCells(S.model);
  err = err || checkModel(S.model);
  if (err) {  // never keep a broken grid
    restore(before); refreshSlots(); renderGrid();
    toast('That change would break the grid (' + err + '). Nothing was changed.');
    console.error('broken grid after', name, err);
    return false;
  }
  S.undo.push(before); if (S.undo.length > 300) S.undo.shift();
  S.redo = [];
  S.meta.edit_counts[kind] = (S.meta.edit_counts[kind] || 0) + 1;
  changed();
  return true;
}
function undo() {
  endAssign();
  if (BX.grid) return gridUndo(false);
  if (!S.undo.length) return toast('Nothing to undo.');
  const back = BX.lastGrid && S.undo[S.undo.length - 1] === BX.lastGrid.snap ? BX.lastGrid.g : null;
  S.redo.push(snapshot());
  restore(S.undo.pop()); changed(); renderSourceSelect();
  if (back) { BX.lastGrid = null; openGrid('again', back); toast('Make boxes undone: the grid is open again with its lines.', 5000); }
}
function redo() {
  endAssign();
  if (BX.grid) return gridUndo(true);
  if (!S.redo.length) return toast('Nothing to redo.');
  S.undo.push(snapshot());
  restore(S.redo.pop()); changed(); renderSourceSelect();
}
function refreshSlots() {
  S.slots = slotsOf(S.model);
  const m = S.model;
  S.sel.ar = clamp(S.sel.ar, 0, m.nRows - 1); S.sel.er = clamp(S.sel.er, 0, m.nRows - 1);
  S.sel.ac = clamp(S.sel.ac, 0, m.nCols - 1); S.sel.ec = clamp(S.sel.ec, 0, m.nCols - 1);
}
function changed() {
  refreshSlots();
  renderGrid();
  S.dirty = true;
  if (S.meta.status === 'todo') { S.meta.status = 'in_progress'; renderTopbar(); }
  scheduleSave();
  if (CMP) cmpRefresh();
}

// ------------------------------------------------------------------------------------------
// Saving

function scheduleSave(delay = 1200) {
  clearTimeout(S.saveTimer);
  setSaveState('Unsaved changes…');
  S.saveTimer = setTimeout(() => save(), delay);
}
function setSaveState(text, err) { const el = $('#save-state'); el.textContent = text; el.classList.toggle('err', !!err); }
function annotationJSON() {
  const m = S.model, d = S.detail;
  return {
    schema: SCHEMA,
    table_id: S.tid, image: d.image_file, image_sha256: d.image_sha256,
    image_size: d.image_size || undefined,  // [width, height]: boxes are in pixels of this image
    annotator: S.annotator,
    status: S.meta.status === 'todo' ? 'in_progress' : S.meta.status,
    skip_reason: S.meta.skip_reason || null,
    flagged: !!S.meta.flagged, comment: S.meta.comment || '',
    started_from: S.meta.started_from,
    n_rows: m.nRows, n_cols: m.nCols,
    cells: m.cells.map(c => {
      const o = { row: c.r, col: c.c, rowspan: c.rs, colspan: c.cs, text: c.text, header: !!c.header, unclear: !!c.unclear };
      if (c.edited) o.edited = true;
      if (c.bbox) o.bbox = c.bbox;
      if (c.polygon) o.polygon = c.polygon;
      if (c.bbox) o.box_by = c.box_by || 'model';
      return o;
    }),
    grid_lines: gridOK(S.meta.grid_lines) ? S.meta.grid_lines : undefined,  // dropped once rows or columns change
    edit_counts: S.meta.edit_counts,
    time_active_s: Math.round(S.active.seconds),
    cursor: [S.sel.ar, S.sel.ac],
    rev: S.meta.rev || 0,
    created: S.meta.created || undefined,
    html: toHTML(m),
  };
}
async function save(force) {
  clearTimeout(S.saveTimer);
  if (!S.tid || S.conflict) return false;
  if (!S.dirty && !force) return true;
  if (S.saving) { scheduleSave(400); return false; }
  const err = checkModel(S.model);
  if (err) { setSaveState('Not saved: ' + err, true); return false; }
  S.saving = true;
  const tid = S.tid, body = annotationJSON();
  S.dirty = false;
  setSaveState('Saving…');
  try {
    const res = await api(`/api/annotation/${encodeURIComponent(tid)}?${q()}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (S.tid === tid) {
      S.meta.rev = res.rev; S.active.saved = body.time_active_s; S.meta.created = S.meta.created || res.modified;
      const t = new Date();
      setSaveState('Saved ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }
    const task = S.tasks.find(t => t.table_id === tid);
    if (task) { task.status = body.status; task.flagged = body.flagged; task.time_active_s = body.time_active_s; }
    return true;
  } catch (e) {
    S.dirty = true;
    if (e.status === 409) {
      S.conflict = true;
      showBanner('This table was saved from another window or tab. Your last changes here are NOT saved. Reload the page to see the saved version.', true);
      setSaveState('Not saved (conflict)', true);
    } else {
      setSaveState('Not saved: ' + e.message + ' (retrying)', true);
      S.saveTimer = setTimeout(() => save(), 5000);
    }
    return false;
  } finally { S.saving = false; }
}
window.addEventListener('beforeunload', e => {
  if (!S.dirty || !S.tid || S.conflict) return;
  try {
    const tid = S.tid;
    fetch(`/api/annotation/${encodeURIComponent(tid)}?${q()}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(annotationJSON()) })
      .then(r => r.ok ? r.json() : null).then(res => { if (res && S.tid === tid) { S.meta.rev = res.rev; } });  // if the person stays on the page
  } catch (err) { /* body too large for keepalive: the prompt below still warns */ }
  e.preventDefault(); e.returnValue = '';
});

// Active time: counts while the page is visible, focused and used in the last 90 s.
['keydown', 'pointerdown', 'wheel', 'pointermove'].forEach(ev => document.addEventListener(ev, () => { S.active.last = Date.now(); }, { passive: true }));
setInterval(() => {
  if (S.view === 'edit' && document.visibilityState === 'visible' && document.hasFocus() && Date.now() - S.active.last < 90000) S.active.seconds += 1;
}, 1000);

// ------------------------------------------------------------------------------------------
// Home view

async function leaveTask() {
  if (S.view !== 'edit' || !S.tid) return;
  stopEditing(true);
  if (!S.dirty && S.meta.rev && S.active.seconds - (S.active.saved || 0) >= 5) S.dirty = true;
  await save();
}
async function showHome(keepHash) {
  await leaveTask();
  S.view = 'home'; S.tid = null;
  $('#editor').hidden = true; $('#home').hidden = false;
  if (!keepHash) history.replaceState(null, '', '#');  // kept while a link to a table is being opened (reload-safe)
  S.tasks = await api('/api/tasks?' + q());
  renderHome();
}
function myTasks() {
  const anyAssigned = S.tasks.some(t => t.assigned_to.length);
  let list = S.tasks;
  if (S.filter === 'mine' && anyAssigned) list = list.filter(t => !t.assigned_to.length || t.assigned_to.includes(S.annotator));
  if (S.search) { const s = S.search.toLowerCase(); list = list.filter(t => (t.table_id + ' ' + t.group).toLowerCase().includes(s)); }
  return list;
}
const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', done: 'Done', skipped: 'Skipped' };
function fmtTime(s) { s = Math.round(s || 0); if (!s) return ''; const m = Math.floor(s / 60); return m ? `${m} min` : `${s} s`; }
function renderHome() {
  $('#batch-name').textContent = S.batch.name;
  $('#who-home').textContent = S.annotator || 'choose…';
  const list = myTasks();
  const count = st => list.filter(t => t.status === st).length;
  const n = list.length || 1, done = count('done'), skip = count('skipped'), wip = count('in_progress');
  $('#progress-text').innerHTML = `<b>${done}</b> done · ${skip} skipped · ${wip} in progress · ${list.length - done - skip - wip} to do <span class="muted">(${list.length} tables)</span>`;
  $('#progress-done').style.width = (100 * done / n) + '%';
  $('#progress-skip').style.width = (100 * skip / n) + '%';
  $('#progress-wip').style.width = (100 * wip / n) + '%';
  $$('input[name=filter]').forEach(r => { r.checked = r.value === S.filter; });
  const tb = $('#task-table tbody');
  tb.innerHTML = list.map(t => {
    const pos = S.tasks.indexOf(t) + 1;
    const others = t.by.filter(b => b.annotator !== S.annotator).map(b => `<span class="badge ${b.status}">${esc(b.annotator)}</span>`).join('');
    return `<tr data-id="${escAttr(t.table_id)}">
      <td class="num">${pos}</td><td class="id">${esc(t.table_id)}</td><td>${esc(t.group)}</td>
      <td>${t.sources.map(s => `<span class="src-tag">${esc(s)}</span>`).join('') || '<span class="muted">none</span>'}</td>
      <td>${esc(t.assigned_to.join(', ')) || '<span class="muted">anyone</span>'}</td>
      <td><span class="badge ${t.status}">${STATUS_LABEL[t.status] || t.status}</span>${t.flagged ? ' <span class="badge flag">flag</span>' : ''}</td>
      <td class="num">${fmtTime(t.time_active_s)}</td><td class="others">${others}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">No tables.</td></tr>';
  const next = nextTodo(null);
  $('#btn-continue').textContent = next ? 'Continue →' : 'All done';
  $('#btn-continue').disabled = !next;
}
function nextTodo(fromId) {
  const list = myTasks();
  const start = fromId ? list.findIndex(t => t.table_id === fromId) + 1 : 0;
  const order = list.slice(start).concat(list.slice(0, start)).filter(t => t.table_id !== fromId);
  if (!fromId) { const wip = order.find(t => t.status === 'in_progress'); if (wip) return wip; }
  return order.find(t => t.status === 'todo' || t.status === 'in_progress');
}

// ------------------------------------------------------------------------------------------
// Editor: open a table

async function openTask(tid) {
  endAssign(); polyCancel(); BX.none = false; BX.lastGrid = null;
  const cmpWas = CMP && { name: CMP.src.name, mode: CMP.mode };  // the same source is compared on the next table
  if (CMP) { CMP = null; $('#cmp').hidden = true; cmpOverlay(); }
  await leaveTask();
  if (S.conflict) { S.conflict = false; hideBanner(); }
  const detail = await api(`/api/task/${encodeURIComponent(tid)}?${q()}`);
  S.view = 'edit'; S.tid = tid; S.detail = detail; S.imports = {};
  S.undo = []; S.redo = []; S.dirty = false;
  $('#home').hidden = true; $('#editor').hidden = false;
  history.replaceState(null, '', '#' + encodeURIComponent(tid));
  const ann = detail.annotation;
  S.meta = {
    status: ann ? ann.status : 'todo', skip_reason: ann ? ann.skip_reason : null,
    flagged: ann ? !!ann.flagged : false, comment: ann ? ann.comment || '' : '',
    started_from: ann ? ann.started_from : null, edit_counts: ann ? (ann.edit_counts || {}) : {},
    rev: ann ? ann.rev : 0, created: ann ? ann.created : null, grid_lines: ann ? ann.grid_lines || null : null,
  };
  closeGrid(false);
  S.active.seconds = S.active.saved = ann ? (ann.time_active_s || 0) : 0;
  hideBanner();
  let notes = [];
  if (ann) {
    const res = modelFromJSON(ann);
    if (!res.model) { showBanner('The saved file of this table could not be read: ' + res.notes.join('; '), true); S.model = emptyModel(1, 1); }
    else S.model = res.model;
    setSaveState(`Saved ${new Date(ann.modified).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`);
  } else {
    const first = defaultSource();
    if (first && S.batch.prefill !== 'none') {
      const mode = S.batch.prefill === 'structure' ? 'structure' : 'full';
      S.model = startModel(first, mode);
      notes = importSource(first).notes.concat(mixStart(S.model));
    } else {
      S.model = emptyModel(10, 5);
      S.meta.started_from = { source: null, mode: 'empty', time: new Date().toISOString() };
    }
    setSaveState('Not started');
  }
  const cur = ann && Array.isArray(ann.cursor) ? ann.cursor : [0, 0];
  S.sel = { ar: cur[0], ac: cur[1], er: cur[0], ec: cur[1] };
  refreshSlots();
  renderTopbar();
  renderSourceSelect();
  renderCmpSelect();
  renderPalette();
  setImportNotes(notes);
  loadImage();
  renderGrid();
  setBoxMode(LS.get('boxmode', false));
  applyAdjust(); applyLineColors();
  $('#gridwrap').scrollTo(0, 0);
  renderSel();
  $('#gridwrap').focus();
  if (cmpWas && detail.pre[cmpWas.name] && importSource(cmpWas.name).model) cmpOpen(batchSource(cmpWas.name), cmpWas.mode);
  if (!ann && !Object.keys(detail.pre).length) setTimeout(() => emptyGridDialog(true), 50);
}
/* First source in the batch order that is usable; a source cut off or much smaller than the others is passed over. */
function defaultSource() {
  const ok = S.batch.sources.filter(s => S.detail.pre[s] && importSource(s).model);
  if (!ok.length) return null;
  const size = s => importSource(s).model.cells.length;
  const biggest = Math.max(...ok.map(size));
  const good = ok.find(s => !importSource(s).notes.some(n => n.startsWith('answer cut off')) && size(s) >= 0.5 * biggest);
  return good || ok.reduce((a, b) => (size(b) > size(a) ? b : a));
}
function startModel(src, mode) {
  const p = S.detail.pre[src];
  const m = cloneModel(importSource(src).model);
  if (mode === 'structure') m.cells.forEach(c => { c.text = ''; });
  if (S.batch.box_prefill === 'none') m.cells.forEach(c => { c.bbox = null; c.polygon = null; });
  S.meta.started_from = { source: src, mode, file: p.file, sha256: p.sha256, time: new Date().toISOString() };
  return m;
}
function setImportNotes(notes) {
  const src = S.meta && S.meta.started_from && S.meta.started_from.source;
  $('#import-notes').textContent = notes && notes.length ? `${src || 'Pre-annotation'}: ${notes.join(' · ')}` : '';
  $('#import-notes').title = $('#import-notes').textContent;
}
function renderTopbar() {
  const list = myTasks(), pos = list.findIndex(t => t.table_id === S.tid);
  $('#t-pos').textContent = pos >= 0 ? `${pos + 1} / ${list.length}` : '';
  const t = S.detail.task;
  $('#t-id').textContent = t.table_id;
  $('#t-id').title = t.table_id;
  $('#t-group').textContent = [t.group, t.note].filter(Boolean).join(' · ');
  const st = $('#t-status');
  st.className = 'badge ' + S.meta.status;
  st.textContent = (STATUS_LABEL[S.meta.status] || S.meta.status) + (S.meta.status === 'skipped' && S.meta.skip_reason ? ': ' + S.meta.skip_reason : '');
  $('#btn-note').textContent = S.meta.flagged ? '⚑ Flagged' : (S.meta.comment ? 'Note •' : 'Note');
  $('#btn-note').style.color = S.meta.flagged ? 'var(--flag)' : '';
  $('#who-edit').textContent = S.annotator;
}
function renderSourceSelect() {
  const sel = $('#src-select');
  const sf = S.meta.started_from || {};
  const opts = S.batch.sources.filter(s => S.detail.pre[s]).map(s => {
    const res = importSource(s);
    const size = res.model ? `${res.model.nRows}×${res.model.nCols}` : 'unreadable';
    const warn = !res.model || res.notes.some(n => n.startsWith('answer cut off')) ? ' ⚠ ' + (res.model ? 'cut off' : '') : '';
    return `<option value="${escAttr(s)}">${esc(s)} (${size})${warn}</option>`;
  });
  if (sf.source && !S.detail.pre[sf.source]) opts.unshift(`<option value="__cur" disabled>${esc(sf.source)}</option>`);
  opts.push('<option value="__file">From a file…</option>', '<option value="__empty">New empty table…</option>');
  sel.innerHTML = opts.join('');
  sel.value = sf.source ? (S.detail.pre[sf.source] ? sf.source : '__cur') : '__empty';
  sel.dataset.current = sel.value;
  const how = { full: 'structure and text', structure: 'structure only' }[sf.mode] || sf.mode;
  sel.title = (sf.source ? `This table comes from ${sf.source} (${how})` : 'This table started from an empty grid')
    + (sf.mixed && sf.mixed.length ? ', mixed with ' + sf.mixed.map(x => `the ${x.part} of ${x.source}`).join(', ') : '')
    + '.\nChoose a source, or a file, to import its text, its structure or its boxes: you see the changes before they are made.';
}
// ------------------------------------------------------------------------------------------
// Symbols ▾: the batch's special characters, your own ones and lists of uncommon symbols. Click one to put it in
// the cell. Alt+1…Alt+9: the first nine (the batch's, then yours). Your own are kept in this browser, per annotator.

const SYMBOL_SETS = [
  ['Numbers and measures', [['½', 'fraction one half'], ['⅓', 'fraction one third'], ['⅔', 'fraction two thirds'], ['¼', 'fraction one quarter'], ['¾', 'fraction three quarters'], ['⅕', 'fraction one fifth'], ['⅙', 'fraction one sixth'], ['⅛', 'fraction one eighth'], ['⅜', 'fraction three eighths'], ['⅝', 'fraction five eighths'], ['⅞', 'fraction seven eighths'],
    ['°', 'degree'], ['′', 'minute (prime)'], ['″', 'second (double prime)'], ['‴', 'third (triple prime)'], ['±', 'plus-minus'], ['×', 'times'], ['÷', 'divided by'], ['−', 'minus'], ['∞', 'infinity'], ['≈', 'almost equal'], ['√', 'square root'], ['‰', 'per mille'], ['№', 'numero'],
    ['⁰', 'superscript 0'], ['¹', 'superscript 1'], ['²', 'superscript 2'], ['³', 'superscript 3'], ['⁴', 'superscript 4'], ['⁵', 'superscript 5'], ['⁶', 'superscript 6'], ['⁷', 'superscript 7'], ['⁸', 'superscript 8'], ['⁹', 'superscript 9'],
    ['₀', 'subscript 0'], ['₁', 'subscript 1'], ['₂', 'subscript 2'], ['₃', 'subscript 3']]],
  ['Astronomy', [['☉', 'Sun'], ['☽', 'Moon, first quarter'], ['☾', 'Moon, last quarter'], ['●', 'new moon'], ['○', 'full moon'], ['☿', 'Mercury'], ['♀', 'Venus'], ['♁', 'Earth'], ['♂', 'Mars'], ['♃', 'Jupiter'], ['♄', 'Saturn'], ['♅', 'Uranus'], ['♆', 'Neptune'],
    ['☊', 'ascending node'], ['☋', 'descending node'], ['☌', 'conjunction'], ['☍', 'opposition'], ['□', 'quadrature (square)'], ['△', 'trine'], ['⚹', 'sextile'], ['✶', 'star'],
    ['♈', 'Aries'], ['♉', 'Taurus'], ['♊', 'Gemini'], ['♋', 'Cancer'], ['♌', 'Leo'], ['♍', 'Virgo'], ['♎', 'Libra'], ['♏', 'Scorpio'], ['♐', 'Sagittarius'], ['♑', 'Capricorn'], ['♒', 'Aquarius'], ['♓', 'Pisces']]],
  ['Signs and marks', [['"', 'ditto mark (straight quote)'], ['〃', 'ditto mark'], ['—', 'em dash'], ['–', 'en dash'], ['·', 'middle dot'], ['†', 'dagger'], ['‡', 'double dagger'], ['§', 'section'], ['¶', 'pilcrow'], ['※', 'reference mark'], ['⁂', 'asterism'], ['∗', 'asterisk'], ['∴', 'therefore'], ['∵', 'because'], ['‖', 'double bar'], ['¦', 'broken bar'], ['✓', 'check mark'], ['✗', 'cross mark'],
    ['£', 'pound'], ['ƒ', 'florin'], ['¢', 'cent'], ['℔', 'pound weight (lb)'], ['℥', 'ounce'], ['ʒ', 'drachm'], ['℈', 'scruple'], ['℞', 'recipe']]],
  ['Letters and abbreviations', [['ſ', 'long s'], ['ꝑ', 'p with stroke (per)'], ['ꝓ', 'p with flourish (pro)'], ['ꝗ', 'q with stroke (quod)'], ['ꝙ', 'q with diagonal stroke (quam)'], ['ꝯ', 'con'], ['ꝰ', 'us'], ['ꝝ', 'rum'], ['ꝛ', 'r rotunda'], ['⁊', 'Tironian et'], ['&', 'ampersand'],
    ['þ', 'thorn'], ['ð', 'eth'], ['ȝ', 'yogh'], ['æ', 'ae'], ['œ', 'oe'], ['̄', 'combining macron (over the letter before)'], ['̃', 'combining tilde (over the letter before)'], ['̅', 'combining overline']]],
];
const SYM_NAME = new Map(SYMBOL_SETS.flatMap(([, list]) => list));
function mySymbols() { const all = LS.get('symbols', {}); return Array.isArray(all[S.annotator]) ? all[S.annotator] : []; }
function setMySymbols(list) { const all = LS.get('symbols', {}); all[S.annotator] = list; LS.set('symbols', all); }
function quickSymbols() { return [...new Set((S.batch.special_chars || []).concat(mySymbols()))]; }
function symCode(ch) { return Array.from(ch).map(x => 'U+' + x.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '); }
function symShow(ch) { return /^\p{M}+$/u.test(ch) ? '◌' + ch : ch; }
function renderPalette() {
  $('#palette').innerHTML = `<button data-rich="sup" title="Superscript: select characters while you edit, then click (Ctrl+.). Click again to take it off. Saved as <sup>…</sup>">x<sup>2</sup></button><button data-rich="sub" title="Subscript: select characters while you edit, then click (Ctrl+,). Click again to take it off. Saved as <sub>…</sub>">x<sub>2</sub></button><button data-rich="math" title="Formula in LaTeX between $…$, drawn as a formula: select it while you edit and click, or type the $ yourself. E.g. $\\frac12$, $x^2$, $\\sqrt2$, $\\alpha+\\beta$">ƒ(x)</button><button id="sym-btn" title="Special symbols: click one to put it in the cell, or add your own. Alt+1…Alt+9: the first nine (${escAttr(quickSymbols().slice(0, 9).join(' '))})">Ω Symbols ▾</button>`;
  if (!$('#sym-pop').hidden) renderSymList();
}
function openSymPop() {
  const pop = $('#sym-pop');
  pop.innerHTML = `<div class="sym-head"><b>Symbols</b><input id="sym-find" type="text" placeholder="Find: moon, fraction, 263D…" spellcheck="false" autocomplete="off"><button class="icon" id="sym-close" title="Close (Esc)">✕</button></div>
    <div id="sym-list"></div>
    <div class="sym-add"><input id="sym-new" type="text" placeholder="Add your own: paste or type, spaces between" spellcheck="false" autocomplete="off"><button id="sym-add">Add</button></div>
    <div class="sym-foot">Click a symbol to put it in the cell (while you edit, at the cursor); the list stays open. Type to find one, <kbd>Enter</kbd> puts the first found. <b>+</b> on a symbol adds it to yours, <b>×</b> removes one of yours. Yours are kept in this browser for ${esc(S.annotator)}.</div>`;
  pop.hidden = false;
  $('#sym-btn').classList.add('on');
  renderSymList();
  const b = $('#sym-btn').getBoundingClientRect(), w = pop.offsetWidth;
  pop.style.left = clamp(b.right - w, 8, window.innerWidth - w - 8) + 'px';
  pop.style.top = (b.bottom + 4) + 'px';
  pop.style.maxHeight = (window.innerHeight - b.bottom - 16) + 'px';
  $('#sym-find').addEventListener('input', renderSymList);
  $('#sym-find').addEventListener('keydown', e => {  // Enter puts the first symbol found in the cell
    if (e.key !== 'Enter') return;
    e.preventDefault(); e.stopPropagation();
    const b = $('#sym-list button.sym');
    if (b) insertChar(b.dataset.ch);
  });
  $('#sym-find').focus({ preventScroll: true });
  $('#sym-close').addEventListener('click', closeSymPop);
  const add = () => { addMySymbols($('#sym-new').value); $('#sym-new').value = ''; };
  $('#sym-add').addEventListener('click', add);
  $('#sym-new').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(); } });
}
function closeSymPop() {
  $('#sym-pop').hidden = true; $('#sym-pop').innerHTML = '';
  const b = $('#sym-btn'); if (b) b.classList.remove('on');
  if (S.view === 'edit') (S.editing !== null ? $('#cell-input') : $('#gridwrap')).focus({ preventScroll: true });
}
function renderSymList() {
  const list = $('#sym-list');
  if (!list) return;
  const q = ($('#sym-find').value || '').trim().toLowerCase(), qh = q.replace(/^u\+/, '');
  const quick = quickSymbols(), batch = S.batch.special_chars || [], mine = mySymbols().filter(ch => !batch.includes(ch));
  const hit = ch => !q || ch.toLowerCase().includes(q) || (SYM_NAME.get(ch) || '').toLowerCase().includes(q) || (qh.length >= 2 && symCode(ch).toLowerCase().includes(qh));
  const btn = (ch, kind) => {
    const i = quick.indexOf(ch), alt = i >= 0 && i < 9 ? i + 1 : 0, name = SYM_NAME.get(ch) || '';
    const tip = [name, fracTex(ch) ? 'puts ' + fracTex(ch) : symCode(ch), alt ? 'Alt+' + alt : ''].filter(Boolean).join(' · ');
    const extra = kind === 'mine' ? '<i data-del title="Remove from my symbols">×</i>' : kind === 'set' && !quick.includes(ch) ? '<i data-pin title="Add to my symbols">+</i>' : '';
    return `<button class="sym" data-ch="${escAttr(ch)}" title="${escAttr(tip)}">${esc(symShow(ch))}${alt ? `<small>${alt}</small>` : ''}${extra}</button>`;
  };
  const sec = (title, chars, kind, empty) => {
    const l = chars.filter(hit);
    if (!l.length && !(empty && !q)) return '';
    return `<div class="sym-sec"><div class="sym-t">${esc(title)}</div>${l.length ? `<div class="sym-grid">${l.map(ch => btn(ch, kind)).join('')}</div>` : `<p class="sym-none">${empty}</p>`}</div>`;
  };
  let html = sec('This batch', batch, 'batch') + sec('Mine', mine, 'mine', 'None yet: add them below, or with + on a symbol.');
  for (const [title, set] of SYMBOL_SETS) html += sec(title, set.map(x => x[0]), 'set');
  list.innerHTML = html || '<p class="sym-none">No symbol matches.</p>';
}
function addMySymbols(str) {
  const add = String(str || '').split(/\s+/).filter(Boolean), mine = mySymbols(), batch = S.batch.special_chars || [];
  const fresh = add.filter((t, i) => !mine.includes(t) && !batch.includes(t) && add.indexOf(t) === i);
  if (!fresh.length) return toast(add.length ? 'Already in your symbols.' : 'Type or paste the symbols to add, separated by spaces.');
  setMySymbols(mine.concat(fresh)); renderPalette();
  toast(`Added: ${fresh.join(' ')}`);
}

// ------------------------------------------------------------------------------------------
// Editor: grid rendering and selection

function colName(k) { let s = ''; k++; while (k > 0) { const r = (k - 1) % 26; s = String.fromCharCode(65 + r) + s; k = Math.floor((k - 1) / 26); } return s; }
function cellHTML(text) {
  return richHTML(text, s => esc(s).replace(/&quot;|"/g, '<span class="q">"</span>'));
}
let TD = [];  // cell index -> td element
function renderGrid() {
  const m = S.model, s = S.slots;
  const parts = ['<thead><tr><th class="corner"></th>'];
  for (let k = 0; k < m.nCols; k++) parts.push(`<th class="colh" data-c="${k}">${colName(k)}</th>`);
  parts.push('</tr></thead><tbody>');
  for (let r = 0; r < m.nRows; r++) {
    parts.push(`<tr><th class="rowh" data-r="${r}">${r + 1}</th>`);
    for (let k = 0; k < m.nCols; k++) {
      const i = s[r][k], c = m.cells[i];
      if (c.r !== r || c.c !== k) continue;
      const cls = [c.header && 'h', c.unclear && 'unc', c.edited && 'ed', c.padded && 'pad', !c.bbox && needsBox(c) && 'nb'].filter(Boolean).join(' ');
      parts.push(`<td data-i="${i}"${c.rs > 1 ? ` rowspan="${c.rs}"` : ''}${c.cs > 1 ? ` colspan="${c.cs}"` : ''}${cls ? ` class="${cls}"` : ''}>${cellHTML(c.text)}</td>`);
    }
    parts.push('</tr>');
  }
  parts.push('</tbody>');
  const grid = $('#grid');
  grid.innerHTML = parts.join('');
  applyViewPrefs();
  TD = [];
  $$('td', grid).forEach(td => { TD[+td.dataset.i] = td; });
  drawBoxes();
  renderSel();
  renderStats();
  cmpMarkGrid();
}
function renderSel(scroll = true) {
  $$('#grid td.sel, #grid td.act').forEach(td => td.classList.remove('sel', 'act'));
  $$('#grid th.hl').forEach(th => th.classList.remove('hl'));
  const rect = rectOfSel();
  for (const i of cellsInRect(rect)) TD[i] && TD[i].classList.add('sel');
  const ai = activeIndex(), td = TD[ai];
  if (td) { td.classList.add('act'); if (scroll) td.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  for (let k = rect.c0; k <= rect.c1; k++) { const th = $(`#grid th.colh[data-c="${k}"]`); th && th.classList.add('hl'); }
  for (let r = rect.r0; r <= rect.r1; r++) { const th = $(`#grid th.rowh[data-r="${r}"]`); th && th.classList.add('hl'); }
  renderCellbar();
  renderBoxbar();
  drawOverlay();
  if (CMP) cmpFollow(scroll);
}
function renderCellbar() {
  const c = S.model.cells[activeIndex()], rect = rectOfSel();
  const n = cellsInRect(rect).length, multi = n > 1;
  $('#cell-ref').textContent = multi ? `${colName(rect.c0)}${rect.r0 + 1}:${colName(rect.c1)}${rect.r1 + 1}` : `${colName(c.c)}${c.r + 1}`;
  const info = [];
  const nr = rect.r1 - rect.r0 + 1, nc = rect.c1 - rect.c0 + 1;
  if (multi) info.push(`${n} cells selected (${nr} row${nr > 1 ? 's' : ''} × ${nc} column${nc > 1 ? 's' : ''})`);
  else {
    if (c.rs > 1 || c.cs > 1) info.push(`merged ${c.rs}×${c.cs}`);
    if (c.header) info.push('header');
    if (c.unclear) info.push('unclear');
    if (c.padded) info.push('added (row was short)');
    if (BX.on) info.push(boxWord(c));
  }
  $('#cell-info').textContent = info.join(' · ');
  const t = multi ? '' : c.text;
  $('#cell-text').innerHTML = t ? cellHTML(t) : '<span class="muted">empty</span>';
  $('#cell-text').title = t;
  $('#cell-text').style.visibility = multi ? 'hidden' : '';
}
function renderStats() {
  const m = S.model;
  const empty = m.cells.filter(c => !c.text).length, edited = m.cells.filter(c => c.edited).length, merged = m.cells.filter(c => c.rs > 1 || c.cs > 1).length;
  $('#stats').textContent = `${m.nRows} rows × ${m.nCols} cols · ${m.cells.length} cells · ${merged} merged · ${empty} empty · ${edited} changed`;
}
function setSel(r, c, extend = false) {
  if (BX.multi && !BX.keepMulti) BX.multi = null;
  if (!BX.keepNone) BX.none = false;
  r = clamp(r, 0, S.model.nRows - 1); c = clamp(c, 0, S.model.nCols - 1);
  if (extend) { S.sel.er = r; S.sel.ec = c; } else S.sel = { ar: r, ac: c, er: r, ec: c };
  renderSel();
}
function move(dr, dc, extend) {
  const sel = S.sel, m = S.model;
  const fr = extend ? sel.er : sel.ar, fc = extend ? sel.ec : sel.ac;
  const cur = m.cells[S.slots[fr][fc]];
  let r = fr, c = fc;
  if (dr > 0) r = cur.r + cur.rs; else if (dr < 0) r = cur.r - 1;
  if (dc > 0) c = cur.c + cur.cs; else if (dc < 0) c = cur.c - 1;
  setSel(clamp(r, 0, m.nRows - 1), clamp(c, 0, m.nCols - 1), extend);
}
function selectLines(axis) {
  const rect = rectOfSel(), m = S.model;
  if (axis === 'row') S.sel = { ar: rect.r0, ac: 0, er: rect.r1, ec: m.nCols - 1 };
  else S.sel = { ar: 0, ac: rect.c0, er: m.nRows - 1, ec: rect.c1 };
  renderSel(false);
}

function applyViewPrefs() {
  const mono = !!LS.get('mono', false), edits = !!LS.get('edits', true);
  $('#grid').classList.toggle('mono', mono);
  $('#grid').classList.toggle('show-edits', edits);
  $('[data-op="mono"]').classList.toggle('on', mono);
  $('[data-op="edits"]').classList.toggle('on', edits);
}

// ------------------------------------------------------------------------------------------
// Editor: in-place text editing

function startEditing(initial) {
  if (S.editing !== null) return;
  const i = activeIndex(), td = TD[i];
  if (!td) return;
  td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const inp = $('#cell-input'), wrap = $('#gridwrap');
  const tr = td.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  inp.style.left = (tr.left - wr.left + wrap.scrollLeft) + 'px';
  inp.style.top = (tr.top - wr.top + wrap.scrollTop) + 'px';
  inp.style.minWidth = Math.max(tr.width, 80) + 'px';
  inp.style.height = Math.max(tr.height, 28) + 'px';
  inp.value = initial !== undefined ? initial : S.model.cells[i].text;
  inp.hidden = false;
  S.editing = i;
  fitInput();
  inp.focus();
  const n = inp.value.length; inp.setSelectionRange(n, n);
}
function fitInput() {
  const inp = $('#cell-input');
  inp.style.width = Math.min(Math.max(parseFloat(inp.style.minWidth) || 80, (inp.value.length + 3) * (LS.get('font', 14) * 0.62)), 700) + 'px';
}
function stopEditing(commit) {
  if (S.editing === null) return false;
  const i = S.editing, inp = $('#cell-input');
  S.editing = null;
  inp.hidden = true;
  $('#gridwrap').focus({ preventScroll: true });
  if (commit) {
    const text = inp.value;
    if (S.model.cells[i] && normText(text) !== S.model.cells[i].text) apply('text', () => setCellText(i, text));
  }
  return true;
}
function wrapRich(tag) {  // x² / x₂: put the selected characters in <sup>/<sub>, or take them out
  if (S.editing === null) {
    if (!TD[activeIndex()]) return;
    startEditing();
    const v = $('#cell-input').value;
    $('#cell-input').setSelectionRange(v.length, v.length);
  }
  const inp = $('#cell-input'), v = inp.value, a = inp.selectionStart, b = inp.selectionEnd;
  const open = tag === 'math' ? '$' : `<${tag}>`, close = tag === 'math' ? '$' : `</${tag}>`, sel = v.slice(a, b);
  if (v.slice(a - open.length, a) === open && v.slice(b, b + close.length) === close) {
    inp.setRangeText(sel, a - open.length, b + close.length, 'select');
  } else if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
    inp.setRangeText(sel.slice(open.length, -close.length), a, b, 'select');
  } else {
    inp.setRangeText(open + sel + close, a, b, 'end');
    inp.setSelectionRange(a + open.length, b + open.length);  // the same characters stay selected: again = undo
  }
  fitInput(); inp.focus();
  richPreview();
}
function richPreview() {  // while editing: the cell bar shows the text with its superscripts
  if (S.editing === null) return;
  const v = $('#cell-input').value;
  if (/<\/?su[bp]>|\$/.test(v)) $('#cell-text').innerHTML = cellHTML(v);
}
function insertChar(ch) {
  ch = fracTex(ch) || ch;  // ½ → $\frac{1}{2}$
  if (S.editing === null) { startEditing(ch); return; }  // like typing: replaces the text
  const inp = $('#cell-input');
  const a = inp.selectionStart, b = inp.selectionEnd;
  inp.setRangeText(ch, a, b, 'end');
  fitInput();
  inp.focus();
}

// ------------------------------------------------------------------------------------------
// Keyboard

function isTyping(e) { return e.key.length === 1 && (!e.ctrlKey && !e.metaKey || (e.ctrlKey && e.altKey)); }
let pendingDelete = false;

document.addEventListener('keydown', e => {
  if (!$('#modal-back').hidden) { if (modalOpts.onKey && modalOpts.onKey(e)) return; if (e.key === 'Escape') closeModal(); return; }
  if (S.view !== 'edit') return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (k === 'Escape' && !$('#sym-pop').hidden) { e.preventDefault(); closeSymPop(); return; }
  if (document.activeElement && document.activeElement.closest('#sym-pop, #help')) return;  // typing in the Symbols or help search
  if (BX.assign !== null && k === 'Escape') { e.preventDefault(); endAssign(); return; }
  if (BX.poly && (k === 'Escape' || k === 'Enter' || k === 'Backspace')) {
    e.preventDefault();
    if (k === 'Enter') polyFinish();
    else if (k === 'Escape' || BX.poly.pts.length <= 1) polyCancel();
    else { BX.poly.pts.pop(); drawPolyDraft(BX.cross); }
    return;
  }
  if (BX.on && !BX.grid && !BX.drag && k === 'Escape' && S.editing === null && !isFormFocus() && $('#ctxmenu').hidden && !pendingDelete
    && (BX.multi || (S.sel.ar === S.sel.er && S.sel.ac === S.sel.ec))) { e.preventDefault(); unselectBox(); return; }
  if (BX.drag && k === 'Escape') {  // cancel the box being drawn or moved
    e.preventDefault();
    if (BX.drag.kind === 'grid') BX.grid = BX.drag.orig;
    BX.drag = null; clearDraft(); drawBoxes(); drawOverlay(); if (BX.grid) drawGrid();
    return;
  }
  if (BX.grid && S.editing === null && !isFormFocus() && (k === 'Escape' || (k === 'Enter' && !ctrl))) { e.preventDefault(); closeGrid(k === 'Enter'); return; }
  if (BX.on && k === ' ' && !ctrl && !e.altKey && IV.hover && S.editing === null) {  // Space + drag moves the image
    e.preventDefault();
    if (!BX.space) { BX.space = true; $('#imgview').style.cursor = 'grab'; drawGuide(); }
    return;
  }
  // palette: Alt+1..9 (not AltGr)
  if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.code.replace('Digit', '').replace('Numpad', ''))) {
    const n = +e.code.replace('Digit', '').replace('Numpad', '');
    const ch = quickSymbols()[n - 1];
    if (ch) { e.preventDefault(); insertChar(ch); return; }
  }
  if (ctrl && !e.altKey && (k === '.' || k === ',') && !isFormFocus()) {
    e.preventDefault(); wrapRich(k === '.' ? 'sup' : 'sub'); return;
  }
  if (S.editing !== null) {
    if (k === 'Enter' && ctrl) { e.preventDefault(); stopEditing(true); markDone(); return; }
    if (k === 'Enter' || k === 'Tab' || k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      stopEditing(true);
      if (k === 'Enter') move(e.shiftKey ? -1 : 1, 0); else if (k === 'Tab') move(0, e.shiftKey ? -1 : 1); else move(k === 'ArrowUp' ? -1 : 1, 0);
    } else if (k === 'Escape') { e.preventDefault(); stopEditing(false); }
    return;
  }
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && document.activeElement.id !== 'cell-input') return;
  if (!$('#ctxmenu').hidden && k === 'Escape') { hideMenu(); return; }
  if (pendingDelete) {
    pendingDelete = false; hideToast();
    if (k === 'r' || k === 'R') { e.preventDefault(); apply('del-rows', OPS['del-rows']); return; }
    if (k === 'c' || k === 'C') { e.preventDefault(); apply('del-cols', OPS['del-cols']); return; }
    if (k === 'l' || k === 'L' || k === 'u' || k === 'U') { e.preventDefault(); const rect = rectOfSel(); apply('del-cells', () => deleteCells(k.toLowerCase() === 'l' ? 'left' : 'up', rect, LS.get('dcboxes', false))); return; }
    if (k === 'Escape') return;
  }
  if (ctrl && k === 'Enter') { e.preventDefault(); markDone(); return; }
  if (ctrl && e.altKey && (k === 'PageDown' || k === 'PageUp')) { e.preventDefault(); goRelative(k === 'PageDown' ? 1 : -1); return; }
  if (ctrl && e.shiftKey && k.startsWith('Arrow')) {
    e.preventDefault();
    apply('insert', OPS[{ ArrowUp: 'row-above', ArrowDown: 'row-below', ArrowLeft: 'col-left', ArrowRight: 'col-right' }[k]]);
    return;
  }
  if (ctrl && !e.altKey) {
    const key = k.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    if (key === 'm') { e.preventDefault(); apply(e.shiftKey ? 'split' : 'merge', OPS[e.shiftKey ? 'split' : 'merge']); return; }
    if (key === 'b') { e.preventDefault(); apply('header', OPS.header); return; }
    if (key === 'u') { e.preventDefault(); apply('unclear', OPS.unclear); return; }
    if (key === 's') { e.preventDefault(); save(true); return; }
    if (key === 'e') { e.preventDefault(); if (boxPolicy() !== 'off') setBoxMode(!BX.on); return; }
    if (key === '/') { e.preventDefault(); helpToggle(); return; }
    if (k === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { e.preventDefault(); askDelete(); return; }
    if (key === 'a') { e.preventDefault(); S.sel = { ar: 0, ac: 0, er: S.model.nRows - 1, ec: S.model.nCols - 1 }; renderSel(false); return; }
    if (k === 'Home') { e.preventDefault(); setSel(0, 0); return; }
    if (k === 'End') { e.preventDefault(); setSel(S.model.nRows - 1, S.model.nCols - 1); return; }
    if (k.startsWith('Arrow')) {  // jump to the edge
      e.preventDefault();
      const m = S.model, r = e.shiftKey ? S.sel.er : S.sel.ar, c = e.shiftKey ? S.sel.ec : S.sel.ac;
      const t = { ArrowUp: [0, c], ArrowDown: [m.nRows - 1, c], ArrowLeft: [r, 0], ArrowRight: [r, m.nCols - 1] }[k];
      setSel(t[0], t[1], e.shiftKey); return;
    }
    return;  // leave other browser shortcuts alone (copy/paste use the clipboard events)
  }
  switch (k) {
    case 'ArrowUp': e.preventDefault(); move(-1, 0, e.shiftKey); return;
    case 'ArrowDown': e.preventDefault(); move(1, 0, e.shiftKey); return;
    case 'ArrowLeft': e.preventDefault(); move(0, -1, e.shiftKey); return;
    case 'ArrowRight': e.preventDefault(); move(0, 1, e.shiftKey); return;
    case 'Tab': e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return;
    case 'Enter': case 'F2': e.preventDefault(); startEditing(); return;
    case 'Delete': case 'Backspace': e.preventDefault(); if (BX.on) apply('unbox', OPS.unbox); else apply('clear', OPS.clear); return;
    case 'Home': e.preventDefault(); setSel(S.sel.ar, 0); return;
    case 'End': e.preventDefault(); setSel(S.sel.ar, S.model.nCols - 1); return;
    case 'PageDown': e.preventDefault(); setSel(S.sel.ar + 10, S.sel.ac); return;
    case 'PageUp': e.preventDefault(); setSel(S.sel.ar - 10, S.sel.ac); return;
    case 'Escape': setSel(S.sel.ar, S.sel.ac); return;
    case ' ':
      if (e.shiftKey) { e.preventDefault(); selectLines('row'); return; }
      break;
  }
  if (isTyping(e)) { e.preventDefault(); startEditing(k); }
});
document.addEventListener('keyup', e => {
  if (e.key === ' ' && BX.space) { BX.space = false; $('#imgview').style.cursor = ''; drawGuide(); }
  if (e.key === 'Alt' && BX.on && IV.hover) e.preventDefault();  // Alt+drag: no browser menu on release
});
document.addEventListener('keydown', e => {  // Ctrl+Space selects columns (handled apart: ctrl branch above returns early)
  if (S.view === 'edit' && S.editing === null && e.ctrlKey && e.code === 'Space') { e.preventDefault(); selectLines('col'); }
}, true);
$('#cell-input').addEventListener('input', () => { fitInput(); richPreview(); });
$('#cell-input').addEventListener('blur', e => { if (S.editing !== null && !(e.relatedTarget && e.relatedTarget.closest('#sym-pop'))) stopEditing(true); });  // finding a symbol keeps the edit going

function askDelete() {
  const rect = rectOfSel(), m = S.model;
  const fullRows = rect.c0 === 0 && rect.c1 === m.nCols - 1, fullCols = rect.r0 === 0 && rect.r1 === m.nRows - 1;
  if (fullRows && !fullCols) return apply('del-rows', OPS['del-rows']);
  if (fullCols && !fullRows) return apply('del-cols', OPS['del-cols']);
  pendingDelete = true;
  toast(`Delete <kbd>R</kbd> rows ${rect.r0 + 1}–${rect.r1 + 1}, <kbd>C</kbd> columns ${colName(rect.c0)}–${colName(rect.c1)}, or the cells: <kbd>L</kbd> the cells on the right move left, <kbd>U</kbd> the cells below move up?  <kbd>Esc</kbd> cancels`, 7000, true);
}

// Clipboard: copy / cut / paste tab-separated text
document.addEventListener('copy', e => {
  if (S.view !== 'edit' || S.editing !== null || isFormFocus()) return;
  e.preventDefault(); e.clipboardData.setData('text/plain', selectionTSV());
});
document.addEventListener('cut', e => {
  if (S.view !== 'edit' || S.editing !== null || isFormFocus()) return;
  e.preventDefault(); e.clipboardData.setData('text/plain', selectionTSV()); apply('clear', OPS.clear);
});
document.addEventListener('paste', e => {
  if (S.view !== 'edit' || S.editing !== null || isFormFocus()) return;
  e.preventDefault();
  const text = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '').replace(/\n$/, '');
  apply('paste', () => pasteTSV(text));
});
function isFormFocus() { const a = document.activeElement; return a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && a.id !== 'cell-input'; }
function selectionTSV() {
  const rect = rectOfSel(), m = S.model, s = S.slots, out = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const row = [];
    for (let k = rect.c0; k <= rect.c1; k++) { const c = m.cells[s[r][k]]; row.push(c.r === r && c.c === k ? c.text : ''); }
    out.push(row.join('\t'));
  }
  return out.join('\n');
}
function pasteTSV(text) {
  const rows = text.split('\n').map(l => l.split('\t'));
  const rect = rectOfSel(), m = S.model, s = S.slots;
  let n = 0;
  if (rows.length === 1 && rows[0].length === 1) {  // one value: fill every selected cell
    for (const i of cellsInRect(rect)) if (setCellText(i, rows[0][0])) n++;
  } else {
    const done = new Set();
    rows.forEach((row, i) => row.forEach((v, j) => {
      const r = rect.r0 + i, k = rect.c0 + j;
      if (r >= m.nRows || k >= m.nCols) return;
      const idx = s[r][k];
      if (done.has(idx)) return; done.add(idx);
      if (setCellText(idx, v)) n++;
    }));
  }
  return n ? 'paste' : false;
}

// ------------------------------------------------------------------------------------------
// Mouse on the grid

let dragSel = false;
$('#grid').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const td = e.target.closest('td'), th = e.target.closest('th');
  if (BX.assign !== null) { e.preventDefault(); if (td) assignTo(+td.dataset.i); else endAssign(); return; }
  if (S.editing !== null) stopEditing(true);
  if (td) {
    const c = S.model.cells[+td.dataset.i];
    if (e.shiftKey) setSel(c.r, c.c, true); else setSel(c.r, c.c);
    dragSel = true;
  } else if (th && th.dataset.r !== undefined) {
    const r = +th.dataset.r;
    if (e.shiftKey) { S.sel.ec = S.model.nCols - 1; S.sel.er = r; S.sel.ac = 0; renderSel(false); }
    else { S.sel = { ar: r, ac: 0, er: r, ec: S.model.nCols - 1 }; renderSel(false); }
    dragSel = 'row';
  } else if (th && th.dataset.c !== undefined) {
    const k = +th.dataset.c;
    if (e.shiftKey) { S.sel.er = S.model.nRows - 1; S.sel.ec = k; S.sel.ar = 0; renderSel(false); }
    else { S.sel = { ar: 0, ac: k, er: S.model.nRows - 1, ec: k }; renderSel(false); }
    dragSel = 'col';
  }
  $('#gridwrap').focus({ preventScroll: true });
  e.preventDefault();
});
$('#grid').addEventListener('mouseover', e => {
  if (!dragSel || !(e.buttons & 1)) { dragSel = false; return; }
  const td = e.target.closest('td'), th = e.target.closest('th');
  if (dragSel === true && td) { const c = S.model.cells[+td.dataset.i]; if (c.r !== S.sel.er || c.c !== S.sel.ec) setSel(c.r, c.c, true); }
  else if (dragSel === 'row' && th && th.dataset.r !== undefined) { S.sel.er = +th.dataset.r; renderSel(false); }
  else if (dragSel === 'col' && th && th.dataset.c !== undefined) { S.sel.ec = +th.dataset.c; renderSel(false); }
});
document.addEventListener('mouseup', () => { dragSel = false; });
let tdHov = -1;  // box mode: the box of the cell under the mouse in the grid is highlighted on the image
$('#grid').addEventListener('pointerover', e => {
  const td = BX.on && e.target.closest('td'), i = td && td.dataset.i !== undefined ? +td.dataset.i : -1;
  if (i === tdHov) return;
  if (BOX[tdHov] && tdHov !== BX.hover) BOX[tdHov].classList.remove('hov');
  tdHov = i;
  if (BOX[i]) BOX[i].classList.add('hov');
});
$('#grid').addEventListener('pointerleave', () => { if (BOX[tdHov] && tdHov !== BX.hover) BOX[tdHov].classList.remove('hov'); tdHov = -1; });
$('#grid').addEventListener('dblclick', e => { if (e.target.closest('td')) startEditing(); });
$('#imgview').addEventListener('contextmenu', e => {
  if (!BX.on || BX.grid || !S.model || e.target.closest('.img-float')) return;
  const j = boxAt(imgPt(e));
  if (j < 0) return;
  e.preventDefault();
  endAssign();
  const c = S.model.cells[j], rect = rectOfSel(), mi = multiIdx();
  if (mi.length > 1 && mi.includes(j)) {
    const r = rectOfSel();
    return showMenuItems(e.clientX, e.clientY, [
      ['merge', `Merge the cells ${colName(r.c0)}${r.r0 + 1}:${colName(r.c1)}${r.r1 + 1} and their boxes`, 'Ctrl+M'],
      null, ['box-fit', `Fit the ${mi.length} boxes to the ink`, ''], ['box-poly', `Turn the ${mi.length} boxes into polygons / rectangles`, ''],
      ['unbox', `Remove the ${mi.length} boxes`, 'Del'],
    ]);
  }
  if (BX.none || !(c.r >= rect.r0 && c.r <= rect.r1 && c.c >= rect.c0 && c.c <= rect.c1)) setSel(c.r, c.c);
  const multi = cellsInRect(rectOfSel()).length > 1;
  showMenuItems(e.clientX, e.clientY, [
    ['merge', multi ? 'Merge the selected cells and their boxes' : 'Merge: Shift+click the boxes to merge first', 'Ctrl+M'],
    ['bx-assign', 'Move this box to another cell…', ''],
    null, ['box-poly', isPoly(c) ? 'Turn into a rectangle' : 'Turn into a polygon (4 points to move)', ''],
    ['box-fit', 'Fit the box to the ink', ''], ['unbox', 'Remove the box', 'Del'],
    null, ['row-below-boxes', 'New row below, boxes the same size', ''], ['row-above-boxes', 'New row above, boxes the same size', ''],
    ['col-right-boxes', 'New column to the right, boxes the same size', ''], ['col-left-boxes', 'New column to the left, boxes the same size', ''],
  ].map(it => (it && it[0] === 'merge' && !multi ? ['', it[1], it[2]] : it)));
});
$('#grid').addEventListener('contextmenu', e => {
  const td = e.target.closest('td, th');
  if (!td) return;
  e.preventDefault();
  if (td.tagName === 'TD') {
    const c = S.model.cells[+td.dataset.i];
    const rect = rectOfSel();
    if (!(c.r >= rect.r0 && c.r <= rect.r1 && c.c >= rect.c0 && c.c <= rect.c1)) setSel(c.r, c.c);
  }
  showMenu(e.clientX, e.clientY);
});

const MENU = [
  ['merge', 'Merge cells', 'Ctrl+M'], ['split', 'Split cell', 'Ctrl+Shift+M'], null,
  ['row-above', 'Insert row above', 'Ctrl+Shift+↑'], ['row-below', 'Insert row below', 'Ctrl+Shift+↓'],
  ['col-left', 'Insert column left', 'Ctrl+Shift+←'], ['col-right', 'Insert column right', 'Ctrl+Shift+→'], null,
  ['del-rows', 'Delete row(s)', ''], ['del-cols', 'Delete column(s)', ''], ['del-cells', 'Delete cells… (the others move left or up)', 'Ctrl+−'], null,
  ['header', 'Header cell on / off', 'Ctrl+B'], ['unclear', 'Unclear reading on / off', 'Ctrl+U'], ['clear', 'Clear text', 'Del'],
];
function showMenu(x, y) {
  const items = MENU.slice();
  if (BX.on) items.push(null, ['unbox', 'Remove the box', 'Del'], ['box-fit', 'Fit the box to the ink', '']);
  showMenuItems(x, y, items);
}
function showMenuItems(x, y, items) {
  const menu = $('#ctxmenu');
  menu.innerHTML = items.map(it => it ? `<button data-op="${escAttr(it[0])}"${it[0] ? '' : ' disabled'}><span>${esc(it[1])}</span><kbd>${esc(it[2])}</kbd></button>` : '<hr>').join('').replace(/<kbd><\/kbd>/g, '');
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function hideMenu() { $('#ctxmenu').hidden = true; }
$('#ctxmenu').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !b.dataset.op) return; hideMenu(); runOp(b.dataset.op); });
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctxmenu')) hideMenu(); });

function runOp(op) {
  if (op === 'undo') return undo();
  if (op === 'redo') return redo();
  if (op === 'help') return helpToggle();
  if (op.startsWith('bx-take:')) return takeBoxesDialog(op.slice(8));
  if (op === 'bx-clear') return clearBoxesDialog();
  if (op === 'bx-assign') return startAssign();
  if (op === 'del-cells') return deleteCellsDialog();
  if (op === 'new-table') return newTableDialog();
  if (op.startsWith('grid:')) return gridOp(op.slice(5));
  if (op === 'mono' || op === 'edits') {
    LS.set(op, !LS.get(op, op === 'edits')); applyViewPrefs(); return;
  }
  if (op === 'font-up' || op === 'font-down') {
    const f = clamp(LS.get('font', 14) + (op === 'font-up' ? 1 : -1), 10, 24);
    LS.set('font', f); document.documentElement.style.setProperty('--cell-font', f + 'px');
    return;
  }
  if (S.editing !== null) stopEditing(true);
  apply(op, OPS[op]);
  $('#gridwrap').focus({ preventScroll: true });
}
['#toolbar', '#statusbar'].forEach(id => $(id).addEventListener('click', e => { const b = e.target.closest('button[data-op]'); if (b) runOp(b.dataset.op); }));
$('#palette').addEventListener('mousedown', e => { e.preventDefault(); });  // the cell being edited keeps the focus
$('#palette').addEventListener('click', e => {
  const r = e.target.closest('[data-rich]');
  if (r) { wrapRich(r.dataset.rich); return; }
  if (e.target.closest('#sym-btn')) { if ($('#sym-pop').hidden) openSymPop(); else closeSymPop(); }
});
$('#sym-pop').addEventListener('mousedown', e => { if (!e.target.closest('input')) e.preventDefault(); });
$('#sym-pop').addEventListener('click', e => {
  const b = e.target.closest('button.sym');
  if (!b) return;
  const ch = b.dataset.ch;
  if (e.target.closest('[data-del]')) { setMySymbols(mySymbols().filter(x => x !== ch)); renderPalette(); return; }
  if (e.target.closest('[data-pin]')) { addMySymbols(ch); return; }
  insertChar(ch);
});
document.addEventListener('mousedown', e => {
  const p = $('#sym-pop');
  if (!p.hidden && !p.contains(e.target) && !e.target.closest('#sym-btn')) closeSymPop();
}, true);

// ------------------------------------------------------------------------------------------
// Image viewer: zoom, pan, row guide, cell boxes

const IV = { scale: 1, tx: 0, ty: 0, w: 0, h: 0, guideY: null, pinY: null, hover: false, lastScale: 0 };
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, cls) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (cls) el.setAttribute('class', cls);
  return el;
}
function loadImage() {
  const img = $('#img');
  IV.w = IV.h = 0; IV.pinY = null; IV.guideY = null; BX.pix = null;
  img.onload = () => {
    IV.w = img.naturalWidth; IV.h = img.naturalHeight;
    const svg = $('#overlay');
    svg.setAttribute('width', IV.w); svg.setAttribute('height', IV.h); svg.setAttribute('viewBox', `0 0 ${IV.w} ${IV.h}`);
    applyLayout();
    imgFit(LS.get('imgfit', 'width'));
    drawGuide();
    drawBoxes();
    drawOverlay();
  };
  img.src = S.detail.image_url;
}
function imgApply() {
  $('#imgstage').style.transform = `translate(${IV.tx}px, ${IV.ty}px) scale(${IV.scale})`;
  $('#zoom-label').textContent = Math.round(IV.scale * 100) + '%';
  if (IV.scale !== IV.lastScale) {  // sizes in screen pixels: handles, grid ends and labels
    IV.lastScale = IV.scale;
    drawHandles();
    if (BX.grid) drawGrid();
    if (BX.names) drawNames();
  }
}
function imgFit(mode) {
  const v = $('#imgview'), W = v.clientWidth, H = v.clientHeight;
  if (!IV.w || !W) return;
  if (mode === 'width') { IV.scale = W / IV.w; IV.tx = 0; IV.ty = 0; }
  else { IV.scale = Math.min(W / IV.w, H / IV.h); IV.tx = (W - IV.w * IV.scale) / 2; IV.ty = (H - IV.h * IV.scale) / 2; }
  LS.set('imgfit', mode);
  imgApply();
}
function imgZoom(f, cx, cy) {
  const v = $('#imgview');
  if (cx === undefined) { cx = v.clientWidth / 2; cy = v.clientHeight / 2; }
  const ns = clamp(IV.scale * f, 0.03, 10);
  IV.tx = cx - (cx - IV.tx) * ns / IV.scale; IV.ty = cy - (cy - IV.ty) * ns / IV.scale; IV.scale = ns;
  imgApply();
}
$('#imgpane .pane-tools').addEventListener('click', e => {
  const b = e.target.closest('button[data-img], button[data-mode]'); if (!b) return;
  if (b.dataset.mode) return setBoxMode(b.dataset.mode === 'boxes');
  const a = b.dataset.img;
  if (a === 'fit' || a === 'width') imgFit(a);
  else if (a === 'adjust') toggleAdjust();
  else if (a === 'colors') toggleColors();
  else imgZoom(a === 'in' ? 1.25 : 0.8);
});
$('#imgview').addEventListener('wheel', e => {
  e.preventDefault();
  const r = $('#imgview').getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) imgZoom(Math.exp(-e.deltaY * 0.0018), e.clientX - r.left, e.clientY - r.top);
  else { IV.tx -= e.shiftKey ? e.deltaY : e.deltaX; IV.ty -= e.shiftKey ? 0 : e.deltaY; imgApply(); }
}, { passive: false });

// Pointer on the image. View mode: drag moves the image, click pins the row guide or selects a boxed cell.
// Box mode: drag draws the box of the selected cell, or adjusts it (edges, corners, inside); Space+drag or the
// middle button moves the image. With the grid open, drag a line or its end.
let pan = null;
function imgPt(e) { const r = $('#imgview').getBoundingClientRect(); return [(e.clientX - r.left - IV.tx) / IV.scale, (e.clientY - r.top - IV.ty) / IV.scale]; }
$('#imgview').addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });  // no autoscroll
$('#imgview').addEventListener('pointerdown', e => {
  if (e.target.closest('.img-float')) return;
  if (e.button !== 0 && e.button !== 1) return;
  const view = $('#imgview');
  if (e.button === 0 && BX.on && !BX.space && IV.w && S.model) {
    const p = imgPt(e);
    if (S.editing !== null) stopEditing(true);
    if (BX.grid) {
      const hit = BX.gridFresh || e.shiftKey ? null : gridHit(p);  // no outline yet, or Shift: always a new outline
      BX.drag = hit ? { kind: 'grid', hit, start: p, orig: cloneGrid(BX.grid), moved: false, alone: e.altKey } : { kind: 'gframe', start: p, moved: false };
      view.setPointerCapture(e.pointerId);
      return;
    } else {
      if (BX.assign !== null) { const j = boxAt(p); if (j >= 0) assignTo(j); else endAssign(); return; }
      const ctrl = e.ctrlKey || e.metaKey;
      if (BX.shape === 'select' || (ctrl && !BX.poly)) {
        // the mouse: drag a rectangle to select boxes, drag selected boxes to move them, click a box to select it;
        // the sides and corners of the selected cell's box still resize it
        const mi = multiIdx(), j = boxAt(p);
        if (!ctrl && mi.length < 2 && !BX.none) {
          const c = S.model.cells[activeIndex()], hit = c && c.bbox ? boxHit(c, p) : null;
          if (hit && hit.kind !== 'move') { boxPointerDown(p, e.altKey, e.shiftKey); view.setPointerCapture(e.pointerId); return; }
        }
        if (!ctrl && j >= 0 && mi.includes(j)) {
          BX.drag = { kind: 'group', start: p, moved: false, idx: mi, G: groupBox(mi), dx: 0, dy: 0 };
          view.setPointerCapture(e.pointerId); return;
        }
        BX.drag = { kind: 'band', start: p, moved: false, shift: e.shiftKey, ctrl, hits: [] };
        view.setPointerCapture(e.pointerId);
        return;
      }
      if (BX.shape === 'poly') {
        const c = S.model.cells[activeIndex()], hit = !BX.poly && !BX.none && c && c.bbox ? boxHit(c, p) : null;
        if (!hit) { BX.drag = { kind: 'polyclick', start: p, moved: false }; view.setPointerCapture(e.pointerId); return; }
        // on the selected box: a drag still moves or reshapes it, a click is a polygon point
        boxPointerDown(p, e.altKey, false); BX.drag.tap = true; view.setPointerCapture(e.pointerId); return;
      }
      boxPointerDown(p, e.altKey, e.shiftKey);
      view.setPointerCapture(e.pointerId);
      return;
    }
  }
  e.preventDefault();
  pan = { x: e.clientX, y: e.clientY, tx: IV.tx, ty: IV.ty, moved: false, click: e.button === 0 && !BX.on };
  view.setPointerCapture(e.pointerId);
});
$('#imgview').addEventListener('pointermove', e => {
  const p = imgPt(e);
  IV.guideY = p[1]; BX.cross = p;
  if (pan) {
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true;
    if (pan.moved) { $('#imgview').classList.add('dragging'); IV.tx = pan.tx + dx; IV.ty = pan.ty + dy; imgApply(); }
  } else if (BX.drag) {
    if (BX.drag.kind === 'grid') gridDrag(BX.drag, p);
    else if (BX.drag.kind === 'gframe') gridFrameDrag(BX.drag, p);
    else if (BX.drag.kind === 'polyclick') { if (dist(p, BX.drag.start) * IV.scale > 6) BX.drag.moved = true; }
    else if (BX.drag.kind === 'band') bandMove(BX.drag, p);
    else if (BX.drag.kind === 'group') groupMove(BX.drag, p);
    else boxPointerMove(p);
  } else if (BX.on) { boxHover(p, e); if (BX.poly) drawPolyDraft(p); else if (BX.shape === 'poly' && !BX.grid && !BX.space) polyHoverSnap(p); }
  drawGuide();
});
$('#imgview').addEventListener('pointerenter', () => { IV.hover = true; });
$('#imgview').addEventListener('pointerleave', () => { IV.hover = false; IV.guideY = null; BX.cross = null; setHover(-1); drawGuide(); });
$('#imgview').addEventListener('pointerup', e => {
  $('#imgview').classList.remove('dragging');
  if (pan) {
    if (!pan.moved && pan.click) {
      const p = imgPt(e);
      const hit = boxAt(p);
      if (hit >= 0) { const c = S.model.cells[hit]; setSel(c.r, c.c, !!pan.shift); }
      else if (!pan.boxsel) { IV.pinY = IV.pinY !== null && Math.abs(IV.pinY - p[1]) * IV.scale < 8 ? null : p[1]; drawGuide(); }
    }
    pan = null;
    return;
  }
  if (BX.drag) {
    const d = BX.drag;
    if (d.kind === 'grid') { BX.drag = null; if (d.moved) gridPush(d.orig); drawGrid(); }
    else if (d.kind === 'gframe') gridFrameUp(d);
    else if (d.kind === 'polyclick') { BX.drag = null; if (!d.moved) polyClick(imgPt(e)); }
    else if (d.kind === 'band') bandUp(d, imgPt(e));
    else if (d.kind === 'group') groupUp(d, imgPt(e), e.ctrlKey || e.metaKey);
    else boxPointerUp(imgPt(e));
  }
});
$('#imgview').addEventListener('dblclick', e => {
  if (!BX.on || BX.grid || !S.model || e.target.closest('.img-float')) return;
  const p = imgPt(e);
  if (BX.poly && BX.poly.pts.length >= 3) return polyFinish();
  polyCancel();  // a double-click that only started a polygon: it is a point edit
  polyEditAt(p);
});
$('#imgview').addEventListener('pointercancel', () => { pan = null; if (BX.drag) { BX.drag = null; clearDraft(); drawBoxes(); drawOverlay(); } });
$('#guide-on').addEventListener('change', () => { LS.set('guide', $('#guide-on').checked); drawGuide(); });
function drawGuide() {
  const svg = $('#overlay');
  $$('.guide-hover, .guide-pin, .cross', svg).forEach(n => n.remove());
  if (!IV.w) return;
  const line = (x1, y1, x2, y2, cls) => svg.appendChild(svgEl('line', { x1, y1, x2, y2, 'vector-effect': 'non-scaling-stroke' }, cls));
  if (BX.on) {  // crosshair, to line the box up with the page
    const p = BX.cross;
    if (p && !BX.space && !BX.grid && !pan && p[0] >= 0 && p[1] >= 0 && p[0] <= IV.w && p[1] <= IV.h) {
      line(0, p[1], IV.w, p[1], 'cross'); line(p[0], 0, p[0], IV.h, 'cross');
    }
    return;
  }
  if (!$('#guide-on').checked) return;
  if (IV.pinY !== null) line(-IV.w * 0.02, IV.pinY, IV.w * 1.02, IV.pinY, 'guide-pin');
  if (IV.guideY !== null && IV.guideY >= 0 && IV.guideY <= IV.h) line(-IV.w * 0.02, IV.guideY, IV.w * 1.02, IV.guideY, 'guide-hover');
}

// ------------------------------------------------------------------------------------------
// Cell boxes

const BX = {
  on: false,      // box mode
  drag: null,     // pointer action in progress
  hover: -1,      // cell index of the box under the pointer
  space: false,   // Space held over the image: drag moves the image
  cross: null,    // pointer position, image pixels
  grid: null,     // grid tool: {h: [[y at x=0, y at x=W], ...], v: [[x at y=0, x at y=H], ...]}
  pix: null,      // ink map of the image, for "snap" and "fit to ink"
  assign: null,   // index of the cell whose box is being given to another cell
  shape: 'rect',  // what a new box is: 'rect' (drag) or 'poly' (click the points)
  poly: null,     // polygon being drawn: {idx, pts}; idx -1: a new box for the cell at that place
  none: false,    // no box selected (click on an empty spot in Select mode, or Esc): a box drawn goes to the cell at that place
};
function boxPolicy() { return (S.batch && S.batch.boxes) || 'optional'; }
/* Cells that should get a box: with policy "text" only the cells with text, else every cell. */
function needsBox(c) { const p = boxPolicy(); return p === 'off' ? false : p === 'text' ? !!c.text : true; }
function cellRef(c) { return colName(c.c) + (c.r + 1); }
const round1 = v => Math.round(v * 10) / 10;
function bboxOf(P) {
  const xs = P.map(q => q[0]), ys = P.map(q => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function setBox(c, bbox, polygon, by = 'hand') {
  if (polygon && polygon.length > 2) { c.polygon = polygon.map(q => [Math.round(q[0]), Math.round(q[1])]); c.bbox = bboxOf(c.polygon); }
  else { c.polygon = null; c.bbox = bbox ? bbox.map(v => Math.round(v)) : null; }
  c.box_by = c.bbox ? by : null;
}
/* How the box of a cell is shown on the box bar: a box made by hand is a checked one. */
function boxWord(c) { return !c.bbox ? 'no box' : c.box_by === 'hand' ? 'box ✓' : c.box_by === 'grid' ? 'grid box' : 'model box'; }
function clampPt(p) { return [clamp(p[0], 0, IV.w), clamp(p[1], 0, IV.h)]; }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L, 0, 1) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function inPoly(p, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    if ((P[i][1] > p[1]) !== (P[j][1] > p[1]) && p[0] < (P[j][0] - P[i][0]) * (p[1] - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) inside = !inside;
  }
  return inside;
}
function inBox(c, p) {
  if (!c.bbox) return false;
  const b = c.bbox;
  if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) return false;
  return c.polygon && c.polygon.length > 2 ? inPoly(p, c.polygon) : true;
}
/* The cell whose box is under p (the smallest one if boxes overlap), or -1. */
function boxAt(p) {
  if (!S.model) return -1;
  let best = -1, area = Infinity;
  S.model.cells.forEach((c, i) => {
    if (!inBox(c, p)) return;
    const a = (c.bbox[2] - c.bbox[0]) * (c.bbox[3] - c.bbox[1]);
    if (a < area) { area = a; best = i; }
  });
  return best;
}

let BOX = [];  // cell index -> svg element
function boxElement(c, cls) {
  if (c.polygon && c.polygon.length > 2) return svgEl('polygon', { points: c.polygon.map(q => q.join(',')).join(' '), 'vector-effect': 'non-scaling-stroke' }, cls);
  const b = c.bbox;
  return svgEl('rect', { x: b[0], y: b[1], width: Math.max(0, b[2] - b[0]), height: Math.max(0, b[3] - b[1]), 'vector-effect': 'non-scaling-stroke' }, cls);
}
function drawBoxes() {
  const svg = $('#overlay');
  $$('.box', svg).forEach(n => n.remove());
  BOX = [];
  if (!S.model) return;
  const first = svg.firstChild;
  S.model.cells.forEach((c, i) => {
    if (!c.bbox) return;
    const el = boxElement(c, i === BX.assign ? 'box assign' : 'box');
    svg.insertBefore(el, first);
    BOX[i] = el;
  });
  boxSel = [];
  BX.hover = -1;
  drawNames();
}
/* The cell name (E5) written in each box, to check which cell each box belongs to. */
function drawNames() {
  const svg = $('#overlay');
  $$('.bname', svg).forEach(n => n.remove());
  if (!S.model || !BX.on || !BX.names || !IV.scale) return;
  const fs = 10.5 / IV.scale, pad = 2.5 / IV.scale, frag = document.createDocumentFragment();
  for (const c of S.model.cells) {
    if (!c.bbox) continue;
    const P = c.polygon && c.polygon.length > 2 ? c.polygon : null;
    const q = P ? P.reduce((b, p) => (p[0] + p[1] < b[0] + b[1] ? p : b)) : [c.bbox[0], c.bbox[1]];
    const el = svgEl('text', { x: q[0] + pad, y: q[1] + pad, 'font-size': fs, 'dominant-baseline': 'hanging' }, 'bname');
    el.textContent = cellRef(c);
    frag.appendChild(el);
  }
  svg.appendChild(frag);
}
let boxSel = [];
function drawOverlay() {
  if (!S.model) return;
  boxSel.forEach(r => r.classList.remove('sel', 'act', 'msel'));
  boxSel = [];
  if (BX.none) { drawHandles(); return; }
  const mi = multiIdx();
  if (mi.length) { for (const i of mi) if (BOX[i]) { BOX[i].classList.add('sel', 'msel'); boxSel.push(BOX[i]); } }
  else for (const i of cellsInRect(rectOfSel())) if (BOX[i]) { BOX[i].classList.add('sel'); boxSel.push(BOX[i]); }
  const ai = activeIndex();
  if (BOX[ai]) { BOX[ai].classList.add('act'); boxSel.push(BOX[ai]); }
  drawHandles();
  const a = S.model.cells[ai], focus = a && a.bbox;
  if (focus && IV.w && !BX.drag && !BX.multi) {  // keep the selected cell's box in view
    const v = $('#imgview'), W = v.clientWidth, H = v.clientHeight;
    const x0 = focus[0] * IV.scale + IV.tx, y0 = focus[1] * IV.scale + IV.ty, x1 = focus[2] * IV.scale + IV.tx, y1 = focus[3] * IV.scale + IV.ty;
    const mx = Math.min(60, W * 0.1), my = Math.min(60, H * 0.12);
    const shift = (a, b, size, m) => (a >= 0 && b <= size ? 0 : b - a > size - 2 * m || a < 0 ? m - a : size - m - b);
    const dx = shift(x0, x1, W, mx), dy = shift(y0, y1, H, my);
    if (dx || dy) { IV.tx += dx; IV.ty += dy; imgApply(); }
  }
}
/* Square handles on the corners (and edge middles) of the selected cell's box, in box mode. */
function drawHandles() {
  const svg = $('#overlay');
  $$('.handle', svg).forEach(n => n.remove());
  if (!BX.on || BX.grid || BX.none || !S.model || !IV.w || (BX.drag && BX.drag.moved) || multiIdx().length > 1) return;
  const c = S.model.cells[activeIndex()];
  if (!c || !c.bbox) return;
  let pts;
  if (c.polygon && c.polygon.length > 2) pts = c.polygon;
  else {
    const [x0, y0, x1, y1] = c.bbox, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    pts = [[x0, y0], [mx, y0], [x1, y0], [x1, my], [x1, y1], [mx, y1], [x0, y1], [x0, my]];
  }
  const s = 7 / IV.scale;
  for (const q of pts) svg.appendChild(svgEl('rect', { x: q[0] - s / 2, y: q[1] - s / 2, width: s, height: s, 'vector-effect': 'non-scaling-stroke' }, 'handle'));
}
function drawDraft(g, links) {
  clearDraft();
  const svg = $('#overlay');
  for (const l of links || []) if (l.geom) svg.appendChild(boxElement(l.geom, 'draft link'));
  svg.appendChild(boxElement({ bbox: g.bbox, polygon: g.polygon }, 'draft'));
}
function clearDraft() { $$('#overlay .draft').forEach(n => n.remove()); }

/* What the pointer is on, for the selected cell's box: a side or corner, a polygon point or edge, or inside. */
function boxHit(c, p) {
  const tol = 7 / IV.scale;
  if (c.polygon && c.polygon.length > 2) {
    const P = c.polygon;
    for (let i = 0; i < P.length; i++) if (dist(P[i], p) <= tol) return { kind: 'vertex', i };
    for (let i = 0; i < P.length; i++) if (segDist(p, P[i], P[(i + 1) % P.length]) <= tol * 0.8) return { kind: 'pedge', i };
    return inPoly(p, P) ? { kind: 'move' } : null;
  }
  const [x0, y0, x1, y1] = c.bbox;
  if (p[0] < x0 - tol || p[0] > x1 + tol || p[1] < y0 - tol || p[1] > y1 + tol) return null;
  let l = Math.abs(p[0] - x0) <= tol, r = Math.abs(p[0] - x1) <= tol, t = Math.abs(p[1] - y0) <= tol, b = Math.abs(p[1] - y1) <= tol;
  if (l && r) { l = Math.abs(p[0] - x0) <= Math.abs(p[0] - x1); r = !l; }
  if (t && b) { t = Math.abs(p[1] - y0) <= Math.abs(p[1] - y1); b = !t; }
  if (l || r || t || b) return { kind: 'resize', l, r, t, b };
  return { kind: 'move' };
}
function hitCursor(h) {
  if (!h) return 'crosshair';
  if (h.kind === 'resize') {
    if ((h.l && h.t) || (h.r && h.b)) return 'nwse-resize';
    if ((h.r && h.t) || (h.l && h.b)) return 'nesw-resize';
    return h.l || h.r ? 'ew-resize' : 'ns-resize';
  }
  return h.kind === 'vertex' ? 'grab' : 'move';
}
function boxPointerDown(p, alone, shift) {
  const ai = activeIndex(), c = S.model.cells[ai];
  const hit = c && c.bbox && !BX.none ? boxHit(c, p) : null;
  BX.drag = { kind: hit ? hit.kind : 'draw', hit, start: p, idx: ai, moved: false, geom: null, links: hit && !alone ? linkedParts(ai, hit) : [], shift, none: BX.none };
}
const isPoly = c => !!(c.polygon && c.polygon.length > 2);
/* The boxes that share the border being dragged, so that a shared border moves for both cells
   (Alt+drag moves one box alone). Rectangles: the touching sides of the neighbours, and the
   corner of the diagonal neighbour at a dragged corner. Polygons: a dragged point moves in every
   polygon that has it, a dragged edge in the polygon on its other side. */
function linkedParts(ai, hit) {
  const cells = S.model.cells, a = cells[ai], tol = Math.max(1.5, 2 / IV.scale), out = [];
  const near = (u, v) => Math.abs(u - v) <= tol;
  if (hit.kind === 'resize' && !isPoly(a)) {
    const [x0, y0, x1, y1] = a.bbox, h = hit;
    const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > tol;
    cells.forEach((o, i) => {
      if (i === ai || !o.bbox || isPoly(o)) return;
      const b = o.bbox, s = { l: false, r: false, t: false, b: false };
      const vo = ov(y0, y1, b[1], b[3]), ho = ov(x0, x1, b[0], b[2]);
      if (h.r && vo && near(b[0], x1)) s.l = true;
      if (h.l && vo && near(b[2], x0)) s.r = true;
      if (h.b && ho && near(b[1], y1)) s.t = true;
      if (h.t && ho && near(b[3], y0)) s.b = true;
      if ((h.l || h.r) && (h.t || h.b) && near(h.r ? b[0] : b[2], h.r ? x1 : x0) && near(h.b ? b[1] : b[3], h.b ? y1 : y0)) {
        s[h.r ? 'l' : 'r'] = true; s[h.b ? 't' : 'b'] = true;
      }
      if (s.l || s.r || s.t || s.b) out.push({ i, sides: s });
    });
  } else if ((hit.kind === 'vertex' || hit.kind === 'pedge') && isPoly(a)) {
    const P = a.polygon, moved = hit.kind === 'vertex' ? [hit.i] : [hit.i, (hit.i + 1) % P.length];
    cells.forEach((o, i) => {
      if (i === ai || !isPoly(o)) return;
      const verts = [];
      o.polygon.forEach((q, k) => { const m = moved.find(j => dist(P[j], q) <= tol); if (m !== undefined) verts.push([k, m]); });
      // a dragged point moves for every box that has it; a dragged edge only for the box on its other side
      if (verts.length && (hit.kind === 'vertex' || new Set(verts.map(v => v[1])).size === 2)) out.push({ i, verts });
    });
  }
  return out;
}
/* The new shape of each linked box: its shared sides (or points) go exactly where the dragged ones are. */
function linkGeoms(d, g) {
  for (const l of d.links) {
    const o = S.model.cells[l.i];
    if (l.sides) {
      const b = o.bbox.slice(), s = l.sides;
      if (s.l) b[0] = g.bbox[2];
      if (s.r) b[2] = g.bbox[0];
      if (s.t) b[1] = g.bbox[3];
      if (s.b) b[3] = g.bbox[1];
      l.geom = { bbox: b, polygon: null };
    } else {
      const Q = o.polygon.map(v => v.slice());
      for (const [k, m] of l.verts) Q[k] = g.polygon[m].slice();
      l.geom = { bbox: bboxOf(Q), polygon: Q };
    }
  }
}
function boxPointerMove(p) {
  const d = BX.drag, c = S.model.cells[d.idx];
  if (!d.moved) {
    if (dist(p, d.start) * IV.scale < 4) return;
    d.moved = true;
    if (d.kind !== 'draw' && BOX[d.idx]) BOX[d.idx].style.display = 'none';
    for (const l of d.links) if (BOX[l.i]) BOX[l.i].style.display = 'none';
    setHover(-1);
    drawHandles();
  }
  const q = clampPt(p), dx = q[0] - d.start[0], dy = q[1] - d.start[1];
  // the magnet ignores the box itself (redrawn, moved or resized) and the boxes whose shared side moves with it
  const skip = new Set(d.kind === 'draw' && d.none ? [] : [d.idx].concat(d.links.map(l => l.i)));
  let g, marks = [], pt = null;
  if (d.kind === 'draw') {
    const s = clampPt(d.start), sn = snapSides([Math.min(s[0], q[0]), Math.min(s[1], q[1]), Math.max(s[0], q[0]), Math.max(s[1], q[1])], skip, ALL_SIDES);
    g = { bbox: sn.b, polygon: null }; marks = sn.lines;
  } else if (d.kind === 'move') {
    const b = c.bbox;
    let mx = clamp(dx, -b[0], IV.w - b[2]), my = clamp(dy, -b[1], IV.h - b[3]);
    const sn = snapShift([b[0] + mx, b[1] + my, b[2] + mx, b[3] + my], skip);
    mx = clamp(mx + sn.dx, -b[0], IV.w - b[2]); my = clamp(my + sn.dy, -b[1], IV.h - b[3]); marks = sn.lines;
    g = { bbox: [b[0] + mx, b[1] + my, b[2] + mx, b[3] + my], polygon: c.polygon && c.polygon.length > 2 ? c.polygon.map(v => [v[0] + mx, v[1] + my]) : null };
  } else if (d.kind === 'resize') {
    let [x0, y0, x1, y1] = c.bbox;
    const h = d.hit, L = d.links.map(l => [l.sides, S.model.cells[l.i].bbox]);
    const lim = (side, k, f, init) => L.filter(([s]) => s[side]).reduce((v, [, b]) => f(v, b[k]), init);
    const sn = snapSides([h.l ? x0 + dx : x0, h.t ? y0 + dy : y0, h.r ? x1 + dx : x1, h.b ? y1 + dy : y1], skip, h), R = sn.b;
    marks = sn.lines;
    if (h.l) x0 = clamp(R[0], lim('r', 0, (v, w) => Math.max(v, w + 2), 0), x1 - 2);
    if (h.r) x1 = clamp(R[2], x0 + 2, lim('l', 2, (v, w) => Math.min(v, w - 2), IV.w));
    if (h.t) y0 = clamp(R[1], lim('b', 1, (v, w) => Math.max(v, w + 2), 0), y1 - 2);
    if (h.b) y1 = clamp(R[3], y0 + 2, lim('t', 3, (v, w) => Math.min(v, w - 2), IV.h));
    g = { bbox: [x0, y0, x1, y1], polygon: null };
  } else {  // polygon point, or polygon edge (its two points)
    const P = c.polygon.map(v => v.slice()), i = d.hit.i;
    const moveIdx = d.kind === 'vertex' ? [i] : [i, (i + 1) % P.length];
    for (const k of moveIdx) P[k] = clampPt([c.polygon[k][0] + dx, c.polygon[k][1] + dy]);
    if (d.kind === 'vertex') { const sn = snapPoint(P[i], skip); if (sn.snap) { P[i] = sn.p; pt = sn.p; } }
    g = { bbox: bboxOf(P), polygon: P };
  }
  d.geom = g;
  if (d.links.length) linkGeoms(d, g);
  drawDraft(g, d.links);
  drawSnapMarks(marks, g.bbox, pt);
}
function boxPointerUp(p) {
  const d = BX.drag;
  BX.drag = null;
  clearDraft();
  if (BOX[d.idx]) BOX[d.idx].style.display = '';
  for (const l of d.links) if (BOX[l.i]) BOX[l.i].style.display = '';
  if (!d.moved) {  // a click: select the cell whose box is there
    if (d.tap) { drawHandles(); return polyClick(p); }  // polygon mode: a point
    const hit = boxAt(p);
    if (hit >= 0 && d.shift) { const c = S.model.cells[hit]; setSel(c.r, c.c, true); }
    else if (hit >= 0 && (hit !== activeIndex() || BX.none)) { const c = S.model.cells[hit]; setSel(c.r, c.c); }
    else drawHandles();
    return;
  }
  const g = d.geom;
  if (!g) return drawHandles();
  if (d.kind === 'draw' && ((g.bbox[2] - g.bbox[0]) * IV.scale < 4 || (g.bbox[3] - g.bbox[1]) * IV.scale < 4)) return drawHandles();
  if (d.kind === 'draw' && d.none) return addBoxAtPlace(g);
  const cell = S.model.cells[d.idx], at = [cell.r, cell.c];
  const ok = apply('box', () => {
    setBox(cell, g.bbox, g.polygon);
    for (const l of d.links) if (l.geom) { const o = S.model.cells[l.i]; setBox(o, l.geom.bbox, l.geom.polygon); }
    return d.kind === 'draw' ? 'box_draw' : 'box_adjust';
  });
  if (ok && d.kind === 'draw' && $('#bx-next').checked) {
    const next = nextNeedingBox(S.slots[at[0]][at[1]]);
    if (next >= 0) { const c = S.model.cells[next]; setSel(c.r, c.c); }
    else toast('Every cell has a box now.');
  }
}
/* Magnet: the sides of a box being drawn, moved or resized stick to the sides of the boxes next to it, and a
   polygon point to the corners or edges of the other boxes (within SNAP_PX screen pixels). The boxes then touch
   without a gap, and a shared side or point moves for both boxes afterwards. Off with the "magnet" box. */
const SNAP_PX = 8, ALL_SIDES = { l: true, r: true, t: true, b: true };
function snapSides(b, skip, sides) {
  if (!BX.snap || !IV.scale) return { b, lines: [] };
  const tol = SNAP_PX / IV.scale, out = b.slice(), lines = [];
  const near = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > -tol;
  const others = S.model.cells.filter((c, i) => c.bbox && !skip.has(i));
  const X = others.filter(c => near(b[1], b[3], c.bbox[1], c.bbox[3])).flatMap(c => [c.bbox[0], c.bbox[2]]);
  const Y = others.filter(c => near(b[0], b[2], c.bbox[0], c.bbox[2])).flatMap(c => [c.bbox[1], c.bbox[3]]);
  for (const [k, side, C] of [[0, 'l', X], [2, 'r', X], [1, 't', Y], [3, 'b', Y]]) {
    if (!sides[side]) continue;
    let w = null, d = tol;
    for (const v of C) { const e = Math.abs(v - b[k]); if (e <= d) { d = e; w = v; } }
    if (w !== null) { out[k] = w; lines.push({ k, w }); }
  }
  if (out[2] - out[0] < 2 || out[3] - out[1] < 2) return { b, lines: [] };  // never squash a box
  return { b: out, lines };
}
/* A box moved as a whole: the shift that puts its nearest side onto a side of a box next to it. */
function snapShift(b, skip) {
  const sn = snapSides(b, skip, ALL_SIDES);
  let lx = null, ly = null;
  for (const L of sn.lines) {
    const d = L.w - b[L.k];
    if (L.k % 2 === 0) { if (!lx || Math.abs(d) < Math.abs(lx.d)) lx = { k: L.k, w: L.w, d }; }
    else if (!ly || Math.abs(d) < Math.abs(ly.d)) ly = { k: L.k, w: L.w, d };
  }
  return { dx: lx ? lx.d : 0, dy: ly ? ly.d : 0, lines: [lx, ly].filter(Boolean) };
}
/* A polygon point: onto a corner of another box, else onto one of its sides or edges. */
function snapPoint(p, skip) {
  if (!BX.snap || !IV.scale) return { p, snap: null };
  const tol = SNAP_PX / IV.scale, shapes = [];
  S.model.cells.forEach((c, i) => {
    if (!c.bbox || skip.has(i)) return;
    const b = c.bbox;
    shapes.push(isPoly(c) ? c.polygon : [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]);
  });
  let best = null, d = tol;
  for (const P of shapes) for (const q of P) { const e = dist(p, q); if (e <= d) { d = e; best = q; } }
  if (best) return { p: best.slice(), snap: 'corner' };
  d = tol;
  for (const P of shapes) for (let k = 0; k < P.length; k++) {
    const a = P[k], b = P[(k + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L, 0, 1) : 0, q = [a[0] + t * dx, a[1] + t * dy];
    const e = dist(p, q);
    if (e <= d) { d = e; best = q; }
  }
  return best ? { p: best, snap: 'edge' } : { p, snap: null };
}
/* Shows where the magnet stuck: the side (k: 0 left, 1 top, 2 right, 3 bottom of box b) or the point. */
function drawSnapMarks(lines, b, pt) {
  const svg = $('#overlay'), pad = 14 / IV.scale;
  for (const L of lines || []) {
    const v = L.k % 2 === 0;
    svg.appendChild(svgEl('line', v ? { x1: L.w, y1: b[1] - pad, x2: L.w, y2: b[3] + pad, 'vector-effect': 'non-scaling-stroke' }
      : { x1: b[0] - pad, y1: L.w, x2: b[2] + pad, y2: L.w, 'vector-effect': 'non-scaling-stroke' }, 'draft snap'));
  }
  if (pt) svg.appendChild(svgEl('circle', { cx: pt[0], cy: pt[1], r: 5 / IV.scale, 'vector-effect': 'non-scaling-stroke' }, 'draft snap'));
}
function polySkip() {
  const i = BX.poly ? BX.poly.idx : BX.none ? -1 : activeIndex();
  return new Set(i >= 0 ? [i] : []);  // the box being redrawn is not a neighbour
}
/* Polygon mode, before the first point: show where the magnet would put it. */
function polyHoverSnap(p) {
  clearDraft();
  const sn = snapPoint(clampPt(p), polySkip());
  if (sn.snap) drawSnapMarks([], null, sn.p);
}
/* Polygon mode: each click adds a point; the first point, a double-click or Enter closes it. */
function polyClick(p) {
  let q = clampPt(p);
  if (!BX.poly) { q = snapPoint(q, polySkip()).p; BX.poly = { idx: BX.none ? -1 : activeIndex(), pts: [q] }; renderBoxbar(); }
  else {
    const P = BX.poly.pts;
    if (P.length >= 3 && dist(q, P[0]) * IV.scale <= 8) return polyFinish();
    q = snapPoint(q, polySkip()).p;
    if (dist(q, P[P.length - 1]) * IV.scale < 3) return;  // second click of a double-click
    P.push(q);
  }
  drawPolyDraft(q);
}
function drawPolyDraft(cur) {
  clearDraft();
  if (!BX.poly) return;
  const sn = cur ? snapPoint(clampPt(cur), polySkip()) : null;
  const svg = $('#overlay'), P = BX.poly.pts.concat(sn ? [sn.p] : []);
  if (sn && sn.snap) drawSnapMarks([], null, sn.p);
  svg.appendChild(svgEl('polyline', { points: P.map(q => q.join(',')).join(' '), 'vector-effect': 'non-scaling-stroke' }, 'draft'));
  const r = 6 / IV.scale, f = BX.poly.pts[0], s = 5 / IV.scale;
  svg.appendChild(svgEl('circle', { cx: f[0], cy: f[1], r, 'vector-effect': 'non-scaling-stroke' }, 'draft first'));
  for (const q of BX.poly.pts.slice(1)) svg.appendChild(svgEl('rect', { x: q[0] - s / 2, y: q[1] - s / 2, width: s, height: s, 'vector-effect': 'non-scaling-stroke' }, 'draft pt'));
}
function polyCancel() { if (BX.poly) { BX.poly = null; clearDraft(); renderBoxbar(); } }
function polyFinish() {
  const d = BX.poly;
  if (!d) return;
  BX.poly = null; clearDraft();
  if (d.pts.length < 3) { renderBoxbar(); return toast('A polygon needs at least 3 points.'); }
  if (d.idx < 0) { renderBoxbar(); return addBoxAtPlace({ bbox: bboxOf(d.pts), polygon: d.pts }); }
  const cell = S.model.cells[d.idx], at = [cell.r, cell.c];
  const ok = apply('box', () => { setBox(cell, null, d.pts, 'hand'); return 'box_poly'; });
  renderBoxbar();
  if (ok && $('#bx-next').checked) {
    const next = nextNeedingBox(S.slots[at[0]][at[1]]);
    if (next >= 0) { const c = S.model.cells[next]; setSel(c.r, c.c); }
    else toast('Every cell has a box now.');
  }
}
/* Double-click on the selected polygon: on a point removes it, on an edge adds a point there. */
function polyEditAt(p) {
  if (BX.none) return false;
  const i = activeIndex(), c = S.model.cells[i];
  if (!c || !isPoly(c)) return false;
  const h = boxHit(c, p);
  if (!h || (h.kind !== 'vertex' && h.kind !== 'pedge')) return false;
  if (h.kind === 'vertex' && c.polygon.length <= 3) { toast('A polygon keeps at least 3 points.'); return true; }
  apply('box', () => {
    const Q = c.polygon.map(q => q.slice());
    if (h.kind === 'vertex') Q.splice(h.i, 1); else Q.splice(h.i + 1, 0, clampPt(p));
    setBox(c, null, Q, 'hand');
    return 'box_adjust';
  });
  return true;
}
function setShape(sh) {
  BX.shape = sh === 'poly' || sh === 'select' ? sh : 'rect';
  LS.set('bxshape', BX.shape);
  polyCancel();
  $$('#bx-shape button').forEach(b => b.classList.toggle('on', b.dataset.shape === BX.shape));
  renderBoxbar();
}
/* A rectangle becomes a 4-point polygon (to move its corners one by one), or a polygon its bounding rectangle. */
OPS['box-poly'] = function () {
  let n = 0;
  for (const i of boxTargets()) {
    const c = S.model.cells[i];
    if (!c.bbox) continue;
    if (isPoly(c)) setBox(c, c.bbox, null, 'hand');
    else { const [x0, y0, x1, y1] = c.bbox; setBox(c, null, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 'hand'); }
    n++;
  }
  if (!n) toast('No box here.');
  return n ? 'box_adjust' : false;
};
/* Several boxes selected at once (a rectangle dragged in ↖ Select, or Ctrl+click): the cells, as objects. */
function multiIdx() {
  if (!BX.multi) return [];
  const out = [];
  S.model.cells.forEach((c, i) => { if (c.bbox && BX.multi.has(c)) out.push(i); });
  return out;
}
/* Nothing selected: click on an empty spot in Select mode, or Esc. A box drawn then is a new box: it goes to the
   cell at that place (from the grid lines, else from the rows and columns of the other boxes) and no box is replaced. */
function unselectBox() {
  endAssign();
  BX.multi = null; BX.none = true;
  drawOverlay(); renderBoxbar();
}
/* The estimated centre and size of each row ('r', at x = at) or column ('c', at y = at); null when nothing tells. */
function placeAxis(axis, at) {
  const m = S.model, n = axis === 'r' ? m.nRows : m.nCols, gl = S.meta.grid_lines;
  const ctr = new Array(n).fill(null), size = new Array(n).fill(null);
  if (gridOK(gl) && IV.w && IV.h) {
    const L = axis === 'r' ? gl.h : gl.v, t = at / (axis === 'r' ? IV.w : IV.h), pos = l => l[0] + (l[1] - l[0]) * t;
    for (let k = 0; k < n; k++) { const a = pos(L[k]), b = pos(L[k + 1]); ctr[k] = (a + b) / 2; size[k] = Math.abs(b - a); }
    return { ctr, size };
  }
  const lo = axis === 'r' ? 1 : 0, hi = lo + 2, vals = Array.from({ length: n }, () => []);
  for (const c of m.cells) if (c.bbox && (axis === 'r' ? c.rs : c.cs) === 1) vals[axis === 'r' ? c.r : c.c].push(c.bbox);
  const med = v => { const w = v.slice().sort((x, y) => x - y); return w[w.length >> 1]; };
  const known = [];
  vals.forEach((B, k) => { if (B.length) { ctr[k] = med(B.map(b => (b[lo] + b[hi]) / 2)); size[k] = med(B.map(b => b[hi] - b[lo])); known.push(k); } });
  if (!known.length) return null;
  const ms = med(known.map(k => size[k]));
  for (let k = 0; k < n; k++) {  // rows / columns without boxes: in between their neighbours, or one size further
    if (ctr[k] !== null) continue;
    const p = known.filter(j => j < k).pop(), q = known.find(j => j > k);
    if (p !== undefined && q !== undefined) { size[k] = (ctr[q] - ctr[p]) / (q - p); ctr[k] = ctr[p] + size[k] * (k - p); }
    else { size[k] = ms; ctr[k] = p !== undefined ? ctr[p] + ms * (k - p) : ctr[q] - ms * (q - k); }
  }
  return { ctr, size };
}
/* The cell a new box goes to: the cell at that place when it has no box, else the nearest cell around it without one. */
function cellAtPlace(b) {
  const m = S.model, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const R = placeAxis('r', cx), C = placeAxis('c', cy);
  if (!R || !C) {  // no box and no grid yet: the selected cell, else the next cell without a box
    const a = activeIndex(), i = !m.cells[a].bbox ? a : nextNeedingBox(a);
    return { i, how: 'first', taken: -1 };
  }
  const nearest = (A, v) => A.ctr.reduce((best, x, k) => (Math.abs(x - v) < Math.abs(A.ctr[best] - v) ? k : best), 0);
  const r = nearest(R, cy), c = nearest(C, cx), at = S.slots[r][c];
  if (!m.cells[at].bbox) return { i: at, how: 'place', taken: -1 };
  const mean = (A, k0, n) => { let t = 0; for (let k = k0; k < k0 + n; k++) t += A.ctr[k]; return t / n; };
  let best = -1, bd = Infinity;
  m.cells.forEach((x, i) => {
    if (x.bbox) return;
    const d = Math.hypot((mean(R, x.r, x.rs) - cy) / (R.size[r] || 1), (mean(C, x.c, x.cs) - cx) / (C.size[c] || 1));
    if (d < bd) { bd = d; best = i; }
  });
  return { i: bd <= 1.6 ? best : -1, how: 'near', taken: at };
}
function addBoxAtPlace(g) {
  const m = S.model, t = cellAtPlace(g.bbox);
  if (t.i < 0) {
    return toast(t.taken >= 0 ? `${cellRef(m.cells[t.taken])}, the cell at that place, already has a box, and so do the cells around it. To redraw a box: click it, then draw.`
      : 'Every cell has a box already. To redraw a box: click it, then draw.', 6000);
  }
  const cell = m.cells[t.i];
  if (!apply('box', () => { setBox(cell, g.bbox, g.polygon, 'hand'); return g.polygon ? 'box_poly' : 'box_draw'; })) return;
  BX.keepNone = true; setSel(cell.r, cell.c); BX.keepNone = false;  // the table shows the cell; nothing stays selected on the image
  const i = S.model.cells.indexOf(cell);
  if (BOX[i]) { const el = BOX[i]; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1300); }
  const name = cellRef(cell);
  toast(t.how === 'near' ? `New box: ${name}, the nearest cell without a box (${cellRef(m.cells[t.taken])}, at that place, has one). Wrong cell? Click the box, then Move to cell….`
    : `New box: ${name}${t.how === 'place' ? ', the cell at that place' : ''}. Wrong cell? Click the box, then Move to cell….`, 5000);
}
/* The cells a box operation works on: the selected boxes, else the selected cells. */
function boxTargets() { const mi = multiIdx(); return mi.length ? mi : BX.none ? [] : cellsInRect(rectOfSel()); }
function groupBox(idx) {
  const B = idx.map(i => S.model.cells[i].bbox);
  return [Math.min(...B.map(b => b[0])), Math.min(...B.map(b => b[1])), Math.max(...B.map(b => b[2])), Math.max(...B.map(b => b[3]))];
}
function setMulti(cells) {
  const list = [...cells].filter(c => c.bbox && S.model.cells.includes(c));
  if (!list.length) { BX.multi = null; drawOverlay(); renderBoxbar(); return; }
  const r0 = Math.min(...list.map(c => c.r)), c0 = Math.min(...list.map(c => c.c));
  const r1 = Math.max(...list.map(c => c.r + c.rs - 1)), c1 = Math.max(...list.map(c => c.c + c.cs - 1));
  BX.keepMulti = true;
  BX.multi = new Set(list);
  if (list.length > 1) { setSel(r0, c0); setSel(r1, c1, true); } else setSel(list[0].r, list[0].c);
  BX.keepMulti = false;
  drawOverlay(); renderBoxbar();
}
function toggleMulti(j) {
  const c = S.model.cells[j];
  const cur = new Set(BX.multi ? multiIdx().map(i => S.model.cells[i]) : BX.none ? [] : cellsInRect(rectOfSel()).map(i => S.model.cells[i]).filter(x => x.bbox));
  if (cur.has(c)) cur.delete(c); else cur.add(c);
  if (!cur.size) return unselectBox();
  setMulti(cur);
}
const bandHits = R => S.model.cells.filter(c => c.bbox && c.bbox[0] < R[2] && c.bbox[2] > R[0] && c.bbox[1] < R[3] && c.bbox[3] > R[1]);
function bandMove(d, p) {
  if (!d.moved) { if (dist(p, d.start) * IV.scale < 4) return; d.moved = true; }
  const a = clampPt(d.start), b = clampPt(p);
  d.rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  clearDraft();
  $('#overlay').appendChild(svgEl('rect', { x: d.rect[0], y: d.rect[1], width: d.rect[2] - d.rect[0], height: d.rect[3] - d.rect[1], 'vector-effect': 'non-scaling-stroke' }, 'draft band'));
  for (const i of d.hits) if (BOX[i]) BOX[i].classList.remove('bandhit');
  d.hits = [];
  S.model.cells.forEach((c, i) => { if (c.bbox && c.bbox[0] < d.rect[2] && c.bbox[2] > d.rect[0] && c.bbox[1] < d.rect[3] && c.bbox[3] > d.rect[1]) { d.hits.push(i); if (BOX[i]) BOX[i].classList.add('bandhit'); } });
}
function bandUp(d, p) {
  BX.drag = null;
  clearDraft();
  for (const i of d.hits) if (BOX[i]) BOX[i].classList.remove('bandhit');
  if (!d.moved) {  // a click
    const j = boxAt(p);
    if (j < 0) return unselectBox();  // a click on an empty spot: nothing selected
    if (d.ctrl) return toggleMulti(j);
    const c = S.model.cells[j];
    if (d.shift) return setSel(c.r, c.c, true);
    return setMulti([c]);
  }
  let hits = bandHits(d.rect);
  if (d.ctrl || d.shift) {  // add to what is selected
    const cur = BX.multi ? multiIdx().map(i => S.model.cells[i]) : BX.none ? [] : cellsInRect(rectOfSel()).map(i => S.model.cells[i]).filter(x => x.bbox);
    hits = [...new Set(cur.concat(hits))];
  }
  if (!hits.length) return unselectBox();
  setMulti(hits);
  if (hits.length > 1) toast(`${hits.length} boxes selected. Drag one of them to move them all · Delete: remove them · right-click: more · Esc: unselect`, 5000);
}
function groupMove(d, p) {
  if (!d.moved) {
    if (dist(p, d.start) * IV.scale < 4) return;
    d.moved = true;
    $$('#overlay .handle, #overlay .bname').forEach(n => n.remove());
  }
  const G = d.G;
  d.dx = clamp(p[0] - d.start[0], -G[0], IV.w - G[2]);
  d.dy = clamp(p[1] - d.start[1], -G[1], IV.h - G[3]);
  const sn = snapShift([G[0] + d.dx, G[1] + d.dy, G[2] + d.dx, G[3] + d.dy], new Set(d.idx));
  d.dx = clamp(d.dx + sn.dx, -G[0], IV.w - G[2]); d.dy = clamp(d.dy + sn.dy, -G[1], IV.h - G[3]);
  clearDraft(); drawSnapMarks(sn.lines, [G[0] + d.dx, G[1] + d.dy, G[2] + d.dx, G[3] + d.dy]);
  for (const i of d.idx) if (BOX[i]) BOX[i].setAttribute('transform', `translate(${d.dx} ${d.dy})`);
}
function groupUp(d, p, ctrl) {
  BX.drag = null;
  clearDraft();
  for (const i of d.idx) if (BOX[i]) BOX[i].removeAttribute('transform');
  if (!d.moved) {  // a click on one of the selected boxes
    const j = boxAt(p);
    if (j < 0) return;
    if (ctrl) return toggleMulti(j);
    return setMulti([S.model.cells[j]]);
  }
  const keep = BX.multi, cells = d.idx.map(i => S.model.cells[i]), dx = d.dx, dy = d.dy;
  if (!dx && !dy) return drawOverlay();
  apply('box', () => {
    for (const c of cells) {
      if (isPoly(c)) setBox(c, null, c.polygon.map(q => [q[0] + dx, q[1] + dy]), 'hand');
      else setBox(c, [c.bbox[0] + dx, c.bbox[1] + dy, c.bbox[2] + dx, c.bbox[3] + dy], null, 'hand');
    }
    return 'box_move_group';
  });
  BX.multi = keep;
  drawOverlay(); renderBoxbar();
}

/* A new row (above / below) or column (left / right) next to the selected cell, whose boxes are those of the
   selected row / column moved by their own height / width: the same size. */
function addLineWithBoxes(axis, after) {
  const m = S.model, a = m.cells[activeIndex()];
  if (!a.bbox) return toast('This cell has no box: select a cell with a box, in the row or column to copy.'), false;
  const row = axis === 'row', at = row ? (after ? a.r + a.rs : a.r) : (after ? a.c + a.cs : a.c);
  const from = row ? (after ? a.r + a.rs - 1 : a.r) : (after ? a.c + a.cs - 1 : a.c);  // the row / column copied
  const n = row ? m.nCols : m.nRows, sign = after ? 1 : -1;
  const unit = row ? (a.bbox[3] - a.bbox[1]) / a.rs : (a.bbox[2] - a.bbox[0]) / a.cs;  // one row / column of the selected box
  // for every column (row) k: the box of the copied row (column) there, moved by one row (column)
  const src = [];
  for (let k = 0; k < n; k++) src.push(m.cells[row ? S.slots[from][k] : S.slots[k][from]]);
  // the extent of column (row) k, for a merged source cell: the median of the 1-wide boxes of that column (row)
  const span = k => {
    const L = m.cells.filter(c => c.bbox && (row ? c.c === k && c.cs === 1 : c.r === k && c.rs === 1));
    if (!L.length) return null;
    const med = v => v.sort((x, y) => x - y)[v.length >> 1];
    return row ? [med(L.map(c => c.bbox[0])), med(L.map(c => c.bbox[2]))] : [med(L.map(c => c.bbox[1])), med(L.map(c => c.bbox[3]))];
  };
  const geom = k => {
    const c = src[k];
    if (!c || !c.bbox) return null;
    const b = c.bbox, own = row ? c.rs === 1 : c.cs === 1, wide = row ? c.cs > 1 : c.rs > 1;
    if (own && !wide) {
      const d = sign * (row ? b[3] - b[1] : b[2] - b[0]);
      if (isPoly(c)) return { polygon: c.polygon.map(q => (row ? [q[0], q[1] + d] : [q[0] + d, q[1]])) };
      return { bbox: row ? [b[0], b[1] + d, b[2], b[3] + d] : [b[0] + d, b[1], b[2] + d, b[3]] };
    }
    // a merged source cell: one row (column) next to it, cut to column (row) k
    const sp = (wide ? span(k) : null) || (wide ? (() => { const w = (row ? b[2] - b[0] : b[3] - b[1]) / (row ? c.cs : c.rs), i = k - (row ? c.c : c.r); return row ? [b[0] + w * i, b[0] + w * (i + 1)] : [b[1] + w * i, b[1] + w * (i + 1)]; })() : (row ? [b[0], b[2]] : [b[1], b[3]]));
    if (row) return { bbox: after ? [sp[0], b[3], sp[1], b[3] + unit] : [sp[0], b[1] - unit, sp[1], b[1]] };
    return { bbox: after ? [b[2], sp[0], b[2] + unit, sp[1]] : [b[0] - unit, sp[0], b[0], sp[1]] };
  };
  const G = src.map((_, k) => geom(k));
  insertLine(axis, at);
  let made = 0;
  for (const c of m.cells) {
    if ((row ? c.r : c.c) !== at || (row ? c.rs : c.cs) !== 1) continue;
    const g = G[row ? c.c : c.r];
    if (!g || c.bbox || !c.edited || c.text) continue;
    const clampB = b => [clamp(b[0], 0, IV.w), clamp(b[1], 0, IV.h), clamp(b[2], 0, IV.w), clamp(b[3], 0, IV.h)];
    if (g.polygon) setBox(c, null, g.polygon.map(clampPt), 'hand');
    else { const bb = clampB(g.bbox); if (bb[2] - bb[0] < 1 || bb[3] - bb[1] < 1) continue; setBox(c, bb, null, 'hand'); }
    made++;
  }
  if (row) S.sel = { ar: at, ac: a.c, er: at, ec: a.c }; else S.sel = { ar: a.r, ac: at, er: a.r, ec: at };
  setTimeout(() => toast(`New ${row ? 'row' : 'column'} ${row ? at + 1 : colName(at)}: ${made} box${made === 1 ? '' : 'es'} the size of ${row ? 'row ' + (from + 1) : 'column ' + colName(from)}. Ctrl+Z: undo.`, 4000), 0);
  return 'insert_' + axis + '_boxes';
}
OPS['row-above-boxes'] = () => addLineWithBoxes('row', false);
OPS['row-below-boxes'] = () => addLineWithBoxes('row', true);
OPS['col-left-boxes'] = () => addLineWithBoxes('col', false);
OPS['col-right-boxes'] = () => addLineWithBoxes('col', true);

/* Next cell in reading order (row by row) that needs a box and has none. */
function nextNeedingBox(from) {
  const cells = S.model.cells, n = cells.length;
  for (let k = 1; k <= n; k++) { const i = (from + k) % n, c = cells[i]; if (!c.bbox && needsBox(c)) return i; }
  return -1;
}
function boxHover(p, e) {
  let cur = 'crosshair';
  if (BX.space) cur = 'grab';
  else if (BX.grid) { const h = gridHit(p); cur = !h ? 'grab' : h.end !== null ? 'move' : h.ax === 'h' ? 'ns-resize' : 'ew-resize'; gridHot(h); }
  else { const c = BX.none ? null : S.model.cells[activeIndex()]; cur = hitCursor(c && c.bbox ? boxHit(c, p) : null); }
  if (BX.shape === 'select' && !BX.grid && !BX.space) {
    const mi = multiIdx(), j = boxAt(p);
    if (j >= 0 && mi.includes(j) && (mi.length > 1 || cur === 'move' || cur === 'crosshair')) cur = 'move';
    else if (cur === 'crosshair' || cur === 'move') cur = BX.assign !== null && j >= 0 ? 'pointer' : 'default';
  }
  $('#imgview').style.cursor = cur;
  setHover(BX.grid ? -1 : boxAt(p), e);
}
function setHover(i, e) {
  const lab = $('#box-label');
  if (i !== BX.hover) {
    if (BOX[BX.hover]) BOX[BX.hover].classList.remove('hov');
    if (TD[BX.hover]) TD[BX.hover].classList.remove('hov');
    BX.hover = i;
    if (BOX[i]) BOX[i].classList.add('hov');
    if (TD[i]) TD[i].classList.add('hov');
    if (i >= 0) { const c = S.model.cells[i]; lab.innerHTML = `<b>${cellRef(c)}</b> ${c.text ? cellHTML(c.text.length > 40 ? c.text.slice(0, 40) + '…' : c.text) : '<span class="muted">empty</span>'}`; }
  }
  lab.hidden = i < 0 || !BX.on;
  if (!lab.hidden && e) {
    const r = $('#imgview').getBoundingClientRect();
    lab.style.left = Math.min(e.clientX - r.left + 14, r.width - lab.offsetWidth - 4) + 'px';
    lab.style.top = Math.max(e.clientY - r.top - 30, 2) + 'px';
  }
}

/* Box mode on / off. */
function setBoxMode(on) {
  if (boxPolicy() === 'off') on = false;
  BX.none = false;
  if (!on) { endAssign(); polyCancel(); }
  if (!on && BX.grid) closeGrid(false);
  const was = BX.on;
  BX.on = !!on;
  LS.set('boxmode', BX.on);
  if (was !== BX.on && IV.w) { applyLayout(); imgFit(LS.get('imgfit', 'width')); }
  $('#imgpane').classList.toggle('boxmode', BX.on);
  $('#grid').classList.toggle('boxmode', BX.on);
  $$('#imgpane [data-mode]').forEach(b => b.classList.toggle('on', (b.dataset.mode === 'boxes') === BX.on));
  $('#boxbar').hidden = !BX.on;
  $('#imgview').style.cursor = '';
  setHover(-1);
  drawGuide(); drawOverlay();
  if (S.model) renderCellbar();
  renderBoxbar();
}
function renderBoxbar() {
  if (!S.model) return;
  $('#mode-seg').hidden = boxPolicy() === 'off';
  const c = S.model.cells[activeIndex()];
  $('#img-hint').textContent = !BX.on ? 'Wheel: scroll · Ctrl+wheel: zoom · drag: move · click: pin row guide'
    : BX.assign !== null ? `Type the cell the box of ${cellRef(S.model.cells[BX.assign])} belongs to (e.g. E5), or click it in the table (or click another box) · Esc: cancel`
    : BX.poly ? `Polygon of ${BX.poly.idx < 0 ? 'a new box (it goes to the cell at that place)' : cellRef(S.model.cells[BX.poly.idx])}: click the next point · click the first point, double-click or Enter: close it · Backspace: remove the last point · Esc: cancel`
    : BX.none && !BX.grid ? (BX.shape === 'select' ? 'Nothing selected · click a box: select it · drag a rectangle: select the boxes it touches · to add boxes, switch to ▭ Box or ⬠ Polygon: a new box goes to the cell at that place, no box is replaced · Space+drag: move the image'
      : BX.shape === 'poly' ? 'Nothing selected: click the points of a new box, it goes to the cell at that place (no box is replaced) · to select a box: ↖ Select, or Ctrl+click it · Space+drag: move the image'
      : 'Nothing selected: drag to draw a new box, it goes to the cell at that place (no box is replaced) · click a box: select it · Space+drag: move the image')
    : BX.shape === 'select' && !BX.grid ? (multiIdx().length > 1 ? `${multiIdx().length} boxes selected: drag one of them to move them all · Delete: remove them · Ctrl+click: add / take out a box · right-click: more · Esc: unselect`
      : `Click a box: select it, then drag it to move it · click an empty spot or Esc: nothing selected (to add boxes) · drag a rectangle: select the boxes it touches (Ctrl: add) · Ctrl+click: add / take out a box · drag a side of the selected box: resize · right-click a box: more · Space+drag: move the image`)
    : BX.shape === 'poly' && !BX.grid ? `Click the points of the polygon of ${cellRef(c)} · double-click a point of a polygon: remove it, an edge: add a point · choose the cell in the table`
    : BX.grid ? (BX.gridFresh ? 'Drag a rectangle around the table: the lines are spread inside it · Space+drag: move the image'
      : 'Drag the outer border: the inner lines follow (Alt: border alone) · drag a line: move it · drag a round end: tilt it (corner: sideways tilts the left/right border, up/down the top/bottom) · Shift+drag: new outline · Space+drag: move the image')
    : `Drag: draw the box of ${cellRef(c)} · drag its edges or inside: adjust (a shared border moves for both cells; Alt+drag: this box alone) · click a box: select its cell, Shift+click: add it (then Merge), Ctrl+click or Ctrl+drag: select several boxes · right-click a box: more · Space+drag: move the image`;
  if (!BX.on) return;
  $('#bx-regrid').hidden = !!BX.grid || !gridOK(S.meta.grid_lines);
  const want = S.model.cells.filter(x => boxPolicy() === 'text' ? !!x.text : true);
  const have = want.filter(x => x.bbox).length;
  $('#bx-count').textContent = `${have} / ${want.length} boxes`;
  $('#bx-count').title = boxPolicy() === 'text' ? 'Cells with text that have a box' : 'Cells that have a box';
  const b = c.bbox, el = $('#bx-cell'), nm = multiIdx().length;
  if (BX.none && !BX.grid) { el.className = ''; el.textContent = 'no box selected'; el.title = 'A box drawn now goes to the cell at that place; no box is replaced. Click a box to select it.'; return; }
  if (nm > 1) { el.className = 'has'; el.innerHTML = `<b>${nm}</b>boxes selected`; el.title = 'Drag one of them to move them all · Delete: remove them · right-click: more · Esc: unselect'; return; }
  el.className = (b ? 'has' : needsBox(c) ? 'todo' : '') + (b && !BX.grid ? ' click' : '');
  el.innerHTML = `<b>${cellRef(c)}</b>` + boxWord(c);
  el.title = b ? `${Math.round(b[2] - b[0])} × ${Math.round(b[3] - b[1])} px` + ({ model: ', from the model: check it', grid: ', from the grid lines' }[c.box_by] || ', drawn or fixed by hand') : 'Drag on the image to draw the box of this cell';
}

// Box operations (undoable, through apply)
OPS.unbox = function () {
  let n = 0;
  for (const i of boxTargets()) { const c = S.model.cells[i]; if (c.bbox) { setBox(c, null, null); n++; } }
  if (!n) toast(BX.none ? 'No box selected: click a box first.' : 'No box to remove here.');
  return n ? 'box_remove' : false;
};
OPS['box-fit'] = function () {
  const P = pixels();
  if (!P) return toast('The image is not loaded yet.'), false;
  let n = 0, none = 0;
  for (const i of boxTargets()) {
    const c = S.model.cells[i];
    if (!c.bbox) continue;
    const b = fitToInk(P, c.bbox);
    if (!b) { none++; continue; }
    if (b.some((v, k) => Math.round(v) !== Math.round(c.bbox[k])) || c.polygon) { setBox(c, b, null); n++; }
  }
  if (!n) toast(none ? 'No ink found inside the box.' : BX.none ? 'No box selected: click a box first.' : 'Select a cell that has a box.');
  return n ? 'box_fit' : false;
};

// ------------------------------------------------------------------------------------------
// Image pixels: ink map (Otsu threshold) for "Snap to the page" and "Fit to ink"

function pixels() {
  const img = $('#img');
  if (BX.pix && BX.pix.url === S.detail.image_url) return BX.pix;
  if (!IV.w || !img.complete) return null;
  const f = Math.min(1, 1600 / Math.max(IV.w, IV.h));
  const w = Math.max(1, Math.round(IV.w * f)), h = Math.max(1, Math.round(IV.h * f));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try { data = ctx.getImageData(0, 0, w, h).data; } catch (e) { toast('Cannot read the pixels of this image.'); return null; }
  const gray = new Uint8Array(w * h), hist = new Float64Array(256);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) { const v = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000 | 0; gray[i] = v; hist[v]++; }
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {  // Otsu
    wB += hist[t]; if (!wB) continue;
    const wF = gray.length - wB; if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
    if (between > best) { best = between; thr = t; }
  }
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = gray[i] <= thr ? 1 : 0;
  // faint marks too (ruled lines are often lighter than the writing): darker than the paper by a clear margin
  const pct = q => { let acc = 0; for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= q * gray.length) return t; } return 255; };
  const paper = pct(0.6), dark = pct(0.03), lthr = paper - Math.max(18, 0.25 * (paper - dark));
  const mark = new Uint8Array(w * h);
  for (let i = 0; i < mark.length; i++) mark[i] = gray[i] <= lthr ? 1 : 0;
  const near = new Uint8Array(w * h);  // faint ink within 1 pixel: tolerant to thin, slightly slanted lines
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mark[i] || (x > 0 && mark[i - 1]) || (x < w - 1 && mark[i + 1]) || (y > 0 && mark[i - w]) || (y < h - 1 && mark[i + w])) near[i] = 1;
  }
  BX.pix = { url: S.detail.image_url, f, w, h, ink, mark, near };
  return BX.pix;
}
/* Shrink a box to the ink inside it. Rows or columns that are mostly ink (ruled lines) are ignored. */
function fitToInk(P, b) {
  const f = P.f, w = P.w;
  const x0 = clamp(Math.floor(b[0] * f), 0, P.w - 1), y0 = clamp(Math.floor(b[1] * f), 0, P.h - 1);
  const x1 = clamp(Math.ceil(b[2] * f), 0, P.w - 1), y1 = clamp(Math.ceil(b[3] * f), 0, P.h - 1);
  const W = x1 - x0 + 1, H = y1 - y0 + 1;
  if (W < 3 || H < 3) return null;
  const rows = new Int32Array(H), cols = new Int32Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (P.ink[(y0 + y) * w + x0 + x]) { rows[y]++; cols[x]++; }
  const ruleRow = Array.from(rows, v => v > 0.6 * W), ruleCol = Array.from(cols, v => v > 0.6 * H);
  const r2 = new Int32Array(H), c2 = new Int32Array(W);
  for (let y = 0; y < H; y++) if (!ruleRow[y]) for (let x = 0; x < W; x++) if (!ruleCol[x] && P.ink[(y0 + y) * w + x0 + x]) { r2[y]++; c2[x]++; }
  const first = a => a.findIndex(v => v > 0), last = a => a.length - 1 - Array.from(a).reverse().findIndex(v => v > 0);
  const fy = first(r2), fx = first(c2);
  if (fy < 0 || fx < 0) return null;
  const ly = last(r2), lx = last(c2), pad = 2;
  return [
    clamp((x0 + fx) / f - pad, b[0], b[2]), clamp((y0 + fy) / f - pad, b[1], b[3]),
    clamp((x0 + lx + 1) / f + pad, b[0], b[2]), clamp((y0 + ly + 1) / f + pad, b[1], b[3]),
  ];
}

// ------------------------------------------------------------------------------------------
// Grid tool: one line per row and column border; every cell gets the box between its lines.
// A line is stored by its position at both image edges, so it can be tilted:
// h[i] = [y at x=0, y at x=W] (nRows + 1 lines), v[j] = [x at y=0, x at y=H] (nCols + 1 lines).

function cloneGrid(g) { return { h: g.h.map(l => l.slice()), v: g.v.map(l => l.slice()) }; }
function gridOK(g) { return g && Array.isArray(g.h) && Array.isArray(g.v) && g.h.length === S.model.nRows + 1 && g.v.length === S.model.nCols + 1; }
function crossPt(hl, vl) {
  const a = (vl[1] - vl[0]) / IV.h, b = (hl[1] - hl[0]) / IV.w;
  const y = (hl[0] + b * vl[0]) / (1 - a * b);
  return [vl[0] + a * y, y];
}
function visEnds(g, ax, i) {
  return ax === 'h' ? [crossPt(g.h[i], g.v[0]), crossPt(g.h[i], g.v[g.v.length - 1])] : [crossPt(g.h[0], g.v[i]), crossPt(g.h[g.h.length - 1], g.v[i])];
}
const gLen = ax => (ax === 'h' ? IV.w : IV.h);       // length along the line
const gSpan = ax => (ax === 'h' ? IV.h : IV.w);      // range of its position
const gPos = (ax, q) => (ax === 'h' ? q[1] : q[0]);
const gAlong = (ax, q) => (ax === 'h' ? q[0] : q[1]);
const gAt = (ax, l, a) => l[0] + (l[1] - l[0]) * a / gLen(ax);
function gThrough(ax, a1, p1, a2, p2) { const s = (p2 - p1) / ((a2 - a1) || 1e-6), p0 = p1 - s * a1; return [p0, p0 + s * gLen(ax)]; }
function evenLines(n, lo, hi) { return Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1)); }
function gridEven() {
  const m = S.model, mx = IV.w * 0.01, my = IV.h * 0.01;
  return { h: evenLines(m.nRows + 1, my, IV.h - my).map(y => [y, y]), v: evenLines(m.nCols + 1, mx, IV.w - mx).map(x => [x, x]) };
}
/* Lines from the boxes the cells already have (median of the box sides on each border); gaps are interpolated. */
function gridFromBoxes() {
  const m = S.model;
  const hs = Array.from({ length: m.nRows + 1 }, () => []), vs = Array.from({ length: m.nCols + 1 }, () => []);
  for (const c of m.cells) if (c.bbox) { hs[c.r].push(c.bbox[1]); hs[c.r + c.rs].push(c.bbox[3]); vs[c.c].push(c.bbox[0]); vs[c.c + c.cs].push(c.bbox[2]); }
  const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const fill = (arr, lo, hi) => {
    const known = arr.map((v, i) => [i, v]).filter(x => x[1] !== null);
    if (known.length < 2) return null;
    const n = arr.length;
    if (arr[0] === null) arr[0] = Math.max(lo, known[0][1] - (known[1][1] - known[0][1]) / (known[1][0] - known[0][0]) * known[0][0]);
    if (arr[n - 1] === null) { const a = known[known.length - 2], b = known[known.length - 1]; arr[n - 1] = Math.min(hi, b[1] + (b[1] - a[1]) / (b[0] - a[0]) * (n - 1 - b[0])); }
    for (let i = 1; i < n - 1; i++) if (arr[i] === null) {
      let j = i + 1; while (arr[j] === null) j++;
      arr[i] = arr[i - 1] + (arr[j] - arr[i - 1]) / (j - i + 1);
    }
    for (let i = 1; i < n; i++) arr[i] = Math.max(arr[i], arr[i - 1] + 2);
    return arr;
  };
  const H = fill(hs.map(med), 0, IV.h), V = fill(vs.map(med), 0, IV.w);
  if (!H || !V) return null;
  return { h: H.map(y => [y, y]), v: V.map(x => [x, x]) };
}
/* How the grid starts: 'saved' (the lines kept for this table), 'boxes' (from the boxes the cells have,
   e.g. the model output) or 'uniform' (rows and columns of equal size, placed by hand). */
function gridStart(mode) {
  const saved = gridOK(S.meta.grid_lines) ? cloneGrid(S.meta.grid_lines) : null;
  if (mode === 'saved' && saved) return { g: saved, fresh: false };
  const fromBoxes = gridFromBoxes();
  if (mode === 'uniform') return { g: gridUniform(fromBoxes || saved), fresh: false, outline: !!(fromBoxes || saved) };
  if (mode === 'boxes' && fromBoxes) return { g: fromBoxes, fresh: false };
  if (saved) return { g: saved, fresh: false };
  return fromBoxes ? { g: fromBoxes, fresh: false } : { g: gridEven(), fresh: true };
}
/* Equal rows and columns between the outer lines of `base` (the table area), or over the whole image. */
function gridUniform(base) {
  const g = base ? cloneGrid(base) : gridEven();
  spreadEven(g, 'h', 0, g.h.length - 1); spreadEven(g, 'v', 0, g.v.length - 1);
  return g;
}
function gridMenu(x, y) {
  const saved = gridOK(S.meta.grid_lines), boxes = S.model.cells.some(c => c.bbox), open = !!BX.grid;
  const items = [];
  if (saved) items.push(['grid:saved', open ? 'Back to the lines saved for this table' : 'Back to the grid these boxes were made from', '']);
  items.push(boxes ? ['grid:boxes', 'Lines from the cell boxes (model output)', ''] : ['', 'Lines from the cell boxes: no cell has a box yet', '']);
  items.push(['grid:uniform', 'Uniform grid: equal rows and columns, you move the lines', '']);
  items.push(['grid:size', 'Uniform grid of another size: choose rows × columns…', '']);
  showMenuItems(x, y, items);
}
function gridOp(mode) {
  if (!IV.w || !S.model) return;
  if (mode === 'size') {  // a uniform grid, then the cursor in the rows field
    gridOp('uniform');
    setTimeout(() => { const el = $('#g-rows'); el.focus(); el.select(); }, 0);
    toast('Type the number of rows and of columns of the grid (Tab between them, Enter).', 5000);
    return;
  }
  LS.set('gridstart', mode);
  if (!BX.grid) return openGrid(mode);
  gridPush();  // already open: start over (Ctrl+Z goes back)
  const st = gridStart(mode);
  BX.grid = st.g; BX.gridFresh = st.fresh;
  drawGrid(); renderBoxbar();
  gridToast(mode, st);
}
function gridToast(mode, st) {
  if (st.fresh) toast('Drag a rectangle around the table first: the lines are spread inside it.', 5000);
  else if (mode === 'uniform') toast(st.outline ? 'Uniform grid over the table area. Move the lines by hand (Snap puts them on the lines of the page).'
    : 'Uniform grid over the image. Shift+drag a rectangle around the table (or drag each outer border), then move the lines by hand.', 6000);
  else if (mode === 'boxes') toast('Lines placed from the boxes the cells have. Drag the outer border: the inner lines follow.', 5000);
  else if (mode === 'saved') toast('Back to the grid these boxes were made from. Move the lines, then Make boxes' + ($('#g-keep').checked ? ': the boxes you fixed by hand are kept ("keep my boxes").' : '.'), 6000);
}
function openGrid(mode, lines) {
  if (!IV.w || !S.model) return;
  endAssign(); polyCancel();
  if (!BX.on) setBoxMode(true);
  const st = lines ? { g: cloneGrid(lines), fresh: false } : gridStart(mode);
  BX.grid = st.g;
  BX.gridFresh = st.fresh;
  BX.gUndo = []; BX.gRedo = [];
  const m = S.model;
  $('#g-keep').checked = S.model.cells.some(c => c.bbox && c.box_by === 'hand');
  $('#bx-normal').hidden = true; $('#bx-gridbar').hidden = false;
  drawBoxes(); drawOverlay(); drawGrid(); drawGuide(); renderBoxbar();
  $('#overlay').classList.add('gridding');
  gridToast(mode || (gridOK(S.meta.grid_lines) ? 'saved' : 'boxes'), st);
}
function closeGrid(applyIt) {
  if (!BX.grid) return;
  if (applyIt && BX.gridFresh) return toast('Drag a rectangle around the table first.');
  if (applyIt && gridSizeDiffers()) return gridResizeDialog();  // the grid stays open until confirmed
  if (applyIt) gridApply();
  BX.grid = null; BX.drag = null;
  $('#bx-normal').hidden = false; $('#bx-gridbar').hidden = true;
  $('#overlay').classList.remove('gridding');
  drawGrid(); drawOverlay(); drawGuide(); renderBoxbar();
  $('#imgview').style.cursor = '';
}
/* The number of rows and columns of the grid. Another size than the table's: Make boxes resizes the table
   (rows added or removed at the bottom, columns at the right) after asking. */
const gridSizeDiffers = () => !!BX.grid && (BX.grid.h.length - 1 !== S.model.nRows || BX.grid.v.length - 1 !== S.model.nCols);
function renderGridSize() {
  const g = BX.grid;
  if (!g) return;
  for (const [id, v] of [['#g-rows', g.h.length - 1], ['#g-cols', g.v.length - 1]]) { const el = $(id); if (document.activeElement !== el) el.value = v; }
  const diff = gridSizeDiffers();
  $('#g-size').classList.toggle('diff', diff);
  $('#g-tbl').textContent = diff ? `table ${S.model.nRows} × ${S.model.nCols}: Make boxes resizes it` : '';
}
function gridSetSize() {
  const g = BX.grid;
  if (!g) return;
  const val = id => clamp(Math.round(+$(id).value || 0), 1, 300);
  const nr = val('#g-rows'), nc = val('#g-cols');
  if (nr === g.h.length - 1 && nc === g.v.length - 1) return renderGridSize();
  gridPush();
  for (const [ax, n] of [['h', nr], ['v', nc]]) {
    const L = g[ax];
    if (L.length - 1 === n) continue;
    const a = L[0], b = L[L.length - 1];
    g[ax] = Array.from({ length: n + 1 }, (_, i) => (i === n ? b.slice() : a.slice()));
    spreadEven(g, ax, 0, n);
  }
  drawGrid(); renderBoxbar();
  toast(gridSizeDiffers() ? `Grid of ${nr} rows × ${nc} columns, spread evenly. Move the lines, then Make boxes: the table becomes ${nr} × ${nc}.`
    : `Grid of ${nr} × ${nc}, the size of the table.`, 5000);
}
function gridResizeDialog() {
  const g = BX.grid, m = S.model, nr = g.h.length - 1, nc = g.v.length - 1;
  const parts = [];
  if (nr > m.nRows) parts.push(`adds ${plural(nr - m.nRows, 'empty row')} at the bottom`);
  if (nr < m.nRows) parts.push(`removes the last ${plural(m.nRows - nr, 'row')} (${nr + 1}${m.nRows - nr > 1 ? '–' + m.nRows : ''})`);
  if (nc > m.nCols) parts.push(`adds ${plural(nc - m.nCols, 'empty column')} at the right`);
  if (nc < m.nCols) parts.push(`removes the last ${plural(m.nCols - nc, 'column')} (${colName(nc)}${m.nCols - nc > 1 ? '–' + colName(m.nCols - 1) : ''})`);
  const lost = m.cells.filter(c => (c.r >= nr || c.c >= nc) && c.text).length;
  openModal(`<h2>Make the table ${nr} × ${nc}?</h2>
    <p>The grid has ${plural(nr, 'row')} and ${plural(nc, 'column')}, the table ${m.nRows} × ${m.nCols}. Make boxes ${parts.join(' and ')}, then gives every cell the box between its lines.${lost ? ` <b>${plural(lost, 'cell')} with text ${lost === 1 ? 'is' : 'are'} deleted.</b>` : ''} Ctrl+Z undoes it.</p>
    <p class="muted">Rows or columns missing in the middle of the table? Cancel, insert them in the table (Row +↑, Col +←), then open the grid again.</p>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="gr-ok">Resize the table and make boxes</button></div>`);
  $('#gr-ok').onclick = () => { closeModal(); gridApply(); closeGrid(false); };
}
/* Rows and columns added at the bottom / right, or removed from there. */
function resizeTable(nr, nc) {
  const m = S.model;
  while (m.nRows < nr) insertLine('row', m.nRows);
  if (m.nRows > nr) deleteLines('row', nr, m.nRows - 1);
  while (m.nCols < nc) insertLine('col', m.nCols);
  if (m.nCols > nc) deleteLines('col', nc, m.nCols - 1);
}
function spreadEven(g, ax, from, to) {  // inner lines between line `from` and line `to`, evenly
  const L = g[ax];
  for (let i = from + 1; i < to; i++) L[i] = [0, 1].map(k => L[from][k] + (L[to][k] - L[from][k]) * (i - from) / (to - from));
}
for (const id of ['#g-rows', '#g-cols']) {
  $(id).addEventListener('change', gridSetSize);
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); gridSetSize(); $('#gridwrap').focus({ preventScroll: true }); }
    else if (e.key === 'Escape') { e.preventDefault(); $(id).value = ''; renderGridSize(); $('#gridwrap').focus({ preventScroll: true }); }
    e.stopPropagation();  // typing here is not typing in the table
  });
}
$('#bx-gridbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-g]'); if (!b) return;
  const a = b.dataset.g;
  if (a === 'cancel') closeGrid(false);
  else if (a === 'apply') closeGrid(true);
  else if (a === 'even') { gridPush(); const g = BX.grid; spreadEven(g, 'h', 0, g.h.length - 1); spreadEven(g, 'v', 0, g.v.length - 1); drawGrid(); }
  else if (a === 'snap') { gridPush(); gridSnap(); }
  else if (a === 'undo') gridUndo(false);
  else if (a === 'redo') gridUndo(true);
  else if (a === 'start') { const r = b.getBoundingClientRect(); gridMenu(r.left, r.bottom + 4); }
});
/* Drag on the image (not on a line) with the grid open: the outline of the table; the lines are spread inside it. */
function gridFrameDrag(d, p) {
  if (!d.moved) { if (dist(p, d.start) * IV.scale < 5) return; d.moved = true; }
  const s = clampPt(d.start), q = clampPt(p);
  d.rect = [Math.min(s[0], q[0]), Math.min(s[1], q[1]), Math.max(s[0], q[0]), Math.max(s[1], q[1])];
  drawDraft({ bbox: d.rect, polygon: null });
}
/* Undo for the lines while the grid is open (Snap, Even, outline, moved or tilted lines). */
function gridPush(before) {
  BX.gUndo.push({ g: cloneGrid(before || BX.grid), fresh: !!BX.gridFresh });
  if (BX.gUndo.length > 100) BX.gUndo.shift();
  BX.gRedo = [];
}
function gridUndo(isRedo) {
  if (BX.drag) return;
  const from = isRedo ? BX.gRedo : BX.gUndo, to = isRedo ? BX.gUndo : BX.gRedo;
  if (!from.length) return toast(isRedo ? 'Nothing to redo in the grid.' : 'Nothing to undo in the grid. (Cancel closes it without changing the boxes.)');
  to.push({ g: cloneGrid(BX.grid), fresh: !!BX.gridFresh });
  const st = from.pop();
  BX.grid = st.g; BX.gridFresh = st.fresh;
  drawGrid(); renderBoxbar();
}
function gridFrameUp(d) {
  BX.drag = null;
  clearDraft();
  if (!d.moved || !d.rect) return;
  const [x0, y0, x1, y1] = d.rect, g = BX.grid;
  if ((x1 - x0) * IV.scale < 10 || (y1 - y0) * IV.scale < 10) return;
  const o = cloneGrid(g), fresh = BX.gridFresh;
  gridPush();
  g.h[0] = [y0, y0]; g.h[g.h.length - 1] = [y1, y1]; g.v[0] = [x0, x0]; g.v[g.v.length - 1] = [x1, x1];
  scaleInner(g, o, 'h'); scaleInner(g, o, 'v');
  BX.gridFresh = false;
  drawGrid(); renderBoxbar();
  toast(fresh ? 'Lines spread inside the outline. Now "Snap" puts them on the lines of the page.'
    : 'Lines fitted inside the new outline, with the same spacing. "Snap" puts them on the lines of the page.', 3500);
}
function gridApply() {
  const g = BX.grid, keep = $('#g-keep') && $('#g-keep').checked;
  const tilted = ['h', 'v'].some(ax => g[ax].some(l => Math.abs(l[1] - l[0]) > 0.5));
  let n = 0, resized = false;
  const made = apply('box', () => {
    if (gridSizeDiffers()) { resizeTable(g.h.length - 1, g.v.length - 1); resized = true; }
    for (const c of S.model.cells) {
      if (keep && c.bbox && c.box_by === 'hand') continue;
      const T = g.h[c.r], B = g.h[c.r + c.rs], L = g.v[c.c], R = g.v[c.c + c.cs];
      const P = [crossPt(T, L), crossPt(T, R), crossPt(B, R), crossPt(B, L)];
      setBox(c, bboxOf(P), tilted ? P : null, 'grid');
      n++;
    }
    return n ? (resized ? 'grid_resize' : 'box_grid') : false;
  });
  S.meta.grid_lines = { h: g.h.map(l => l.map(round1)), v: g.v.map(l => l.map(round1)) };
  if (made) BX.lastGrid = { snap: S.undo[S.undo.length - 1], g: cloneGrid(g) };
  S.dirty = true; scheduleSave();
  toast(n ? `${n} box${n > 1 ? 'es' : ''} made from the lines. Drag the edges of a box to adjust it. ▦ Back to grid (or Ctrl+Z) opens the lines again.` : 'Every cell has a box made by hand (uncheck "keep my boxes").', 5000);
}
function drawGrid() {
  const svg = $('#overlay');
  $$('.g', svg).forEach(n => n.remove());
  for (const k of ['snap', 'even', 'apply']) $(`#bx-gridbar [data-g="${k}"]`).disabled = !!BX.gridFresh;
  $('#bx-gridbar [data-g="undo"]').disabled = !(BX.gUndo || []).length;
  $('#bx-gridbar [data-g="redo"]').disabled = !(BX.gRedo || []).length;
  if (!BX.grid || !IV.w || BX.gridFresh) { renderGridSize(); return; }  // no lines before the outline is drawn
  renderGridSize();
  const g = BX.grid, s = IV.scale, grp = svgEl('g', {}, 'g'), hotKeys = (BX.gridHotKey || '').split('|');
  for (const ax of ['h', 'v']) g[ax].forEach((_, i) => {
    const [A, B] = visEnds(g, ax, i), last = g[ax].length - 1;
    const gap = Math.min(...[i - 1, i + 1].filter(j => j >= 0 && j <= last).map(j => Math.abs(gAt(ax, g[ax][j], gAlong(ax, A)) - gAt(ax, g[ax][i], gAlong(ax, A)))));
    const rad = clamp(gap * s * 0.3, 2.5, 5.5);  // smaller round ends when the lines are close on screen
    const cls = 'gl' + (i === 0 || i === last ? ' frame' : '') + (hotKeys.includes(ax + i) ? ' hot' : '');
    grp.appendChild(svgEl('line', { x1: A[0], y1: A[1], x2: B[0], y2: B[1], 'vector-effect': 'non-scaling-stroke' }, cls));
    for (const P of [A, B]) grp.appendChild(svgEl('circle', { cx: P[0], cy: P[1], r: rad / s, 'vector-effect': 'non-scaling-stroke' }, 'gh' + (hotKeys.includes(ax + i) ? ' hot' : '')));
  });
  const fs = 11 / s, label = (x, y, t, anchor) => {
    const el = svgEl('text', { x, y, 'font-size': fs, 'text-anchor': anchor, 'dominant-baseline': 'central' }, 'glabel');
    el.textContent = t; grp.appendChild(el);
  };
  for (let i = 0; i < g.h.length - 1; i++) {
    const a = visEnds(g, 'h', i)[0], b = visEnds(g, 'h', i + 1)[0];
    if ((b[1] - a[1]) * s >= 9) label(a[0] - 9 / s, (a[1] + b[1]) / 2, String(i + 1), 'end');
  }
  for (let k = 0; k < g.v.length - 1; k++) {
    const a = visEnds(g, 'v', k)[0], b = visEnds(g, 'v', k + 1)[0];
    if ((b[0] - a[0]) * s >= 9) label((a[0] + b[0]) / 2, a[1] - 10 / s, colName(k), 'middle');
  }
  svg.appendChild(grp);
}
function gridHot(h) {
  const key = h ? h.ax + h.i + (h.alt ? '|' + h.alt.ax + h.alt.i : '') : null;
  if (key !== BX.gridHotKey) { BX.gridHotKey = key; drawGrid(); }
}
/* The line (or round end of a line) under p. A round end only when the pointer is on it: the ends sit on the
   outer lines, so between two ends the outer line itself is taken. */
function gridHit(p) {
  const g = BX.grid, s = IV.scale, tol = 8 / s;
  let end = null, line = null;
  const ends = [];
  for (const ax of ['h', 'v']) g[ax].forEach((_, i) => {
    const [A, B] = visEnds(g, ax, i);
    [A, B].forEach((P, k) => { const d = dist(P, p); ends.push({ ax, i, end: k, P }); if (d <= tol && (!end || d < end.d)) end = { ax, i, end: k, d, P }; });
    const d = segDist(p, A, B);
    if (d <= tol && (!line || d < line.d)) line = { ax, i, end: null, d };
  });
  if (!(end && (!line || end.d * s <= 5 || end.d <= line.d))) return line;
  // a corner is the end of an outer row line and of an outer column line: the direction of the drag picks one
  const other = ends.find(o => o.ax !== end.ax && dist(o.P, end.P) * s < 1.5);
  if (other) end.alt = { ax: other.ax, i: other.i, end: other.end, d: end.d };
  return end;
}
/* Allowed range of the position of line i at `a` along it: between its neighbours, inside the image. */
function gLimits(g, ax, i, a) {
  const L = g[ax];
  return [i > 0 ? gAt(ax, L[i - 1], a) + 2 : 0, i < L.length - 1 ? gAt(ax, L[i + 1], a) - 2 : gSpan(ax)];
}
function gridDrag(d, p) {
  if (!d.moved) {
    if (dist(p, d.start) * IV.scale < (d.hit.alt ? 4 : 2)) return;
    d.moved = true;
    if (d.hit.alt) {
      const side = Math.abs(p[0] - d.start[0]) > Math.abs(p[1] - d.start[1]), want = side ? 'v' : 'h';
      d.hit = d.hit.ax === want ? { ...d.hit, alt: null } : { ...d.hit.alt, alt: null };
      BX.gridHotKey = null;
    }
  }
  const g = BX.grid, o = d.orig, { ax, i, end } = d.hit, line = o[ax][i], last = o[ax].length - 1;
  const ends = visEnds(o, ax, i), delta = gPos(ax, p) - gPos(ax, d.start);
  // an outer line (the border of the table) takes the inner lines along, in proportion; Alt: it moves alone
  const scale = (i === 0 || i === last) && last > 1 && !d.alone;
  const lim = a => !scale ? gLimits(o, ax, i, a)
    : i === 0 ? [0, gAt(ax, o[ax][last], a) - 2 * last] : [gAt(ax, o[ax][0], a) + 2 * last, gSpan(ax)];
  if (end === null) {  // move the whole line
    let lo = -Infinity, hi = Infinity;
    for (const E of ends) {
      const a = gAlong(ax, E), cur = gAt(ax, line, a), [mn, mx] = lim(a);
      lo = Math.max(lo, mn - cur); hi = Math.min(hi, mx - cur);
    }
    if (lo > hi) return;
    const dd = clamp(delta, lo, hi);
    g[ax][i] = [line[0] + dd, line[1] + dd];
  } else {  // tilt: move one end, the other stays
    const E = ends[end], F = ends[1 - end], a = gAlong(ax, E), [mn, mx] = lim(a);
    if (mn > mx) return;
    const np = clamp(gPos(ax, E) + delta, mn, mx);
    g[ax][i] = gThrough(ax, a, np, gAlong(ax, F), gPos(ax, F));
  }
  if (scale) scaleInner(g, o, ax);
  drawGrid();
}
/* Inner lines of axis ax placed between the (new) outer lines of g as they were between the outer lines of o:
   each keeps its share of the width (or height), so the spacing of the model's grid is kept. */
function scaleInner(g, o, ax) {
  const L = g[ax], O = o[ax], n = L.length - 1;
  for (let i = 1; i < n; i++) L[i] = [0, 1].map(k => {
    const span = O[n][k] - O[0][k], t = span ? (O[i][k] - O[0][k]) / span : i / n;
    return L[0][k] + (L[n][k] - L[0][k]) * t;
  });
}
/* Snap: each line goes to the strongest drawn line near it; if there is none, to the middle of the nearest gap
   between text (for the outer lines: to the edge of the gap, next to the table). */
function gridSnap() {
  const P = pixels();
  if (!P) return toast('The image is not loaded yet.');
  const g = BX.grid;
  let lines = 0, gaps = 0;
  const count = r => { if (r === 'line') lines++; else if (r === 'gap') gaps++; };
  for (const ax of ['h', 'v']) {
    const n = g[ax].length;
    const t = estimateSkew(P, g, ax);  // a skewed page: tilt all the lines first
    if (t !== null) for (let i = 0; i < n; i++) {
      const [A, B] = visEnds(g, ax, i), a = (gAlong(ax, A) + gAlong(ax, B)) / 2, c = gAt(ax, g[ax][i], a);
      g[ax][i] = [c - t * a, c - t * a + t * gLen(ax)];
    }
    count(snapLine(P, g, ax, 0)); count(snapLine(P, g, ax, n - 1));
    for (let i = 1; i < n - 1; i++) {  // top to bottom (left to right): the lines after follow, so drift does not add up
      spreadEven(g, ax, i - 1, n - 1);
      count(snapLine(P, g, ax, i));
    }
  }
  drawGrid();
  toast(`Snapped: ${lines} line${lines !== 1 ? 's' : ''} on drawn lines, ${gaps} in gaps between text. Check them before making the boxes.`, 4000);
}
/* Slope (tan of the angle) of the rows ('h') or columns ('v') of writing and ruling inside the grid outline,
   from the sharpest projection profile; null when the page looks straight. */
function estimateSkew(P, g, ax) {
  const f = P.f, tl = crossPt(g.h[0], g.v[0]), br = crossPt(g.h[g.h.length - 1], g.v[g.v.length - 1]);
  const x0 = clamp(Math.floor(tl[0] * f), 0, P.w - 1), x1 = clamp(Math.ceil(br[0] * f), 0, P.w - 1);
  const y0 = clamp(Math.floor(tl[1] * f), 0, P.h - 1), y1 = clamp(Math.ceil(br[1] * f), 0, P.h - 1);
  if (x1 - x0 < 20 || y1 - y0 < 20) return null;
  const pts = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (P.mark[y * P.w + x]) pts.push(ax === 'h' ? x : y, ax === 'h' ? y : x);
  if (pts.length < 200) return null;
  const ac = ax === 'h' ? (x0 + x1) / 2 : (y0 + y1) / 2, span = (ax === 'h' ? P.h : P.w) + 400;
  const bins = new Float64Array(span);
  const score = t => {
    bins.fill(0);
    for (let k = 0; k < pts.length; k += 2) { const b = Math.round(pts[k + 1] - t * (pts[k] - ac)) + 200; if (b >= 0 && b < span) bins[b]++; }
    let s = 0; for (let b = 0; b < span; b++) s += bins[b] * bins[b];
    return s;
  };
  const base = score(0);
  let best = 0, bs = base;
  for (let deg = -4; deg <= 4.0001; deg += 0.2) { const t = Math.tan(deg * Math.PI / 180), sc = score(t); if (sc > bs) { bs = sc; best = t; } }
  for (let d = -0.1; d <= 0.1001; d += 0.025) { const t = best + Math.tan(d * Math.PI / 180), sc = score(t); if (sc > bs) { bs = sc; best = t; } }
  return bs > base * 1.03 ? best : null;
}
function snapLine(P, g, ax, i) {
  const L = g[ax], n = L.length, ln = L[i], [A, B] = visEnds(g, ax, i);
  const a0 = gAlong(ax, A), a1 = gAlong(ax, B), mid = (a0 + a1) / 2;
  const gaps = [];
  if (i > 0) gaps.push(gAt(ax, ln, mid) - gAt(ax, L[i - 1], mid));
  if (i < n - 1) gaps.push(gAt(ax, L[i + 1], mid) - gAt(ax, ln, mid));
  const R = clamp(0.45 * Math.min(...gaps), 2, 120);
  const edge = i === 0 ? 'first' : i === n - 1 ? 'last' : null;
  const full = profileBest(P, ax, ln, a0, a1, R, edge);
  if (!full) return null;
  let d0 = full.d, d1 = full.d, at0 = a0, at1 = a1;
  if (full.rule) {  // a drawn line: follow its slope, from the first and last third
    const t = (a1 - a0) / 3, left = profileBest(P, ax, ln, a0, a0 + t, R, edge), right = profileBest(P, ax, ln, a1 - t, a1, R, edge);
    if (left && right && left.rule && right.rule && Math.abs(left.d - right.d) < R) { d0 = left.d; d1 = right.d; at0 = a0 + t / 2; at1 = a1 - t / 2; }
  }
  const cand = gThrough(ax, at0, gAt(ax, ln, at0) + d0, at1, gAt(ax, ln, at1) + d1);
  for (const a of [a0, a1]) {  // keep the order of the lines
    const [mn, mx] = gLimits(g, ax, i, a), v = gAt(ax, cand, a);
    if (v < mn - 0.01 || v > mx + 0.01) return null;
  }
  L[i] = cand;
  return full.rule ? 'line' : 'gap';
}
function profileBest(P, ax, ln, a0, a1, R, edge) {
  if (a1 - a0 < 4) return null;
  const f = P.f, step = Math.max(1, 1.5 / f), stepD = Math.max(0.5, 0.75 / f), vals = [];
  for (let d = -R; d <= R + 1e-9; d += stepD) {
    let ink = 0, cnt = 0;
    for (let a = a0; a <= a1; a += step) {
      const p = gAt(ax, ln, a) + d, x = (ax === 'h' ? a : p) * f, y = (ax === 'h' ? p : a) * f;
      const xi = x | 0, yi = y | 0;
      if (xi < 0 || yi < 0 || xi >= P.w || yi >= P.h) continue;
      ink += P.near[yi * P.w + xi]; cnt++;
    }
    vals.push([d, cnt ? ink / cnt : 0]);
  }
  if (!vals.length) return null;
  const vs = vals.map(v => v[1]), sorted = vs.slice().sort((x, y) => x - y);
  const med = sorted[sorted.length >> 1], mx = sorted[sorted.length - 1], mn = sorted[0];
  if (mx >= 0.3 && mx >= 1.6 * med + 0.1) {  // a drawn line: the strong peak nearest to the current place
    const cand = vals.filter(v => v[1] >= 0.85 * mx);
    return { d: cand.reduce((x, y) => (Math.abs(y[0]) < Math.abs(x[0]) ? y : x))[0], rule: true };
  }
  const lim = mn + 0.25 * (med - mn) + 0.004;  // gaps: runs of (almost) no ink
  const runs = [];
  let start = null;
  vals.forEach((v, k) => {
    if (v[1] <= lim) { if (start === null) start = k; }
    else if (start !== null) { runs.push([start, k - 1]); start = null; }
  });
  if (start !== null) runs.push([start, vals.length - 1]);
  if (!runs.length) return null;
  const pick = run => edge === 'first' ? vals[run[1]][0] - 2 : edge === 'last' ? vals[run[0]][0] + 2 : (vals[run[0]][0] + vals[run[1]][0]) / 2;
  const best = runs.map(pick).reduce((x, y) => (Math.abs(y) < Math.abs(x) ? y : x));
  return { d: best, rule: false };
}

// ------------------------------------------------------------------------------------------
// Boxes from a pre-annotation, or from scratch

function boxSources() {
  return S.batch.sources.filter(s => S.detail.pre[s]).map(s => [s, importSource(s).model]).filter(([, m]) => m && m.cells.some(c => c.bbox));
}
/* Source boxes for the cells of the current table: same grid size -> slot by slot (a cell takes the union of the
   source cells inside it); else by equal text, nearest place in the table. */
function matchBoxes(sm, m = S.model) {
  const out = new Map();
  if (sm.nRows === m.nRows && sm.nCols === m.nCols) {
    const ss = slotsOf(sm);
    for (const c of m.cells) {
      const parts = new Set();
      for (let r = c.r; r < c.r + c.rs; r++) for (let k = c.c; k < c.c + c.cs; k++) parts.add(ss[r][k]);
      const src = [...parts].map(j => sm.cells[j]);
      if (src.some(x => x.r < c.r || x.c < c.c || x.r + x.rs > c.r + c.rs || x.c + x.cs > c.c + c.cs)) continue;
      const boxed = src.filter(x => x.bbox);
      if (boxed.length) out.set(c, boxed);
    }
    return { out, how: 'same grid, cell by cell' };
  }
  const sig = (mm, axis, i) => mm.cells.filter(x => (axis === 'r' ? x.r : x.c) === i && x.text).map(x => x.text);
  const dice = (a, b) => {
    if (!a.length || !b.length) return 0;
    const bag = new Map(); a.forEach(t => bag.set(t, (bag.get(t) || 0) + 1));
    let common = 0; b.forEach(t => { const k = bag.get(t); if (k) { common++; bag.set(t, k - 1); } });
    return 2 * common / (a.length + b.length);
  };
  const rowMap = alignSeq(m.nRows, sm.nRows, (i, j) => dice(sig(m, 'r', i), sig(sm, 'r', j)));
  const colMap = alignSeq(m.nCols, sm.nCols, (i, j) => dice(sig(m, 'c', i), sig(sm, 'c', j)));
  const ss = slotsOf(sm);
  for (const c of m.cells) {
    const r0 = rowMap[c.r], r1 = rowMap[c.r + c.rs - 1], c0 = colMap[c.c], c1 = colMap[c.c + c.cs - 1];
    if (r0 < 0 || r1 < 0 || c0 < 0 || c1 < 0) continue;
    const parts = new Set();
    for (let r = r0; r <= r1; r++) for (let k = c0; k <= c1; k++) parts.add(ss[r][k]);
    const src = [...parts].map(j => sm.cells[j]);
    if (src.some(x => x.r < r0 || x.c < c0 || x.r + x.rs - 1 > r1 || x.c + x.cs - 1 > c1)) continue;
    const boxed = src.filter(x => x.bbox);
    if (boxed.length) out.set(c, boxed);
  }
  const nr = rowMap.filter(v => v >= 0).length, nc = colMap.filter(v => v >= 0).length;
  return { out, how: `the grids differ, ${sm.nRows}×${sm.nCols} there: ${nr} of ${m.nRows} rows and ${nc} of ${m.nCols} columns matched by their text` };
}
/* The text of the source table `sm` for the cells of the table `m`. Each source cell's text goes to the cell of m
   at the same place: same grid -> the same row and column; m with boxes and sm with boxes -> the cell whose box
   holds the centre of the source box; else rows and columns matched by their text. Returns {plan: [[cell, text, source cells]], how}. */
/* Most of the cells with text have a box (then text can go by the place of the boxes). */
function boxedText(m) {
  const tx = m.cells.filter(x => x.text);
  return tx.length ? tx.filter(x => x.bbox).length >= 0.5 * tx.length : m.cells.some(x => x.bbox);
}
function textPlan(sm, m = S.model) {
  const to = new Map(), add = (c, x) => { if (c) { if (!to.has(c)) to.set(c, []); to.get(c).push(x); } };
  const ts = slotsOf(m);
  let how;
  if (sm.nRows === m.nRows && sm.nCols === m.nCols) {
    for (const x of sm.cells) add(m.cells[ts[x.r][x.c]], x);
    how = 'same grid, cell by cell';
  } else if (m.cells.filter(c => c.bbox).length >= 0.5 * m.cells.length && boxedText(sm)) {
    for (const x of sm.cells) {
      if (!x.bbox) continue;
      const p = [(x.bbox[0] + x.bbox[2]) / 2, (x.bbox[1] + x.bbox[3]) / 2];
      let best = null, area = Infinity;
      for (const c of m.cells) if (inBox(c, p)) { const a = (c.bbox[2] - c.bbox[0]) * (c.bbox[3] - c.bbox[1]); if (a < area) { area = a; best = c; } }
      add(best, x);
    }
    how = `the grids differ, ${sm.nRows}×${sm.nCols} there: matched by the place of the boxes`;
  } else {
    const sig = (mm, axis, i) => mm.cells.filter(x => (axis === 'r' ? x.r : x.c) === i && x.text).map(x => x.text);
    const dice = (a, b) => {
      if (!a.length || !b.length) return 0;
      const bag = new Map(); a.forEach(t => bag.set(t, (bag.get(t) || 0) + 1));
      let common = 0; b.forEach(t => { const k = bag.get(t); if (k) { common++; bag.set(t, k - 1); } });
      return 2 * common / (a.length + b.length);
    };
    const rowMap = alignSeq(m.nRows, sm.nRows, (i, j) => dice(sig(m, 'r', i), sig(sm, 'r', j)));
    const colMap = alignSeq(m.nCols, sm.nCols, (i, j) => dice(sig(m, 'c', i), sig(sm, 'c', j)));
    const rInv = new Map(), cInv = new Map();
    rowMap.forEach((j, i) => { if (j >= 0) rInv.set(j, i); }); colMap.forEach((j, i) => { if (j >= 0) cInv.set(j, i); });
    for (const x of sm.cells) if (rInv.has(x.r) && cInv.has(x.c)) add(m.cells[ts[rInv.get(x.r)][cInv.get(x.c)]], x);
    how = `the grids differ, ${sm.nRows}×${sm.nCols} there: ${rInv.size} of ${m.nRows} rows and ${cInv.size} of ${m.nCols} columns matched by their text`;
  }
  const plan = [...to].map(([c, xs]) => { xs.sort((a, b) => a.r - b.r || a.c - b.c); return [c, xs.map(x => x.text).filter(Boolean).join(' '), xs]; });
  return { plan, how };
}
/* Text or boxes of another source put on the table: kept in started_from.mixed (a new object, so Ctrl+Z restores the old one). */
function noteMix(part, source, cells, how, extra) {
  const sf = S.meta.started_from || {};
  S.meta.started_from = Object.assign({}, sf, { mixed: (sf.mixed || []).concat([Object.assign({ part, source, cells, how, time: new Date().toISOString() }, extra || {})]) });
}
function putText(plan) { for (const [c, t] of plan) { c.text = t; c.padded = false; } }
function putBoxes(out, keep) {
  let n = 0;
  for (const [c, parts] of out) {
    if (keep && c.bbox) continue;
    if (parts.length === 1) setBox(c, parts[0].bbox, parts[0].polygon, 'model');
    else setBox(c, bboxOf(parts.flatMap(x => [[x.bbox[0], x.bbox[1]], [x.bbox[2], x.bbox[3]]])), null, 'model');
    n++;
  }
  return n;
}
/* A new table: its text and boxes from other sources when the batch says so (make_batch --text-from / --boxes-from). */
function mixStart(m) {
  const notes = [], src = S.meta.started_from.source, ts = S.batch.text_source, bs = S.batch.box_source;
  const usable = n => n && n !== src && S.detail.pre[n] && importSource(n).model;
  if (ts && ts !== src) {
    if (usable(ts)) {
      const { plan, how } = textPlan(importSource(ts).model, m);
      putText(plan); noteMix('text', ts, plan.length, how);
      notes.push(`text from ${ts}: ${plan.length} of ${m.cells.length} cells (${how})`);
    } else notes.push(`no text from ${ts} for this table`);
  }
  if (bs && bs !== src && S.batch.box_prefill !== 'none') {
    if (usable(bs)) {
      const { out, how } = matchBoxes(importSource(bs).model, m);
      m.cells.forEach(c => setBox(c, null, null));
      const n = putBoxes(out, false); noteMix('boxes', bs, n, how);
      notes.push(`boxes from ${bs}: ${n} of ${m.cells.length} cells (${how})`);
    } else notes.push(`no boxes from ${bs} for this table`);
  }
  return notes;
}
/* Monotonic alignment of two sequences (rows or columns) by similarity; map[i] = j or -1. */
function alignSeq(n, m, sim) {
  const sc = Array.from({ length: n + 1 }, () => new Float64Array(m + 1)), bk = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    let best = sc[i - 1][j], b = 1;
    if (sc[i][j - 1] > best) { best = sc[i][j - 1]; b = 2; }
    const s = sim(i - 1, j - 1);
    if (s >= 0.34 && sc[i - 1][j - 1] + s > best) { best = sc[i - 1][j - 1] + s; b = 3; }
    sc[i][j] = best; bk[i][j] = b;
  }
  const map = new Array(n).fill(-1);
  for (let i = n, j = m; i > 0 && j > 0;) { const b = bk[i][j]; if (b === 3) { map[i - 1] = j - 1; i--; j--; } else if (b === 1) i--; else j--; }
  // rows with little text do not match by their text: the ones left between two matched rows (or before the
  // first, after the last) are paired in order when there are as many on both sides
  let pi = -1, pj = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && map[i] < 0) continue;
    const j = i < n ? map[i] : m;
    if (i - pi > 1 && i - pi === j - pj) for (let t = 1; t < i - pi; t++) map[pi + t] = pj + t;
    pi = i; pj = j;
  }
  return map;
}
function takeBoxesDialog(src) { openReview(batchSource(src), 'boxes'); }
function clearBoxesDialog() {
  const n = S.model.cells.filter(c => c.bbox).length;
  if (!n) return toast('There are no boxes yet: drag on the image, or use Grid.');
  openModal(`<h2>Remove all ${n} boxes?</h2><p>Start the boxes of this table from scratch (the text and structure stay). You can undo with Ctrl+Z.</p>
    <div class="actions"><button data-close>Cancel</button><button class="primary danger-bg" id="cb-ok">Remove all boxes</button></div>`);
  $('#cb-ok').onclick = () => {
    closeModal();
    apply('box', () => { S.model.cells.forEach(c => setBox(c, null, null)); return 'box_remove_all'; });
  };
}
/* Give the box of the selected cell to another cell: click this, then the cell in the table (or another box:
   the two boxes swap). */
function startAssign() {
  if (BX.grid) return;
  if (BX.none) return toast('No box selected: click a box first.');
  const i = activeIndex(), c = S.model.cells[i];
  if (!c.bbox) return toast('This cell has no box to move: select a cell that has one.');
  endAssign();
  BX.assign = i;
  $('#grid').classList.add('assigning');
  if (BOX[i]) BOX[i].classList.add('assign');
  renderBoxbar();
  showMovePanel(i);
}
/* The panel of "Move to cell…": type the cell (E5) or click it in the table; the other boxes can shift the same way. */
const moveScope = () => { const r = document.querySelector('#bx-move input[name="mv"]:checked'); return r ? r.value : LS.get('mvscope', 'one'); };
function showMovePanel(i) {
  const c = S.model.cells[i], pop = $('#bx-move'), sc = LS.get('mvscope', 'one');
  const opt = (v, t) => `<label><input type="radio" name="mv" value="${v}"${v === sc ? ' checked' : ''}><span>${t}</span></label>`;
  pop.innerHTML = `<div class="mv-row"><b>Box of ${cellRef(c)}</b><span>belongs to</span><input id="mv-ref" placeholder="e.g. E5" autocomplete="off" spellcheck="false"></div>
    ${opt('one', 'only this box <span class="muted">(swaps with the box of that cell)</span>')}
    ${opt('after', 'this box and the boxes after it: <span id="mv-after" class="muted">shift them the same way</span>')}
    ${opt('all', 'all the boxes of the table: shift them the same way')}
    <div id="mv-info"></div>
    <div class="gp-row"><button id="mv-cancel">Cancel</button><span class="spacer"></span><button id="mv-ok" class="primary">Move</button></div>`;
  pop.hidden = false;
  placeMovePanel(i);
  const inp = $('#mv-ref');
  inp.oninput = moveInfo;
  inp.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); moveOK(); }
    else if (e.key === 'Escape') { e.preventDefault(); endAssign(); }
    e.stopPropagation();  // typing here is not typing in the table
  };
  pop.querySelectorAll('input[name="mv"]').forEach(r => { r.onchange = () => { LS.set('mvscope', r.value); moveInfo(); inp.focus(); }; });
  $('#mv-ok').onclick = moveOK;
  $('#mv-cancel').onclick = () => endAssign();
  moveInfo();
  setTimeout(() => inp.focus(), 0);
}
function placeMovePanel(i) {
  const b = S.model.cells[i].bbox, v = $('#imgview'), pop = $('#bx-move');
  const W = v.clientWidth, H = v.clientHeight, w = pop.offsetWidth, h = pop.offsetHeight;
  // in the corner of the image farthest from the box, so that the boxes around it stay clickable
  const cx = (b[0] + b[2]) / 2 * IV.scale + IV.tx, cy = (b[1] + b[3]) / 2 * IV.scale + IV.ty;
  const left = cx < W / 2 ? Math.max(6, W - w - 8) : 8, top = cy < H / 2 ? Math.max(6, H - h - 34) : 8;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}
/* "E5" -> the cell there (column letters, row number from 1). */
function parseRef(txt) {
  const m = /^\s*([A-Za-z]{1,3})\s*(\d{1,4})\s*$/.exec(txt || '');
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  const r = +m[2] - 1; c -= 1;
  if (r < 0 || c < 0 || r >= S.model.nRows || c >= S.model.nCols) return { bad: true };
  return { r, c, j: S.slots[r][c] };
}
const plural = (n, w) => `${n} ${n === 1 ? w : w === 'box' ? 'boxes' : w + 's'}`;
function shiftWords(dr, dc) {
  const p = [];
  if (dc) p.push(plural(Math.abs(dc), 'column') + (dc > 0 ? ' right' : ' left'));
  if (dr) p.push(plural(Math.abs(dr), 'row') + (dr > 0 ? ' down' : ' up'));
  return p.join(' and ');
}
/* What moves when the box of cell i goes to cell j: only it (swap), the boxes after it, or all boxes, by the same
   number of rows and columns. A box that lands outside the table is dropped; several boxes landing in one merged
   cell become one box over them. */
function movePlan(i, j, scope) {
  const cells = S.model.cells, a = cells[i], b = cells[j], m = S.model;
  const dr = b.r - a.r, dc = b.c - a.c;
  if (scope === 'one' || (!dr && !dc)) return { scope: 'one', a, b, dr, dc };
  const inScope = c => scope === 'all' || ((!dr || c.r >= a.r) && (!dc || c.c >= a.c));
  const moving = [], recv = new Map();
  let lost = 0;
  cells.forEach((c, k) => {
    if (!c.bbox || !inScope(c)) return;
    moving.push(k);
    const r = c.r + dr, cc = c.c + dc;
    if (r < 0 || cc < 0 || r >= m.nRows || cc >= m.nCols) { lost++; return; }
    const t = S.slots[r][cc];
    if (!recv.has(t)) recv.set(t, []);
    recv.get(t).push({ bbox: c.bbox, polygon: c.polygon, by: k === i ? 'hand' : c.box_by });
  });
  const mv = new Set(moving);
  const replaced = [...recv.keys()].filter(t => !mv.has(t) && cells[t].bbox).length;
  return { scope, a, b, dr, dc, moving, recv, lost, replaced };
}
function planText(pl) {
  if (pl.scope === 'one') return `${cellRef(pl.a)} → ${cellRef(pl.b)}` + (pl.b.bbox && pl.b !== pl.a ? ': the two boxes swap.' : '.');
  return `${pl.moving.length} boxes move ${shiftWords(pl.dr, pl.dc)}` + (pl.lost ? `; ${plural(pl.lost, 'box')} fall off the table and are dropped` : '')
    + (pl.replaced ? `; ${plural(pl.replaced, 'box')} not shifted ${pl.replaced === 1 ? 'is' : 'are'} replaced` : '') + '.';
}
function moveInfo() {
  const i = BX.assign;
  if (i === null || !$('#mv-ref')) return;
  const a = S.model.cells[i], info = $('#mv-info'), v = $('#mv-ref').value;
  const after = $('#mv-after');
  const t = parseRef(v);
  if (after) {
    const dr = t && !t.bad ? t.r - a.r : 0, dc = t && !t.bad ? t.c - a.c : 0;
    after.textContent = dc && !dr ? `columns ${colName(a.c)} and right, all rows, shift the same way`
      : dr && !dc ? `rows ${a.r + 1} and below, all columns, shift the same way` : 'shift them the same way';
  }
  info.className = 'muted';
  if (!v.trim()) info.textContent = 'Type the cell (e.g. E5) and press Enter, or click the cell in the table.';
  else if (!t) info.textContent = 'Write a cell like E5: column letter, then row number.';
  else if (t.bad) { info.className = 'warn'; info.textContent = `Outside the table: the last cell is ${colName(S.model.nCols - 1)}${S.model.nRows}.`; }
  else if (t.j === i) info.textContent = `That is the cell of this box (${cellRef(a)}).`;
  else { info.className = 'ok'; info.textContent = planText(movePlan(i, t.j, moveScope())); }
}
function moveOK() {
  const i = BX.assign;
  if (i === null) return;
  const t = parseRef($('#mv-ref').value);
  if (!t || t.bad || t.j === i) { moveInfo(); $('#mv-ref').focus(); return; }
  assignTo(t.j);
}
function endAssign() {
  if (BX.assign === null) return;
  if (BOX[BX.assign]) BOX[BX.assign].classList.remove('assign');
  BX.assign = null;
  $('#bx-move').hidden = true;
  $('#grid').classList.remove('assigning');
  if ($('#toast').textContent.startsWith('Now click the cell')) $('#toast').hidden = true;
  renderBoxbar();
}
function assignTo(j) {
  const i = BX.assign, scope = moveScope();
  endAssign();
  if (i === null || j === i) return;
  const pl = movePlan(i, j, scope);
  if (pl.scope !== 'one') return shiftBoxes(pl);
  const a = S.model.cells[i], b = S.model.cells[j], had = !!b.bbox;
  const ok = apply('box', () => {
    const ga = { bbox: a.bbox, polygon: a.polygon }, gb = { bbox: b.bbox, polygon: b.polygon };
    setBox(b, ga.bbox, ga.polygon, 'hand');
    if (gb.bbox) setBox(a, gb.bbox, gb.polygon, 'hand'); else setBox(a, null, null);
    return 'box_assign';
  });
  if (!ok) return;
  setSel(b.r, b.c);
  toast(had ? `The boxes of ${cellRef(a)} and ${cellRef(b)} were swapped.` : `The box of ${cellRef(a)} now belongs to ${cellRef(b)}.`);
}
function shiftBoxes(pl) {
  const cells = S.model.cells;
  const ok = apply('box', () => {
    for (const k of pl.moving) setBox(cells[k], null, null);
    for (const [t, gs] of pl.recv) {
      if (gs.length === 1) setBox(cells[t], gs[0].bbox, gs[0].polygon, gs[0].by);
      else setBox(cells[t], [Math.min(...gs.map(g => g.bbox[0])), Math.min(...gs.map(g => g.bbox[1])), Math.max(...gs.map(g => g.bbox[2])), Math.max(...gs.map(g => g.bbox[3]))], null, 'hand');
    }
    return 'box_shift';
  });
  if (!ok) return;
  setSel(pl.b.r, pl.b.c);
  toast(planText(pl).replace('boxes move', 'boxes moved').replace('are dropped', 'were dropped').replace(' is replaced', ' was replaced').replace(' are replaced', ' were replaced') + ' Ctrl+Z: undo.', 6000);
}
function boxMenu(x, y) {
  const items = boxSources().map(([s, sm]) => [`bx-take:${s}`, `Take the boxes of ${s}`, `${sm.cells.filter(c => c.bbox).length} boxes`]);
  if (!items.length) items.push(['', 'No pre-annotation of this table has boxes', '']);
  items.push(null, ['bx-clear', 'Remove all boxes (start from scratch)', '']);
  showMenuItems(x, y, items);
}
$('#boxbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-bx]'); if (!b) return;
  const a = b.dataset.bx;
  if (a === 'regrid') return openGrid('saved');
  if (a === 'grid') { if (BX.grid) return closeGrid(false); const r = b.getBoundingClientRect(); return gridMenu(r.left, r.bottom + 4); }
  if (a === 'fit') return runOp('box-fit');
  if (a === 'assign') return BX.assign !== null ? endAssign() : startAssign();
  if (a === 'shape') return;
  if (a === 'merge') return apply('merge', OPS.merge);
  if (a === 'remove') return runOp('unbox');
  if (a === 'more') { const r = b.getBoundingClientRect(); boxMenu(r.left, r.bottom + 4); }
});
$('#bx-cell').addEventListener('click', () => { if (BX.on && !BX.grid && S.model.cells[activeIndex()].bbox) (BX.assign !== null ? endAssign() : startAssign()); });
$('#bx-shape').addEventListener('click', e => { const b = e.target.closest('button[data-shape]'); if (b) { setShape(b.dataset.shape); $('#gridwrap').focus({ preventScroll: true }); } });
setShape(LS.get('bxshape', 'rect'));
$('#bx-next').checked = LS.get('bxnext', true);
BX.snap = $('#bx-snap').checked = LS.get('bxsnap', true);
$('#bx-snap').addEventListener('change', () => { BX.snap = $('#bx-snap').checked; LS.set('bxsnap', BX.snap); $('#gridwrap').focus({ preventScroll: true }); });
BX.names = $('#bx-names').checked = LS.get('bxnames', false);
$('#bx-names').addEventListener('change', () => { BX.names = $('#bx-names').checked; LS.set('bxnames', BX.names); drawNames(); $('#gridwrap').focus({ preventScroll: true }); });
$('#bx-next').addEventListener('change', () => { LS.set('bxnext', $('#bx-next').checked); $('#gridwrap').focus({ preventScroll: true }); });

// Colors of the box and grid lines (display only, kept in this browser)
const LINE_COLORS = { box: '#1d5fd0', act: '#f97316', grid: '#0284c7' };
const SWATCHES = ['#1d5fd0', '#0284c7', '#16a34a', '#f97316', '#dc2626', '#db2777', '#9333ea', '#facc15', '#111827', '#ffffff'];
const lineColors = () => Object.assign({}, LINE_COLORS, LS.get('linecolors', {}));
function applyLineColors() {
  const c = lineColors(), root = document.documentElement.style;
  root.setProperty('--boxline', c.box); root.setProperty('--boxact', c.act); root.setProperty('--gridline', c.grid);
  $('[data-img="colors"]').classList.toggle('on', Object.keys(LINE_COLORS).some(k => c[k] !== LINE_COLORS[k]));
}
function toggleColors() {
  const pop = $('#imgadj');
  if (!pop.hidden && pop.dataset.kind === 'colors') { pop.hidden = true; return; }
  pop.dataset.kind = 'colors';
  const c = lineColors();
  const row = (k, label) => `<div class="col-row"><span>${label}</span><input type="color" data-k="${k}" value="${c[k]}" title="Any color"></div>
    <div class="sw">${SWATCHES.map(v => `<button class="swatch${v === c[k] ? ' on' : ''}" data-k="${k}" data-c="${v}" style="background:${v}" title="${v}"></button>`).join('')}</div>`;
  pop.innerHTML = `<b>Line colors</b>${row('box', 'Boxes')}${row('act', 'Box of the selected cell')}${row('grid', 'Grid lines')}
    <div class="gp-row"><button id="col-reset">Reset</button><span class="spacer"></span><button id="col-close" class="primary">OK</button></div>`;
  pop.hidden = false;
  const set = (k, v) => {
    LS.set('linecolors', Object.assign(lineColors(), { [k]: v })); applyLineColors();
    pop.querySelectorAll(`.swatch[data-k="${k}"]`).forEach(b => b.classList.toggle('on', b.dataset.c === v));
    pop.querySelector(`input[data-k="${k}"]`).value = v;
  };
  pop.onclick = e => { const b = e.target.closest('.swatch'); if (b) set(b.dataset.k, b.dataset.c); };
  pop.querySelectorAll('input[type=color]').forEach(i => { i.oninput = () => set(i.dataset.k, i.value); });
  $('#col-reset').onclick = () => { for (const k in LINE_COLORS) set(k, LINE_COLORS[k]); };
  $('#col-close').onclick = () => { pop.hidden = true; $('#gridwrap').focus({ preventScroll: true }); };
}

// Brightness / contrast of the image (display only)
function applyAdjust() {
  const [b, c] = LS.get('imgadj', [100, 100]);
  $('#img').style.filter = b === 100 && c === 100 ? '' : `brightness(${b}%) contrast(${c}%)`;
  $('[data-img="adjust"]').classList.toggle('on', b !== 100 || c !== 100);
}
function toggleAdjust() {
  const pop = $('#imgadj');
  if (!pop.hidden && pop.dataset.kind !== 'colors') { pop.hidden = true; return; }
  pop.dataset.kind = 'adjust'; pop.onclick = null;
  const [b, c] = LS.get('imgadj', [100, 100]);
  pop.innerHTML = `<label>Brightness <input type="range" id="adj-b" min="40" max="200" value="${b}"></label>
    <label>Contrast <input type="range" id="adj-c" min="50" max="300" value="${c}"></label>
    <div class="gp-row"><button id="adj-reset">Reset</button><span class="spacer"></span><button id="adj-close" class="primary">OK</button></div>`;
  pop.hidden = false;
  const upd = () => { LS.set('imgadj', [+$('#adj-b').value, +$('#adj-c').value]); applyAdjust(); };
  $('#adj-b').oninput = upd; $('#adj-c').oninput = upd;
  $('#adj-reset').onclick = () => { $('#adj-b').value = 100; $('#adj-c').value = 100; upd(); };
  $('#adj-close').onclick = () => { pop.hidden = true; $('#gridwrap').focus({ preventScroll: true }); };
}

// Layout: image beside or above the table, resizable
function splitKey(lay) { return 'split.' + lay + (BX.on ? '.box' : ''); }
function applyLayout() {
  let lay = LS.get('layout', 'auto');
  if (lay === 'auto') lay = IV.w && IV.w / IV.h > 1.45 ? 'stacked' : 'side';
  const work = $('#work');
  work.classList.toggle('stacked', lay === 'stacked');
  const size = LS.get(splitKey(lay), lay === 'stacked' ? (BX.on ? 58 : 38) : (BX.on ? 55 : 45));
  $('#imgpane').style.flex = `0 0 ${size}%`;
}
$('#btn-layout').addEventListener('click', () => {
  const now = $('#work').classList.contains('stacked') ? 'stacked' : 'side';
  LS.set('layout', now === 'stacked' ? 'side' : 'stacked');
  applyLayout(); imgFit(LS.get('imgfit', 'width'));
});
(() => {
  const div = $('#divider');
  let drag = false;
  div.addEventListener('pointerdown', e => { drag = true; div.classList.add('drag'); div.setPointerCapture(e.pointerId); });
  div.addEventListener('pointermove', e => {
    if (!drag) return;
    const work = $('#work'), r = work.getBoundingClientRect(), stacked = work.classList.contains('stacked');
    const pct = clamp(stacked ? (e.clientY - r.top) / r.height * 100 : (e.clientX - r.left) / r.width * 100, 12, 85);
    $('#imgpane').style.flex = `0 0 ${pct}%`;
    LS.set(splitKey(stacked ? 'stacked' : 'side'), pct);
  });
  div.addEventListener('pointerup', () => { drag = false; div.classList.remove('drag'); imgFit(LS.get('imgfit', 'width')); });
})();
window.addEventListener('resize', () => { if (S.view === 'edit') imgApply(); });

// ------------------------------------------------------------------------------------------
// Table status: done, skip, note, navigation

function doneWarnings() {
  const m = S.model, s = S.slots, out = [];
  const emptyRows = [], emptyCols = [];
  for (let r = 0; r < m.nRows; r++) { let any = false; for (let k = 0; k < m.nCols; k++) if (m.cells[s[r][k]].text) { any = true; break; } if (!any) emptyRows.push(r + 1); }
  for (let k = 0; k < m.nCols; k++) { let any = false; for (let r = 0; r < m.nRows; r++) if (m.cells[s[r][k]].text) { any = true; break; } if (!any) emptyCols.push(colName(k)); }
  const short = a => a.slice(0, 8).join(', ') + (a.length > 8 ? ', …' : '');
  if (emptyRows.length) out.push(`Empty row${emptyRows.length > 1 ? 's' : ''}: ${short(emptyRows)}`);
  if (emptyCols.length) out.push(`Empty column${emptyCols.length > 1 ? 's' : ''}: ${short(emptyCols)}`);
  const pol = boxPolicy();
  if (pol === 'text' || pol === 'all') {
    const miss = m.cells.filter(c => needsBox(c) && !c.bbox);
    if (miss.length) out.push(`${miss.length} cell${miss.length > 1 ? 's' : ''} without a box: ${short(miss.map(cellRef))} (Ctrl+E shows the boxes)`);
  }
  return out;
}
async function markDone(force) {
  if (!force) {
    const warn = doneWarnings();
    if (warn.length) {
      openModal(`<h2>Mark as done?</h2><p>Please check, it may be right:</p><ul>${warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
        <div class="actions"><button data-close>Go back</button><button class="primary" id="done-ok">Done anyway</button></div>`);
      $('#done-ok').onclick = () => { closeModal(); markDone(true); };
      return;
    }
  }
  S.meta.status = 'done'; S.meta.skip_reason = null; S.dirty = true;
  const ok = await save(true);
  if (!ok) return;
  toast('Saved as done ✓');
  const next = nextTodo(S.tid);
  if (next) openTask(next.table_id); else { toast('No more tables to do in this list. 🎉'); showHome(); }
}
function goRelative(d) {
  const list = myTasks(), pos = list.findIndex(t => t.table_id === S.tid);
  const t = list[pos + d];
  if (t) openTask(t.table_id);
}
$('#btn-done').addEventListener('click', () => { stopEditing(true); markDone(); });
$('#btn-prev').addEventListener('click', () => goRelative(-1));
$('#btn-next').addEventListener('click', () => goRelative(1));
$('#btn-home').addEventListener('click', () => showHome());
$('#btn-skip').addEventListener('click', () => {
  const reasons = ['Not a table', 'Unreadable', 'Table is cut / incomplete', 'Duplicate of another table', 'Other (write a note)'];
  openModal(`<h2>Skip this table</h2><p>The table stays in your list as "Skipped" with the reason. You can come back and annotate it later.</p>
    <div class="choices">${reasons.map((r, i) => `<label><input type="radio" name="reason" value="${escAttr(r)}"${i === 0 ? ' checked' : ''}> ${esc(r)}</label>`).join('')}</div>
    <p style="margin-top:12px">Note (optional)</p><textarea id="skip-note">${esc(S.meta.comment || '')}</textarea>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="skip-ok">Skip table</button></div>`);
  $('#skip-ok').onclick = async () => {
    S.meta.status = 'skipped'; S.meta.skip_reason = $('input[name=reason]:checked').value; S.meta.comment = $('#skip-note').value.trim();
    S.dirty = true; closeModal();
    if (await save(true)) { const next = nextTodo(S.tid); if (next) openTask(next.table_id); else showHome(); }
  };
});
$('#btn-note').addEventListener('click', () => {
  openModal(`<h2>Note on this table</h2><p>For questions or doubts. Flag the table if it needs a discussion with the team.</p>
    <textarea id="note-text" placeholder="e.g. column C: unsure whether these are ditto marks">${esc(S.meta.comment || '')}</textarea>
    <div class="row" style="margin-top:10px"><label><input type="checkbox" id="note-flag"${S.meta.flagged ? ' checked' : ''}> ⚑ Flag for discussion</label></div>
    <div class="actions"><button data-close>Cancel</button><button class="primary" id="note-ok">Save note</button></div>`);
  $('#note-text').focus();
  $('#note-ok').onclick = () => {
    S.meta.comment = $('#note-text').value.trim(); S.meta.flagged = $('#note-flag').checked;
    closeModal(); renderTopbar(); S.dirty = true; scheduleSave(100);
  };
});

// ------------------------------------------------------------------------------------------
// Import: another source (a pre-annotation of the batch, or a file) shown next to the image and to your table
// before anything changes. Modes: only the text (keep my table), structure and text (replace my table), only the
// structure (their rows, columns and merges, with my text put in the new cells), only the boxes. Each change of a
// cell's text (or box) can be taken or not; the structure comes as a whole.

const RV_MODES = [
  ['text', 'Only the text'],
  ['full', 'Structure and text'],
  ['structure', 'Only the structure'],
  ['boxes', 'Only the boxes'],
];
let RV = null;

$('#src-select').addEventListener('change', () => {
  const sel = $('#src-select'), v = sel.value;
  sel.value = sel.dataset.current;  // only change after the review
  if (v === '__empty') return newTableDialog();
  if (v === '__file') { const f = $('#src-file'); f.value = ''; return f.click(); }
  if (v === '__cur') return;
  openReview(batchSource(v));
});
$('#src-file').addEventListener('change', async () => { const src = await pickedSource($('#src-file')); if (src) openReview(src); });
async function pickedSource(input) {
  const f = input.files[0];
  if (!f || S.view !== 'edit') return null;
  let buf;
  try { buf = await f.arrayBuffer(); } catch (e) { toast(`Cannot read ${f.name}: ${e.message}`, 5000); return null; }
  const src = fileSource(f.name, new TextDecoder('utf-8').decode(buf));
  src.sha256 = await sha256Hex(buf);
  if (!src.model) { toast(`Cannot use ${f.name}: ${src.notes.join('; ')}`, 7000); return null; }
  return src;
}
async function sha256Hex(buf) {
  try { const d = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(d), x => x.toString(16).padStart(2, '0')).join(''); }
  catch (e) { return null; }  // no crypto.subtle over plain http (--share): the file name is still recorded
}
function batchSource(name) {
  const res = importSource(name), p = S.detail.pre[name];
  return { name, model: res.model, notes: res.notes.slice(), file: p.file, sha256: p.sha256 };
}

/* A table from a file: HTML (a model answer), our JSON (an annotation or a pre-annotation, or any JSON holding an
   HTML table), PAGE XML (TableRegion > TableCell, as pagexml_to_cells.py reads it) or CSV / TSV text. */
function fileSource(fname, raw) {
  const text = raw.replace(/^﻿/, ''), head = text.trimStart();
  const src = { name: 'file ' + fname, file: fname, notes: [], model: null };
  const set = res => { src.model = res.model; src.notes = res.notes.slice(); };
  try {
    if (/^([{[]|```)/.test(head)) {
      const { obj, cut } = parseAnswerJSON(text);
      if (obj && Array.isArray(obj.cells)) {
        set(modelFromJSON(obj, !obj.schema));  // a saved annotation as it is; a model's answer repaired
        if (cut) src.notes.unshift('answer cut off: read up to its last whole cell');
        if (obj.annotator) src.name = `file ${fname} (${obj.annotator})`;
        if (obj.table_id && obj.table_id !== S.tid) src.notes.push(`this file is for the table ${obj.table_id}`);
        const size = S.detail.image_size, was = obj.image_size;
        if (src.model && size && Array.isArray(was) && was.length === 2 && (was[0] !== size[0] || was[1] !== size[1]) && was[0] > 0 && was[1] > 0) {
          const sx = size[0] / was[0], sy = size[1] / was[1];
          for (const c of src.model.cells) {
            if (c.bbox) c.bbox = [c.bbox[0] * sx, c.bbox[1] * sy, c.bbox[2] * sx, c.bbox[3] * sy];
            if (c.polygon) c.polygon = c.polygon.map(p => [p[0] * sx, p[1] * sy]);
          }
          src.notes.push(`boxes scaled from a ${was[0]}×${was[1]} image`);
        } else if (obj.image_sha256 && S.detail.image_sha256 && obj.image_sha256 !== S.detail.image_sha256) src.notes.push('made on another image: the boxes may not fit');
      } else {
        const html = findTableHTML(obj);
        if (!html) throw new Error('no table in this JSON (it needs "cells" and "n_rows", or an HTML table)');
        set(modelFromHTML(html));
      }
    } else if (/<([\w-]+:)?(PcGts|TableRegion)\b/.test(head.slice(0, 5000)) || /<([\w-]+:)?TableRegion\b/.test(text)) {
      pageSource(src, text);
    } else if (/<table\b/i.test(text)) set(modelFromHTML(text));
    else set(modelFromDelimited(text));
  } catch (e) { src.model = null; src.notes = ['could not read it: ' + e.message]; }
  return src;
}
function findTableHTML(obj, depth = 0) {
  if (typeof obj === 'string') return /<table\b/i.test(obj) ? obj : null;
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const v of Object.values(obj)) { const h = findTableHTML(v, depth + 1); if (h) return h; }
  return null;
}
/* CSV / TSV / plain text: one line per row; tab-separated if there is a tab, else ; or , (with "quotes"). */
function modelFromDelimited(text) {
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return { model: null, notes: ['the file is empty'] };
  const sample = lines.slice(0, 50).join('\n'), count = ch => sample.split(ch).length - 1;
  const d = count('\t') ? '\t' : count(';') > count(',') ? ';' : count(',') ? ',' : null;
  const rows = d === '\t' || !d ? lines.map(l => d ? l.split('\t') : [l]) : parseDelimited(lines.join('\n'), d);
  const nRows = rows.length, nCols = Math.max(...rows.map(r => r.length));
  if (nRows > 1000 || nCols > 300) return { model: null, notes: [`too big for a table: ${nRows} lines, ${nCols} columns`] };
  const cells = [];
  let padded = 0;
  rows.forEach((row, r) => { for (let k = 0; k < nCols; k++) { if (k < row.length) cells.push(newCell(r, k, 1, 1, normText(row[k]))); else { cells.push(newCell(r, k, 1, 1, '', { padded: true })); padded++; } } });
  const notes = [`read as ${d === '\t' ? 'tab-separated' : d ? `"${d}"-separated` : 'one column of'} text`];
  if (padded) notes.push(`${padded} cell${padded > 1 ? 's' : ''} added to short rows`);
  return { model: { nRows, nCols, cells }, notes };
}
function parseDelimited(text, d) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && cell === '') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

/* PAGE XML: the TableRegion of this table (the one the batch's ground truth names, else the only one, else the
   first: a menu in the review lets you pick another). Boxes are page coordinates: they are moved to the crop with
   the crop corner of the batch's PAGE pre-annotation (pagexml_to_cells.py keeps it as "offset"). */
function pageSource(src, text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('not valid XML');
  const regions = Array.from(doc.getElementsByTagNameNS('*', 'TableRegion')).filter(r => r.getElementsByTagNameNS('*', 'TableCell').length);
  if (!regions.length) throw new Error('no TableRegion with cells in this XML');
  const hint = pageHint(), base = src.file;
  src.regions = regions.map(r => r.getAttribute('id') || '');
  src.setRegion = k => {
    const res = modelFromPage(regions[k], hint, base);
    src.region = k; src.model = res.model; src.notes = res.notes;
    src.name = `file ${base}#${src.regions[k] || k + 1}`;
  };
  let k = hint ? src.regions.indexOf(hint.region) : -1;
  if (k < 0) k = src.regions.findIndex(id => id && S.tid.endsWith('__' + id));
  src.setRegion(Math.max(0, k));
}
function pageHint() {
  for (const s of S.batch.sources) {
    const p = S.detail.pre[s];
    if (!p || p.kind !== 'json' || !/"offset"/.test(p.text)) continue;
    let o; try { o = JSON.parse(p.text); } catch (e) { continue; }
    const mm = typeof o.source === 'string' && o.source.match(/^(.*)#([^#]+)$/);
    if (mm && Array.isArray(o.offset) && o.offset.length === 2) return { file: mm[1], region: mm[2], offset: o.offset.map(Number), from: s };
  }
  return null;
}
function hisclimaClean(t) {
  return String(t || '').replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(w => w && w !== '!blank')
    .map(w => w.replace(/!(print|manuscript|blank)$/, '')).filter(Boolean).join(' ');
}
function modelFromPage(region, hint, fname) {
  const kids = (el, n) => Array.from(el.children).filter(x => x.localName === n);
  const pts = el => {
    const co = kids(el, 'Coords')[0], v = co && co.getAttribute('points');
    return v ? v.trim().split(/\s+/).map(p => p.split(',').map(Number)).filter(p => p.length === 2 && p.every(isFinite)) : [];
  };
  const uni = el => kids(el, 'TextEquiv').map(te => kids(te, 'Unicode')[0]).filter(u => u && u.textContent).map(u => u.textContent);
  const raw = [];
  for (const c of region.getElementsByTagNameNS('*', 'TableCell')) {
    let lines = [];
    for (const tl of c.getElementsByTagNameNS('*', 'TextLine')) lines = lines.concat(uni(tl));
    if (!lines.length) lines = uni(c);
    raw.push({ row: parseInt(c.getAttribute('row'), 10) || 0, col: parseInt(c.getAttribute('col'), 10) || 0,
      rs: parseInt(c.getAttribute('rowSpan'), 10) || 1, cs: parseInt(c.getAttribute('colSpan'), 10) || 1, lines, pts: pts(c) });
  }
  const notes = [], id = region.getAttribute('id') || '';
  const tags = raw.some(x => x.lines.some(l => /!(print|manuscript|blank)(\s|$)/.test(l)));
  if (tags) notes.push('HisClima word tags removed');
  // where the crop starts in the page
  const size = S.detail.image_size || [IV.w, IV.h], all = raw.flatMap(x => x.pts), rp = pts(region);
  const ext = v => [Math.min(...v.map(p => p[0])), Math.min(...v.map(p => p[1])), Math.max(...v.map(p => p[0])), Math.max(...v.map(p => p[1]))];
  const fname0 = fname.replace(/^.*[\\/]/, '');
  let off = [0, 0];
  if (hint && (hint.region === id || hint.file === fname0)) { off = hint.offset; notes.push(`boxes moved to the crop as in ${hint.from} (corner ${off.join(', ')})`); }
  else if (all.length) {
    const e = ext(rp.length ? rp : all), w = e[2] - e[0], h = e[3] - e[1], a = ext(all);
    const near = size[0] && w > 0.75 * size[0] && w < 1.05 * size[0] && h > 0.75 * size[1] && h < 1.05 * size[1];
    if (near) { off = [e[0], e[1]]; notes.push(`boxes moved to the crop from the table region's corner (${off.join(', ')}): they may be off by the crop margin`); }
    else if (size[0] && a[2] <= size[0] * 1.02 && a[3] <= size[1] * 1.02) off = [0, 0];
    else { off = [e[0], e[1]]; notes.push(`the crop corner is unknown: boxes placed from the table region's corner (${off.join(', ')}), they may be shifted`); }
  }
  if (!raw.length) return { model: null, notes: notes.concat(['the region has no cells']) };
  const used = [...new Set(raw.flatMap(x => Array.from({ length: x.rs }, (_, i) => x.row + i)))].sort((a, b) => a - b);
  const remap = new Map(used.map((r, i) => [r, i]));
  for (const x of raw) { const last = remap.get(x.row + x.rs - 1); x.row = remap.get(x.row); x.rs = last - x.row + 1; }
  const nRows = used.length, nCols = Math.max(...raw.map(x => x.col + x.cs));
  if (nRows > 1000 || nCols > 300) return { model: null, notes: notes.concat([`too big: ${nRows} × ${nCols}`]) };
  const taken = Array.from({ length: nRows }, () => new Uint8Array(nCols)), cells = [];
  let dropped = 0;
  raw.sort((a, b) => a.row - b.row || a.col - b.col);
  for (const x of raw) {
    let clash = false;
    for (let r = x.row; r < x.row + x.rs && !clash; r++) for (let k = x.col; k < x.col + x.cs; k++) if (taken[r][k]) { clash = true; break; }
    if (clash) { dropped++; continue; }
    for (let r = x.row; r < x.row + x.rs; r++) for (let k = x.col; k < x.col + x.cs; k++) taken[r][k] = 1;
    const text = normText(x.lines.map(l => (tags ? hisclimaClean(l) : cleanText(l))).filter(Boolean).join(' '));
    const P = x.pts.map(p => [p[0] - off[0], p[1] - off[1]]);
    cells.push(newCell(x.row, x.col, x.rs, x.cs, text, P.length > 2 ? { bbox: bboxOf(P), polygon: P, box_by: 'model' } : {}));
  }
  for (let r = 0; r < nRows; r++) for (let k = 0; k < nCols; k++) if (!taken[r][k]) cells.push(newCell(r, k));
  if (dropped) notes.push(`${dropped} overlapping cell${dropped > 1 ? 's' : ''} left out`);
  const m = { nRows, nCols, cells }, err = checkModel(m);
  return { model: err ? null : sortCells(m), notes: err ? notes.concat(['not a valid grid: ' + err]) : notes };
}

// The review window
function openReview(src, mode) {
  if (!src.model) return toast(`Cannot use ${src.name}: ${src.notes.join('; ')}`, 5000);
  const hasBoxes = src.model.cells.some(c => c.bbox);
  mode = mode || LS.get('rvmode', S.batch.prefill === 'structure' ? 'structure' : 'full');
  if (mode === 'boxes' && !hasBoxes) mode = 'full';
  RV = { src, mode, boxes: null, zoom: 1, hover: null };
  openModal(`<div class="rv-head">
      <h2>Import from <span id="rv-name"></span></h2>
      <span id="rv-region"></span>
      <div class="rv-modes" role="radiogroup" aria-label="What to import">${RV_MODES.map(([v, l]) => `<label data-mode="${v}"><input type="radio" name="mode" value="${v}"> ${l}</label>`).join('')}</div>
      <label id="rv-boxwrap" class="rv-boxopt">Boxes <select id="rv-boxes"></select></label>
    </div>
    <p class="rv-info" id="rv-info"></p>
    <div class="rv-legend" id="rv-legend"></div>
    <div class="rv-body">
      <section class="rv-pane rv-imgpane"><header>Image <span class="spacer"></span><button data-lay title="Image above the tables, or beside them">⇅</button><button data-z="-" title="Zoom out">−</button><button data-z="fit" title="Fit the width">Fit</button><button data-z="+" title="Zoom in">+</button></header>
        <div class="rv-scroll" id="rv-img"><div class="rv-stage" id="rv-stage"><img alt="" draggable="false"><svg id="rv-svg" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none"></svg></div></div></section>
      <section class="rv-pane"><header>Now: your table <span class="muted" id="rv-now-size"></span></header><div class="rv-scroll" id="rv-now"></div></section>
      <section class="rv-pane"><header>After the import <span class="muted" id="rv-after-size"></span></header><div class="rv-scroll" id="rv-after"></div></section>
    </div>
    <div class="rv-detail" id="rv-detail"></div>
    <div class="rv-foot">
      <span id="rv-count"></span><span id="rv-selinfo"></span>
      <button data-rv="all">Take all</button><button data-rv="none">Take none</button><button data-rv="empty" id="rv-empty"></button>
      <span class="spacer"></span>
      <button data-close>Cancel</button><button class="primary" id="src-ok">Apply</button>
    </div>`, { cls: 'review', onKey: rvKey, onClose: () => { RV = null; } });
  const lay = LS.get('rvlayout', 'auto');
  $('#modal').classList.toggle('rv-top', lay === 'auto' ? IV.w > 1.3 * IV.h : lay === 'top');
  $('#modal [data-lay]').addEventListener('click', () => { const top = $('#modal').classList.toggle('rv-top'); LS.set('rvlayout', top ? 'top' : 'side'); });
  const img = $('#rv-stage img');
  img.onload = () => { $('#rv-svg').setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`); rvOverlay(); };
  img.src = S.detail.image_url;
  $$('#modal input[name=mode]').forEach(r => r.addEventListener('change', () => { RV.mode = r.value; LS.set('rvmode', r.value); RV.boxes = null; rvBuild(); rvPaint(); }));
  $('#rv-boxes').addEventListener('change', e => { RV.boxes = e.target.value; rvBuild(); rvPaint(); });
  $$('#modal [data-z]').forEach(b => b.addEventListener('click', () => rvZoom(b.dataset.z)));
  $('#rv-img').addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); rvZoom(e.deltaY < 0 ? '+' : '-'); }, { passive: false });
  $$('#modal [data-rv]').forEach(b => b.addEventListener('click', () => {
    const w = b.dataset.rv;
    RV.items.forEach(it => { it.on = w === 'all' ? true : w === 'none' ? false : !it.old; });
    rvPaint();
  }));
  for (const side of ['now', 'after']) {
    const el = $('#rv-' + side);
    el.addEventListener('mousedown', e => {
      const td = e.target.closest('td[data-i]');
      if (e.button !== 0 || !td) return;
      e.preventDefault();  // no text selection while dragging
      RV.noClick = false;
      const c = (side === 'after' ? RV.P : S.model).cells[+td.dataset.i];
      RV.drag = { side, a: c, b: c, moved: false, add: e.ctrlKey || e.shiftKey || e.metaKey, base: RV.sel };
    });
    el.addEventListener('mouseover', e => {
      const td = e.target.closest('td[data-i]'), h = RV.hover, d = RV.drag;
      if (td && d && d.side === side) {
        const c = (side === 'after' ? RV.P : S.model).cells[+td.dataset.i];
        if (c !== d.b) { d.b = c; d.moved = true; RV.sel = rvDragKeys(d); rvMarkSel(); }
      }
      if (td && !(h && h.side === side && h.i === +td.dataset.i)) rvHover(side, +td.dataset.i);
    });
    el.addEventListener('mouseleave', () => rvHover(null));
    el.addEventListener('click', e => {
      if (RV.noClick) { RV.noClick = false; return; }
      const td = e.target.closest('td[data-i]'), th = e.target.closest('th[data-col], th[data-row]');
      let ks = [];
      if (td) ks = side === 'after' ? (RV.byCell.has(+td.dataset.i) ? [RV.byCell.get(+td.dataset.i)] : []) : (RV.nowItems.get(+td.dataset.i) || []);
      else if (th && (side === 'after' || RV.same)) {
        const m = RV.P, col = th.dataset.col, row = th.dataset.row;
        ks = RV.items.map((it, k) => [it, k]).filter(([it]) => { const c = m.cells[it.i]; return col != null ? c.c <= +col && +col < c.c + c.cs : c.r <= +row && +row < c.r + c.rs; }).map(([, k]) => k);
      }
      if (!ks.length) return;
      if (td && (e.ctrlKey || e.shiftKey || e.metaKey)) return rvSelAdd(ks);
      const on = !ks.every(k => RV.items[k].on);
      ks.forEach(k => { RV.items[k].on = on; });
      RV.sel = null;
      rvPaint();
    });
    el.addEventListener('scroll', () => {  // the two tables scroll together
      if (RV.syncing) { RV.syncing = false; return; }
      const o = $('#rv-' + (side === 'now' ? 'after' : 'now'));
      const fy = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight), fx = el.scrollLeft / Math.max(1, el.scrollWidth - el.clientWidth);
      const ty = Math.round(fy * (o.scrollHeight - o.clientHeight)), tx = Math.round(fx * (o.scrollWidth - o.clientWidth));
      if (Math.abs(o.scrollTop - ty) > 1 || Math.abs(o.scrollLeft - tx) > 1) { RV.syncing = true; o.scrollTop = ty; o.scrollLeft = tx; }
    });
  }
  $('#rv-svg').addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    RV.noClick = false;
    const p = rvImgPt(e);
    RV.drag = { side: 'img', p0: p, p1: p, x: e.clientX, y: e.clientY, moved: false, add: e.ctrlKey || e.shiftKey || e.metaKey, base: RV.sel };
  });
  $('#rv-svg').addEventListener('click', e => {
    if (RV.noClick) { RV.noClick = false; return; }
    const k = e.target.dataset && e.target.dataset.k;
    if (k == null) return;
    if (e.ctrlKey || e.shiftKey || e.metaKey) return rvSelAdd([+k]);
    RV.items[+k].on = !RV.items[+k].on; RV.sel = null; rvPaint();
  });
  $('#src-ok').onclick = rvApply;
  rvBuild(); rvPaint();
}
function rvZoom(z) {
  RV.zoom = z === 'fit' ? 1 : clamp(RV.zoom * (z === '+' ? 1.25 : 0.8), 0.4, 8);
  $('#rv-stage').style.width = (RV.zoom * 100) + '%';
}
/* Which of my boxes to keep when the structure changes: mine where I have one and theirs elsewhere, only mine, only theirs, none. */
function rvBoxChoices() {
  const m = S.model, sm = RV.src.model;
  const mine = m.cells.some(c => c.bbox), theirs = sm.cells.some(c => c.bbox) && S.batch.box_prefill !== 'none';
  const made = m.cells.some(c => c.bbox && c.box_by !== 'model');
  const ch = [];
  if (mine && theirs) ch.push(['both', 'mine, theirs for the other cells']);
  if (mine) ch.push(['mine', 'only mine']);
  if (theirs) ch.push(['theirs', `only theirs (${esc(RV.src.name)})`]);
  ch.push(['none', 'none']);
  const def = mine && theirs ? (made ? 'both' : 'theirs') : mine ? 'mine' : theirs ? 'theirs' : 'none';
  return { ch, def };
}
function rvBuild() {
  const { src } = RV, sm = src.model, m = S.model;
  RV.sel = null; RV.drag = null;
  if (RV.mode === 'boxes' && !sm.cells.some(c => c.bbox)) RV.mode = 'full';
  const mode = RV.mode, items = [], map = new Map(), lost = [];
  let P, how = '', boxNote = '';
  RV.same = mode === 'text' || mode === 'boxes';
  RV.mineText = 0; RV.mineBoxes = 0; RV.boxHow = '';
  const unionBox = parts => parts.length === 1 ? { bbox: parts[0].bbox.slice(), polygon: parts[0].polygon ? parts[0].polygon.map(p => p.slice()) : null }
    : { bbox: bboxOf(parts.flatMap(x => [[x.bbox[0], x.bbox[1]], [x.bbox[2], x.bbox[3]]])), polygon: null };
  if (RV.same) {
    P = cloneModel(m);
    const idx = new Map(P.cells.map((c, i) => [c, i]));
    P.cells.forEach((c, i) => map.set(i, [i]));
    if (mode === 'text') {
      const tp = textPlan(sm, P); how = tp.how;
      for (const [c, t, xs] of tp.plan) if (t !== c.text) items.push({ i: idx.get(c), kind: 'text', old: c.text, neu: t, on: true, srcBox: boxOfCells(xs) });
    } else {
      const mb = matchBoxes(sm, P); how = mb.how;
      for (const [c, parts] of mb.out) {
        const nb = unionBox(parts);
        if (c.bbox && nb.bbox.every((v, j) => Math.abs(v - c.bbox[j]) < 0.5) && !c.polygon === !nb.polygon) continue;
        items.push({ i: idx.get(c), kind: 'box', old: c.bbox ? { bbox: c.bbox.slice(), polygon: c.polygon } : null, neu: nb, on: true });
      }
    }
  } else {
    P = cloneModel(sm);
    const idx = new Map(P.cells.map((c, i) => [c, i])), idxM = new Map(m.cells.map((c, i) => [c, i]));
    const tp = textPlan(m, P), mine = new Map();
    for (const [c, t, xs] of tp.plan) { const i = idx.get(c); mine.set(i, { t, xs }); map.set(i, xs.map(x => idxM.get(x))); }
    how = tp.how;
    const used = new Set([].concat(...map.values()));
    m.cells.forEach((c, i) => { if (!used.has(i) && c.text) lost.push(i); });
    const flags = (c, xs) => { c.unclear = xs.some(x => x.unclear); c.edited = xs.some(x => x.edited); };
    if (mode === 'full') {
      P.cells.forEach((c, i) => {
        const my = mine.get(i), old = my ? my.t : '';
        if (old !== c.text) items.push({ i, kind: 'text', old, neu: c.text, on: true, mine: my ? my.xs : [], srcBox: boxOfCells([sm.cells[i]]) });
      });
    } else {
      P.cells.forEach((c, i) => {
        const my = mine.get(i);
        c.text = my ? my.t : '';
        if (my) { flags(c, my.xs); c.header = c.header || my.xs.some(x => x.header); if (my.t) RV.mineText++; }
        else { c.unclear = false; c.edited = false; }
      });
    }
    // boxes of the new cells
    const bc = rvBoxChoices();
    if (!RV.boxes || !bc.ch.some(([v]) => v === RV.boxes)) RV.boxes = bc.def;
    if (RV.boxes === 'mine' || RV.boxes === 'none') P.cells.forEach(c => { c.bbox = null; c.polygon = null; c.box_by = null; });
    if (RV.boxes === 'mine' || RV.boxes === 'both') {
      const mb = matchBoxes(m, P);
      for (const [c, parts] of mb.out) {
        const nb = unionBox(parts);
        c.bbox = nb.bbox; c.polygon = nb.polygon;
        c.box_by = parts.length === 1 ? parts[0].box_by || 'model' : parts.every(x => x.box_by === parts[0].box_by) ? parts[0].box_by || 'model' : 'hand';
        RV.mineBoxes++;
      }
      RV.boxHow = mb.how;
    }
    const nb = P.cells.filter(c => c.bbox).length;
    boxNote = RV.boxes === 'none' ? 'No boxes.' : `${nb} of ${P.cells.length} new cells get a box` +
      (RV.boxes === 'both' ? ` (${RV.mineBoxes} of yours, ${nb - RV.mineBoxes} of theirs).` : RV.boxes === 'mine' ? ' (yours).' : ' (theirs).');
  }
  const rmap = new Map();
  for (const [i, js] of map) for (const j of js) { if (!rmap.has(j)) rmap.set(j, []); rmap.get(j).push(i); }
  Object.assign(RV, { P, items, map, rmap, lost, how, boxNote, byCell: new Map(items.map((it, k) => [it.i, k])) });
  // the header: name, region menu, modes, box menu, what this mode does
  $('#rv-name').textContent = src.name;
  $('#rv-region').innerHTML = src.regions && src.regions.length > 1
    ? `<select id="rv-regsel" title="Table regions in this PAGE file">${src.regions.map((id, k) => `<option value="${k}"${k === src.region ? ' selected' : ''}>region ${esc(id || k + 1)}</option>`).join('')}</select>` : '';
  if ($('#rv-regsel')) $('#rv-regsel').onchange = e => { src.setRegion(+e.target.value); if (!src.model) { toast('This region cannot be read: ' + src.notes.join('; '), 5000); return; } RV.boxes = null; rvBuild(); rvPaint(); };
  const hasBoxes = sm.cells.some(c => c.bbox);
  $$('#modal .rv-modes label').forEach(l => {
    const v = l.dataset.mode, inp = $('input', l), dis = v === 'boxes' && !hasBoxes;
    inp.disabled = dis; inp.checked = v === mode; l.classList.toggle('on', v === mode); l.classList.toggle('dis', dis);
    l.title = dis ? `${src.name} has no boxes` : '';
  });
  const bc = rvBoxChoices();
  $('#rv-boxwrap').hidden = RV.same;
  $('#rv-boxes').innerHTML = bc.ch.map(([v, l]) => `<option value="${v}"${v === RV.boxes ? ' selected' : ''}>${l}</option>`).join('');
  const sz = mm => `${mm.nRows} × ${mm.nCols}`, nm = esc(src.name);
  const what = {
    text: `Keep my table (${sz(m)}) and take the text of ${nm} (${sz(sm)}). Cells matched: ${esc(how)}.`,
    full: `Replace my table by ${nm} (${sz(sm)}): its rows, columns, merges and text. A cell whose change you do not take keeps your text. Your text matched to the new cells: ${esc(how)}. ${esc(boxNote)}`,
    structure: `Take the rows, columns and merges of ${nm} (${sz(sm)}); your text goes into the new cells (${esc(how)}), the structure comes as a whole. ${esc(boxNote)}`,
    boxes: `Keep my table and take the boxes of ${nm}. Cells matched: ${esc(how)}.`,
  }[mode];
  const lostNote = lost.length ? ` <b class="rv-warn">${lost.length} of your cells with text have no place in the new table (red in Now): that text is not kept.</b>` : '';
  $('#rv-info').innerHTML = what + lostNote + (src.notes.length ? ` <span class="muted">Notes: ${esc(src.notes.join(' · '))}</span>` : '');
  const sw = (c, t) => `<span><i class="sw ${c}"></i>${t}</span>`;
  $('#rv-legend').innerHTML = (items.length ? sw('on', 'change taken') + sw('off', 'change not taken (click a cell, a column letter or a row number to switch)') : '')
    + (RV.same ? (items.length ? sw('was', 'in Now: the cells that change') : '') : sw('lost', 'your text with no place in the new table') + sw('fresh', 'new cell: nothing of yours goes there'));
  $('#rv-now-size').textContent = sz(m);
  $('#rv-after-size').textContent = sz(P);
  const empty = $('#rv-empty');
  empty.hidden = !items.length;
  empty.textContent = mode === 'boxes' ? 'Only cells without a box' : 'Only where mine is empty';
  RV.hint = items.length ? 'Point at a cell to compare; click it to take or leave its change. Drag over cells (or on the image) to select several, then Enter.' : '';
}
function boxOfCells(xs) {
  const b = xs.filter(x => x && x.bbox);
  return b.length ? bboxOf(b.flatMap(x => [[x.bbox[0], x.bbox[1]], [x.bbox[2], x.bbox[3]]])) : null;
}
function rvTable(m, fn) {
  const s = slotsOf(m), out = ['<table class="rv-t"><thead><tr><th class="rv-c"></th>'];
  for (let k = 0; k < m.nCols; k++) out.push(`<th data-col="${k}">${colName(k)}</th>`);
  out.push('</tr></thead><tbody>');
  for (let r = 0; r < m.nRows; r++) {
    out.push(`<tr><th data-row="${r}">${r + 1}</th>`);
    for (let k = 0; k < m.nCols; k++) {
      const i = s[r][k], c = m.cells[i];
      if (c.r !== r || c.c !== k) continue;
      const [cls, text] = fn(c, i);
      out.push(`<td data-i="${i}"${c.rs > 1 ? ` rowspan="${c.rs}"` : ''}${c.cs > 1 ? ` colspan="${c.cs}"` : ''}${cls ? ` class="${cls.trim()}"` : ''}>${cellHTML(text)}</td>`);
    }
    out.push('</tr>');
  }
  out.push('</tbody></table>');
  return out.join('');
}
function rvPaint() {
  const { P, items, same } = RV, m = S.model;
  const nowItems = new Map();
  items.forEach((it, k) => { for (const j of RV.map.get(it.i) || []) { if (!nowItems.has(j)) nowItems.set(j, []); nowItems.get(j).push(k); } });
  RV.nowItems = nowItems;
  const lost = new Set(RV.lost), now = $('#rv-now'), after = $('#rv-after');
  const keep = [now.scrollTop, now.scrollLeft, after.scrollTop, after.scrollLeft];
  now.innerHTML = rvTable(m, (c, i) => {
    const ks = nowItems.get(i) || [];
    let cls = c.header ? 'hd' : '';
    if (ks.length) cls += ks.some(k => items[k].on) ? ' chg' : ' chg off';
    if (lost.has(i)) cls += ' lost';
    if (same && ks.length && items[ks[0]].kind === 'box') cls += ' bx';
    return [cls, c.text];
  });
  after.innerHTML = rvTable(P, (c, i) => {
    const it = items[RV.byCell.get(i)];
    let cls = c.header ? 'hd' : '', text = c.text;
    if (it) { cls += it.on ? ' chg' : ' chg off'; if (it.kind === 'text') text = it.on ? it.neu : it.old; else cls += ' bx'; }
    if (!same && !RV.map.has(i)) cls += ' fresh';
    return [cls, text];
  });
  RV.syncing = false;
  now.scrollTop = keep[0]; now.scrollLeft = keep[1]; after.scrollTop = keep[2]; after.scrollLeft = keep[3];
  RV.syncing = false;
  const n = items.length, on = items.filter(it => it.on).length, ok = $('#src-ok');
  if (RV.mode === 'text' || RV.mode === 'boxes') {
    $('#rv-count').textContent = n ? `${on} of ${n} ${RV.mode === 'boxes' ? 'box' : 'text'} change${n > 1 ? 's' : ''} taken` : `Nothing to change: ${RV.mode === 'boxes' ? 'no cell gets a new box' : 'the matched cells already have this text'}.`;
    ok.textContent = on ? `Take ${on} change${on > 1 ? 's' : ''}` : 'Take the changes';
    ok.disabled = !on;
  } else {
    $('#rv-count').textContent = `New table ${P.nRows} × ${P.nCols}` + (RV.mode === 'full' ? (n ? ` · ${on} of ${n} cell texts theirs, ${n - on} yours` : ' · same text as yours') : ` · your text in ${RV.mineText} cells`);
    ok.textContent = RV.mode === 'full' ? 'Replace my table' : 'Replace the structure';
    ok.disabled = false;
  }
  $$('#modal [data-rv]').forEach(b => { b.hidden = !n; });
  rvMarkSel();
  if (RV.hover) rvHover(RV.hover.side, RV.hover.i); else $('#rv-detail').innerHTML = esc(RV.hint);
}
function rvDiff(a, b) {
  let p = 0, s = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const show = (x, tag) => { const mid = x.slice(p, x.length - s); return esc(x.slice(0, p)) + (mid ? `<${tag}>${esc(mid)}</${tag}>` : '') + esc(x.slice(x.length - s)); };
  return [a ? '“' + show(a, 'del') + '”' : '<i class="muted">empty</i>', b ? '“' + show(b, 'ins') + '”' : '<i class="muted">empty</i>'];
}
function rvHover(side, i) {
  $$('#modal td.hov').forEach(e => e.classList.remove('hov'));
  if (!RV) return;
  if (!side) { RV.hover = null; $('#rv-detail').innerHTML = esc(RV.hint); rvOverlay(); return; }
  RV.hover = { side, i };
  const P = RV.P, m = S.model;
  const pIdx = side === 'after' ? [i] : (RV.rmap.get(i) || []), mine = side === 'after' ? (RV.map.get(i) || []) : [i];
  pIdx.forEach(x => { const td = $(`#rv-after td[data-i="${x}"]`); if (td) td.classList.add('hov'); });
  mine.forEach(x => { const td = $(`#rv-now td[data-i="${x}"]`); if (td) td.classList.add('hov'); });
  const refs = (mm, xs) => xs.map(x => cellRef(mm.cells[x])).join(', ');
  let html;
  if (side === 'after') {
    const c = P.cells[i], it = RV.items[RV.byCell.get(i)];
    html = `<b>${cellRef(c)}</b>` + (RV.same ? '' : mine.length ? ` <span class="muted">(yours: ${refs(m, mine)})</span>` : ' <span class="muted">(new cell)</span>');
    if (it && it.kind === 'text') { const [a, b] = rvDiff(it.old, it.neu); html += ` · yours ${a} → theirs ${b} · ${it.on ? '<b class="ok">taken</b> (click to keep yours)' : '<b>yours kept</b> (click to take theirs)'}`; }
    else if (it) html += ` · box ${it.old ? 'replaced' : 'added'} · ${it.on ? '<b class="ok">taken</b> (click to leave it)' : '<b>not taken</b> (click to take it)'}`;
    else html += ` · “${esc(c.text)}” · no change`;
  } else {
    const c = m.cells[i], ks = RV.nowItems.get(i) || [];
    html = `<b>${cellRef(c)}</b> (yours) “${esc(c.text)}”`;
    if (RV.lost.includes(i)) html += ' · <b class="rv-warn">not in the new table: this text is not kept</b>';
    else if (!RV.same && pIdx.length) html += ` → ${refs(P, pIdx)} in the new table`;
    if (ks.length) html += ` · ${ks.filter(k => RV.items[k].on).length} of ${ks.length} change${ks.length > 1 ? 's' : ''} taken (click to switch)`;
  }
  $('#rv-detail').innerHTML = html;
  rvOverlay();
  // bring the box into view on the image
  const b = rvBoxOf(pIdx[0], mine[0]);
  const box = $('#rv-img'), img = $('#rv-stage img');
  if (b && img.naturalWidth) {
    const k = img.clientWidth / img.naturalWidth, x0 = b[0] * k, y0 = b[1] * k, x1 = b[2] * k, y1 = b[3] * k;
    if (x0 < box.scrollLeft || x1 > box.scrollLeft + box.clientWidth) box.scrollLeft = (x0 + x1 - box.clientWidth) / 2;
    if (y0 < box.scrollTop || y1 > box.scrollTop + box.clientHeight) box.scrollTop = (y0 + y1 - box.clientHeight) / 2;
  }
}
function rvBoxOf(pi, mi) {
  const it = pi != null ? RV.items[RV.byCell.get(pi)] : null;
  if (it && it.kind === 'box' && it.on) return it.neu.bbox;
  const pc = pi != null ? RV.P.cells[pi] : null;
  if (pc && pc.bbox) return pc.bbox;
  if (it && it.srcBox) return it.srcBox;
  const mc = mi != null ? S.model.cells[mi] : null;
  return mc && mc.bbox ? mc.bbox : null;
}
function rvOverlay() {
  const svg = $('#rv-svg');
  if (!svg || !RV) return;
  const out = [], P = RV.P, m = S.model;
  const shape = (b, poly, cls, k) => {
    const dk = k != null ? ` data-k="${k}"` : '';
    return poly && poly.length > 2 ? `<polygon class="rv-b ${cls}" points="${poly.map(p => p.join(',')).join(' ')}"${dk}/>`
      : `<rect class="rv-b ${cls}" x="${b[0]}" y="${b[1]}" width="${Math.max(1, b[2] - b[0])}" height="${Math.max(1, b[3] - b[1])}"${dk}/>`;
  };
  for (const i of RV.lost) { const c = m.cells[i]; if (c.bbox) out.push(shape(c.bbox, c.polygon, 'lost')); }
  RV.items.forEach((it, k) => {
    const st = (it.on ? 'on' : 'off') + (RV.sel && RV.sel.has(k) ? ' sel' : '');
    if (it.kind === 'box') { if (it.old) out.push(shape(it.old.bbox, it.old.polygon, 'was')); out.push(shape(it.neu.bbox, it.neu.polygon, st, k)); return; }
    const c = P.cells[it.i];
    if (c.bbox) out.push(shape(c.bbox, c.polygon, st, k)); else if (it.srcBox) out.push(shape(it.srcBox, null, st, k));
  });
  const h = RV.hover;
  if (h) {
    const pIdx = h.side === 'after' ? [h.i] : (RV.rmap.get(h.i) || []), mine = h.side === 'after' ? (RV.map.get(h.i) || []) : [h.i];
    if (!RV.same) for (const j of mine) { const c = m.cells[j]; if (c.bbox) out.push(shape(c.bbox, c.polygon, 'mine')); }
    for (const i of pIdx) { const b = rvBoxOf(i, null); if (b) out.push(shape(b, null, 'hov')); }
    if (!pIdx.length) for (const j of mine) { const c = m.cells[j]; if (c.bbox) out.push(shape(c.bbox, c.polygon, 'hov')); }
  }
  const d = RV.drag;
  if (d && d.side === 'img' && d.moved) {
    const x0 = Math.min(d.p0[0], d.p1[0]), y0 = Math.min(d.p0[1], d.p1[1]);
    out.push(`<rect class="rv-band" x="${x0}" y="${y0}" width="${Math.abs(d.p1[0] - d.p0[0])}" height="${Math.abs(d.p1[1] - d.p0[1])}"/>`);
  }
  svg.innerHTML = out.join('');
}
/* Several changes at once: drag over cells of Now or After, or over the image (Ctrl or Shift adds to the
   selection), then Enter: if any of them is taken, all are left out; if none is, all are taken. Esc unselects. */
function rvRectOf(d) {
  return { r0: Math.min(d.a.r, d.b.r), c0: Math.min(d.a.c, d.b.c), r1: Math.max(d.a.r + d.a.rs, d.b.r + d.b.rs) - 1, c1: Math.max(d.a.c + d.a.cs, d.b.c + d.b.cs) - 1 };
}
function rvHit(c, R) { return c.r <= R.r1 && c.r + c.rs - 1 >= R.r0 && c.c <= R.c1 && c.c + c.cs - 1 >= R.c0; }
function rvItemBox(it) { return it.kind === 'box' ? it.neu.bbox : RV.P.cells[it.i].bbox || it.srcBox || null; }
function rvImgPt(e) {
  const svg = $('#rv-svg'), r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
  return [(e.clientX - r.left) / r.width * vb.width, (e.clientY - r.top) / r.height * vb.height];
}
function rvDragKeys(d) {
  const ks = new Set(d.add && d.base ? d.base : []);
  if (d.side === 'img') {
    const x0 = Math.min(d.p0[0], d.p1[0]), x1 = Math.max(d.p0[0], d.p1[0]), y0 = Math.min(d.p0[1], d.p1[1]), y1 = Math.max(d.p0[1], d.p1[1]);
    RV.items.forEach((it, k) => { const b = rvItemBox(it); if (b && b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0) ks.add(k); });
  } else {
    const R = rvRectOf(d);
    if (d.side === 'after') RV.items.forEach((it, k) => { if (rvHit(RV.P.cells[it.i], R)) ks.add(k); });
    else S.model.cells.forEach((c, i) => { if (rvHit(c, R)) (RV.nowItems.get(i) || []).forEach(k => ks.add(k)); });
  }
  return ks;
}
function rvSelAdd(ks) {
  const sel = new Set(RV.sel || []), has = ks.every(k => sel.has(k));
  ks.forEach(k => { if (has) sel.delete(k); else sel.add(k); });
  RV.sel = sel.size ? sel : null;
  rvMarkSel();
}
function rvMarkSel() {
  if (!RV) return;
  const sel = RV.sel || new Set(), d = RV.drag && RV.drag.moved && RV.drag.side !== 'img' ? RV.drag : null, R = d && rvRectOf(d);
  for (const side of ['now', 'after']) {
    const mm = side === 'after' ? RV.P : S.model;
    $$(`#rv-${side} td[data-i]`).forEach(td => {
      const i = +td.dataset.i, ks = side === 'after' ? (RV.byCell.has(i) ? [RV.byCell.get(i)] : []) : (RV.nowItems.get(i) || []);
      td.classList.toggle('sel', ks.some(k => sel.has(k)));
      td.classList.toggle('rng', !!(d && d.side === side && rvHit(mm.cells[i], R)));
    });
  }
  const n = sel.size, on = [...sel].filter(k => RV.items[k].on).length;
  $('#rv-selinfo').innerHTML = n ? `${n} selected, ${on} taken · <kbd>Enter</kbd> ${on ? 'leaves them out' : 'takes them'} · <kbd>Esc</kbd> unselects` : '';
  rvOverlay();
}
function rvKey(e) {
  if (!RV) return false;
  if (e.key === 'Enter' && RV.sel && RV.sel.size) {
    e.preventDefault();
    const ks = [...RV.sel], on = !ks.some(k => RV.items[k].on);
    ks.forEach(k => { RV.items[k].on = on; });
    rvPaint();
    return true;
  }
  if (e.key === 'Escape' && (RV.drag || RV.sel)) { e.preventDefault(); RV.sel = null; RV.drag = null; rvPaint(); return true; }
  return false;
}
document.addEventListener('mousemove', e => {
  const d = RV && RV.drag;
  if (!d) return;
  d.mx = e.clientX; d.my = e.clientY;
  if (d.side === 'img') {
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true; d.p1 = rvImgPt(e); RV.sel = rvDragKeys(d); rvMarkSel();
  }
  if (d.moved || d.side !== 'img') rvAutoScroll();
});
/* Dragging to the edge of a pane (or past it) scrolls it, and the rectangle follows. */
function rvAutoScroll() {
  const d = RV && RV.drag;
  if (!d || d.timer) return;
  const el = $(d.side === 'img' ? '#rv-img' : '#rv-' + d.side), r = el.getBoundingClientRect(), E = 28;
  const vx = d.mx < r.left + E ? -1 : d.mx > r.right - E ? 1 : 0, vy = d.my < r.top + E ? -1 : d.my > r.bottom - E ? 1 : 0;
  if (!vx && !vy) return;
  d.timer = setTimeout(() => {
    d.timer = null;
    if (!RV || RV.drag !== d) return;
    const x = el.scrollLeft, y = el.scrollTop;
    el.scrollLeft += vx * 20; el.scrollTop += vy * 20;
    if (el.scrollLeft === x && el.scrollTop === y) return;  // at the end
    if (d.side === 'img') { d.moved = true; d.p1 = rvImgPt({ clientX: d.mx, clientY: d.my }); }
    else {
      const px = clamp(d.mx, r.left + 2, r.right - 2), py = clamp(d.my, r.top + 2, r.bottom - 2), hit = document.elementFromPoint(px, py);
      const td = hit && hit.closest && hit.closest(`#rv-${d.side} td[data-i]`);
      if (td) { const c = (d.side === 'after' ? RV.P : S.model).cells[+td.dataset.i]; if (c !== d.b) { d.b = c; d.moved = true; } }
    }
    RV.sel = rvDragKeys(d); rvMarkSel();
    rvAutoScroll();
  }, 40);
}
document.addEventListener('mouseup', () => {
  const d = RV && RV.drag;
  if (!d) return;
  clearTimeout(d.timer);
  RV.drag = null;
  if (d.moved) { RV.sel = rvDragKeys(d); if (!RV.sel.size) RV.sel = null; RV.noClick = true; }
  rvMarkSel();
});
/* The table after the import, with the changes taken. */
function rvResult() {
  const P = cloneModel(RV.P), m = S.model;
  for (const it of RV.items) {
    const c = P.cells[it.i];
    if (it.kind === 'text') {
      c.text = it.on ? it.neu : it.old;
      if (it.on) c.padded = false;
      if (!it.on && it.mine && it.mine.length) { c.unclear = it.mine.some(x => x.unclear); c.edited = it.mine.some(x => x.edited); }
    } else if (it.on) { c.bbox = it.neu.bbox.slice(); c.polygon = it.neu.polygon ? it.neu.polygon.map(p => p.slice()) : null; c.box_by = 'model'; }
    else if (RV.same) { const o = m.cells[it.i]; c.bbox = o.bbox ? o.bbox.slice() : null; c.polygon = o.polygon; c.box_by = o.box_by; }
  }
  return P;
}
function rvApply() {
  const { src, mode, items, how } = RV, n = items.length, on = items.filter(it => it.on).length;
  const P = rvResult(), mineText = RV.mineText, mineBoxes = RV.mineBoxes, boxHow = RV.boxHow, boxes = RV.boxes;
  closeModal(true);
  const extra = { offered: n, file: src.file || undefined, sha256: src.sha256 || undefined };
  if (mode === 'text' || mode === 'boxes') {
    if (!on) return;
    const part = mode === 'text' ? 'text' : 'boxes';
    const ok = apply(mode === 'text' ? 'take_text' : 'box', () => { S.model = P; noteMix(part, src.name, on, how, extra); return mode === 'text' ? 'text_take' : 'box_take'; });
    if (ok) toast(`${mode === 'text' ? 'Text' : 'Boxes'} of ${src.name} taken in ${on} cell${on > 1 ? 's' : ''}${on < n ? ` (${n - on} change${n - on > 1 ? 's' : ''} left out)` : ''}. Ctrl+Z undoes it.`, 4500);
    return;
  }
  const prevFrom = S.meta.started_from, time = new Date().toISOString();
  apply('restart', () => {
    S.model = P; S.sel = { ar: 0, ac: 0, er: 0, ec: 0 };
    const sf = { source: src.name, mode, file: src.file, sha256: src.sha256 || undefined, time };
    if (mode === 'full') sf.review = { changes: n, taken: on };
    const mixed = [];
    if (mode === 'full' && on < n) mixed.push({ part: 'text', source: 'previous annotation', cells: n - on, how, time });
    if (mode === 'structure' && mineText) mixed.push({ part: 'text', source: 'previous annotation', cells: mineText, how, time });
    if ((boxes === 'mine' || boxes === 'both') && mineBoxes) mixed.push({ part: 'boxes', source: 'previous annotation', cells: mineBoxes, how: boxHow, time });
    if (mixed.length) sf.mixed = mixed;
    S.meta.started_from = sf;
    return 'restart';
  });
  if (S.meta.started_from === prevFrom) return;
  setImportNotes(src.notes); renderSourceSelect();
  toast(mode === 'full' ? `Table replaced by ${src.name}${on < n ? ` (your text kept in ${n - on} cell${n - on > 1 ? 's' : ''})` : ''}. Ctrl+Z undoes it.`
    : `Structure of ${src.name} taken, your text in ${mineText} cells. Ctrl+Z undoes it.`, 4500);
}
// ------------------------------------------------------------------------------------------
// Compare: another source next to your table while you edit (its text, its structure or its boxes). Nothing
// changes until you take a difference: select it (click, or drag over several), then Enter, Take ← or a
// double-click. The comparison follows your edits and the cell you are on.

let CMP = null;
function renderCmpSelect() {
  const sel = $('#cmp-select');
  if (!S.detail) return;
  const opts = ['<option value="">—</option>'].concat(S.batch.sources.filter(s => S.detail.pre[s]).map(s => `<option value="${escAttr(s)}">${esc(s)}</option>`));
  const cur = CMP ? (S.detail.pre[CMP.src.name] ? CMP.src.name : '__cur') : '';
  if (cur === '__cur') opts.push(`<option value="__cur">${esc(CMP.src.name)}</option>`);
  opts.push('<option value="__file">From a file…</option>');
  sel.innerHTML = opts.join('');
  sel.value = cur;
}
$('#cmp-select').addEventListener('change', () => {
  const v = $('#cmp-select').value;
  if (v === '__cur') return;
  if (v === '__file') { renderCmpSelect(); const f = $('#cmp-file'); f.value = ''; return f.click(); }
  if (!v) return cmpClose();
  const src = batchSource(v);
  if (!src.model) { renderCmpSelect(); return toast(`Cannot use ${v}: ${src.notes.join('; ')}`, 5000); }
  cmpOpen(src);
});
$('#cmp-file').addEventListener('change', async () => { const src = await pickedSource($('#cmp-file')); if (src) cmpOpen(src); });
function cmpOpen(src, mode) {
  const boxed = src.model.cells.some(c => c.bbox);
  mode = mode || LS.get('cmpmode', 'text');
  if (mode === 'boxes' && !boxed) mode = 'text';
  CMP = { src, mode, selT: new Set(), diffs: [], their: new Map(), mine: new Map(), theirTo: new Map() };
  $('#cmp').hidden = false;
  $('#cmp-name').textContent = src.name;
  $('#cmp-name').title = src.notes.length ? 'Notes: ' + src.notes.join(' · ') : '';
  $('#cmp-mode button[data-cm="boxes"]').disabled = !boxed;
  $('#cmp-mode button[data-cm="boxes"]').title = boxed ? 'Their boxes against yours (theirs dashed on the image)' : `${src.name} has no boxes`;
  renderCmpSelect();
  cmpRefresh();
}
function cmpClose() {
  CMP = null;
  $('#cmp').hidden = true;
  renderCmpSelect(); cmpMarkGrid(); cmpOverlay();
  $('#gridwrap').focus({ preventScroll: true });
}
$('#cmp-close').addEventListener('click', cmpClose);
$$('#cmp-mode button').forEach(b => b.addEventListener('click', () => {
  if (!CMP || b.disabled) return;
  CMP.mode = b.dataset.cm; CMP.selT = new Set(); LS.set('cmpmode', CMP.mode); cmpRefresh();
}));
$('#cmp-take').addEventListener('click', () => cmpTake(cmpSelected()));
$('#cmp-import').addEventListener('click', () => { if (CMP) openReview(CMP.src, CMP.mode === 'structure' ? 'structure' : CMP.mode); });

/* The differences between their table and yours: for each of your cells, their cells at the same place
   (matched as in the import: same grid cell by cell, else by the place of the boxes or by rows and columns
   whose text matches). their: their cell -> index of its difference (-1 = the same, absent = not matched). */
function cmpCompute() {
  const sm = CMP.src.model, m = S.model, mode = CMP.mode;
  const idxS = new Map(sm.cells.map((c, i) => [c, i])), idxM = new Map(m.cells.map((c, i) => [c, i]));
  const diffs = [], their = new Map(), mine = new Map(), theirTo = new Map();
  let how = '';
  const link = (mi, tis, d) => { mine.set(mi, tis); tis.forEach(j => { their.set(j, d); theirTo.set(j, mi); }); };
  if (mode === 'text') {
    const tp = textPlan(sm, m); how = tp.how;
    for (const [c, t, xs] of tp.plan) {
      const mi = idxM.get(c), d = t !== c.text ? diffs.push({ my: mi, kind: 'text', old: c.text, neu: t }) - 1 : -1;
      link(mi, xs.map(x => idxS.get(x)), d);
    }
  } else if (mode === 'boxes') {
    const mb = matchBoxes(sm, m); how = mb.how;
    for (const [c, parts] of mb.out) {
      const nb = parts.length === 1 ? { bbox: parts[0].bbox, polygon: parts[0].polygon }
        : { bbox: bboxOf(parts.flatMap(x => [[x.bbox[0], x.bbox[1]], [x.bbox[2], x.bbox[3]]])), polygon: null };
      const same = c.bbox && nb.bbox.every((v, j) => Math.abs(v - c.bbox[j]) <= 2);
      const mi = idxM.get(c), d = same ? -1 : diffs.push({ my: mi, kind: 'box', old: c.bbox, neu: nb }) - 1;
      link(mi, parts.map(x => idxS.get(x)), d);
    }
  } else {
    const tp = textPlan(m, sm); how = tp.how;
    const got = new Map();
    for (const [c, , xs] of tp.plan) got.set(idxS.get(c), xs.map(x => idxM.get(x)));
    sm.cells.forEach((c, j) => {
      const mis = got.get(j) || [];
      let why = null;
      if (!mis.length) why = 'new';
      else if (mis.length > 1) why = 'merged';
      else { const x = m.cells[mis[0]]; if (x.rs !== c.rs || x.cs !== c.cs) why = 'span'; }
      const d = why ? diffs.push({ my: mis.length ? mis[0] : -1, mine: mis, kind: 'structure', why }) - 1 : -1;
      their.set(j, d);
      if (mis.length) theirTo.set(j, mis[0]);
      for (const mi of mis) { if (!mine.has(mi)) mine.set(mi, []); mine.get(mi).push(j); }
    });
    m.cells.forEach((c, i) => { if (!mine.has(i) && c.text) diffs.push({ my: i, mine: [i], kind: 'structure', why: 'lost' }); });
  }
  Object.assign(CMP, { diffs, their, mine, theirTo, how });
}
function cmpRefresh() {
  if (!CMP) return;
  if (!CMP.src.model) return cmpClose();
  cmpCompute();
  $$('#cmp-mode button').forEach(b => b.classList.toggle('on', b.dataset.cm === CMP.mode));
  const body = $('#cmp-body'), keep = [body.scrollTop, body.scrollLeft];
  body.innerHTML = rvTable(CMP.src.model, (c, j) => {
    const d = CMP.their.get(j), df = d >= 0 ? CMP.diffs[d] : null;
    let cls = c.header ? 'hd' : '';
    if (d === undefined) { if (CMP.mode !== 'boxes' || c.bbox) cls += ' nomatch'; }
    else if (df) cls += df.kind === 'structure' ? ' cs cs-' + df.why : ' cd' + (df.kind === 'box' ? ' bx' : '');
    if (CMP.selT.has(j)) cls += ' csel';
    return [cls, c.text];
  });
  body.scrollTop = keep[0]; body.scrollLeft = keep[1];
  const n = CMP.diffs.length, w = { text: 'text', boxes: 'box', structure: 'structure' }[CMP.mode];
  $('#cmp-count').textContent = n ? `${n} ${w} difference${n > 1 ? 's' : ''}` : `same ${w} as yours`;
  $('#cmp-count').title = 'Cells matched: ' + CMP.how;
  $('#cmp-take').hidden = CMP.mode === 'structure';
  $('#cmp-import').textContent = CMP.mode === 'structure' ? 'Import this structure…' : 'Import…';
  cmpMarkGrid(); cmpFollow(false); cmpOverlay();
}
/* Your cells that differ get a corner mark in the grid. */
function cmpMarkGrid() {
  $$('#grid td.cmp-d, #grid td.cmp-s, #grid td.cmp-lost').forEach(td => td.classList.remove('cmp-d', 'cmp-s', 'cmp-lost'));
  if (!CMP) return;
  for (const d of CMP.diffs) {
    const td = TD[d.my];
    if (td) td.classList.add(d.kind !== 'structure' ? 'cmp-d' : d.why === 'lost' ? 'cmp-lost' : 'cmp-s');
  }
}
/* Their cells for the cell you are on: outlined and scrolled into view; the line above says yours / theirs. */
function cmpFollow(scroll = true) {
  if (!CMP) return;
  const body = $('#cmp-body'), ai = activeIndex(), m = S.model;
  $$('td.ccur', body).forEach(td => td.classList.remove('ccur'));
  const tis = CMP.mine.get(ai) || [];
  tis.forEach((j, n) => { const td = $(`td[data-i="${j}"]`, body); if (td) { td.classList.add('ccur'); if (scroll && !n) cmpScrollTo(td); } });
  cmpDetail();
}
function cmpScrollTo(td) {
  const body = $('#cmp-body'), r = td.getBoundingClientRect(), b = body.getBoundingClientRect(), head = 24, side = 34;
  if (r.top < b.top + head || r.bottom > b.bottom) body.scrollTop += r.top - b.top - head - (b.height - head - r.height) / 2;
  if (r.left < b.left + side || r.right > b.right) body.scrollLeft += r.left - b.left - side - (b.width - side - r.width) / 2;
}
function cmpDetail(j) {
  if (!CMP) return;
  const m = S.model, sm = CMP.src.model, sel = cmpSelected();
  let html;
  if (j == null && sel.length > 1) {
    const t = sel.filter(d => d.kind !== 'structure').length;
    html = `<b>${sel.length} differences selected</b>` + (t ? ' · <kbd>Enter</kbd> or Take ← puts theirs in your table · <kbd>Esc</kbd> unselects' : ' · the structure is taken as a whole: Import this structure…');
  } else {
    const mi = j != null ? CMP.theirTo.get(j) : activeIndex(), c = mi != null ? m.cells[mi] : null;
    const k = j != null ? CMP.their.get(j) : CMP.diffs.findIndex(x => x.my === mi), d = k >= 0 ? CMP.diffs[k] : null;
    const matched = j != null ? CMP.their.has(j) : CMP.mine.has(mi);
    const ref = c ? `<b>${cellRef(c)}</b>` : `<b>their ${cellRef(sm.cells[j])}</b>`;
    if (d && d.kind === 'text') { const [x, y] = rvDiff(d.old, d.neu); html = `${ref} · yours ${x} → theirs ${y} · double-click, <kbd>Enter</kbd> or Take ← to take it`; }
    else if (d && d.kind === 'box') html = `${ref} · ${d.old ? 'their box is not at the same place' : 'no box of yours'} (theirs dashed on the image) · double-click, <kbd>Enter</kbd> or Take ← to take it`;
    else if (d) html = `${ref} · ` + { new: 'no cell of yours here', merged: `they merge ${(d.mine || []).map(x => cellRef(m.cells[x])).join(', ')}`, span: 'merged differently', lost: 'your text has no place in their table' }[d.why];
    else if (!c) html = `${ref} · no cell of yours here`;
    else if (!matched) html = `${ref} · not matched with ${esc(CMP.src.name)}`;
    else html = `${ref} · same as theirs` + (CMP.mode === 'text' ? ` “${esc(c.text)}”` : '');
  }
  $('#cmp-detail').innerHTML = html;
}
function cmpSelected() {
  if (!CMP) return [];
  const ks = new Set();
  for (const j of CMP.selT) { const d = CMP.their.get(j); if (d >= 0) ks.add(d); }
  return [...ks].map(k => CMP.diffs[k]);
}
function cmpSelect(js, add) {
  if (!add) CMP.selT = new Set();
  js.forEach(j => CMP.selT.add(j));
  $$('#cmp-body td[data-i]').forEach(td => td.classList.toggle('csel', CMP.selT.has(+td.dataset.i)));
  cmpOverlay(); cmpDetail();
}
/* Take their text (or box) for the differences given: one undo step, kept in started_from.mixed. */
function cmpTake(ds) {
  if (!CMP) return;
  ds = ds.filter(d => d.kind === 'text' || d.kind === 'box');
  if (!ds.length) return toast(CMP.mode === 'structure' ? 'The structure is taken as a whole: Import this structure… shows it first.' : 'Select a difference first: click a coloured cell on the right, or drag over several.', 4000);
  const src = CMP.src, part = ds[0].kind === 'text' ? 'text' : 'boxes', how = CMP.how;
  const ok = apply(part === 'text' ? 'cmp_text' : 'cmp_box', () => {
    for (const d of ds) {
      const c = S.model.cells[d.my];
      if (d.kind === 'text') { c.text = d.neu; c.padded = false; }
      else setBox(c, d.neu.bbox.slice(), d.neu.polygon ? d.neu.polygon.map(p => p.slice()) : null, 'model');
    }
    const sf = S.meta.started_from || {}, mixed = (sf.mixed || []).slice(), last = mixed[mixed.length - 1];
    if (last && last.via === 'compare' && last.part === part && last.source === src.name) mixed[mixed.length - 1] = Object.assign({}, last, { cells: last.cells + ds.length, time: new Date().toISOString() });
    else mixed.push({ part, source: src.name, cells: ds.length, how, via: 'compare', file: src.file || undefined, sha256: src.sha256 || undefined, time: new Date().toISOString() });
    S.meta.started_from = Object.assign({}, sf, { mixed });
    return part === 'text' ? 'text_take' : 'box_take';
  });
  if (ok) { CMP.selT = new Set(); cmpRefresh(); toast(`${part === 'text' ? 'Text' : 'Box'} of ${src.name} taken in ${ds.length} cell${ds.length > 1 ? 's' : ''}. Ctrl+Z undoes it.`); }
}
/* Their boxes on the image: in Boxes all the differences, else the cells selected on the right. */
function cmpOverlay() {
  const svg = $('#overlay');
  let g = $('g.cmp-ov', svg);
  if (!CMP) { if (g) g.remove(); return; }
  if (!g) { g = svgEl('g', {}, 'cmp-ov'); svg.appendChild(g); }
  const sm = CMP.src.model, out = [];
  const shape = (c, cls) => c.polygon && c.polygon.length > 2 ? `<polygon class="${cls}" points="${c.polygon.map(p => p.join(',')).join(' ')}"/>`
    : `<rect class="${cls}" x="${c.bbox[0]}" y="${c.bbox[1]}" width="${Math.max(1, c.bbox[2] - c.bbox[0])}" height="${Math.max(1, c.bbox[3] - c.bbox[1])}"/>`;
  sm.cells.forEach((c, j) => {
    if (!c.bbox) return;
    const d = CMP.their.get(j), sel = CMP.selT.has(j);
    if (sel) out.push(shape(c, 'cb sel'));
    else if (CMP.mode === 'boxes' && d >= 0) out.push(shape(c, 'cb'));
  });
  g.innerHTML = out.join('');
}
/* The panel: click a cell (Ctrl or Shift: add), drag over several, double-click takes one, Enter takes the selection. */
(() => {
  const body = $('#cmp-body');
  let drag = null;
  const cellOf = td => CMP.src.model.cells[+td.dataset.i];
  const inRect = (d) => {
    const R = rvRectOf(d), js = [];
    CMP.src.model.cells.forEach((c, j) => { if (rvHit(c, R)) js.push(j); });
    return js;
  };
  body.addEventListener('mousedown', e => {
    const td = e.target.closest('td[data-i]');
    body.focus({ preventScroll: true });
    if (!CMP || e.button !== 0 || !td) return;
    e.preventDefault();
    const c = cellOf(td), add = e.ctrlKey || e.shiftKey || e.metaKey;
    drag = { a: c, b: c, add, base: new Set(CMP.selT), j: +td.dataset.i, moved: false };
  });
  body.addEventListener('mouseover', e => {
    const td = e.target.closest('td[data-i]');
    if (!CMP || !td) return;
    if (drag) {
      const c = cellOf(td);
      if (c !== drag.b) { drag.b = c; drag.moved = true; CMP.selT = new Set(drag.add ? drag.base : []); cmpSelect(inRect(drag), true); }
    } else if (!CMP.selT.size) cmpDetail(+td.dataset.i);
  });
  body.addEventListener('mouseleave', () => { if (CMP && !drag) cmpDetail(); });
  document.addEventListener('mouseup', () => {
    if (!drag || !CMP) { drag = null; return; }
    const d = drag; drag = null;
    if (d.moved) return;
    const j = d.j;
    if (d.add) { if (CMP.selT.has(j)) CMP.selT.delete(j); else CMP.selT.add(j); cmpSelect([], true); return; }
    cmpSelect([j], false);
    const mi = CMP.theirTo.get(j);
    if (mi != null && S.model.cells[mi]) { const c = S.model.cells[mi]; setSel(c.r, c.c); renderSel(); }
    cmpDetail(j);
  });
  body.addEventListener('dblclick', e => {
    const td = e.target.closest('td[data-i]');
    if (!CMP || !td) return;
    const d = CMP.their.get(+td.dataset.i);
    if (d >= 0) cmpTake([CMP.diffs[d]]);
  });
  body.addEventListener('keydown', e => {
    if (!CMP) return;
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); cmpTake(cmpSelected().length ? cmpSelected() : cmpCurrent()); }
    else if (e.key === 'Escape' && CMP.selT.size) { e.preventDefault(); e.stopPropagation(); cmpSelect([], false); }
  });
})();
/* No selection: Enter takes the difference of the cell you are on. */
function cmpCurrent() { const ai = activeIndex(); return CMP.diffs.filter(d => d.my === ai); }
/* The rows and columns a set of boxes forms. The page skew is taken out (slope of the centres of side-by-side
   boxes), the box sides are grouped into lines (sides closer than about a third of a small box are one line),
   and the stretches between two lines that some box covers are the rows (columns). Each box gets the rows and
   columns between its sides: {items: [{box, r0, r1, c0, c1}], nr, nc}. */
function boxLattice(boxes) {
  if (!boxes.length) return null;
  const B = boxes.map(b => b.bbox), pct = (v, f) => { const w = v.slice().sort((a, b) => a - b); return w[Math.min(w.length - 1, Math.floor(f * w.length))]; };
  const med = v => pct(v, 0.5), ctr = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const H = med(B.map(b => b[3] - b[1])), W = med(B.map(b => b[2] - b[0]));
  const sh = [], sv = [];
  B.forEach((a, i) => B.forEach((b, j) => {
    if (i === j) return;
    const ca = ctr(a), cb = ctr(b);
    const vo = Math.min(a[3], b[3]) - Math.max(a[1], b[1]), ho = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    if (cb[0] > ca[0] && vo > 0.5 * Math.min(a[3] - a[1], b[3] - b[1]) && Math.abs(b[0] - a[2]) < 0.5 * W) sh.push((cb[1] - ca[1]) / (cb[0] - ca[0]));
    if (cb[1] > ca[1] && ho > 0.5 * Math.min(a[2] - a[0], b[2] - b[0]) && Math.abs(b[1] - a[3]) < 0.5 * H) sv.push((cb[0] - ca[0]) / (cb[1] - ca[1]));
  }));
  const kh = sh.length ? med(sh) : 0, kv = sv.length ? med(sv) : 0;
  const it = boxes.map((box, i) => { const b = B[i], c = ctr(b); return { box, t: b[1] - kh * c[0], b: b[3] - kh * c[0], l: b[0] - kv * c[1], r: b[2] - kv * c[1] }; });
  const axis = (lo, hi, small) => {
    const tol = Math.max(2, 0.35 * small), v = it.flatMap(x => [x[lo], x[hi]]).sort((a, b) => a - b), lines = [];
    let grp = [v[0]];
    for (let i = 1; i < v.length; i++) { if (v[i] - v[i - 1] > tol) { lines.push(med(grp)); grp = []; } grp.push(v[i]); }
    lines.push(med(grp));
    const near = x => lines.reduce((best, y, k) => (Math.abs(y - x) < Math.abs(lines[best] - x) ? k : best), 0);
    const span = it.map(x => { const a = near(x[lo]); let z = near(x[hi]); if (z <= a) z = a + 1; return [a, z]; });
    const used = new Array(lines.length).fill(false);  // stretch k: between lines k and k+1
    for (const [a, z] of span) for (let k = a; k < z && k < used.length; k++) used[k] = true;
    const idx = []; let n = 0;
    used.forEach((u, k) => { idx[k] = u ? n++ : -1; });
    return { n, span: span.map(([a, z]) => { const ks = []; for (let k = a; k < z; k++) if (idx[k] >= 0) ks.push(idx[k]); return [ks[0], ks[ks.length - 1]]; }) };
  };
  const R = axis('t', 'b', pct(B.map(b => b[3] - b[1]), 0.1)), C = axis('l', 'r', pct(B.map(b => b[2] - b[0]), 0.1));
  return { nr: R.n, nc: C.n, items: it.map((x, i) => ({ box: x.box, r0: R.span[i][0], r1: R.span[i][1], c0: C.span[i][0], c1: C.span[i][1] })) };
}
/* The boxes put on the cells of m by their place, the first row and column of boxes on A1. A box over several rows
   or columns merges those cells when `merge` (and no other box starts inside). Several boxes on one cell: their union. */
function placeBoxes(m, L, merge) {
  const groups = new Map();
  let dropped = 0, merged = 0, placed = 0;
  for (const x of (L ? L.items : [])) {
    if (x.r0 >= m.nRows || x.c0 >= m.nCols) { dropped++; continue; }
    const k = x.r0 + ',' + x.c0;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  if (merge) for (const [k, xs] of groups) {
    const r0 = xs[0].r0, c0 = xs[0].c0, r1 = Math.min(m.nRows - 1, Math.max(...xs.map(x => x.r1))), c1 = Math.min(m.nCols - 1, Math.max(...xs.map(x => x.c1)));
    if (r1 === r0 && c1 === c0) continue;
    let ok = true;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if ((r !== r0 || c !== c0) && groups.has(r + ',' + c)) ok = false;
    const sl = slotsOf(m), inside = new Set();
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) inside.add(m.cells[sl[r][c]]);
    if (!ok || [...inside].some(x => x.r < r0 || x.c < c0 || x.r + x.rs - 1 > r1 || x.c + x.cs - 1 > c1)) continue;
    const top = m.cells[sl[r0][c0]];
    m.cells = m.cells.filter(x => x === top || !inside.has(x));
    top.rs = r1 - r0 + 1; top.cs = c1 - c0 + 1;
    merged++;
  }
  const sl = slotsOf(m);
  for (const [k, xs] of groups) {
    const [r0, c0] = k.split(',').map(Number), c = m.cells[sl[r0][c0]], by = xs[0].box.by || 'model';
    if (xs.length === 1) setBox(c, xs[0].box.bbox, xs[0].box.polygon, by);
    else setBox(c, bboxOf(xs.flatMap(x => [[x.box.bbox[0], x.box.bbox[1]], [x.box.bbox[2], x.box.bbox[3]]])), null, by);
    placed += xs.length;
  }
  return { placed, dropped, merged };
}
/* New table: remove the whole annotation and start from an empty grid of the size chosen. The boxes (this table's,
   or a source's) can be put on the new grid by their place. */
function newTableDialog() {
  const m = S.model, opts = [];
  const own = m.cells.filter(c => c.bbox).map(c => ({ bbox: c.bbox, polygon: c.polygon, by: c.box_by }));
  if (own.length) opts.push(['own', `Keep the ${own.length} boxes of this table`, own]);
  for (const [src, sm] of (S.detail && S.batch ? boxSources() : [])) opts.push(['src:' + src, `The boxes of ${src}`, sm.cells.filter(c => c.bbox).map(c => ({ bbox: c.bbox, polygon: c.polygon, by: 'model' }))]);
  const lat = new Map(opts.map(([v, , bs]) => [v, boxLattice(bs)]));
  openModal(`<h2>New table</h2>
    <p>Removes the whole annotation of this table (structure, text and boxes) and starts from an empty grid. You can undo with Ctrl+Z.</p>
    <div class="row"><label>Rows <input type="number" id="nt-rows" min="1" max="500" value="${m.nRows}"></label>
    <label>Columns <input type="number" id="nt-cols" min="1" max="200" value="${m.nCols}"></label>
    <button type="button" id="nt-size" hidden></button></div>
    <div class="choices">
      ${opts.map(([v, label], i) => `<label><input type="radio" name="nt-box" value="${esc(v)}"${i === 0 ? ' checked' : ''}> ${esc(label)}, put on the new grid by their place (they form ${lat.get(v).nr} rows × ${lat.get(v).nc} columns)</label>`).join('')}
      <label><input type="radio" name="nt-box" value="none"${opts.length ? '' : ' checked'}> No boxes</label>
    </div>
    <label id="nt-merge-l"><input type="checkbox" id="nt-merge" checked> Merge the cells that one box covers (a box over 2 rows makes a merged cell)</label>
    <p class="muted" id="nt-hint">The boxes start at A1. Off by some rows or columns? Click one box, Move to cell…, type its cell and choose "all the boxes": the others follow.</p>
    <div class="actions"><button data-close>Cancel</button><button class="primary danger-bg" id="nt-ok">Remove all and create the grid</button></div>`);
  const pick = () => { const r = $('input[name=nt-box]:checked'); return r ? r.value : 'none'; };
  const upd = () => {
    const L = lat.get(pick()), b = $('#nt-size');
    b.hidden = !L || (+$('#nt-rows').value === L.nr && +$('#nt-cols').value === L.nc);
    if (L) b.textContent = `Use ${L.nr} × ${L.nc} (the size the boxes form)`;
    $('#nt-merge-l').hidden = $('#nt-hint').hidden = !L;
  };
  $('#nt-size').onclick = () => { const L = lat.get(pick()); $('#nt-rows').value = L.nr; $('#nt-cols').value = L.nc; upd(); };
  $$('#modal input[name=nt-box], #nt-rows, #nt-cols').forEach(el => el.addEventListener('input', upd));
  $$('#modal input[name=nt-box]').forEach(el => el.addEventListener('change', upd));
  upd();
  $('#nt-rows').select();
  $('#nt-ok').onclick = () => {
    const r = clamp(parseInt($('#nt-rows').value, 10) || 1, 1, 500), c = clamp(parseInt($('#nt-cols').value, 10) || 1, 1, 200);
    const v = pick(), L = lat.get(v), merge = $('#nt-merge').checked;
    closeModal();
    let res = null;
    apply('restart', () => { S.model = emptyModel(r, c); if (L) res = placeBoxes(S.model, L, merge); S.sel = { ar: 0, ac: 0, er: 0, ec: 0 }; return 'new_table'; });
    const src = v === 'own' ? 'this table' : v.startsWith('src:') ? v.slice(4) : null;
    S.meta.started_from = Object.assign({ source: null, mode: 'empty', time: new Date().toISOString() },
      res && res.placed ? { mixed: [{ part: 'boxes', source: src, cells: res.placed, how: 'by their place' }] } : {});
    setImportNotes([]); renderSourceSelect();
    toast(`New ${r} × ${c} table.` + (res ? ` ${plural(res.placed, 'box')} put on it by their place, from A1` + (res.merged ? `, ${plural(res.merged, 'merged cell')}` : '')
      + (res.dropped ? `; ${res.dropped} outside the grid left out` : '') + '. Off by some rows or columns? Click a box, Move to cell…, "all the boxes".' : ''), 9000);
  };
}
function emptyGridDialog(first) {
  openModal(`<h2>${first ? 'No pre-annotation for this table' : 'Start from an empty grid'}</h2>
    <p>${first ? 'Set the size of the table. You can add or delete rows and columns later.' : 'The table on the right is replaced by an empty grid. You can undo with Ctrl+Z.'}</p>
    <div class="row"><label>Rows <input type="number" id="eg-rows" min="1" max="500" value="${first ? 10 : S.model.nRows}"></label>
    <label>Columns <input type="number" id="eg-cols" min="1" max="200" value="${first ? 5 : S.model.nCols}"></label></div>
    <div class="actions"><button data-close>${first ? 'Keep 10 × 5' : 'Cancel'}</button><button class="primary" id="eg-ok">Create grid</button></div>`);
  $('#eg-rows').select();
  $('#eg-ok').onclick = () => {
    const r = clamp(parseInt($('#eg-rows').value, 10) || 1, 1, 500), c = clamp(parseInt($('#eg-cols').value, 10) || 1, 1, 200);
    closeModal();
    apply('restart', () => { S.model = emptyModel(r, c); S.sel = { ar: 0, ac: 0, er: 0, ec: 0 }; return 'restart'; });
    S.meta.started_from = { source: null, mode: 'empty', time: new Date().toISOString() };
    setImportNotes([]); renderSourceSelect();
  };
}

// ------------------------------------------------------------------------------------------
// Annotator, help, modal, toast

function chooseAnnotator(cancellable) {
  const names = S.batch.annotators || [];
  openModal(`<h2>Who is annotating?</h2><p>Your work is saved under your name, in <code>annotations/&lt;name&gt;/</code>. Each annotator has their own files.</p>
    ${names.length ? `<div class="who-grid">${names.map(n => `<button data-who="${escAttr(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
    ${S.batch.allow_other_names !== false || !names.length ? `<p>${names.length ? 'Not in the list? ' : ''}Type a short name (lowercase letters, digits, - or _):</p>
    <div class="row"><input type="text" id="who-new" maxlength="32" placeholder="e.g. marie"><button class="primary" id="who-ok">OK</button></div>` : ''}
    ${cancellable ? '<div class="actions"><button data-close>Cancel</button></div>' : ''}`, { closable: cancellable });
  $$('#modal [data-who]').forEach(b => { b.onclick = () => setAnnotator(b.dataset.who); });
  const ok = $('#who-ok');
  if (ok) {
    ok.onclick = () => {
      const v = $('#who-new').value.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(v)) return toast('Use lowercase letters, digits, - or _ only.');
      setAnnotator(v);
    };
    $('#who-new').addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); });
  }
}
async function setAnnotator(name) {
  await leaveTask();
  S.annotator = name; LS.set('annotator', name); closeModal(true);
  await showHome();
  if (!LS.get('seenIntro', false)) quickStart();
}
$('#who-home').addEventListener('click', () => chooseAnnotator(true));
$('#who-edit').addEventListener('click', () => chooseAnnotator(true));

// Help: a panel that stays open while you work. Tabs by topic, a search, keys drawn as keys. Move it by its title
// bar, resize it from any edge or corner, ⇥ puts it back on the right side, A− A+ set its text size (all remembered).
const HP = { tab: LS.get('helptab', 'start'), q: '', drag: null };
const hpCell = (cls, text = '') => `<span class="hp-cell ${cls}">${esc(text)}</span>`;
function helpSections() {
  const boxes = boxPolicy() !== 'off';
  const secs = [
    { id: 'start', title: 'Start here', note: 'Correct the table until it matches the image: first the structure (rows, columns, merged cells), then the text of every cell. Your work is saved by itself as you go.', items: [
      ['↑↓←→', 'Move between cells'],
      ['type', 'Replace the text of the cell; {Enter} saves it and goes down'],
      ['Enter | F2 | double-click', 'Edit the text that is there'],
      ['Shift+↑↓←→ then Ctrl+M', 'Merge cells; {Ctrl+Shift+M} splits them'],
      ['right-click', 'Insert or delete rows and columns, header, unclear'],
      ['Ctrl+Z', 'Undo anything'],
      ['Ctrl+Enter', 'This table is done: open the next one'],
      ...(boxes ? [['Ctrl+E', 'Box mode: draw or fix the box of each cell on the image']] : []),
      ['Ctrl+/ | [?]', 'Open or close this help'],
    ] },
    { id: 'move', title: 'Move and select', items: [
      ['↑↓←→', 'Move'],
      ['Tab | Shift+Tab', 'Next / previous cell'],
      ['Shift+↑↓←→ | drag', 'Select several cells'],
      ['Shift+Space', 'Select whole rows'],
      ['Ctrl+Space', 'Select whole columns'],
      ['Ctrl+A', 'Select all'],
      ['Ctrl+↑↓←→', 'Jump to the edge'],
      ['PageUp | PageDown', '10 rows up / down'],
      ['Ctrl+Home | Ctrl+End', 'First / last cell'],
    ] },
    { id: 'text', title: 'Text', items: [
      ['type', 'Replace the text of the cell'],
      ['Enter | F2 | double-click', 'Edit the text that is there'],
      ['Enter', 'Save the text and go down'],
      ['Tab', 'Save the text and go right'],
      ['Esc', 'Cancel the edit'],
      ['Delete', 'Clear the selected cells'],
      ['[Ω Symbols ▾]', 'Uncommon symbols: fractions, astronomy, signs, medieval abbreviations', 'Click one to put it in the cell (while you edit, at the cursor). A fraction goes in as its LaTeX formula; a fraction character typed or pasted becomes one too. Find one by name or code (moon, fraction, 263D); add your own at the bottom, or with + on a symbol.'],
      ['Alt+1…9', 'The first nine symbols (the batch’s, then yours)'],
      ['[x²] | Ctrl+.', 'Superscript: select characters while you edit, then click or press', 'Saved as <sup>…</sup> and shown raised; again on the same characters takes it off. A raised decimal (32 with a small 5) is typed as written: 32<sup>5</sup>; the scorer reads it as 32.5. With nothing selected, it starts a superscript at the cursor.'],
      ['[x₂] | Ctrl+,', 'Subscript, the same way', 'Saved as <sub>…</sub> and shown lowered.'],
      ['[ƒ(x)]', 'Formula: LaTeX between $…$, drawn as a formula', 'Select it while you edit and click, or type the $ yourself: $\\frac12$, $x^2$, $\\sqrt2$, $\\alpha+\\beta$. Hover a formula to see its LaTeX; one with an error is red. A $ with a space after it, or a closing $ with a digit after it, stays a dollar sign; \\$ always is one. Only for real formulas: symbols go through Ω Symbols, raised characters through x².'],
      ['Ctrl+C | Ctrl+V', 'Copy / paste text, also from and to Excel', 'One value pasted on a selection fills every cell.'],
    ] },
    { id: 'structure', title: 'Structure', items: [
      ['Ctrl+M', 'Merge the selected cells'],
      ['Ctrl+Shift+M', 'Split a merged cell'],
      ['Ctrl+Shift+↑ | Ctrl+Shift+↓', 'Insert a row above / below'],
      ['Ctrl+Shift+← | Ctrl+Shift+→', 'Insert a column left / right'],
      ['Ctrl+−', 'Delete the selected rows or columns', 'When it is not clear which, it asks: {R} rows or {C} columns.'],
      ['Ctrl+− then L/U | [Cells ✕]', 'Delete the selected cells: {L} the cells on the right move left, {U} the cells below move up', 'The boxes stay where they are on the image, unless you tick “the boxes move with their text”. A merged cell only partly selected must be split first.'],
      ['Ctrl+B', 'Header cell on / off'],
      ['Ctrl+U', 'Unclear reading on / off'],
      ['[New table…]', 'Start again from an empty grid of the size you choose', 'The boxes (yours or a model’s) can be kept: they are put on the new grid by their place, from A1. Off by some rows or columns: click a box, [Move to cell…], “all the boxes”.'],
      ['right-click', 'All of the above, in a menu'],
    ] },
    { id: 'table', title: 'Table and import', items: [
      ['Ctrl+Z | Ctrl+Y', 'Undo / redo (everything, structure too)'],
      ['Ctrl+Enter | [Done ✓]', 'Done, next table', 'It warns you about empty rows or columns first.'],
      ['Ctrl+S', 'Save now (it also saves by itself)'],
      ['Ctrl+Alt+PageDown | Ctrl+Alt+PageUp', 'Next / previous table, without marking done'],
      ['[Note]', 'Write a note on this table, or flag it for discussion'],
      ['[Skip…]', 'Skip this table (not a table, unreadable…), with a reason'],
      ['[Import ▾]', 'Take the text, the structure or the boxes of another source: a model of the batch, or a file', 'Only the text, the structure and text, only the structure (your text goes into its cells) or only the boxes. You first see the image, your table and the table after the import: take all the changes or click the ones to leave out. Drag over several, then {Enter}: if any is taken, all are left out; if none, all are taken. Files: annotation JSON, HTML table, PAGE XML, CSV / TSV.'],
      ['[Compare ▾]', 'Another source next to your table while you edit', 'Its text, structure or boxes. The cells that differ are coloured on the right and marked in your table; it follows the cell you are on and your edits. Take a difference: click it (or drag over several), then {Enter}, [Take ←] or double-click.'],
    ] },
    { id: 'image', title: 'Image', items: [
      ['wheel', 'Scroll'],
      ['Ctrl+wheel', 'Zoom'],
      ['drag', 'Move the image'],
      ['click', 'Pin the red row guide (click again to remove it)'],
      ['[Fit] | [Width]', 'The whole image / as wide as the pane'],
      ['[☀]', 'Brightness and contrast'],
      ['[⇆ Layout]', 'Image beside or above the table'],
    ] },
  ];
  if (boxes) secs.push({ id: 'boxes', title: 'Boxes', note: 'Every cell gets a box on the image. {Ctrl+E} turns box mode on and off.', items: [
    ['drag on the image', 'Draw the box of the selected cell', 'It replaces its box; then the next cell without a box is selected. With nothing selected: a new box, for the cell at that place.'],
    ['click a box | Shift+click', 'Select its cell / add it to the selection'],
    ['drag a side, a corner or inside', 'Resize or move the box', 'A border shared with the next box moves for both.'],
    ['Alt+drag a side', 'Move the side of this box alone'],
    ['[↖ Select]', 'Select boxes with the mouse', 'Drag a rectangle to select every box it touches; {Ctrl}+click adds or takes out a box. Drag one of the selected boxes: they all move; {Delete} removes them. Click an empty spot (or {Esc}): nothing selected; then [▭ Box] or [⬠ Polygon] draws new boxes, each for the cell at that place.'],
    ['[⬠ Polygon]', 'Click the points of a tilted cell instead of dragging a box', 'Close on the first point, double-click or {Enter}; {Backspace} removes the last point. Double-click a point to remove it, an edge to add one.'],
    ['Ctrl+M', 'Merge the selected cells: their boxes become one'],
    ['[Move to cell…]', 'Give the box of the selected cell to another cell', 'Type the cell (e.g. E5) and {Enter}, or click it in the table. “The boxes after it” or “all the boxes” shifts the others the same way (B3 → C3: one column right).'],
    ['[magnet]', 'Sides stick to the boxes next to them, so boxes touch without a gap', 'When closer than 8 screen pixels; polygon points stick to corners and edges. A side shared that way moves for both; with {Alt}, alone. Untick it to leave a gap.'],
    ['[names]', 'Write the cell name in each box, to check them'],
    ['right-click a box', 'Merge, move to another cell, fit, remove; a new row or column with boxes of the same size'],
    ['Space+drag | middle button', 'Move the image'],
    ['Delete', 'Remove the box of the selected cells'],
    ['Esc', 'Cancel the box being drawn'],
    ['[Grid]', 'Give every cell its box at once, from lines on the row and column borders', 'Start from the cell boxes (model output) or from a uniform grid you move by hand. The rows × columns fields set its size; another size than the table: Make boxes resizes the table, after asking. Drag the outer border: the inner lines follow; with {Alt}, alone. Drag a round end to tilt a line. {Ctrl+Z} undoes Snap, Even and line moves while the grid is open.'],
    ['[▦ Back to grid]', 'After Make boxes: open the grid again with the same lines', 'Move them and Make boxes again (boxes fixed by hand are kept with “keep my boxes”). {Ctrl+Z} right after Make boxes does the same.'],
    ['[Fit to ink]', 'Shrink the box to the writing inside it', 'Ruled lines are ignored; it never grows a box.'],
    ['[More ▾]', 'Take the boxes of a model, or remove all boxes'],
    ['[🎨]', 'The colours of the boxes, of the selected box and of the grid lines'],
  ] });
  secs.push({ id: 'marks', title: 'Marks and colours', note: 'What the colours and corners on the cells of your table mean.', items: [
    [hpCell('act', 'B3') + hpCell('sel'), 'Blue outline: the cell you are on; light blue: the other selected cells'],
    [hpCell('ed', '12'), 'Green corner, top left: you changed this cell', 'Its text or its structure. Only a reminder: [Changes], at the bottom right of the table, hides or shows it.'],
    [hpCell('unc', '12'), 'Orange outline and ?: unclear reading, {Ctrl+U}'],
    [hpCell('h', 'Ages'), 'Grey and bold: header cell, {Ctrl+B}'],
    [hpCell('pad'), 'Striped: an empty cell added to fill a short row of the source', 'Check that this row really has a cell there.'],
    [hpCell('q', '"'), 'Purple ": a ditto mark'],
    ...(boxes ? [[hpCell('nb', '12'), 'Orange corner, top right, in box mode: this cell still needs its box']] : []),
    [hpCell('cmp-d', '12'), 'Orange corner, top right, with [Compare ▾] open: differs from the source you compare with'],
    [hpCell('cmp-s', '12'), 'Purple corner: the structure differs there'],
    [hpCell('cmp-lost', '12'), 'Red corner: your text has no place in their table'],
  ] });
  secs.push({ id: 'tips', title: 'Tips and tricks', html: S.tips ? `<div class="md">${md(S.tips)}</div>` : '<p class="hp-none">No tips (static/tips.md is missing).</p>', text: S.tips || '' });
  return secs;
}
function hpKeys(s) {  // 'Ctrl+M | drag' → key chips; [Label] = a button; lowercase words = the mouse
  if (s.startsWith('<')) return s;
  return s.split(' | ').map(alt => alt.split(' then ').map(seg => {
    const b = seg.match(/^\[(.*)\]$/);
    if (b) return `<span class="hp-btn">${esc(b[1])}</span>`;
    return seg.split('+').map(part => {
      if (part.length > 1 && /^[a-z]/.test(part)) return `<span class="hp-mouse">${esc(part)}</span>`;
      if (part.length > 1 && part.includes('/')) return part.split('/').map(x => `<kbd>${esc(x)}</kbd>`).join('<span class="hp-sep">/</span>');
      return `<kbd${/^[↑↓←→]{2,}$/.test(part) ? ' class="arr"' : ''}>${esc(part)}</kbd>`;
    }).join('<span class="hp-sep">+</span>');
  }).join('<span class="hp-or">then</span>')).join('<span class="hp-or">or</span>');
}
function hpFmt(s) {  // {keys}, [button], **bold** in a line of help
  return String(s || '').split(/(\{[^}]+\}|\[[^\]]+\]|\*\*[^*]+\*\*)/).map(p =>
    p.startsWith('{') && p.endsWith('}') ? hpKeys(p.slice(1, -1)) : p.startsWith('[') && p.endsWith(']') ? hpKeys(p)
      : p.startsWith('**') && p.length > 4 ? `<b>${esc(p.slice(2, -2))}</b>` : esc(p)).join('');
}
const hpPlain = it => (it[0].startsWith('<') ? '' : it[0]).concat(' ', it[1], ' ', it[2] || '').replace(/[{}[\]*]/g, '').toLowerCase();
function hpItem(it) {
  return `<div class="hp-item"><div class="hp-keys">${hpKeys(it[0])}</div><div class="hp-text"><div class="hp-sum">${hpFmt(it[1])}</div>${it[2] ? `<div class="hp-more">${hpFmt(it[2])}</div>` : ''}</div></div>`;
}
function helpOpen(tab) {
  const p = $('#help');
  if (tab) { HP.tab = tab; HP.q = ''; LS.set('helptab', tab); }
  if (p.hidden) {
    p.innerHTML = `<div class="hp-head" title="Drag to move the help">
        <b>Help</b>
        <input id="hp-find" type="search" placeholder="Search: merge, box, symbol…" spellcheck="false" autocomplete="off">
        <span class="hp-tools"><button data-hp="font-" title="Smaller text">A−</button><button data-hp="font+" title="Larger text">A+</button><button data-hp="side" title="Back to the right side, full height">⇥</button><button data-hp="close" class="icon" title="Close (Esc or Ctrl+/)">✕</button></span>
      </div>
      <nav class="hp-tabs"></nav>
      <div class="hp-body"></div>
      <div class="hp-foot">Keeps open while you work. Drag the title bar to move it, an edge or a corner to resize it.</div>
      ${['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map(h => `<i class="hp-h hp-${h}" data-h="${h}"></i>`).join('')}`;
    p.hidden = false;
    helpPlace(LS.get('helpbox', null));
    p.style.setProperty('--hp-font', LS.get('helpfont', 14) + 'px');
    const b = $('[data-op="help"]'); if (b) b.classList.add('on');
  }
  $('#hp-find').value = HP.q;
  renderHelp();
}
function helpClose() {
  const p = $('#help');
  if (p.hidden) return;
  const inside = p.contains(document.activeElement);
  p.hidden = true; p.innerHTML = ''; HP.drag = null;
  const b = $('[data-op="help"]'); if (b) b.classList.remove('on');
  if (inside && S.view === 'edit') $('#gridwrap').focus({ preventScroll: true });
}
function helpToggle(tab) { if ($('#help').hidden) helpOpen(tab); else helpClose(); }
function renderHelp() {
  const p = $('#help');
  if (p.hidden) return;
  const secs = helpSections(), words = HP.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!secs.some(s => s.id === HP.tab)) HP.tab = 'start';
  const hit = it => words.every(w => hpPlain(it).includes(w));
  const textHits = s => {  // the lines (list items, paragraphs) of a text tab that hold every word
    if (!s.text || !words.every(w => s.text.toLowerCase().includes(w))) return [];
    const d = document.createElement('div'); d.innerHTML = s.html;
    return [...d.querySelectorAll('li, p')].filter(el => words.every(w => el.textContent.toLowerCase().includes(w))).map(el => el.innerHTML);
  };
  const count = s => s.items ? s.items.filter(hit).length : textHits(s).length;
  p.querySelector('.hp-tabs').innerHTML = secs.map(s => {
    const n = words.length ? count(s) : 0;
    return `<button data-tab="${s.id}" class="${!words.length && s.id === HP.tab ? 'on' : ''}${words.length && !n ? ' zero' : ''}">${esc(s.title)}${words.length && n ? ` <small>${n}</small>` : ''}</button>`;
  }).join('');
  const body = p.querySelector('.hp-body');
  if (words.length) {
    let html = secs.filter(s => s.items).map(s => { const l = s.items.filter(hit); return l.length ? `<h3>${esc(s.title)}</h3>` + l.map(hpItem).join('') : ''; }).join('');
    for (const s of secs.filter(x => !x.items)) {
      const l = textHits(s);
      if (l.length) html += `<h3>${esc(s.title)} <button class="hp-open" data-tab="${s.id}">Open</button></h3><ul class="hp-found">${l.map(x => `<li>${x}</li>`).join('')}</ul>`;
    }
    body.innerHTML = html || `<p class="hp-none">Nothing found for “${esc(HP.q.trim())}”. Try another word, or a key such as Ctrl+M.</p>`;
    hpMark(body, words);
  } else {
    const s = secs.find(x => x.id === HP.tab);
    body.innerHTML = (s.note ? `<p class="hp-note">${hpFmt(s.note)}</p>` : '') + (s.html || s.items.map(hpItem).join(''));
  }
}
function hpMark(root, words) {  // highlight the words searched for
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  for (let n of nodes) {
    if (n.parentNode.closest('h3, .hp-cell, button')) continue;
    for (;;) {
      const t = n.nodeValue.toLowerCase();
      let at = -1, len = 0;
      for (const x of words) { const i = t.indexOf(x); if (i >= 0 && (at < 0 || i < at)) { at = i; len = x.length; } }
      if (at < 0) break;
      const mid = n.splitText(at), rest = mid.splitText(len), m = document.createElement('mark');
      m.textContent = mid.nodeValue; mid.replaceWith(m); n = rest;
    }
  }
}
function helpDefaultBox() {
  const tb = $('#topbar'), top = Math.round(tb && tb.offsetParent ? tb.getBoundingClientRect().bottom : 8) + 6;
  const w = Math.min(560, Math.max(380, Math.round(innerWidth * 0.36)));
  return { x: innerWidth - w - 8, y: top, w, h: innerHeight - top - 8 };
}
function helpPlace(b) {
  b = b || helpDefaultBox();
  const W = innerWidth, H = innerHeight;
  const w = clamp(b.w, Math.min(320, W - 16), W - 16), h = clamp(b.h, Math.min(220, H - 16), H - 16);
  Object.assign($('#help').style, { left: clamp(b.x, 0, W - w) + 'px', top: clamp(b.y, 0, H - h) + 'px', width: w + 'px', height: h + 'px' });
}
function helpBox() { const r = $('#help').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
$('#help').addEventListener('click', e => {
  const t = e.target.closest('[data-tab]');
  if (t) { HP.tab = t.dataset.tab; HP.q = ''; LS.set('helptab', HP.tab); $('#hp-find').value = ''; renderHelp(); $('#help .hp-body').scrollTop = 0; return; }
  const a = e.target.closest('[data-hp]');
  if (!a) return;
  const op = a.dataset.hp;
  if (op === 'close') helpClose();
  else if (op === 'side') { LS.set('helpbox', null); helpPlace(null); }
  else {
    const f = clamp(LS.get('helpfont', 14) + (op === 'font+' ? 1 : -1), 11, 22);
    LS.set('helpfont', f); $('#help').style.setProperty('--hp-font', f + 'px');
  }
});
$('#help').addEventListener('input', e => { if (e.target.id === 'hp-find') { HP.q = e.target.value; renderHelp(); } });
$('#help').addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.id === 'hp-find' && e.target.value) {  // Esc first clears the search
    e.preventDefault(); e.stopPropagation(); e.target.value = ''; HP.q = ''; renderHelp(); return;
  }
  if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === '/')) { e.preventDefault(); e.stopPropagation(); helpClose(); }
});
$('#help').addEventListener('mousedown', e => {
  const h = e.target.closest('.hp-h');
  if (!h && e.target.closest('button')) { e.preventDefault(); return; }  // the grid keeps the keyboard
  if (!h && !(e.target.closest('.hp-head') && !e.target.closest('input'))) return;
  e.preventDefault();
  HP.drag = { h: h ? h.dataset.h : 'move', x: e.clientX, y: e.clientY, r: helpBox() };
  document.body.classList.add('hp-dragging');
});
document.addEventListener('mousemove', e => {
  const d = HP.drag;
  if (!d) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y, o = d.r, b = { ...o };
  if (d.h === 'move') { b.x = o.x + dx; b.y = o.y + dy; }
  else {
    const MW = Math.min(320, innerWidth - 16), MH = Math.min(220, innerHeight - 16);
    if (d.h.includes('e')) b.w = o.w + dx;
    if (d.h.includes('s')) b.h = o.h + dy;
    if (d.h.includes('w')) { b.w = Math.max(MW, Math.min(o.w - dx, o.x + o.w)); b.x = o.x + o.w - b.w; }
    if (d.h.includes('n')) { b.h = Math.max(MH, Math.min(o.h - dy, o.y + o.h)); b.y = o.y + o.h - b.h; }
  }
  helpPlace(b);
});
document.addEventListener('mouseup', () => {
  if (!HP.drag) return;
  HP.drag = null; document.body.classList.remove('hp-dragging');
  LS.set('helpbox', helpBox());
});
window.addEventListener('resize', () => { if (!$('#help').hidden) helpPlace(LS.get('helpbox', null)); });
function quickStart() {
  LS.set('seenIntro', true);
  openModal(`<h2>Quick start</h2>
    <p>Each table comes pre-filled by a model. Correct it until it matches the image: first the structure (rows, columns, merged cells), then the text of every cell.</p>
    <div class="help" style="columns:1"><table>
    <tr><td><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></td><td>move between cells</td></tr>
    <tr><td>type</td><td>replace the text of the cell; <kbd>Enter</kbd> saves it and goes down</td></tr>
    <tr><td><kbd>Enter</kbd> / double-click</td><td>edit the text that is there</td></tr>
    <tr><td><kbd>Shift</kbd>+arrows, then <kbd>Ctrl+M</kbd></td><td>merge cells (<kbd>Ctrl+Shift+M</kbd> splits)</td></tr>
    <tr><td>right-click</td><td>insert or delete rows and columns, header, unclear</td></tr>
    <tr><td><kbd>Ctrl+Z</kbd></td><td>undo anything</td></tr>
    <tr><td><kbd>Ctrl+Enter</kbd></td><td>table done, open the next one</td></tr>
    ${boxPolicy() === 'off' ? '' : '<tr><td><kbd>Ctrl+E</kbd></td><td>box mode: draw or fix the box of each cell on the image</td></tr>'}
    </table></div>
    <p>Your work is saved by itself as you go. On the image: <kbd>Ctrl</kbd>+wheel zooms, click pins a red line to follow a row. All the keys, what the colours mean: <kbd>Ctrl+/</kbd> or the <b>?</b> button (it stays open beside your work).</p>
    <div class="actions"><button class="primary" data-close>Start</button></div>`);
}
function md(text) {  // tiny Markdown: headings, lists, bold, code, paragraphs (wrapped lines join their item)
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<"']+[^\s<"'.,;:)])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');  // web links
  const blocks = [];
  for (const line of text.split('\n')) {
    const h = line.match(/^(#{1,3})\s+(.*)/), li = line.match(/^\s*[-*]\s+(.*)/), last = blocks[blocks.length - 1];
    if (h) blocks.push({ t: 'h', n: h[1].length + 1, s: h[2] });
    else if (li) blocks.push({ t: 'li', s: li[1] });
    else if (!line.trim()) blocks.push({ t: 'blank' });
    else if (last && (last.t === 'p' || (last.t === 'li' && /^\s/.test(line)))) last.s += ' ' + line.trim();
    else blocks.push({ t: 'p', s: line.trim() });
  }
  const out = []; let list = false;
  for (const b of blocks) {
    if (b.t !== 'li' && list) { out.push('</ul>'); list = false; }
    if (b.t === 'h') out.push(`<h${b.n}>${inline(b.s)}</h${b.n}>`);
    else if (b.t === 'li') { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(b.s)}</li>`); }
    else if (b.t === 'p') out.push(`<p>${inline(b.s)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

let modalOpts = {};
function openModal(html, opts = {}) {
  modalOpts = opts;
  const m = $('#modal');
  m.className = opts.cls || (opts.wide ? 'wide' : '');
  m.innerHTML = html;
  $('#modal-back').hidden = false;
  $$('[data-close]', m).forEach(b => { b.onclick = () => closeModal(); });
  const first = $('input, textarea, button.primary', m);
  if (first) first.focus({ preventScroll: true });
  m.scrollTop = 0;
}
function closeModal(force) {
  if (modalOpts.closable === false && !force) return;
  const done = modalOpts.onClose;
  modalOpts = {};
  $('#modal-back').hidden = true; $('#modal').innerHTML = '';
  if (done) done();
  if (S.view === 'edit') $('#gridwrap').focus({ preventScroll: true });
}
$('#modal-back').addEventListener('mousedown', e => { if (e.target.id === 'modal-back') closeModal(); });
let toastTimer = null;
function toast(html, ms = 2600, raw = false) {
  const t = $('#toast');
  t.innerHTML = raw ? html : esc(html);
  t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('#toast').hidden = true; pendingDelete = false; }
function showBanner(text, err) { const b = $('#banner'); b.textContent = text; b.className = err ? 'err' : ''; b.hidden = false; }
function hideBanner() { $('#banner').hidden = true; }

// Home view events
$('#task-table').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) openTask(tr.dataset.id); });
$('#btn-continue').addEventListener('click', () => { const t = nextTodo(null); if (t) openTask(t.table_id); });
$$('input[name=filter]').forEach(r => r.addEventListener('change', () => { S.filter = r.value; LS.set('filter', r.value); renderHome(); }));
$('#search').addEventListener('input', e => { S.search = e.target.value; renderHome(); });

window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!S.batch || !S.annotator) return;
  if (id && id !== S.tid && S.tasks.some(t => t.table_id === id)) openTask(id);
  else if (!id && S.view === 'edit') showHome();
});

// ------------------------------------------------------------------------------------------
// Start

(async function init() {
  document.documentElement.style.setProperty('--cell-font', LS.get('font', 14) + 'px');
  $('#guide-on').checked = LS.get('guide', true);
  fetch('static/tips.md').then(r => r.ok ? r.text() : '').then(t => { S.tips = t; renderHelp(); }).catch(() => {});
  try { S.batch = await api('/api/batch'); }
  catch (e) { document.body.innerHTML = '<p style="padding:30px">Cannot reach the annotation server. Is the black window (annotate.py) still open?</p>'; return; }
  document.title = S.batch.name + ' · Table annotation';
  const known = S.batch.annotators || [];
  if (!S.annotator || (known.length && S.batch.allow_other_names === false && !known.includes(S.annotator))) {
    $('#home').hidden = false;
    $('#batch-name').textContent = S.batch.name;
    return chooseAnnotator(false);
  }
  const hash = decodeURIComponent(location.hash.slice(1));
  await showHome(!!hash);
  if (!LS.get('seenIntro', false)) quickStart();
  if (hash && S.tasks.some(t => t.table_id === hash)) openTask(hash);
})();
