// ============================================================================
// VOXERIA -- KOMMENTARE FUER DEN BUILD ENTFERNEN
// ----------------------------------------------------------------------------
// Wird von build-zip.js benutzt und veraendert NIE eine Datei im Ordner. Der
// Quellcode behaelt seine Kommentare, das ZIP bekommt sie nicht.
//
// WARUM NUR IM BUILD
// Die Kommentare in diesem Projekt sind zu einem grossen Teil Begruendungen,
// die sonst nirgends stehen: warum "AA==" und nicht "", warum die Autoren im
// Koop angehaengt und nicht sortiert werden. Sie aus den Dateien zu loeschen
// waere ein Diff ueber zehntausende Zeilen, der git blame wertlos macht, und
// er waere fuer immer. Ein Schritt beim Packen kostet nichts und ist jederzeit
// zuruecknehmbar, indem man ihn wieder ausbaut.
//
// WARUM DIE ZEILENNUMMERN GLEICH BLEIBEN
// Jeder entfernte Kommentar hinterlaesst seine Umbrueche. Damit steht in Zeile
// 4711 der gepackten Datei dieselbe Anweisung wie in Zeile 4711 der Quelle,
// und ein Fehlerbericht aus der Konsole eines Spielers laesst sich ohne
// Umrechnung im Repository nachschlagen. Die leeren Zeilen kosten ein Byte
// pro Stueck; sie zusammenzuschieben wuerde ein paar Kilobyte sparen und diese
// Eigenschaft aufgeben. Der Tausch lohnt nicht.
//
// WARUM KEIN MINIFIER
// Ein Minifier wuerde zusaetzlich Namen kuerzen. Damit waere jeder Stacktrace
// aus einem ausgelieferten Build unlesbar, und in einem Spiel, dessen Mods aus
// einem geschlossenen Katalog ueber globale Namen laufen, ist das ein hoher
// Preis fuer wenig. Kommentare weg ist der Teil, der nichts kostet.
//
// DER SCANNER ist derselbe wie strip() in tools/check.js, mit einem anderen
// Ausgabeverhalten: dort werden Kommentare UND Strings ausgeblendet, weil nur
// das Codegeruest interessiert, hier faellt ausschliesslich der Kommentar weg
// und alles andere wird Zeichen fuer Zeichen durchgereicht. Die Heuristik, an
// der ein '/' als Division oder als Regex erkannt wird, ist bewusst dieselbe:
// sie laeuft ueber genau diese Dateien seit Monaten in jedem `npm run check`.
//
// GEPRUEFT WIRD TROTZDEM, siehe pruefe() unten. Auf eine Heuristik wird nichts
// gepackt, das nicht vorher gegengerechnet wurde.
//
//   node tools/strip-comments.js        Selbsttest, dann Ersparnis pro Datei
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// Der Scanner
// ---------------------------------------------------------------------------
// Gibt den Quelltext ohne Kommentare zurueck und, wenn `sammle` gesetzt ist,
// nebenbei jedes String-Literal so wie es dasteht. Die Liste ist kein Extra
// fuer den Aufrufer, sondern das Beweismittel in pruefe(): wenn vorher und
// nachher dieselben Literale in derselben Reihenfolge herauskommen, hat der
// Scanner in keinen String hineingeschnitten.
function scan(src, sammle) {
  const literale = sammle ? [] : null;

  // Die Umbrueche eines Stuecks, das gleich verschwindet. Ohne sie wuerde ein
  // Blockkommentar ueber 30 Zeilen die Datei um 30 Zeilen verkuerzen und jede
  // Zeilennummer dahinter waere falsch.
  const nl = text => {
    let k = 0;
    for (let j = 0; j < text.length; j++) if (text[j] === '\n') k++;
    return '\n'.repeat(k);
  };

  // Das letzte bedeutsame Zeichen, das als echter Code herauskam. Daran
  // entscheidet sich, ob ein '/' eine Division oder ein Regex-Literal
  // einleitet: nach einem Wert (Bezeichner, Ziffer, schliessende Klammer) ist
  // es eine Division, sonst ein Regex.
  let letztes = '';
  const merke = ch => { if (!/\s/.test(ch)) letztes = ch; };

  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // Zeilenkommentar. Der Umbruch dahinter bleibt stehen, weil er zur
    // naechsten Zeile gehoert und nicht zum Kommentar.
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // Blockkommentar. Ein nicht geschlossener bricht den Build ab statt still
    // den Rest der Datei zu schlucken: das waere der eine Fehler, den man erst
    // im fertigen ZIP sieht.
    if (c === '/' && d === '*') {
      const von = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i >= n) throw new Error('Blockkommentar ab Zeichen ' + von + ' wird nie geschlossen.');
      i += 2;
      out += nl(src.slice(von, i));
      continue;
    }

    // Regex-Literal. Ohne diesen Zweig verschluckt sich der Scanner an einer
    // Zeile wie
    //
    //   .replace(/"/g, '&quot;')
    //
    // Er sieht dort das Anfuehrungszeichen IM Regex, haelt es fuer einen
    // String-Anfang und ist ab da mit seinem Zustand allein. Eckige Klammern
    // zaehlen mit, damit ein '/' in einer Zeichenklasse wie [^/] das Literal
    // nicht vorzeitig beendet.
    if (c === '/' && !/[\w$)\]]/.test(letztes)) {
      const von = i;
      i++;
      let klasse = false;
      while (i < n) {
        const z = src[i];
        if (z === '\\') { i += 2; continue; }
        if (z === '\n') break;                  // ein Regex geht nie ueber Zeilen
        if (z === '[') klasse = true;
        else if (z === ']') klasse = false;
        else if (z === '/' && !klasse) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;   // Flags
      out += src.slice(von, i);
      merke('/');
      continue;
    }

    // String und Template-Literal. Beides wandert unveraendert durch, auch der
    // 9-MB-Base64-Block der Musik. Innerhalb von ${...} eines Templates steht
    // wieder Code, also auch wieder moeglicher Kommentar, deshalb der Rekurs.
    if (c === '"' || c === '\'' || c === '`') {
      const q = c;
      const von = i;
      i++;
      let stueck = q;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { stueck += src.slice(i, i + 2); i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let tiefe = 1;
          i += 2;
          const innen = i;
          while (i < n && tiefe > 0) {
            if (src[i] === '{') tiefe++;
            else if (src[i] === '}') tiefe--;
            if (tiefe > 0) i++;
          }
          const kern = scan(src.slice(innen, i), sammle);
          if (sammle) for (const l of kern.literale) literale.push(l);
          stueck += '${' + kern.code + '}';
          i++;
          continue;
        }
        stueck += src[i];
        i++;
      }
      if (i >= n) throw new Error('String ab Zeichen ' + von + ' wird nie geschlossen.');
      stueck += q;
      i++;
      out += stueck;
      if (sammle) literale.push(stueck);
      // Ein String ist ein Wert: ein '/' danach ist Division, kein Regex.
      merke('x');
      continue;
    }

    out += c;
    merke(c);
    i++;
  }

  return { code: out, literale: literale };
}

