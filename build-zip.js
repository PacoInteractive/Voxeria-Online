const fs = require('fs');
const path = require('path');
const archiver = require('archiver'); // npm install archiver --save-dev

const OUTPUT_ZIP = 'Voxeria_pitch_build.zip';

// 1. Temp index.html ohne voxeria-director.js erstellen
let htmlContent = fs.readFileSync('index.html', 'utf8');
const cleanedHtml = htmlContent.replace(/<script src=["']voxeria-director\.js["']><\/script>\n?/g, '');
fs.writeFileSync('index.build.html', cleanedHtml);

const output = fs.createWriteStream(OUTPUT_ZIP);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`Build erfolgreich! Archiv-Groesse: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
  fs.unlinkSync('index.build.html'); // Cleanup Temp
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
  if (!fs.existsSync(file)) {
    console.error(`FEHLER: index.html referenziert "${file}", die Datei fehlt aber im Ordner.`);
    process.exit(1);
  }
  archive.file(file, { name: file });
});

// Assets & Musik-Ordner
archive.directory('Assets/', 'Assets');
archive.directory('Music/', 'Music');

archive.finalize();
