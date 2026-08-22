const fs = require('fs');
const path = require('path');
const archiver = require('archiver'); // npm install archiver --save-dev

const OUTPUT_ZIP = 'Voxeria_pitch_build.zip';

// 1. Temp index.html ohne voxeria-director.js erstellen
let htmlContent = fs.readFileSync('index.html', 'utf8');
const cleanedHtml = htmlContent.replace(/<script src=["']voxeria-director\.js["']><\/script>\n?/g, '');
fs.writeFileSync('index.build.html', cleanedHtml);

// Die vier Musikstuecke (MUSIC_B64 + Music/*.mp3) sind mit einem Suno-
// Gratis-Konto entstanden -- laut Sunos eigenen Bedingungen nur nicht-
// kommerziell nutzbar, Suno behaelt die Rechte. Duerfen deshalb NICHT in
// den Build, den ein Publisher zu sehen bekommt. Der normale itch.io-Build
// (npm run build:itch, falls es den gibt) bleibt davon unberuehrt -- das
// hier betrifft ausschliesslich Voxeria_pitch_build.zip. Sobald die Musik
// ersetzt oder rechtlich geklaert ist, kann dieser Block wieder raus.
// "AA==" statt "" -- MUSIC_TRACKS[0] hat kein `url`-Feld, nur `b64`, und
// loadMusicTrack() prueft `if (track.b64)`. Ein leerer String ist falsy und
// wuerde in den url-Fetch-Zweig rutschen (dort ist `track.url` undefined,
// das ergaebe ein sinnloses fetch("undefined")). "AA==" ist ein einzelnes
// Null-Byte -- bleibt truthy, nimmt den atob()-Pfad, decodeAudioData lehnt
// es sauber ab und der Track wird ganz normal als "broken" markiert, exakt
// der Pfad, den DATEISTRUKTUR.md fuer ein nicht ladbares Stueck beschreibt.
let engineContent = fs.readFileSync('voxeria-engine.js', 'utf8');
const engineWithoutMusic = engineContent.replace(/const MUSIC_B64 = "[^"]*";/, 'const MUSIC_B64 = "AA==";');
if (engineWithoutMusic === engineContent) {
  console.error('FEHLER: MUSIC_B64 in voxeria-engine.js nicht gefunden -- Musik-Ausschluss fuer den Pitch-Build konnte nicht angewendet werden.');
  process.exit(1);
}
fs.writeFileSync('voxeria-engine.build.js', engineWithoutMusic);

const output = fs.createWriteStream(OUTPUT_ZIP);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`Build erfolgreich! Archiv-Groesse: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
  console.log('Hinweis: Musik ausgeschlossen (Suno-Gratis-Tarif, nicht kommerziell nutzbar). Spiel laeuft ohne Hintergrundmusik.');
  fs.unlinkSync('index.build.html'); // Cleanup Temp
  fs.unlinkSync('voxeria-engine.build.js'); // Cleanup Temp
});

archive.on('error', (err) => { throw err; });

archive.pipe(output);

// Dateien hinzufuegen
archive.file('index.build.html', { name: 'index.html' });
archive.file('package.json', { name: 'package.json' });
archive.file('main.js', { name: 'main.js' });
archive.file('DATEISTRUKTUR.md', { name: 'DATEISTRUKTUR.md' });

// Skripte NICHT per Ordner-Glob einsammeln -- ein loses "voxeria-*.js" greift
// auch Streu-Kopien im Ordner (z.B. Arbeitskopien mit " - Kopie" im Namen),
// die in keinem <script src> referenziert sind. Stattdessen exakt die Tags
// aus der (bereinigten) index.html lesen -- das ist automatisch dieselbe
// Liste, die der Build tatsaechlich laedt, und director.js ist durch den
// Cleanup-Schritt oben schon draussen.
const scriptTags = [...cleanedHtml.matchAll(/<script src=["']([^"']+\.js)["']><\/script>/g)]
  .map(m => m[1])
  .filter(src => !src.includes('/')); // nur lokale Root-Dateien, keine CDN-URLs

scriptTags.forEach(file => {
  // voxeria-engine.js kommt aus der Musik-bereinigten Temp-Kopie, nicht aus
  // dem Original -- siehe engineWithoutMusic oben.
  if (file === 'voxeria-engine.js') {
    archive.file('voxeria-engine.build.js', { name: 'voxeria-engine.js' });
    return;
  }
  if (!fs.existsSync(file)) {
    console.error(`FEHLER: index.html referenziert "${file}", die Datei fehlt aber im Ordner.`);
    process.exit(1);
  }
  archive.file(file, { name: file });
});

// Assets, aber bewusst OHNE Music/ -- siehe Kommentar bei engineWithoutMusic.
archive.directory('Assets/', 'Assets');

archive.finalize();
