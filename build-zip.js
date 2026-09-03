// ============================================================================
// VOXERIA -- BUILD
// ----------------------------------------------------------------------------
//   npm run build        ->  Pitch-Build   (ohne Musik, fuer Publisher)
//   npm run build:itch   ->  itch.io-Build (mit Musik, zum Hochladen)
//
// Beide Ziele nehmen dieselbe Dateiliste aus denselben <script src>-Tags in
// index.html. Der Unterschied zwischen ihnen ist ausschliesslich die Musik,
// und der ist unten in TARGETS in zwei Zeilen zu sehen statt in zwei Skripten,
// die auseinanderlaufen koennen.
//
// Warum es den itch-Build ueberhaupt als Befehl gibt: er wurde vorher von Hand
// zusammengesetzt, indem ein altes ZIP kopiert und einzelne Dateien darin
// ersetzt wurden. Das funktioniert, solange man an jede geaenderte Datei
// denkt, und genau daran denkt man irgendwann nicht. Eine neu hinzugekommene
// Datei (zuletzt voxeria-tests.js) haette dabei stillschweigend gefehlt, und
// das faellt erst auf, wenn ein Spieler eine leere Seite sieht.
//
// Nach dem Packen prueft sich der Build selbst (siehe pruefeInhalt unten): war
// ein Skript aus index.html nicht dabei, oder ist die Musik im falschen Ziel
// gelandet, bricht er ab statt ein kaputtes ZIP abzuliefern.
// ============================================================================

const fs = require('fs');
const archiver = require('archiver');   // npm install archiver --save-dev

function heute() {
  const d = new Date();
  const zwei = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + zwei(d.getMonth() + 1) + '-' + zwei(d.getDate());
}

// ---------------------------------------------------------------------------
// Die zwei Ziele
// ---------------------------------------------------------------------------
// Die vier Musikstuecke (MUSIC_B64 im Engine-Code + Music/*.mp3) sind mit
// einem Suno-Gratis-Konto entstanden. Laut Sunos eigenen Bedingungen nur
// nicht-kommerziell nutzbar, die Rechte bleiben bei Suno. Sie duerfen deshalb
// NICHT in den Build, den ein Publisher zu sehen bekommt. Sobald die Musik
// ersetzt oder rechtlich geklaert ist, kann `musikRaus` bei 'pitch' auf false.
const TARGETS = {
  pitch: {
    beschreibung: 'Pitch-Build fuer Publisher',
    standardName: 'Voxeria_pitch_build.zip',
    musikRaus: true,      // MUSIC_B64 im Engine-Code durch eine Attrappe ersetzen
    musikOrdner: false,   // Music/*.mp3 nicht mitpacken
    // Electron-Dateien: der Pitch-Build ist auch die Vorlage fuer den
    // Desktop-Build, deshalb liegen sie hier bei.
    extras: ['package.json', 'main.js', 'DATEISTRUKTUR.md']
  },
  itch: {
    beschreibung: 'itch.io-Build zum Hochladen',
    standardName: 'Voxeria_itch_build_' + heute() + '.zip',
    musikRaus: false,
    musikOrdner: true,
    // Kein package.json und kein main.js: itch laedt index.html im Browser,
    // die beiden sind reine Electron-Dateien und wurden dort auch bisher nie
    // mitgeliefert.
    //
    // build-zip.js lag im bisherigen, von Hand gebauten itch-ZIP mit drin.
    // Das war ein Versehen und ist hier bewusst nicht uebernommen: das
    // Build-Skript wird vom Spiel nicht geladen und hat in einem Build fuer
    // Spieler nichts verloren. Soll es wieder rein, hier eintragen.
    extras: ['DATEISTRUKTUR.md']
  }
};

const ZIEL_NAME = (process.argv[2] || process.env.VOXERIA_BUILD_TARGET || 'pitch').toLowerCase();
const ZIEL = TARGETS[ZIEL_NAME];
if (!ZIEL) {
  console.error('FEHLER: unbekanntes Ziel "' + ZIEL_NAME + '". Moeglich: ' + Object.keys(TARGETS).join(', '));
  process.exit(1);
}
// VOXERIA_BUILD_OUTPUT bleibt erhalten: damit laesst sich ein Testbuild bauen,
// ohne das letzte gute Archiv zu ueberschreiben.
const OUTPUT_ZIP = process.env.VOXERIA_BUILD_OUTPUT || ZIEL.standardName;

