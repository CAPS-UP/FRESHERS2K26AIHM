// Guards against the bug that broke the door: a regex escape that got doubled
// during editing, so /\d/ became /\\d/ and silently matched nothing.
// Textual checks are not enough — the ticket reader gets executed here.
import fs from 'fs';
import { execSync } from 'child_process';

const FILES = ['index.html', 'ankitpanel.html', 'aartipanel.html'];
let bad = 0;
const fail = m => { bad++; console.log('  FAIL  ' + m); };
const pass = m => console.log('  pass  ' + m);

for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  console.log('\n== ' + f + ' ==');

  // strip comments so CSS/JS block comments are not mistaken for regexes
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // 1. doubled escapes inside a regex literal
  const doubled = [...noComments.matchAll(/\/[^/\n]*\\\\[dswbDSWB][^/\n]*\/[gimsuy]*/g)];
  doubled.length
    ? doubled.forEach(m => fail('doubled escape: ' + m[0]))
    : pass('no doubled escapes');

  // 2. every regex literal compiles
  const lits = [...noComments.matchAll(/[=(,:!&|?[\s]\/((?:[^/\\\n[]|\\.|\[[^\]\n]*\])+)\/([gimsuy]*)/g)];
  let broke = 0;
  for (const m of lits) {
    try { new RegExp(m[1], m[2]); } catch { broke++; fail('will not compile: /' + m[1] + '/'); }
  }
  if (!broke) pass(lits.length + ' regex literals compile');

  // 3. inline script parses
  const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const js = blocks[blocks.length - 1] || '';
  fs.writeFileSync('/tmp/v.js', js);
  try { execSync('node --check /tmp/v.js', { stdio: 'pipe' }); pass('script parses'); }
  catch (e) { fail('script will not parse: ' + String(e.stderr).split('\n')[2]); }

  // 4. every element the script reaches for exists
  const body = src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  const have = new Set([...body.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const runtime = new Set([...js.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
  const want = new Set([...src.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]));
  const missing = [...want].filter(id => !have.has(id) && !runtime.has(id));
  missing.length ? fail('missing elements: ' + missing.join(', ')) : pass('all elements exist');
}

// 5. THE important one: run the door's ticket reader for real
console.log('\n== the door reads a ticket (executed, not read) ==');
const scanner = fs.readFileSync('aartipanel.html', 'utf8');
const js = [...scanner.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).pop();
const slice = js.slice(js.indexOf('var DIGIT_RE'), js.indexOf('/* ---------------- sign in'));
const parseScan = new Function(slice + '; return parseScan;')();

const cases = [
  ['F26-7462-5350', 'F26-7462-5350'], ['f26-7462-5350', 'F26-7462-5350'],
  ['F26 7462 5350', 'F26-7462-5350'], ['74625350', 'F26-7462-5350'],
  ['7462 5350', 'F26-7462-5350'],     ['7462-5350', 'F26-7462-5350'],
  ['F26-7462-5350|N|1|ABCDEFGHJK', 'F26-7462-5350'],
  ['hello', null], ['', null], ['12345', null],
];
let ok = 0;
for (const [inp, want] of cases) {
  const r = parseScan(inp);
  const got = r.ok ? r.ticket : null;
  got === want ? (ok++, pass(JSON.stringify(inp) + ' -> ' + (got || 'rejected')))
               : fail(JSON.stringify(inp) + ' -> ' + got + ', wanted ' + want);
}
console.log('  (' + ok + '/' + cases.length + ')');

// 6. server and scanner must agree on what a ticket is
console.log('\n== server agrees with the door ==');
const lib = fs.readFileSync('functions/api/_lib.js', 'utf8');
const isTicket = new Function('return ' + lib.match(/export const isTicket = ([\s\S]*?);\n/)[1])();
for (const t of ['F26-7462-5350', 'F26-0000-0000']) {
  const a = isTicket(t), b = parseScan(t).ticket === t;
  a && b ? pass(t + ' accepted by both') : fail(t + ' server=' + a + ' door=' + b);
}
for (const t of ['F26-746-5350', 'XYZ']) {
  isTicket(t) ? fail(t + ' wrongly accepted by server') : pass(t + ' rejected by server');
}

console.log('\n' + (bad ? bad + ' PROBLEM(S)' : 'ALL CLEAN') + '\n');
process.exit(bad ? 1 : 0);
