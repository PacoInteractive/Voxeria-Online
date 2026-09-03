// ============================================================================
// VOXERIA -- BUILD CHECK
// ----------------------------------------------------------------------------
// Was voxeriaSelfTest() nicht kann: laufen, ohne dass jemand das Spiel oeffnet
// und die Konsole aufmacht. Genau das ist die Luecke, die beim Umbau weh tut,
// denn ein Refactor bricht Dinge in Dateien, die man an dem Tag gar nicht
// angefasst hat.
//
//   node tools/check.js               alles
//   node tools/check.js syntax        nur Syntax
//   node tools/check.js deps          nur die Abhaengigkeitskarte
//   node tools/check.js cycles        nur die Ringe, also die offene Arbeit
//   node tools/check.js why A B       zwei Dateien vollstaendig gegenueber
//
// SYNTAX faengt das Billige: Klammer vergessen, doppelte Deklaration, kaputtes
// Template-Literal. Kostet eine Sekunde und ist die Bedingung dafuer, dass man
// ueberhaupt wagt, grosse Bloecke zu verschieben.
//
// DEPS ist das eigentliche Werkzeug fuer den Umbau. Voxeria haelt seine Teile
// ueber globale Namen zusammen, nicht ueber imports. Welche Datei welche
// fremden Namen braucht, steht damit nirgends geschrieben, sondern nur in der
// Reihenfolge der <script>-Tags in index.html. Diese Karte schreibt es auf:
// pro Datei die Namen, die sie liest, aber selbst nicht deklariert, und wer
// sie deklariert. Wer wenig Fremdes braucht, kann zuerst heraus.
//
// Absichtlich KEIN echter Parser. Ein Regex-Scanner ueber Deklarationen ist
// hier genau genug, um die Reihenfolge zu bestimmen, und er braucht kein
// npm install, das der Build sonst nirgends braucht. Die Zahlen sind eine
// Rangliste, keine Bilanz.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Nur was der Build wirklich ausliefert. Backups, Kopien und Prototypen sind
// bewusst draussen: ein roter Punkt in einer Datei, die niemand laedt, macht
// den Check wertlos, weil man ihn dann ignoriert.
const SHIPPED = [
  'voxeria-core.js',
  'voxeria-engine.js',
  'voxeria-worldgen.js',
  'voxeria-dimensions-progress.js',
  'voxeria-modding.js',
  'voxeria-menu-worlds.js',
  'voxeria-arena.js',
  'voxeria-coop-mods.js',
  'voxeria-gallery.js',
  'voxeria-terminal.js',
  'voxeria-devtools.js',
  'voxeria-juice.js',
  'voxeria-desert-prototype.js',
  'voxeria-director.js',
  'voxeria-tests.js',
  'voxeria-boot.js',
  'main.js',
  'build-zip.js'
];

function existing() {
  return SHIPPED.filter(f => fs.existsSync(path.join(ROOT, f)));
}

// ---------------------------------------------------------------- Syntax ---

function checkSyntax() {
  const files = existing();
  const bad = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    } catch (e) {
      const out = String(e.stderr || e.stdout || e.message).trim().split('\n').slice(0, 4).join('\n');
      bad.push(f + '\n    ' + out.replace(/\n/g, '\n    '));
    }
  }
  const missing = SHIPPED.filter(f => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) console.log('   fehlt: ' + missing.join(', '));
  if (bad.length) {
    console.log('X  Syntax: ' + bad.length + ' Datei(en) kaputt');
    bad.forEach(b => console.log('   ' + b));
    return false;
  }
  console.log('OK Syntax: ' + files.length + ' Dateien parsen sauber');
  return checkRedeclared(files);
}