// ---------------------------------------------------------------------------
// 1. index.html ohne voxeria-director.js
// ---------------------------------------------------------------------------
const TEMP_HTML = 'index.build.html';
const TEMP_ENGINE = 'voxeria-engine.build.js';
const tempDateien = [];

function aufraeumen() {
  for (const f of tempDateien) { try { fs.unlinkSync(f); } catch (e) {} }
}
function abbruch(nachricht) {
  console.error('FEHLER: ' + nachricht);
  aufraeumen();
  process.exit(1);
}

const htmlContent = fs.readFileSync('index.html', 'utf8');
const cleanedHtml = htmlContent.replace(/<script src=["']voxeria-director\.js["'](?:\?[^"']*)?><\/script>\n?/g, '');
fs.writeFileSync(TEMP_HTML, cleanedHtml);
tempDateien.push(TEMP_HTML);

// ---------------------------------------------------------------------------
// 2. Engine, je nach Ziel mit oder ohne eingebettete Musik
// ---------------------------------------------------------------------------
// "AA==" statt "" -- MUSIC_TRACKS[0] hat kein `url`-Feld, nur `b64`, und
// loadMusicTrack() prueft `if (track.b64)`. Ein leerer String ist falsy und
// wuerde in den url-Fetch-Zweig rutschen (dort ist `track.url` undefined, das
// ergaebe ein sinnloses fetch("undefined")). "AA==" ist ein einzelnes
// Null-Byte: bleibt truthy, nimmt den atob()-Pfad, decodeAudioData lehnt es
// sauber ab und der Track wird ganz normal als "broken" markiert, exakt der
// Pfad, den DATEISTRUKTUR.md fuer ein nicht ladbares Stueck beschreibt.
let engineQuelle = 'voxeria-engine.js';
if (ZIEL.musikRaus) {
  const engineContent = fs.readFileSync('voxeria-engine.js', 'utf8');
  const ohneMusik = engineContent.replace(/const MUSIC_B64 = "[^"]*";/, 'const MUSIC_B64 = "AA==";');
  if (ohneMusik === engineContent) {
    abbruch('MUSIC_B64 in voxeria-engine.js nicht gefunden, der Musik-Ausschluss konnte nicht angewendet werden.');
  }
  fs.writeFileSync(TEMP_ENGINE, ohneMusik);
  tempDateien.push(TEMP_ENGINE);
  engineQuelle = TEMP_ENGINE;
}