// Kommentare raus, danach am Zeilenende aufraeumen. Der zweite Schritt ist
// noetig, weil ein Kommentar hinter Code (`const x = 5;   // warum`) sonst
// seine Einrueckung als Leerzeichen zuruecklaesst.
function entferneKommentare(src) {
  return scan(src, false).code.replace(/[ \t]+$/gm, '');
}

// ---------------------------------------------------------------------------
// Die Gegenrechnung
// ---------------------------------------------------------------------------
// Drei Fragen, und jede deckt etwas ab, das die anderen beide nicht sehen:
//
//   1. Parst das Ergebnis noch?          faengt einen Schnitt mitten in den Code
//   2. Ist das Codegeruest unveraendert?  faengt geloeschten Code, der zufaellig
//                                         noch parst
//   3. Sind alle Literale unberuehrt?     faengt einen Schnitt IN einen String,
//                                         den Frage 2 nicht sehen kann, weil
//                                         check.js dort ohnehin alles ausblendet
//
// Frage 2 borgt sich strip() aus tools/check.js: das ist der Scanner, der
// Kommentare UND Strings zu Umbruechen macht. Bleibt davon vor und nach dem
// Entfernen dasselbe uebrig, ist zwischen den Kommentaren nichts abhanden
// gekommen.
function pruefe(original, entfernt, dateiname) {
  const { strip } = require('./check.js');

  try {
    new vm.Script(entfernt, { filename: dateiname });
  } catch (e) {
    return dateiname + ': parst nach dem Entfernen nicht mehr (' + e.message + ').';
  }

  // Zeilenenden auf beiden Seiten glattziehen, bevor verglichen wird. Ein
  // Kommentar hinter Code laesst beim Entfernen die Leerzeichen davor zurueck,
  // die wir wegputzen; in der Quelle stehen sie noch. Das ist der einzige
  // erlaubte Unterschied, und er darf die Frage nicht beantworten, ob Code
  // fehlt.
  const geruest = s => strip(s).replace(/[ \t]+$/gm, '');
  if (geruest(original) !== geruest(entfernt)) {
    return dateiname + ': das Codegeruest hat sich veraendert, es wurde mehr entfernt als Kommentar.';
  }

  const vorher = scan(original, true).literale;
  const nachher = scan(entfernt, true).literale;
  if (vorher.length !== nachher.length) {
    return dateiname + ': ' + vorher.length + ' Literale vorher, ' + nachher.length + ' nachher.';
  }
  for (let i = 0; i < vorher.length; i++) {
    if (vorher[i] !== nachher[i]) {
      return dateiname + ': Literal Nr. ' + (i + 1) + ' hat sich veraendert.';
    }
  }

  return null;
}

