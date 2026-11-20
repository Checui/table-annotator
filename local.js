/* Local-folder mode of the table annotation tool: the tool as a plain web page, with no server.

   Loaded before app.js on the website (build_site.py puts it there). It answers the calls that app.js makes to
   annotate.py (/api/batch, /api/tasks, /api/task/<id>, PUT /api/annotation/<id>, /img/<id>, /static/...) from:
   - a batch folder that the person opens on their own computer (File System Access API: Chrome or Edge). The page
     reads the images and the pre-annotations there and saves into annotations/<name>/ of that folder, exactly as
     annotate.py does (same files, same JSON, same _log.jsonl and _history/). Nothing is uploaded anywhere.
   - or the example batch shipped with the website (read only; changes are kept in memory until the page reloads).
   app.js is not changed: it talks to this file as if it were the server. */
(function () {
  'use strict';

  const TOOL_VERSION = "0.2.0";            // filled in by build_site.py, from annotate.py
  const DEFAULT_CHARS = ["\"", "½", "¼", "¾", "°", "′", "″", "—", "·", "†"];            // idem
  const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp'];
  const PRE_EXT = ['.json', '.html', '.htm', '.txt'];
  const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
  const SNAPSHOT_EVERY_S = 600;                       // as annotate.py: a copy of the previous version every 10 min
  const SITE = new URL('.', document.baseURI);        // the folder of index.html
  const EXAMPLE = new URL('example/', SITE);
  const realFetch = window.fetch.bind(window);

  // Who is annotating: asked every time a folder is opened (the editor would otherwise reuse the last name, and on a
  // shared computer the next person could save under someone else's name). The last name is offered, pre-filled.
  let lastName = '';
  try {
    lastName = JSON.parse(localStorage.getItem('ann.annotator') || '""') || '';
    localStorage.removeItem('ann.annotator');  // read by app.js when it loads, after this file
  } catch (e) { /* storage blocked */ }
  if (lastName) {
    new MutationObserver((list, obs) => {
      const inp = document.getElementById('who-new');
      const btn = [...document.querySelectorAll('#modal [data-who]')].find(b => b.dataset.who === lastName);
      if (!inp && !btn) return;
      obs.disconnect();
      if (btn) btn.focus();                                            // a listed name: Enter picks it
      else if (!inp.value) { inp.value = lastName; inp.select(); }     // a typed name: Enter confirms it
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // ----------------------------------------------------------------------------------------------
  // Two kinds of storage with the same small interface: file(path) -> File | null, list(dir) -> [{name, kind}],
  // write(path, text | Blob). Paths are relative to the batch folder, with "/".

  const split = p => p.split('/').filter(Boolean);
  const missing = e => e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');

  class FolderStore {  // a folder on this computer
    constructor(handle) { this.root = handle; this.name = handle.name; this.example = false; }
    async dir(parts, create) {
      let d = this.root;
      for (const p of parts) d = await d.getDirectoryHandle(p, { create });
      return d;
    }
    async file(path) {
      const parts = split(path), name = parts.pop();
      try { const d = await this.dir(parts, false); return await (await d.getFileHandle(name)).getFile(); }
      catch (e) { if (missing(e)) return null; throw e; }
    }
    async list(path) {
      try {
        const d = await this.dir(split(path), false), out = [];
        for await (const [name, h] of d.entries()) out.push({ name, kind: h.kind });
        return out;
      } catch (e) { if (missing(e)) return []; throw e; }
    }
    async write(path, data) {
      const parts = split(path), name = parts.pop();
      const d = await this.dir(parts, true);
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();  // replaced on close only
      await w.write(data);
      await w.close();
    }
  }

  class ExampleStore {  // the example batch of the website: read over HTTP, changes kept in memory
    constructor(files) { this.files = new Set(files); this.mem = new Map(); this.got = new Map(); this.name = 'example'; this.example = true; }
    async file(path) {
      if (this.mem.has(path)) return this.mem.get(path);
      if (!this.files.has(path)) return null;
      if (!this.got.has(path)) {
        this.got.set(path, (async () => {
          const r = await realFetch(new URL(split(path).map(encodeURIComponent).join('/'), EXAMPLE));
          if (!r.ok) return null;
          const b = await r.blob();
          return new File([b], split(path).pop(), { type: b.type, lastModified: 0 });
        })());
      }
      return this.got.get(path);
    }
    async list(path) {
      const pre = path ? path.replace(/\/?$/, '/') : '';
      const seen = new Map();
      for (const p of [...this.files, ...this.mem.keys()]) {
        if (!p.startsWith(pre)) continue;
        const rest = p.slice(pre.length), i = rest.indexOf('/');
        seen.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'directory');
      }
      return [...seen].map(([name, kind]) => ({ name, kind }));
    }
    async write(path, data) { this.mem.set(path, new File([data], split(path).pop(), { lastModified: Date.now() })); }
  }

  // ----------------------------------------------------------------------------------------------
  // Helpers

  async function readText(store, path, windows1252) {
    const f = await store.file(path);
    if (!f) return null;
    const buf = await f.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder(windows1252 ? 'windows-1252' : 'utf-8').decode(buf).replace(/^﻿/, ''); }
  }

  async function sha256(buf) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // (width, height) from the PNG / GIF / WEBP / JPEG header, as annotate.py does (no EXIF rotation), or null.
  function imageSize(buf) {
    const v = new DataView(buf), n = buf.byteLength, u8 = new Uint8Array(buf);
    const ascii = (o, k) => String.fromCharCode(...u8.slice(o, o + k));
    try {
      if (n >= 24 && u8[0] === 0x89 && ascii(1, 3) === 'PNG') return [v.getUint32(16), v.getUint32(20)];
      if (n >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return [v.getUint16(6, true), v.getUint16(8, true)];
      if (n >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
        const kind = ascii(12, 4);
        if (kind === 'VP8X') return [1 + (v.getUint32(24, true) & 0xFFFFFF), 1 + (v.getUint32(27, true) & 0xFFFFFF)];
        if (kind === 'VP8 ') return [v.getUint16(26, true) & 0x3FFF, v.getUint16(28, true) & 0x3FFF];
        if (kind === 'VP8L') { const b = v.getUint32(21, true); return [(b & 0x3FFF) + 1, ((b >>> 14) & 0x3FFF) + 1]; }
      }
      if (n >= 4 && u8[0] === 0xFF && u8[1] === 0xD8) {
        let o = 2;
        while (o + 4 <= n) {
          if (u8[o] !== 0xFF) return null;
          const m = u8[o + 1];
          if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { o += 2; continue; }
          const len = v.getUint16(o + 2);
          if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [v.getUint16(o + 7), v.getUint16(o + 5)];
          o += 2 + len;
        }
      }
    } catch (e) { /* truncated file */ }
    return null;
  }

  function nowIso() {  // like Python's datetime.now().astimezone().isoformat(timespec="seconds")
    const d = new Date(), off = -d.getTimezoneOffset(), p = x => String(Math.abs(x)).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
      `${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
  }

  // JSON as Python's json.dumps(ensure_ascii=False) writes it (", " and ": "), so saved files match annotate.py's.
  function pyJson(v, indent, level = 0) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    const items = Array.isArray(v) ? v.map(x => pyJson(x, indent, level + 1))
      : Object.keys(v).filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ': ' + pyJson(v[k], indent, level + 1));
    const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
    if (!items.length) return open + close;
    if (indent == null) return open + items.join(', ') + close;
    const pad = '\n' + ' '.repeat(indent * (level + 1));
    return open + pad + items.join(',' + pad) + '\n' + ' '.repeat(indent * level) + close;
  }

  function dumpAnnotation(ann) {  // one line per cell, as annotate.py's dump_annotation
    const head = {};
    for (const k of Object.keys(ann)) if (k !== 'cells') head[k] = ann[k];
    const text = pyJson(head, 1);
    const cells = (ann.cells || []).map(c => '  ' + pyJson(c)).join(',\n');
    return text.slice(0, -2) + ',\n "cells": [\n' + cells + '\n ]\n}\n';
  }

  function checkAnnotation(ann) {  // as annotate.py's check_annotation: the cells must tile the grid exactly
    const int = (x, what) => { const n = Number(x); if (!Number.isInteger(n)) throw new Error(`bad ${what}`); return n; };
    if (!ann || typeof ann !== 'object' || !Array.isArray(ann.cells)) throw new Error('no cells');
    const nr = int(ann.n_rows, 'n_rows'), nc = int(ann.n_cols, 'n_cols');
    if (nr < 0 || nc < 0 || nr * nc > 5e6) throw new Error('bad table size');
    const seen = Array.from({ length: nr }, () => new Array(nc).fill(0));
    for (const c of ann.cells) {
      const r0 = int(c.row, 'row'), c0 = int(c.col, 'col'), rs = int(c.rowspan, 'rowspan'), cs = int(c.colspan, 'colspan');
      if (rs < 1 || cs < 1 || r0 < 0 || c0 < 0 || r0 + rs > nr || c0 + cs > nc) throw new Error(`cell out of the grid at row ${r0}, col ${c0}`);
      if (c.text !== undefined && typeof c.text !== 'string') throw new Error('cell text must be a string');
      const box = c.bbox;
      if (box != null && !(Array.isArray(box) && box.length === 4 && box.every(x => typeof x === 'number'))) throw new Error(`bad bbox at row ${r0}, col ${c0}`);
      const poly = c.polygon;
      if (poly != null && !(Array.isArray(poly) && poly.every(q => Array.isArray(q) && q.length === 2))) throw new Error(`bad polygon at row ${r0}, col ${c0}`);
      for (let r = r0; r < r0 + rs; r++) for (let k = c0; k < c0 + cs; k++) seen[r][k] += 1;
    }
    let bad = 0, first = null;
    for (let r = 0; r < nr; r++) for (let k = 0; k < nc; k++) if (seen[r][k] !== 1) { bad++; if (!first) first = [r, k]; }
    if (bad) throw new Error(`grid not tiled exactly (${bad} slots), first at row ${first[0]}, col ${first[1]}`);
    if (!['in_progress', 'done', 'skipped'].includes(ann.status)) throw new Error('bad status');
  }

  function parseCSV(text) {  // RFC 4180: quoted fields, "" inside quotes, CRLF
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const live = rows.filter(r => !(r.length === 1 && r[0] === ''));
    if (!live.length) return [];
    const head = live[0];
    return live.slice(1).map(r => Object.fromEntries(head.map((h, k) => [h, r[k] === undefined ? '' : r[k]])));
  }

  // ----------------------------------------------------------------------------------------------
  // The batch: what annotate.py's Batch class does, on a store

  const NOT_A_BATCH = 'This folder is not a batch: it has no batch.json, no tasks.csv and no images folder. ' +
    'Open the batch folder itself (the one that holds images/).';

  class Batch {
    constructor(store) { this.store = store; this.cache = new Map(); this.urls = new Map(); this.lock = Promise.resolve(); }

    async load() {
      const s = this.store;
      const top = await s.list('');
      const has = n => top.some(e => e.name === n);
      if (!has('batch.json') && !has('tasks.csv') && !has('images')) {
        const subs = [];
        for (const e of top) if (e.kind === 'directory' && (await s.list(e.name)).some(x => x.name === 'batch.json' || x.name === 'tasks.csv')) subs.push(e.name);
        throw new Error(NOT_A_BATCH + (subs.length ? ` The folder "${subs[0]}" inside it looks like one.` : ''));
      }
      let cfg = {};
      const cfgText = await readText(s, 'batch.json');
      if (cfgText != null) {
        try { cfg = JSON.parse(cfgText); } catch (e) { throw new Error('batch.json cannot be read: ' + e.message); }
      }
      const def = { name: s.name, annotators: [], prefill: 'full', special_chars: DEFAULT_CHARS, boxes: 'optional', box_prefill: 'model', box_formats: {} };
      for (const [k, v] of Object.entries(def)) if (!(k in cfg)) cfg[k] = v;
      cfg.annotators = (cfg.annotators || []).map(a => String(a).toLowerCase());
      this.cfg = cfg;
      this.images = new Set((await s.list('images')).filter(e => e.kind === 'file').map(e => e.name));
      this.tasks = await this.loadTasks();
      this.byId = new Map(this.tasks.map(t => [t.table_id, t]));
      this.pre = new Map();
      const found = (await s.list('pre')).filter(e => e.kind === 'directory').map(e => e.name).sort();
      for (const src of found) this.pre.set(src, new Set((await s.list('pre/' + src)).filter(e => e.kind === 'file').map(e => e.name)));
      const order = (cfg.sources || []).filter(x => found.includes(x));
      this.sources = order.concat(found.filter(x => !order.includes(x)));
      cfg.sources = this.sources;
    }

    async loadTasks() {
      const text = await readText(this.store, 'tasks.csv', true);
      const tasks = [];
      if (text != null) {
        for (const row of parseCSV(text)) {
          const tid = (row.table_id || '').trim();
          if (!tid) continue;
          tasks.push({
            table_id: tid,
            image: (row.image || '').trim() || this.findImage(tid),
            group: (row.group || '').trim(),
            assigned_to: (row.assigned_to || '').split(/[;,]/).map(a => a.trim().toLowerCase()).filter(Boolean),
            note: (row.note || '').trim(),
          });
        }
      } else {
        for (const name of [...this.images].sort()) {
          const dot = name.lastIndexOf('.');
          if (dot > 0 && IMAGE_EXT.includes(name.slice(dot).toLowerCase()))
            tasks.push({ table_id: name.slice(0, dot), image: `images/${name}`, group: '', assigned_to: [], note: '' });
        }
      }
      if (!tasks.length) throw new Error('No tables found in this folder (it needs tasks.csv or images in images/).');
      return tasks;
    }

    findImage(tid) {
      for (const ext of IMAGE_EXT) if (this.images.has(tid + ext)) return `images/${tid}${ext}`;
      return `images/${tid}.png`;
    }

    preFiles(tid) {
      const out = {};
      for (const src of this.sources) {
        const names = this.pre.get(src) || new Set();
        for (const ext of PRE_EXT) if (names.has(tid + ext)) { out[src] = `pre/${src}/${tid}${ext}`; break; }
      }
      return out;
    }

    async readJSON(path) {  // parsed JSON, cached until the file changes; undefined = no file; throws if unreadable
      const f = await this.store.file(path);
      if (!f) return undefined;
      const c = this.cache.get(path);
      if (c && c.lm === f.lastModified && c.size === f.size && !this.store.example) return c.obj;
      const obj = JSON.parse(new TextDecoder('utf-8').decode(await f.arrayBuffer()).replace(/^﻿/, ''));
      this.cache.set(path, { lm: f.lastModified, size: f.size, obj });
      return obj;
    }

    annPath(annotator, tid) { return `annotations/${annotator}/${tid}.json`; }

    async readAnn(annotator, tid) {
      const a = await this.readJSON(this.annPath(annotator, tid));
      return a === undefined ? null : JSON.parse(JSON.stringify(a));  // a copy: callers change it
    }

    async taskList(annotator) {
      const dirs = (await this.store.list('annotations')).filter(e => e.kind === 'directory').map(e => e.name).sort();
      const files = new Map();
      for (const d of dirs) files.set(d, new Set((await this.store.list('annotations/' + d)).map(e => e.name)));
      const out = [];
      for (const t of this.tasks) {
        const row = Object.assign({}, t);
        row.sources = Object.keys(this.preFiles(t.table_id));
        const mine = annotator && files.has(annotator) && files.get(annotator).has(t.table_id + '.json') ? await this.readAnn(annotator, t.table_id) : null;
        row.status = mine ? (mine.status || 'in_progress') : 'todo';
        row.flagged = !!(mine && mine.flagged);
        row.time_active_s = mine ? (mine.time_active_s || 0) : 0;
        row.modified = mine ? (mine.modified || null) : null;
        row.by = [];
        for (const d of dirs) {
          if (!files.get(d).has(t.table_id + '.json')) continue;
          let st;
          try { const a = await this.readJSON(this.annPath(d, t.table_id)); st = a && a.status !== undefined ? a.status : null; }
          catch (e) { st = 'unreadable'; }
          row.by.push({ annotator: d, status: st });
        }
        out.push(row);
      }
      return out;
    }

    async imageUrl(tid, file) {
      const old = this.urls.get(tid);
      if (old && old.lm === file.lastModified && old.size === file.size) return old.url;
      if (old) URL.revokeObjectURL(old.url);
      const url = URL.createObjectURL(file);
      this.urls.set(tid, { url, lm: file.lastModified, size: file.size });
      return url;
    }

    async taskDetail(annotator, tid) {
      const t = this.byId.get(tid), pre = {};
      for (const [src, path] of Object.entries(this.preFiles(tid))) {
        const buf = await (await this.store.file(path)).arrayBuffer();
        pre[src] = { kind: path.endsWith('.json') ? 'json' : 'html', text: new TextDecoder('utf-8').decode(buf), file: path, sha256: await sha256(buf) };
        const meta = await this.readJSON(`pre/${src}/${tid}.meta.json`).catch(() => undefined);
        if (meta !== undefined) pre[src].meta = meta;
      }
      const img = await this.store.file(t.image);
      let url = null, hash = null, size = null;
      if (img) {
        const buf = await img.arrayBuffer();
        hash = await sha256(buf);
        size = imageSize(buf);
        url = await this.imageUrl(tid, img);
      }
      return { task: t, pre, annotation: annotator ? await this.readAnn(annotator, tid) : null,
        image_url: url, image_file: t.image, image_sha256: hash, image_size: size };
    }

    save(annotator, tid, ann) {  // one save at a time, as annotate.py's lock
      const run = this.lock.then(() => this.saveNow(annotator, tid, ann));
      this.lock = run.catch(() => {});
      return run;
    }

    async saveNow(annotator, tid, ann) {
      const s = this.store, path = this.annPath(annotator, tid), dir = `annotations/${annotator}`;
      const oldFile = await s.file(path);
      const old = oldFile ? JSON.parse(new TextDecoder('utf-8').decode(await oldFile.arrayBuffer())) : null;
      const oldRev = old ? (old.rev || 0) : 0;
      if ((ann.rev || 0) !== oldRev) return { conflict: true, rev: oldRev };
      if (old) {
        const snaps = (await s.list(dir + '/_history')).map(e => e.name).filter(n => n.startsWith(tid + '__') && n.endsWith('.json')).sort();
        let age = null;
        if (snaps.length) { const f = await s.file(`${dir}/_history/${snaps[snaps.length - 1]}`); age = (Date.now() - f.lastModified) / 1000; }
        if (old.status !== ann.status || age === null || age > SNAPSHOT_EVERY_S) {
          const stamp = (old.modified || nowIso()).slice(0, 19).replace(/[^0-9T]/g, '');
          await s.write(`${dir}/_history/${tid}__${stamp}.json`, await oldFile.arrayBuffer());
        }
      }
      ann.rev = oldRev + 1;
      ann.annotator = annotator;
      ann.table_id = tid;
      ann.modified = nowIso();
      if (!('created' in ann)) ann.created = ann.modified;
      ann.tool_version = TOOL_VERSION;
      const html = 'html' in ann ? ann.html : null;
      delete ann.html;
      await s.write(path, dumpAnnotation(ann));
      if (html != null) await s.write(`${dir}/${tid}.html`, html);
      const log = (await readText(s, `${dir}/_log.jsonl`)) || '';
      const line = pyJson({ time: ann.modified, table_id: tid, rev: ann.rev, status: ann.status === undefined ? null : ann.status,
        time_active_s: ann.time_active_s === undefined ? null : ann.time_active_s,
        rows: ann.n_rows === undefined ? null : ann.n_rows, cols: ann.n_cols === undefined ? null : ann.n_cols });
      await s.write(`${dir}/_log.jsonl`, log + line + '\n');
      return { rev: ann.rev, modified: ann.modified };
    }
  }

  // ----------------------------------------------------------------------------------------------
  // The fake server: answers app.js's fetch calls once a batch is open

  let batch = null, setReady;
  const ready = new Promise(r => { setReady = r; });

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const annotatorOf = url => {
    const name = (url.searchParams.get('annotator') || '').trim().toLowerCase();
    if (name && !NAME_RE.test(name)) throw Object.assign(new Error('Annotator name: use lowercase letters, digits, - or _ (max 32).'), { status: 400 });
    return name;
  };

  async function serve(url, init) {
    const path = url.pathname, method = ((init && init.method) || 'GET').toUpperCase();
    if (path.startsWith('/static/')) return realFetch(new URL('static/' + path.slice(8), SITE), init);
    await ready;
    try {
      if (path === '/api/batch' && method === 'GET') {
        const cfg = Object.assign({}, batch.cfg);
        cfg.tool_version = TOOL_VERSION;
        cfg.n_tables = batch.tasks.length;
        return json(cfg);
      }
      if (path === '/api/tasks' && method === 'GET') return json(await batch.taskList(annotatorOf(url)));
      if (path.startsWith('/api/task/') && method === 'GET') {
        const tid = decodeURIComponent(path.slice(10));
        if (!batch.byId.has(tid)) return json({ error: 'unknown table' }, 404);
        return json(await batch.taskDetail(annotatorOf(url), tid));
      }
      if (path.startsWith('/img/') && method === 'GET') {
        const tid = decodeURIComponent(path.slice(5));
        const f = batch.byId.has(tid) && await batch.store.file(batch.byId.get(tid).image);
        return f ? new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }) : new Response('', { status: 404 });
      }
      if (path.startsWith('/api/annotation/') && (method === 'PUT' || method === 'POST')) {
        const tid = decodeURIComponent(path.slice(16));
        const name = annotatorOf(url);
        if (!name) return json({ error: 'No annotator name.' }, 400);
        if (!batch.byId.has(tid)) return json({ error: 'unknown table' }, 404);
        let ann;
        try { ann = JSON.parse(typeof init.body === 'string' ? init.body : await new Response(init.body).text()); checkAnnotation(ann); }
        catch (e) { return json({ error: e.message }, 400); }
        const res = await batch.save(name, tid, ann);
        return res.conflict ? json({ error: 'conflict', rev: res.rev }, 409) : json(res);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      if (e.status) return json({ error: e.message }, e.status);
      console.error(e);
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      return json({ error: denied ? 'The browser no longer allows this page to use the folder. Reload the page and open it again.' : String(e.message || e) }, 500);
    }
  }

  window.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === location.origin && /^\/(api|img|static)\//.test(url.pathname)) return serve(url, init || {});
    return realFetch(input, init);
  };

  // ----------------------------------------------------------------------------------------------
  // Remember the last folder (IndexedDB keeps the folder handle; the browser asks again before using it)

  const DB = {
    open() {
      return new Promise((ok, fail) => {
        const r = indexedDB.open('table-annotation', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('handles');
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      });
    },
    async get(key) {
      try {
        const db = await DB.open();
        return await new Promise(ok => { const q = db.transaction('handles').objectStore('handles').get(key); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); });
      } catch (e) { return null; }
    },
    async set(key, value) {
      try {
        const db = await DB.open();
        await new Promise(ok => { const t = db.transaction('handles', 'readwrite'); t.objectStore('handles').put(value, key); t.oncomplete = ok; t.onerror = ok; });
      } catch (e) { /* private window: not remembered */ }
    },
  };

  // ----------------------------------------------------------------------------------------------
  // The start screen

  const canOpen = typeof window.showDirectoryPicker === 'function';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = document.createElement('div');
  el.id = 'lc-start';
  el.innerHTML = `
    <div class="lc-card" role="dialog" aria-labelledby="lc-title">
      <div class="lc-eyebrow">Table annotation</div>
      <h1 id="lc-title">Correct tables against their image</h1>
      <p>Fix the structure (rows, columns, merged cells), the text of each cell and the cell boxes, starting from a
        model's answer or from an empty grid.</p>
      <p class="lc-muted"><b>Nothing is uploaded.</b> The page reads the images from a folder on your computer and saves your
        work into that same folder, in <code>annotations/&lt;your name&gt;/</code>.</p>
      <div class="lc-actions">
        <button class="lc-primary" id="lc-open" ${canOpen ? '' : 'disabled'}>Open a batch folder…</button>
        <button id="lc-reopen" hidden></button>
      </div>
      <p class="lc-warn" id="lc-nosupport" ${canOpen ? 'hidden' : ''}>Opening a folder needs <b>Chrome</b> or <b>Edge</b> on a
        computer. You can still try the example below.</p>
      <p class="lc-err" id="lc-err" hidden></p>
      <div class="lc-sep"></div>
      <div class="lc-actions">
        <button id="lc-example">Try the example</button>
        <a id="lc-zip" href="example.zip" download>Download the example folder (.zip)</a>
      </div>
      <p class="lc-muted lc-small">The example holds four tables from the HisClima dataset (weather logbooks, 1879–1890s,
        CC BY 4.0), with a model's answer and the dataset's own annotation to start from. In the example, changes are
        kept only until you reload the page; unzip the example folder and open it to try saving.</p>
      <details class="lc-small"><summary>What is a batch folder?</summary>
        <p>A folder with <code>images/</code> (one image per table), optionally <code>tasks.csv</code> (which tables, in which
          order, for whom), <code>batch.json</code> (settings) and <code>pre/&lt;model&gt;/</code> (each model's answer per table, as
          HTML or JSON). Your work goes to <code>annotations/&lt;your name&gt;/</code>: one JSON and one HTML file per table.
          Send that folder back, or keep the batch in a shared cloud folder so it travels by itself.</p>
      </details>
    </div>`;
  document.body.appendChild(el);
  const $ = sel => el.querySelector(sel);

  function showError(msg) { const p = $('#lc-err'); p.textContent = msg; p.hidden = !msg; }

  async function start(store) {
    showError('');
    const b = new Batch(store);
    try { await b.load(); }
    catch (e) { showError(e.message || String(e)); return false; }
    batch = b;
    el.remove();
    addFolderChip(store);
    setReady();
    return true;
  }

  function addFolderChip(store) {
    const chip = document.createElement('div');
    chip.id = 'lc-folder';
    chip.innerHTML = store.example
      ? '<span class="lc-pill lc-pill-ex" title="In the example, changes are kept only until the page reloads">Example · not saved</span> <button id="lc-change">Open a folder…</button>'
      : `<span class="lc-pill" title="Your work is saved in this folder">📁 ${esc(store.name)}</span> <button id="lc-change" title="Open another batch folder">Change…</button>`;
    const head = document.querySelector('#home .home-head');
    if (head) head.insertBefore(chip, head.querySelector('.who-box') || null);
    else { chip.classList.add('lc-float'); document.body.appendChild(chip); }
    chip.querySelector('#lc-change').addEventListener('click', () => { location.hash = ''; location.reload(); });
  }

  async function useHandle(handle) {
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { showError('The browser was not allowed to use this folder. Open it again and choose "Allow" or "Edit files".'); return; }
    if (await start(new FolderStore(handle))) DB.set('last', handle);
  }

  $('#lc-open').addEventListener('click', async () => {
    let handle;
    try { handle = await window.showDirectoryPicker({ id: 'annotation-batch', mode: 'readwrite' }); }
    catch (e) { if (e.name !== 'AbortError') showError(e.message || String(e)); return; }
    await useHandle(handle);
  });

  $('#lc-example').addEventListener('click', async () => {
    showError('');
    try {
      const r = await realFetch(new URL('files.json', EXAMPLE));
      if (!r.ok) throw new Error('The example could not be loaded (' + r.status + ').');
      await start(new ExampleStore(await r.json()));
    } catch (e) { showError(e.message || String(e)); }
  });

  if (canOpen) {
    DB.get('last').then(handle => {
      if (!handle || !el.isConnected) return;
      const b = $('#lc-reopen');
      b.textContent = `Reopen “${handle.name}”`;
      b.hidden = false;
      b.addEventListener('click', () => useHandle(handle).catch(e => showError(e.message || String(e))));
    });
  }

  // For tests: open a folder handle without the picker (e.g. the origin private file system).
  window.__openBatchHandle = handle => start(new FolderStore(handle));
})();
