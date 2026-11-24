// Grade the local main.ts against a practice trial's checks and expected results.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

const [kit, trial] = process.argv.slice(2);
const MAIN = process.env.MAIN ?? '/tmp/ssrun/mend24/main.ts';
const checks = JSON.parse(readFileSync(`${kit}/practice/${trial}/input/env/checks.json`, 'utf8')).checks;
const expected = JSON.parse(readFileSync(`${kit}/practice/${trial}/reference/expected.json`, 'utf8')).checks;
const exp = new Map(expected.map((c) => [c.id, c]));

function runCheck(c) {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  try {
    for (const [p, t] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, t);
    }
    const r = spawnSync(process.execPath, [MAIN, ...c.argv], { cwd: dir, input: c.stdin ?? '', encoding: 'utf8', timeout: 10000 });
    const files = {};
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) files[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    return { exit: r.status, stdout: r.stdout, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let pass = 0;
const fails = [];
for (const c of checks) {
  const got = runCheck(c);
  const want = exp.get(c.id);
  const ok = got.exit === want.exit && got.stdout === want.stdout &&
    Object.keys(got.files).length === Object.keys(want.files).length &&
    Object.entries(want.files).every(([k, v]) => got.files[k] === v);
  if (ok) pass += 1;
  else fails.push({ id: c.id, group: want.group, got, want });
}
console.log(`${trial}: ${pass}/${checks.length}`);
const byGroup = {};
for (const f of fails) byGroup[f.group] = (byGroup[f.group] ?? 0) + 1;
console.log('fail by group:', JSON.stringify(byGroup));
process.env.VERBOSE && fails.slice(0, Number(process.env.VERBOSE)).forEach((f) => {
  console.log('='.repeat(70));
  console.log(f.id, f.group, '| argv', JSON.stringify(exp.get(f.id) ? '' : ''), '');
  console.log('want exit', f.want.exit, 'got', f.got.exit);
  console.log('want out', JSON.stringify(f.want.stdout));
  console.log('got  out', JSON.stringify(f.got.stdout));
  const wk = Object.keys(f.want.files), gk = Object.keys(f.got.files);
  for (const k of wk) if (f.want.files[k] !== (f.got.files[k] ?? null)) {
    console.log('--- file', k);
    console.log('want:', JSON.stringify(f.want.files[k]).slice(0, 500));
    console.log('got :', JSON.stringify(f.got.files[k] ?? null).slice(0, 500));
  }
  for (const k of gk) if (!(k in f.want.files)) console.log('extra file', k, JSON.stringify(f.got.files[k]).slice(0, 200));
});