// Die Luecke, die `node --check` prinzipiell nicht sehen kann: es prueft jede
// Datei fuer sich, aber alle teilen sich zur Laufzeit EINEN globalen Scope.
// Zwei Dateien mit `let camX` an Spaltenposition 0 sind einzeln fehlerfrei und
// zusammen ein sofortiger SyntaxError, "Identifier 'camX' has already been
// declared", der das ganze Spiel beim Laden anhaelt.
//
// Genau das ist beim Verschieben von voxeria-boot.js nach voxeria-engine.js
// einmal passiert: die Deklaration war in der Engine angekommen, die alte in
// boot aber noch da, und Syntaxpruefung wie Abhaengigkeitskarte standen auf
// gruen. Seitdem bricht der Check hier ab.
//
// NUR let/const/class. `function` und `var` duerfen sich im Skript-Scope
// ueberschreiben, und genau davon lebt das Umhuellen in voxeria-modding.js und
// voxeria-arena.js: das ist Absicht und darf nicht als Fehler gemeldet werden.
function checkRedeclared(files) {
  const owner = new Map();
  for (const f of files) {
    const code = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const names = new Set();
    let m;
    const re = /^(?:let|const|class)\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = re.exec(code))) names.add(m[1]);
    // Destructuring auf oberster Ebene zaehlt genauso.
    const reD = /^(?:let|const)\s*[[{]([^\]}]{0,400})[\]}]\s*=/gm;
    while ((m = reD.exec(code))) (m[1].match(/[A-Za-z_$][\w$]*/g) || []).forEach(x => names.add(x));
    for (const n of names) {
      if (!owner.has(n)) owner.set(n, []);
      owner.get(n).push(f);
    }
  }
  const kollisionen = [...owner.entries()].filter(e => e[1].length > 1);
  if (!kollisionen.length) {
    console.log('OK Namen:  keine doppelte let/const/class-Deklaration');
    return true;
  }
  console.log('X  Namen:  ' + kollisionen.length + ' Name(n) doppelt deklariert, das Spiel laedt so nicht');
  for (const [n, wo] of kollisionen) console.log('   ' + n + '  in  ' + wo.join('  und  '));
  return false;
}

// ------------------------------------------------------------------ Deps ---

// Namen, die die Laufzeit selbst mitbringt. Alles hier drin taucht in der
// Karte nicht auf, sonst geht das Signal im Rauschen unter.
const BUILTIN = new Set(('Array Object String Number Boolean Symbol BigInt Math JSON Date RegExp Error TypeError ' +
  'RangeError SyntaxError ReferenceError EvalError URIError Promise Map Set WeakMap WeakSet Proxy Reflect Function ' +
  'Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array ' +
  'BigInt64Array BigUint64Array ArrayBuffer SharedArrayBuffer DataView Atomics Intl globalThis ' +
  'window document console navigator location history screen performance localStorage sessionStorage indexedDB ' +
  'setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask ' +
  'fetch XMLHttpRequest WebSocket Worker Blob File FileReader URL URLSearchParams FormData Headers Request Response ' +
  'Image Audio AudioContext webkitAudioContext Path2D ImageData OffscreenCanvas ResizeObserver IntersectionObserver ' +
  'MutationObserver CustomEvent Event KeyboardEvent MouseEvent TouchEvent PointerEvent WheelEvent DragEvent ' +
  'HTMLElement HTMLCanvasElement HTMLImageElement HTMLInputElement Element Node NodeList DOMParser TextEncoder TextDecoder ' +
  'parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape ' +
  'alert confirm prompt structuredClone crypto matchMedia getComputedStyle devicePixelRatio innerWidth innerHeight ' +
  'undefined NaN Infinity arguments eval ' +
  'require module exports process Buffer setImmediate ' +
  'firebase').split(/\s+/));

// Sprachschluesselwoerter. Die stehen sonst als "fremder Name" in der Karte.
const KEYWORD = new Set(('var let const function class return if else for while do switch case break continue ' +
  'new delete typeof instanceof in of void throw try catch finally yield await async static get set extends ' +
  'import export default from as with debugger this super null true false').split(/\s+/));

