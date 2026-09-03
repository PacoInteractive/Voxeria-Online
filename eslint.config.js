// ============================================================================
// VOXERIA -- LINT
// ----------------------------------------------------------------------------
//   npm run lint         meldet
//   npm run lint:fix     repariert, was sich sicher reparieren laesst
//
// WAS HIER BEWUSST FEHLT: Stilregeln. Keine Einrueckung, keine Anfuehrungs-
// zeichen, keine Semikolons, kein Prettier. Der Code dieses Projekts ist von
// Hand gesetzt, und an mehreren Stellen ist die Form die Aussage: die
// Zeichenkette in _gameLoopInner steht in EINER Zeile, weil sie eine
// Reihenfolge ist und keine Liste, und die Kommentarbloecke sind auf Breite
// gesetzt. Ein Formatierer wuerde das alles umbrechen, einen Diff ueber
// zehntausende Zeilen erzeugen und `git blame` fuer die gesamte Codebasis
// wertlos machen. Das uebliche Argument fuer einen Formatierer ("dann muss
// niemand mehr ueber Leerzeichen streiten") greift bei einem Projekt mit
// einem Autor nicht.
//
// WAS HIER STEHT: Regeln, die FEHLER finden. Vor allem eine.
//
// no-undef ist fuer dieses Projekt die wichtigste Regel ueberhaupt, und
// gleichzeitig die, die am schwersten einzurichten war. Alle Spieldateien sind
// klassische Skripte und teilen sich EINEN globalen Scope (siehe
// DATEISTRUKTUR.md). Ein Linter sieht aber immer nur eine Datei. Ohne Hilfe
// haelt er jeden Aufruf ueber Dateigrenzen hinweg fuer einen undefinierten
// Namen, meldet Tausende von Treffern, und man schaltet ihn nach zwei Minuten
// wieder ab.
//
// Deshalb liest diese Datei die Globals aus demselben Scanner, den auch
// `npm run check` benutzt: alle Deklarationen auf oberster Ebene aus allen
// ausgelieferten Dateien. Eine von Hand gepflegte Liste waere nach der ersten
// neuen Funktion veraltet, und ein Linter mit veralteter Liste meldet entweder
// Unsinn oder schweigt zu echten Fehlern.
//
// Was danach uebrig bleibt, ist echt: Tippfehler, Reste geloeschter Funktionen
// und Namen, die jemand in einer Datei erwartet, wo sie nie standen.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { ROOT, existing, strip, declaredIn, BUILTIN } = require('./tools/check.js');

// Alles, was irgendeine ausgelieferte Datei auf oberster Ebene deklariert.
// 'writable', nicht 'readonly': mehrere Dateien schreiben absichtlich in
// fremde Namen (die Ueberschreib-Ebene, das Umhuellen in voxeria-modding.js),
// und das ist hier kein Fehler, sondern das dokumentierte Muster.
function projektGlobals() {
  const g = {};
  for (const f of existing()) {
    if (f === 'main.js' || f === 'build-zip.js') continue;
    const code = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const name of declaredIn(code)) g[name] = 'writable';
  }
  return g;
}

// Der Browser bringt diese mit. Dieselbe Liste, die auch die
// Abhaengigkeitskarte benutzt, damit es nur eine Wahrheit gibt.
function browserGlobals() {
  const g = {};
  for (const name of BUILTIN) g[name] = 'readonly';
  return g;
}

// Vom Hosting eingespritzt, falls vorhanden. Beide Lesestellen in
// voxeria-engine.js pruefen vorher mit typeof, das Spiel laeuft also auch ohne.
const PLATTFORM = ['__app_id', '__initial_auth_token'];

// Firebase kommt als ES-Modul im <head> von index.html herein und legt seine
// Funktionen auf window. Fuer den Linter sind das freie Namen.
const FIREBASE = ['initializeApp', 'getAuth', 'signInAnonymously', 'onAuthStateChanged',
  'getFirestore', 'collection', 'doc', 'setDoc', 'getDoc', 'getDocs', 'deleteDoc',
  'updateDoc', 'onSnapshot', 'query', 'where', 'orderBy', 'limit', 'serverTimestamp',
  'writeBatch', 'runTransaction', 'increment', 'arrayUnion', 'arrayRemove'];

module.exports = [
  {
    // Nur die ausgelieferten Spieldateien. Backups, Kopien und die Website
    // draussen, sonst faerbt eine Datei, die niemand laedt, den Bericht rot.
    files: ['voxeria-*.js'],
    ignores: ['* - Kopie.js', 'voxeria-site.html'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: Object.assign(
        browserGlobals(),
        Object.fromEntries(FIREBASE.concat(PLATTFORM).map(n => [n, 'readonly'])),
        projektGlobals()
      )
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      // ── Die eigentliche Ausbeute ──
      'no-undef': 'error',

      // ── Fehler, die still falsch rechnen ──
      'no-dupe-keys': 'error',          // zweiter Schluessel gewinnt, der erste ist tot
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',        // Code hinter return/throw
      'no-cond-assign': 'error',        // if (a = b) statt if (a === b)
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-sparse-arrays': 'error',      // [1, , 2] ist fast immer ein Tippfehler
      'use-isnan': 'error',             // x === NaN ist immer false
      'valid-typeof': 'error',          // typeof x === 'strnig'
      'no-compare-neg-zero': 'error',
      'no-unsafe-negation': 'error',    // !a in b statt !(a in b)
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-obj-calls': 'error',
      'no-setter-return': 'error',
      'no-unsafe-finally': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'off',  // zu viele Fehlalarme bei Firebase-Callbacks

      // ── Aufraeumen, aber nur als Hinweis ──
      // args: 'none', weil Callback-Signaturen oft mehr Parameter haben, als
      // der eine Aufruf braucht, und das kein Fehler ist.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },
  {
    // Werkzeuge und Electron laufen in Node, nicht im Browser.
    files: ['tools/**/*.js', 'build-zip.js', 'main.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', exports: 'writable',
                 process: 'readonly', __dirname: 'readonly', __filename: 'readonly',
                 console: 'readonly', Buffer: 'readonly' }
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none' }] }
  }
];