// ---------------------------------------------------------------------------
// 3. Dateiliste aus den Script-Tags
// ---------------------------------------------------------------------------
// Skripte NICHT per Ordner-Glob einsammeln -- ein loses "voxeria-*.js" greift
// auch Streu-Kopien im Ordner (z.B. Arbeitskopien mit " - Kopie" im Namen),
// die in keinem <script src> referenziert sind. Stattdessen exakt die Tags aus
// der (bereinigten) index.html lesen: das ist automatisch dieselbe Liste, die
// der Build tatsaechlich laedt, und director.js ist oben schon draussen.
// (?:\?[^"']*)? ueberspringt den Cache-Buster (z.B. "?v=2", siehe Kommentar an
// den Script-Tags in index.html), damit die Gruppe der reine Dateiname bleibt.
const scriptTags = [...cleanedHtml.matchAll(/<script src=["']([^"'?]+\.js)(?:\?[^"']*)?["']><\/script>/g)]
  .map(m => m[1])
  .filter(src => !src.includes('/'));   // nur lokale Root-Dateien, keine CDN-URLs

if (!scriptTags.length) abbruch('in index.html wurde kein einziges <script src> gefunden.');

for (const f of scriptTags) {
  if (f === 'voxeria-engine.js') continue;   // kommt aus engineQuelle
  if (!fs.existsSync(f)) abbruch(`index.html referenziert "${f}", die Datei fehlt aber im Ordner.`);
}
for (const f of ZIEL.extras) {
  if (!fs.existsSync(f)) abbruch(`"${f}" gehoert in den ${ZIEL_NAME}-Build, fehlt aber im Ordner.`);
}
if (!fs.existsSync('Assets')) abbruch('der Ordner Assets/ fehlt.');
if (ZIEL.musikOrdner && !fs.existsSync('Music')) abbruch('der Ordner Music/ fehlt, wird fuer den itch-Build aber gebraucht.');

// ---------------------------------------------------------------------------
// 4. Packen
// ---------------------------------------------------------------------------
const output = fs.createWriteStream(OUTPUT_ZIP);
const archive = archiver('zip', { zlib: { level: 9 } });

// Jeder Eintrag wird hier mitgeschrieben, damit der Build danach pruefen kann,
// was er wirklich gepackt hat, statt es nur zu behaupten.
const eintraege = [];
function packe(quelle, name) { archive.file(quelle, { name }); eintraege.push(name); }

function zaehleOrdner(dir) {
  let n = 0;
  for (const eintrag of fs.readdirSync(dir, { withFileTypes: true })) {
    n += eintrag.isDirectory() ? zaehleOrdner(dir + '/' + eintrag.name) : 1;
  }
  return n;
}

output.on('close', () => {
  const mb = (archive.pointer() / 1024 / 1024).toFixed(2);
  pruefeInhalt(mb);
  aufraeumen();
});

archive.on('error', err => { throw err; });
archive.pipe(output);

packe(TEMP_HTML, 'index.html');
for (const f of ZIEL.extras) packe(f, f);
for (const f of scriptTags) {
  if (f === 'voxeria-engine.js') packe(engineQuelle, 'voxeria-engine.js');
  else packe(f, f);
}

const assetsAnzahl = zaehleOrdner('Assets');
archive.directory('Assets/', 'Assets');

let musikAnzahl = 0;
if (ZIEL.musikOrdner) {
  musikAnzahl = zaehleOrdner('Music');
  archive.directory('Music/', 'Music');
}

archive.finalize();

// ---------------------------------------------------------------------------
// 5. Selbstpruefung
// ---------------------------------------------------------------------------
// Der Build sagt nicht nur "fertig", sondern auch, woraus das ZIP besteht, und
// bricht ab, wenn etwas fehlt. Genau der Fall, der von Hand passiert waere:
// eine neue Datei kommt in index.html dazu und nicht in den Build.
function pruefeInhalt(mb) {
  const fehler = [];

  if (eintraege.indexOf('index.html') < 0) fehler.push('index.html fehlt im Archiv.');
  for (const f of scriptTags) {
    if (eintraege.indexOf(f) < 0) fehler.push(`"${f}" steht in index.html, wurde aber nicht gepackt.`);
  }
  for (const f of ZIEL.extras) {
    if (eintraege.indexOf(f) < 0) fehler.push(`"${f}" fehlt im Archiv.`);
  }
  if (!assetsAnzahl) fehler.push('Assets/ ist leer.');
  if (ZIEL.musikOrdner && !musikAnzahl) fehler.push('Music/ ist leer, der itch-Build braucht die Stuecke.');

  // Die Musikregel gegenpruefen statt ihr zu vertrauen: beim Pitch-Build muss
  // die Attrappe wirklich in der gepackten Engine stehen, beim itch-Build darf
  // sie es gerade nicht.
  const gepackteEngine = fs.readFileSync(engineQuelle, 'utf8');
  const attrappe = gepackteEngine.indexOf('const MUSIC_B64 = "AA==";') >= 0;
  if (ZIEL.musikRaus && !attrappe) fehler.push('die gepackte Engine enthaelt noch echte Musikdaten.');
  if (!ZIEL.musikRaus && attrappe) fehler.push('die gepackte Engine enthaelt die Musik-Attrappe, obwohl dieses Ziel Musik behalten soll.');

  const dateien = eintraege.length + assetsAnzahl + musikAnzahl;
  if (fehler.length) {
    console.error(`\nBuild FEHLGESCHLAGEN (${ZIEL.beschreibung}): ${fehler.length} Problem(e)`);
    fehler.forEach(f => console.error('   ' + f));
    aufraeumen();
    process.exit(1);
  }

  console.log(`\n${ZIEL.beschreibung}`);
  console.log(`  Datei     ${OUTPUT_ZIP}  (${mb} MB)`);
  console.log(`  Inhalt    ${dateien} Dateien: ${scriptTags.length} Skripte, ${assetsAnzahl} Assets` +
              (ZIEL.musikOrdner ? `, ${musikAnzahl} Musikstuecke` : ', ohne Musik'));
  if (ZIEL.musikRaus) {
    console.log('  Hinweis   Musik ausgeschlossen (Suno-Gratis-Tarif, nicht kommerziell nutzbar).');
  }
  console.log('  Geprueft  jedes <script src> aus index.html ist im Archiv.\n');
}