// Kommentare und Strings raus, bevor irgendetwas gezaehlt wird. Ohne das
// zaehlt jedes Wort in jedem Hilfetext als Bezeichner. Code in ${...} zaehlt
// weiterhin, denn das ist echter Code.
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === '\'' || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          const start = i;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0) i++;
          }
          out += ' ' + strip(src.slice(start, i)) + ' ';
          i++;
          continue;
        }
        i++;
      }
      i++;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Was eine Datei in den globalen Namensraum stellt. Entscheidend ist hier die
// EINRUECKUNG: Voxerias Dateien sind flache Skripte, in denen alles auf
// Spaltenposition 0 global wird und alles Eingerueckte in einer Funktion sitzt
// und niemanden ausserhalb interessiert. Ohne diese Regel zaehlt jede
// Schleifenvariable `i` aus jeder Datei als Abhaengigkeit und die Karte wird
// unlesbar. Dateien, die komplett in einer IIFE liegen, exportieren ueber
// window.X, deshalb zaehlt das ebenfalls.
function declaredIn(code) {
  const names = new Set();
  const collect = (re, group) => {
    let m;
    while ((m = re.exec(code))) {
      const src = m[group || 1];
      (src.match(/[A-Za-z_$][\w$]*/g) || []).forEach(x => names.add(x));
    }
  };
  // Nur Zeilenanfang ohne Einrueckung: das ist der globale Namensraum.
  collect(/^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm);
  collect(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm);
  collect(/^class\s+([A-Za-z_$][\w$]*)/gm);
  collect(/^(?:var|let|const)\s*[[{]([^\]}]{0,400})[\]}]\s*=/gm);
  // Bewusste Exporte aus gekapselten Dateien.
  collect(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g);
  return names;
}

// Alles, was irgendwo in der Datei deklariert wird, egal auf welcher Ebene.
// Wird nur gebraucht, um eigene lokale Namen NICHT als fremd zu melden.
function localsIn(code) {
  const names = new Set();
  const collect = re => {
    let m;
    while ((m = re.exec(code))) {
      (m[1].match(/[A-Za-z_$][\w$]*/g) || []).forEach(x => names.add(x));
    }
  };
  collect(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g);
  collect(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g);
  collect(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  collect(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g);
  collect(/\b(?:var|let|const)\s*[[{]([^\]}]{0,400})[\]}]\s*=/g);
  collect(/([A-Za-z_$][\w$]*)\s*=>/g);

  // Parameterlisten: "(a, b) {" oder "(a, b) =>". Die Klammer VOR einem Block
  // sieht aber genauso aus wie die von if/for/while, und die enthaelt keine
  // Parameter, sondern gelesene Namen.
  //
  // Ohne diese Unterscheidung galt jeder Name in jeder Bedingung als lokal.
  // In voxeria-worldgen.js verschwanden dadurch BLOCKS, CHUNK_W, WORLD_H und
  // currentDim komplett aus der Karte, obwohl die Datei sie 94, 64, 35 und 15
  // Mal aus der Engine liest. Die Karte hat Abhaengigkeiten also verschwiegen,
  // nicht erfunden, und die frueheren Zahlen waren zu niedrig.
  const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else', 'return', 'typeof', 'in', 'of', 'await', 'yield', 'new', 'delete', 'void', 'case']);
  const re = /([A-Za-z_$][\w$]*)?\s*\(([^()]{0,400})\)\s*(?:=>|\{)/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[1] && CONTROL.has(m[1])) continue;
    (m[2].match(/[A-Za-z_$][\w$]*/g) || []).forEach(x => names.add(x));
  }
  return names;
}

// Alles, was wie ein gelesener Bezeichner aussieht. Property-Zugriffe
// (foo.bar) und Objekt-Schluessel (bar:) fallen raus, denn die haengen nicht
// am globalen Namensraum.
function usedIn(code) {
  const names = new Set();
  // Spread und Rest zuerst weg. Vor dem Namen steht dort ein Punkt, und die
  // Regel unten wirft alles nach einem Punkt raus, weil das ein
  // Property-Zugriff ist. `...customOreTiers` ist aber kein Zugriff auf ein
  // Feld, sondern eine ganz normale Lesestelle, und genau die eine ist der
  // Karte dadurch entgangen. In gueltigem JavaScript sind drei Punkte immer
  // Spread oder Rest, nie ein Zugriff, das Ersetzen ist also gefahrlos.
  code = code.replace(/\.\.\./g, ' ');
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)(\s*)(:?)/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[4] === ':') continue;
    const name = m[2];
    if (KEYWORD.has(name) || BUILTIN.has(name)) continue;
    names.add(name);
  }
  return names;
}