// Was build-zip.js aufruft: entfernen, gegenrechnen, und im Zweifel eine
// Fehlermeldung statt eines Ergebnisses. Ein ZIP wird lieber gar nicht gebaut
// als mit einer Datei, bei der eine Heuristik danebengelegen hat.
function bereinige(src, dateiname) {
  let entfernt;
  try {
    entfernt = entferneKommentare(src);
  } catch (e) {
    return { fehler: dateiname + ': ' + e.message };
  }
  const fehler = pruefe(src, entfernt, dateiname);
  if (fehler) return { fehler: fehler };
  return { code: entfernt, gespart: src.length - entfernt.length };
}

// ---------------------------------------------------------------------------
// Selbsttest
// ---------------------------------------------------------------------------
// Die Faelle, an denen ein naiver Ersetzer scheitert, alle in einer Liste
// statt in einem Kommentar, der behauptet sie seien bedacht.
const FAELLE = [
  ['Zeilenkommentar',        'const a = 1; // weg\n',            'const a = 1;\n'],
  ['Blockkommentar',         'const a = /* weg */ 1;',           'const a =  1;'],
  ['URL im String',          'const u = "http://x.de/y";',       'const u = "http://x.de/y";'],
  ['URL im Template',        'const u = `http://x.de`;',         'const u = `http://x.de`;'],
  ['Regex mit Schraegstrich', 'x.replace(/\\/\\//g, "");',       'x.replace(/\\/\\//g, "");'],
  ['Regex mit Anfuehrung',   'x.replace(/"/g, "&q;"); // weg',   'x.replace(/"/g, "&q;");'],
  ['Zeichenklasse',          'x.split(/[^/]+/); // weg',         'x.split(/[^/]+/);'],
  ['Division davor',         'const a = b / c; // weg',          'const a = b / c;'],
  ['Kommentar im Template',  'const t = `${a // weg\n}`;',       'const t = `${a\n}`;'],
  ['Sterne im String',       'const s = "/* kein Kommentar */";', 'const s = "/* kein Kommentar */";'],
  ['Umbrueche bleiben',      '/* eins\nzwei\ndrei */\nconst a=1;', '\n\n\nconst a=1;'],
  ['Escapetes Zitat',        'const s = "er sagte \\" // nein";', 'const s = "er sagte \\" // nein";']
];

function selbsttest() {
  let ok = true;
  for (const [name, ein, soll] of FAELLE) {
    let ist;
    try { ist = entferneKommentare(ein); }
    catch (e) { ist = 'FEHLER: ' + e.message; }
    if (ist !== soll) {
      ok = false;
      console.error('  FEHLGESCHLAGEN  ' + name);
      console.error('    erwartet  ' + JSON.stringify(soll));
      console.error('    bekommen  ' + JSON.stringify(ist));
    }
  }
  console.log(ok
    ? '  ' + FAELLE.length + ' Faelle, alle richtig.'
    : '  Selbsttest fehlgeschlagen.');
  return ok;
}

module.exports = { entferneKommentare, bereinige, selbsttest };

// ------------------------------------------------------------------ Main ---

if (require.main !== module) return;

console.log('\nSelbsttest');
if (!selbsttest()) process.exit(1);

console.log('\nErsparnis pro Datei');
const { ROOT, existing } = require('./check.js');
let summeVorher = 0, summeNachher = 0, probleme = 0;

for (const f of existing()) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const r = bereinige(src, f);
  if (r.fehler) { console.error('  ' + r.fehler); probleme++; continue; }
  summeVorher += src.length;
  summeNachher += r.code.length;
  const kb = (r.gespart / 1024).toFixed(1);
  const pct = src.length ? (r.gespart / src.length * 100).toFixed(0) : '0';
  console.log('  ' + f.padEnd(34) + kb.padStart(8) + ' KB  (' + pct.padStart(2) + ' %)');
}

const gespart = summeVorher - summeNachher;
console.log('  ' + '-'.repeat(52));
console.log('  ' + 'gesamt'.padEnd(34) + (gespart / 1024).toFixed(1).padStart(8) + ' KB  (' +
            (summeVorher ? (gespart / summeVorher * 100).toFixed(0) : '0').padStart(2) + ' %)\n');
process.exit(probleme ? 1 : 0);
