// main.ts is mend, the CLI SPEC.md specifies. Node 22 and its standard library alone; run as
// `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` with the working directory the root of
// the tree. In a trial MAKEFUN_ENV_URL is set and this file hands over to runner.ts, which the kit
// supplies and which must stay as it is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** SPEC.md section 1: the patch's lines, split at \n with one trailing \r taken off each. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a safe path. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** SPEC.md section 3: a file's lines and its own line break. */
interface Doc {
  lines: string[];
  br: '\n' | '\r\n';
  ended: boolean;
}
function splitDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', ended: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ended = text.endsWith(br);
  const parts = text.split(br);
  if (ended) parts.pop();
  return { lines: parts, br, ended };
}
function joinDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.ended ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made, old path to new path, for the R lines. */
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  doc(p: string): Doc {
    const t = this.get(p);
    return t === null ? { lines: [], br: '\n', ended: false } : splitDoc(t);
  }
}

type Edit = (tree: Tree) => void;

// ------------------------------------------------------------ SPEC.md section 5

const stripEnd = (s: string): string => s.replace(/[ \t]+$/g, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const NORM: ((s: string) => string)[] = [(s) => s, stripEnd, stripBoth];

/** Leading spaces and tabs. */
function lead(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/**
 * The first tier at which `old` occurs in `file`, with every occurrence's 0-based position.
 * Tier 0 is exact, 1 drops trailing blanks, 2 drops leading and trailing blanks. With `strict`
 * only tier 0 is tried. Occurrences may overlap.
 */
function matchAt(file: string[], old: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const last = strict ? 1 : 3;
  for (let tier = 0; tier < last; tier++) {
    const f = NORM[tier]!;
    const o = old.map(f);
    const fl = file.map(f);
    const occ: number[] = [];
    const n = o.length;
    for (let i = 0; i + n <= fl.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        if (fl[i + j] !== o[j]) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** At tier 2 an added line carrying O's indent is re-indented to the file's. */
function indenter(fileLine: string, oldFirst: string): (s: string) => string {
  const from = lead(oldFirst);
  const to = lead(fileLine);
  return (s: string): string =>
    s.trim() !== '' && s.startsWith(from) ? to + s.slice(from.length) : s;
}

// ------------------------------------------------------------ SPEC.md section 9 (JSON)

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const mustExist = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = mustExist(tree);
      const nl = before.indexOf('\n');
      const br: '\n' | '\r\n' = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ------------------------------------------------------------ SPEC.md section 6 (unified)

interface Token {
  k: 'c' | 'o' | 'n';
  t: string;
  nn?: boolean;
}
interface Hunk {
  a: number;
  body: Token[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  gitOld: string | null;
  gitNew: string | null;
  hunks: Hunk[];
}

const TAB_PATH = (s: string): string => {
  const t = s.slice(4);
  const tab = t.indexOf('\t');
  return (tab < 0 ? t : t.slice(0, tab)).trim();
};
const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** Read a unified diff into sections. */
function unifiedSections(lines: string[]): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  const fresh = (): Section => ({
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    isNew: false,
    isDeleted: false,
    gitOld: null,
    gitNew: null,
    hunks: [],
  });
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      out.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nx = lines[i + 1] ?? '';
      if (!nx.startsWith('+++ ')) {
        if (cur !== null) throw new Exit2(`error: parse ${i + 2}`);
        i += 1;
        continue;
      }
      if (cur === null || cur.hunks.length > 0) {
        cur = fresh();
        out.push(cur);
      }
      const op = TAB_PATH(l);
      const np = TAB_PATH(nx);
      cur.oldPath = op === '/dev/null' ? null : stripAB(op);
      cur.newPath = np === '/dev/null' ? null : stripAB(np);
      i += 2;
      continue;
    }
    if (cur === null) {
      i += 1;
      continue;
    }
    // Inside a section.
    if (cur.hunks.length === 0) {
      if (l.startsWith('+++ ')) {
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isNew = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDeleted = true;
        i += 1;
        continue;
      }
      if (l.startsWith('index ') || l.startsWith('old mode') || l.startsWith('new mode') ||
          l.startsWith('similarity index') || l.startsWith('dissimilarity index') || l.startsWith('Index:')) {
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const h = hunkHeader(l);
        if (h === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.hunks.push({ a: h, body: [] });
        i += 1;
        continue;
      }
      // Anything else before the first hunk is a header line we ignore.
      i += 1;
      continue;
    }
    // Past the first hunk: a line that begins a body continues the last hunk.
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      continue;
    }
    if (l === '') {
      cur.hunks[cur.hunks.length - 1]!.body.push({ k: 'c', t: '' });
      i += 1;
      continue;
    }
    const c0 = l[0];
    if (c0 === ' ' || c0 === '-' || c0 === '+') {
      cur.hunks[cur.hunks.length - 1]!.body.push({ k: c0 === ' ' ? 'c' : c0 === '-' ? 'o' : 'n', t: l.slice(1) });
      i += 1;
      continue;
    }
    if (c0 === '\\') {
      const b = cur.hunks[cur.hunks.length - 1]!.body;
      if (b.length > 0) b[b.length - 1]!.nn = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const h = hunkHeader(l);
      if (h === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.hunks.push({ a: h, body: [] });
      i += 1;
      continue;
    }
    i += 1;
  }
  for (const s of out) {
    for (const h of s.hunks) {
      while (h.body.length > 0 && h.body[h.body.length - 1]!.k === 'c' && h.body[h.body.length - 1]!.t === '') h.body.pop();
    }
  }
  return out;
}

/** `@@ -A[,B] +C[,D] @@`, giving A, or null. */
function hunkHeader(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
  return m === null ? null : Number(m[1]);
}

function applyHunk(doc: Doc, hunk: Hunk, strict: boolean, path: string): Doc {
  const file = doc.lines;
  const body = hunk.body;
  const oldL: string[] = [];
  const newL: string[] = [];
  for (const t of body) {
    if (t.k === 'c') {
      oldL.push(t.t);
      newL.push(t.t);
    } else if (t.k === 'o') {
      oldL.push(t.t);
    } else {
      newL.push(t.t);
    }
  }
  let at: number;
  let tier = 0;
  let fix: (s: string) => string = (s) => s;
  if (oldL.length === 0) {
    at = Math.min(hunk.a, file.length);
  } else {
    const m = matchAt(file, oldL, strict);
    if (m === null) throw new Fail('no-match', path);
    tier = m.tier;
    let best = m.occ[0]!;
    let bd = Math.abs(best - (hunk.a - 1));
    for (const p of m.occ) {
      const d = Math.abs(p - (hunk.a - 1));
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    at = best;
    if (tier === 2) fix = indenter(file[at]!, oldL[0]!);
  }
  const out: string[] = [];
  for (let k = 0; k < at; k++) out.push(file[k]!);
  let pos = at;
  let lastCN = -1;
  if (oldL.length === 0) {
    for (let k = 0; k < body.length; k++) {
      const t = body[k]!;
      if (t.k === 'n') {
        out.push(tier === 2 ? fix(t.t) : t.t);
        lastCN = k;
      }
    }
  } else {
    for (let k = 0; k < body.length; k++) {
      const t = body[k]!;
      if (t.k === 'c') {
        out.push(file[pos]!);
        pos += 1;
        lastCN = k;
      } else if (t.k === 'o') {
        pos += 1;
      } else {
        out.push(tier === 2 ? fix(t.t) : t.t);
        lastCN = k;
      }
    }
  }
  for (let k = pos; k < file.length; k++) out.push(file[k]!);
  const reachedEnd = oldL.length === 0 ? at >= file.length : pos >= file.length;
  let ended = doc.ended;
  if (reachedEnd && lastCN >= 0 && body[lastCN]!.nn === true) ended = false;
  return { lines: out, br: doc.br, ended };
}

/** One unified section as an edit. */
function unifiedEdit(s: Section, strict: boolean): Edit {
  let oldPath = s.oldPath ?? s.renameFrom ?? s.gitOld;
  let newPath = s.newPath ?? s.renameTo ?? s.gitNew;
  const isNew = s.isNew || s.oldPath === null;
  const isDeleted = s.isDeleted || s.newPath === null;
  if (oldPath === null && isDeleted) oldPath = s.gitOld;
  if (newPath === null && isNew) newPath = s.gitNew;
  return (tree) => {
    for (const p of [oldPath, newPath]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isNew) {
      const p = newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      for (const h of s.hunks) for (const t of h.body) if (t.k === 'n') lines.push(t.t);
      let ended = true;
      const last = s.hunks[s.hunks.length - 1];
      if (last !== undefined) {
        for (let k = last.body.length - 1; k >= 0; k--) {
          const t = last.body[k]!;
          if (t.k === 'c' || t.k === 'n') {
            if (t.nn === true) ended = false;
            break;
          }
        }
      }
      const text = lines.length === 0 ? '' : lines.join('\n') + (ended ? '\n' : '');
      tree.now.set(p, text);
      return;
    }
    if (isDeleted) {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath === newPath) {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      let doc = tree.doc(p);
      for (const h of s.hunks) doc = applyHunk(doc, h, strict, p);
      tree.now.set(p, joinDoc(doc));
      return;
    }
    const o = oldPath!;
    const nw = newPath!;
    if (tree.get(o) === null) throw new Fail('missing', o);
    if (tree.get(nw) !== null) throw new Fail('exists', nw);
    let doc = tree.doc(o);
    for (const h of s.hunks) doc = applyHunk(doc, h, strict, o);
    tree.now.set(nw, joinDoc(doc));
    tree.now.set(o, null);
    tree.moves.set(nw, o);
  };
}

// ------------------------------------------------------------ SPEC.md section 7 (SEARCH/REPLACE)

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const out: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k > prevReplace; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = -1;
    let end = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine}`);
    if (end === -1) {
      for (let k = sep + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldL = lines.slice(i + 1, sep);
    const newL = lines.slice(sep + 1, end);
    const p = path;
    out.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldL.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const text = newL.length === 0 ? '' : newL.join('\n') + '\n';
        tree.now.set(p, text);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = splitDoc(before);
      const m = matchAt(doc.lines, oldL, strict);
      if (m === null) throw new Fail('no-match', p);
      if (m.occ.length > 1) throw new Fail('ambiguous', p);
      const at = m.occ[0]!;
      const fix = m.tier === 2 ? indenter(doc.lines[at]!, oldL[0]!) : (s: string) => s;
      const outLines: string[] = [];
      for (let k = 0; k < at; k++) outLines.push(doc.lines[k]!);
      for (const s of newL) outLines.push(fix(s));
      for (let k = at + oldL.length; k < doc.lines.length; k++) outLines.push(doc.lines[k]!);
      tree.now.set(p, joinDoc({ lines: outLines, br: doc.br, ended: doc.ended }));
    });
    prevPath = path;
    prevReplace = end;
    i = end;
  }
  return out;
}

// ------------------------------------------------------------ SPEC.md section 8 (V4A)

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: Token[];
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
}

function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const out: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const s: VSection = { kind: 'add', path: l.slice(14).trim(), moveTo: null, lines: [], chunks: [] };
      i += 1;
      while (i < last) {
        const t = lines[i]!;
        if (blank(t)) {
          // Blank lines belong to the file only while the section runs; a later section ends it.
          let j = i;
          while (j < last && blank(lines[j]!)) j += 1;
          if (j >= last || lines[j]!.startsWith('*** ')) break;
          s.lines.push('');
          i += 1;
          continue;
        }
        if (t.startsWith('*** ')) break;
        if (t.startsWith('+')) s.lines.push(t.slice(1));
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      out.push(s);
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      out.push({ kind: 'del', path: l.slice(17).trim(), moveTo: null, lines: [], chunks: [] });
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const s: VSection = { kind: 'upd', path: l.slice(17).trim(), moveTo: null, lines: [], chunks: [] };
      i += 1;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        s.moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }
      // Chunks.
      let chunk: VChunk | null = null;
      let sawChunk = false;
      while (i < last) {
        const t = lines[i]!;
        if (blank(t)) {
          let j = i;
          while (j < last && blank(lines[j]!)) j += 1;
          if (j >= last || lines[j]!.startsWith('*** ')) break;
          if (chunk !== null) chunk.body.push({ k: 'c', t: '' });
          i += 1;
          continue;
        }
        if (t.startsWith('*** End of File')) {
          if (chunk !== null) chunk.eof = true;
          i += 1;
          continue;
        }
        if (t.startsWith('@@')) {
          if (chunk !== null) s.chunks.push(chunk);
          const a = t.slice(2).trim();
          chunk = { anchor: a === '' ? null : a, eof: false, body: [] };
          sawChunk = true;
          i += 1;
          continue;
        }
        if (t.startsWith('*** ')) break;
        const c0 = t[0];
        if (c0 === ' ' || c0 === '-' || c0 === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            sawChunk = true;
          }
          chunk.body.push({ k: c0 === ' ' ? 'c' : c0 === '-' ? 'o' : 'n', t: t.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunk !== null) s.chunks.push(chunk);
      if (!sawChunk && s.moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      out.push(s);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return out;
}

function v4aEdits(sections: VSection[], strict: boolean): Edit[] {
  return sections.map((s) => (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const text = s.lines.length === 0 ? '' : s.lines.join('\n') + '\n';
      tree.now.set(s.path, text);
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (tree.get(s.path) === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null) {
      if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    }
    let doc = tree.doc(s.path);
    let cursor = 0;
    for (const ch of s.chunks) {
      const oldL: string[] = [];
      for (const t of ch.body) if (t.k === 'c' || t.k === 'o') oldL.push(t.t);
      if (ch.anchor !== null) {
        const hit = matchAt(doc.lines.slice(cursor), [ch.anchor], strict);
        if (hit === null) throw new Fail('no-match', s.path);
        cursor += hit.occ[0]! + 1;
      }
      let at: number;
      let tier = 0;
      let fix: (x: string) => string = (x) => x;
      if (oldL.length === 0) {
        at = ch.eof ? doc.lines.length : cursor;
      } else {
        const m = matchAt(doc.lines.slice(cursor), oldL, strict);
        if (m === null) throw new Fail('no-match', s.path);
        at = cursor + m.occ[0]!;
        tier = m.tier;
        if (tier === 2) fix = indenter(doc.lines[at]!, oldL[0]!);
        if (ch.eof && at + oldL.length !== doc.lines.length) throw new Fail('no-match', s.path);
      }
      const out: string[] = [];
      for (let k = 0; k < at; k++) out.push(doc.lines[k]!);
      let pos = at;
      for (const t of ch.body) {
        if (t.k === 'c') {
          out.push(doc.lines[pos]!);
          pos += 1;
        } else if (t.k === 'o') {
          pos += 1;
        } else {
          out.push(tier === 2 ? fix(t.t) : t.t);
        }
      }
      for (let k = pos; k < doc.lines.length; k++) out.push(doc.lines[k]!);
      doc = { lines: out, br: doc.br, ended: doc.ended };
      cursor = pos;
    }
    const text = joinDoc(doc);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, text);
      tree.now.set(s.path, null);
      tree.moves.set(s.moveTo, s.path);
    } else {
      tree.now.set(s.path, text);
    }
  });
}

// ------------------------------------------------------------ SPEC.md section 4

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ------------------------------------------------------------ SPEC.md sections 1, 2 and 10

function run(args: string[], strictFlag = false): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = strictFlag;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') {
      const secs = unifiedSections(lines);
      edits = secs.map((s) => unifiedEdit(s, strict));
    } else if (kind === 'search-replace') {
      edits = searchReplaceEdits(lines, strict);
    } else {
      edits = v4aEdits(v4aSections(lines), strict);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of movesBefore) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: string[] = [];
  const moveOlds = new Set(tree.moves.values());
  const paths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  for (const p of paths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    // A moved-away path is named by the R line of its new path, and by nothing else.
    if (moveOlds.has(p)) continue;
    rows.push(tree.moves.has(p) ? `R ${tree.moves.get(p)} -> ${p}` : `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