function checkDeps() {
  const files = existing().filter(f => f !== 'main.js' && f !== 'build-zip.js');
  const decl = new Map();
  const local = new Map();
  const used = new Map();

  for (const f of files) {
    const code = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    decl.set(f, declaredIn(code));
    local.set(f, localsIn(code));
    used.set(f, usedIn(code));
  }

  // Wer deklariert einen Namen? Mehrfachnennung ist ein eigenes Signal.
  const owner = new Map();
  for (const [f, names] of decl) {
    for (const n of names) {
      if (!owner.has(n)) owner.set(n, []);
      owner.get(n).push(f);
    }
  }

  const rows = [];
  for (const f of files) {
    const mine = local.get(f);
    const foreign = new Map();
    const all = new Set();
    for (const n of used.get(f)) {
      if (mine.has(n)) continue;
      const owners = (owner.get(n) || []).filter(o => o !== f);
      if (!owners.length) continue;
      all.add(n);
      for (const o of owners) {
        if (!foreign.has(o)) foreign.set(o, new Set());
        foreign.get(o).add(n);
      }
    }
    rows.push({ file: f, total: all.size, foreign: foreign });
  }

  rows.sort((a, b) => a.total - b.total);

  console.log('');
  console.log('   Abhaengigkeiten: welche fremden Namen eine Datei liest');
  console.log('   Aufsteigend. Oben steht, was am leichtesten herausloesbar ist.');
  console.log('');
  for (const r of rows) {
    console.log('   ' + String(r.total).padStart(4) + '  ' + r.file);
    const parts = [...r.foreign.entries()].sort((a, b) => b[1].size - a[1].size);
    for (const [src, set] of parts.slice(0, 4)) {
      const list = [...set].sort();
      const short = src.replace('voxeria-', '').replace('.js', '');
      console.log('         von ' + short + ' (' + set.size + '): ' +
                  list.slice(0, 6).join(', ') + (list.length > 6 ? ' ...' : ''));
    }
  }

  const shared = [...owner.entries()].filter(entry => entry[1].length > 1);
  if (shared.length) {
    console.log('');
    console.log('   Derselbe Name in mehreren Dateien deklariert (' + shared.length + '):');
    const sample = shared.slice(0, 14).map(entry => entry[0] + ' [' + entry[1].length + ']');
    console.log('   ' + sample.join(', ') + (shared.length > 14 ? ' ...' : ''));
  }
  console.log('');
  return true;
}

// ---------------------------------------------------------------- Cycles ---

