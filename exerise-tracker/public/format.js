// File formats for the data repo. Shared by the site (browser) and the API (Cloudflare Pages Function).
//
//   exercises/<name>.md   YAML frontmatter for settings, markdown body for notes (Obsidian-friendly)
//   log/<year>.csv        one row per exercise per workout

/* ---------- exercises: markdown + frontmatter ---------- */

export function slug(name) {
  return String(name || 'exercise').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'exercise';
}

function yamlValue(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v ?? '');
  const plain = /^[A-Za-z][A-Za-z0-9 ./&()+'-]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) && s.trim() === s;
  return plain ? s : JSON.stringify(s);
}
function yamlParse(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return '';
  if (s === '[]') return [];
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch (e) { return s.slice(1, -1); } }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map((x) => yamlParse(x)).filter((x) => x !== '');
  return s;
}

const FIELD_ORDER = ['id', 'name', 'active', 'phase', 'muscles', 'volume', 'difficulty', 'sets', 'unit',
  'current_reps', 'current_time', 'current_weight', 'current_level',
  'goal_reps', 'goal_time', 'goal_weight', 'goal_level', 'levels', 'example', 'created'];

export function exToMd(ex) {
  const fm = {
    id: ex.id, name: ex.name || 'Untitled', active: !!ex.active, phase: ex.phase, muscles: ex.muscles || [],
    volume: ex.volume, difficulty: ex.difficulty, sets: ex.sets, unit: ex.unit || 'lb',
    current_reps: ex.cur.reps, current_time: ex.cur.time, current_weight: ex.cur.weight, current_level: ex.cur.level,
    goal_reps: ex.goal.reps, goal_time: ex.goal.time, goal_weight: ex.goal.weight, goal_level: ex.goal.level,
    levels: ex.levels || [],
  };
  if (ex.example) fm.example = true;
  if (ex.createdAt) fm.created = new Date(ex.createdAt).toISOString();
  const lines = ['---'];
  FIELD_ORDER.forEach((k) => {
    if (!(k in fm)) return;
    const v = fm[k];
    if (Array.isArray(v)) {
      if (!v.length) lines.push(k + ': []');
      else { lines.push(k + ':'); v.forEach((x) => lines.push('  - ' + yamlValue(x))); }
    } else lines.push(k + ': ' + yamlValue(v));
  });
  lines.push('---', '');
  const notes = String(ex.notes || '').trim();
  return lines.join('\n') + (notes ? notes + '\n' : '');
}

export function mdToEx(text) {
  const m = String(text || '').replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) return null;
  const fm = {}; let key = null;
  m[1].split(/\r?\n/).forEach((line) => {
    let x;
    if ((x = line.match(/^\s+-\s*(.*)$/)) && key) {
      if (!Array.isArray(fm[key])) fm[key] = [];
      fm[key].push(yamlParse(x[1]));
    } else if ((x = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))) {
      key = x[1]; fm[key] = x[2].trim() === '' ? [] : yamlParse(x[2]);
    }
  });
  const n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const list = (v) => (Array.isArray(v) ? v : v === '' || v == null ? [] : [v]).map((x) => String(x)).filter(Boolean);
  const name = typeof fm.name === 'string' || typeof fm.name === 'number' ? String(fm.name) : '';
  return {
    id: fm.id != null && fm.id !== '' && !Array.isArray(fm.id) ? String(fm.id) : '',
    name,
    active: fm.active === true,
    phase: typeof fm.phase === 'string' ? fm.phase : 'strength',
    muscles: list(fm.muscles).map((x) => x.toLowerCase()),
    volume: fm.volume === 'time' ? 'time' : 'reps',
    difficulty: ['weight', 'progression', 'none'].includes(fm.difficulty) ? fm.difficulty : 'none',
    sets: Math.max(1, Math.round(n(fm.sets, 3))),
    unit: fm.unit === 'kg' ? 'kg' : 'lb',
    cur: { reps: n(fm.current_reps, 8), time: n(fm.current_time, 30), weight: n(fm.current_weight, 0), level: n(fm.current_level, 0) },
    goal: { reps: n(fm.goal_reps, 12), time: n(fm.goal_time, 60), weight: n(fm.goal_weight, 0), level: n(fm.goal_level, 0) },
    levels: list(fm.levels),
    example: fm.example === true,
    createdAt: Date.parse(fm.created) || 0,
    notes: (m[2] || '').trim(),
  };
}

/* ---------- workout log: CSV ---------- */

export const CSV_HEADER = ['date', 'started', 'finished', 'session', 'exercise_id', 'exercise', 'sets', 'unit',
  'weight', 'level', 'level_name', 'feel', 'next', 'plan'];

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const csvLine = (fields) => fields.map(csvEscape).join(',');

export function csvParse(text) {
  const rows = []; let row = [], f = '', q = false;
  const t = String(text || '').replace(/^﻿/, '');
  const endRow = () => { row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; endRow(); }
    else f += c;
  }
  if (f !== '' || row.length) endRow();
  return rows;
}

export function csvObjects(text) {
  const rows = csvParse(text);
  if (!rows.length) return [];
  const h = rows[0].map((x) => x.trim());
  return rows.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

// Rebuild a year's log: drop removed workouts, append new rows. Keeps whatever column order the file already has.
export function updateLog(text, removeSessions, appendObjects) {
  const rows = csvParse(text);
  const header = rows.length ? rows[0].map((x) => x.trim()) : CSV_HEADER.slice();
  CSV_HEADER.forEach((k) => { if (!header.includes(k)) header.push(k); });
  const si = header.indexOf('session');
  const remove = new Set(removeSessions || []);
  const body = rows.slice(1).filter((r) => !remove.has(r[si]));
  const added = (appendObjects || []).filter((o) => !remove.has(o.session)).map((o) => header.map((k) => o[k] ?? ''));
  return [header, ...body.map((r) => header.map((_, i) => r[i] ?? '')), ...added].map(csvLine).join('\n') + '\n';
}

// CSV rows -> workout objects the app understands.
export function rowsToSessions(objs, into = {}) {
  objs.forEach((o) => {
    const id = (o.session || '').trim();
    if (!id) return;
    let s = into[id];
    if (!s) {
      const started = Date.parse(o.started) || Date.parse(o.date + 'T12:00:00') || 0;
      s = into[id] = { id, status: 'done', saved: true, example: id.startsWith('example-'), startedAt: started,
        finishedAt: Date.parse(o.finished) || null, items: [] };
    }
    const vols = String(o.sets || '').trim().split(/[\s|;]+/).filter(Boolean).map(Number).filter((x) => isFinite(x));
    const lvl = String(o.level ?? '').trim() !== '' ? Number(o.level) : null;
    const w = String(o.weight ?? '').trim() !== '' ? Number(o.weight) : null;
    const diff = lvl != null && isFinite(lvl) ? lvl : w != null && isFinite(w) ? w : null;
    s.items.push({ exId: o.exercise_id, name: o.exercise, logged: true, now: false, feel: o.feel || null, next: o.next || 'keep',
      prev: null, result: { vols, diff }, target: { sets: vols.length, vol: vols[0] || 0, diff } });
  });
  return into;
}