// Die Karte zeigt, wer wen liest. Sie sagt aber nicht, wo daraus ein RING
// wird, und nur der ist das eigentliche Problem: A benutzt B ist gesund,
// A benutzt B und B benutzt A heisst, dass keines von beiden allein laufen,
// laden oder getestet werden kann.
//
//   node tools/check.js cycles
//
// Die kleinere der zwei Zahlen ist die Arbeit. Sie zeigt die Richtung, die
// vermutlich falsch herum ist, denn ein Feature darf das Fundament benutzen,
// aber nicht umgekehrt.
function checkCycles() {
  const files = existing().filter(f => f !== 'main.js' && f !== 'build-zip.js');
  const info = new Map();
  for (const f of files) {
    const code = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    info.set(f, { decl: declaredIn(code), local: localsIn(code), used: usedIn(code) });
  }

  const reads = (a, b) => {
    const A = info.get(a), B = info.get(b);
    return [...A.used].filter(n => !A.local.has(n) && B.decl.has(n));
  };

  const short = f => f.replace('voxeria-', '').replace('.js', '');
  const pairs = [];
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const ab = reads(files[i], files[j]);
      const ba = reads(files[j], files[i]);
      if (!ab.length || !ba.length) continue;
      const klein = ab.length <= ba.length
        ? { von: files[i], nach: files[j], n: ab.length, namen: ab }
        : { von: files[j], nach: files[i], n: ba.length, namen: ba };
      pairs.push({ a: files[i], b: files[j], ab: ab.length, ba: ba.length, klein: klein });
    }
  }
  pairs.sort((x, y) => x.klein.n - y.klein.n);

  const offen = pairs.reduce((n, p) => n + p.klein.n, 0);
  console.log('');
  console.log('   Ringe: ' + pairs.length + ' Dateipaare lesen sich gegenseitig');
  console.log('   Zu loesen sind ' + offen + ' Namen, naemlich jeweils die kleinere Richtung.');
  console.log('');
  for (const p of pairs) {
    console.log('   ' + String(p.klein.n).padStart(4) + '  ' +
                short(p.klein.von) + ' -> ' + short(p.klein.nach) +
                '   (zurueck: ' + (p.klein.von === p.a ? p.ba : p.ab) + ')');
    const namen = [...new Set(p.klein.namen)].sort();
    for (let i = 0; i < namen.length; i += 4) {
      console.log('         ' + namen.slice(i, i + 4).map(n => n.padEnd(24)).join('').trimEnd());
    }
  }
  console.log('');
  return true;
}

// ------------------------------------------------------------------- Why ---

// Die Karte sagt, DASS zwei Dateien aneinander haengen. Zum Entwirren braucht
// man die vollstaendige Namensliste in beide Richtungen, nicht die ersten
// sechs. Genau das macht dieser Modus:
//
//   node tools/check.js why engine dimensions-progress
//
// Der Dateiname darf abgekuerzt werden, "voxeria-" und ".js" fallen weg.
function checkWhy(aArg, bArg) {
  const files = existing().filter(f => f !== 'main.js' && f !== 'build-zip.js');
  const resolve = arg => files.find(f => f === arg || f === 'voxeria-' + arg + '.js' || f.includes(arg));
  const a = resolve(aArg);
  const b = resolve(bArg);
  if (!a || !b) {
    console.log('   Unbekannt: ' + (a ? bArg : aArg));
    console.log('   Bekannt: ' + files.map(f => f.replace('voxeria-', '').replace('.js', '')).join(', '));
    return false;
  }

  const read = f => {
    const code = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    return { decl: declaredIn(code), local: localsIn(code), used: usedIn(code) };
  };
  const A = read(a);
  const B = read(b);

  const between = (from, to, fromName, toName) => {
    const list = [...from.used].filter(n => !from.local.has(n) && to.decl.has(n)).sort();
    console.log('');
    console.log('   ' + fromName + '  ->  ' + toName + '   (' + list.length + ')');
    for (let i = 0; i < list.length; i += 4) {
      console.log('      ' + list.slice(i, i + 4).map(n => n.padEnd(26)).join('').trimEnd());
    }
    return list;
  };

  const short = f => f.replace('voxeria-', '').replace('.js', '');
  const ab = between(A, B, short(a), short(b));
  const ba = between(B, A, short(b), short(a));

  const both = ab.filter(n => ba.includes(n));
  if (both.length) {
    console.log('');
    console.log('   In BEIDE Richtungen gelesen (' + both.length + '): ' + both.join(', '));
  }
  console.log('');
  return true;
}

// ------------------------------------------------------------------ Main ---

const mode = process.argv[2] || 'all';
let ok = true;
if (mode === 'why') ok = checkWhy(process.argv[3], process.argv[4]);
else if (mode === 'cycles') ok = checkCycles();
else {
  if (mode === 'all' || mode === 'syntax') ok = checkSyntax() && ok;
  if (mode === 'all' || mode === 'deps') checkDeps();
}
process.exit(ok ? 0 : 1);
