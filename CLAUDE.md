# Voxeria

2D-Voxel-Sandbox im Browser, Canvas-2D. Ein Autor: Jaylen Winkler.

Diese Datei ist die kurze Fassung, die bei jeder Sitzung mitgelesen wird.
Die lange Fassung steht in `DATEISTRUKTUR.md` (rund 1500 Zeilen, mit Begruendungen).
Wo hier etwas nur behauptet wird, steht dort das Warum.

## Die einzige Quelle

`index.html` plus die `voxeria-*.js`-Dateien daneben. Das gilt fuer Web **und**
Electron: `main.js` laedt dieselbe `index.html`, es gibt keine zweite Fassung.

Alles in `archive/`, `dist/`, `output/` und `Voxeria-win32-x64/` ist Backup oder
Build-Ausgabe. Nichts davon wird geladen, Aenderungen darin haben keine Wirkung.
Nicht dort suchen, nicht dort editieren.

## Ein globaler Scope, keine Module

Alle `.js` sind klassische Scripts ohne `import`/`export`. Jede Datei sieht jeden
globalen Namen jeder anderen. Daraus folgt alles Weitere:

* **Die Ladereihenfolge in `index.html` ist Programmlogik**, kein Detail.
  `voxeria-core.js` zuerst (Fundament: `BLOCKS`, `TILE`, `WORLD_H`, `CHUNK_W`,
  `seededRandom`, `VxHooks`), `voxeria-boot.js` zuletzt (startet das Spiel).
* Neue `function` gehen ueberall. Vorsicht nur bei `const`/`let` auf oberster
  Ebene, die beim Laden schon gelesen werden.
* Zwei `let` oder `const` mit demselben Namen in zwei Dateien sind ein sofortiger
  `SyntaxError` beim Laden. `npm run check` faengt genau das ab.

## Aufrufe zeigen nach unten

Ein Feature darf die Engine benutzen. Die Engine darf kein Feature beim Namen
kennen. Wo sie trotzdem etwas anstossen muss, macht sie einen Hook auf:

```js
VxHooks.run('updateLate', dt);          // voxeria-engine.js, kennt niemanden
VxHooks.on('updateLate', updatePocket); // das Feature traegt sich ein
```

16 Punkte gibt es bereits (`update`, `drawWorld`, `blockMined`, `keyDown`,
`seedInput`, `playerDeath`, ...), die Tabelle steht in `DATEISTRUKTUR.md`.
`VxHooks.debug()` in der Konsole zeigt, wer woran haengt.

Wer einen Ring baut, sieht ihn in `npm run check:cycles`.

## Vor jedem Commit

```bash
npm run check && npm run lint
```

`check` prueft Syntax, doppelte Namen ueber Dateigrenzen und den
Weltgenerator-Determinismus (derselbe Seed muss dasselbe Terrain ergeben, ohne
Browser). `lint` blockiert nur bei Fehlern, Warnungen sind geduldet.

Einmal pro Klon einschalten, danach laeuft beides automatisch:

```bash
git config core.hooksPath tools/hooks
```

## Testen

Nie per Doppelklick ueber `file://`, die Skripte und PNGs brauchen einen Server:

```bash
npx serve .
```

Ohne Node: `powershell -NoProfile -ExecutionPolicy Bypass -File .claude/serve.ps1`,
dann `http://localhost:4173`.

**Im Browser-Pane laeuft `requestAnimationFrame` nicht.** Das Spiel sieht dort
eingefroren aus, obwohl es laeuft. Frames von Hand takten, sonst jagt man einen
Fehler, den es nicht gibt.

`voxeriaSelfTest()` in der Browser-Konsole prueft die Dinge, die schon einmal
kaputt waren. Braucht ein laufendes Spiel, deshalb nicht in der CI.

## Build

```bash
npm run build        # Pitch-Build fuer Publisher, ohne Musik (Suno-Lizenz)
npm run build:itch   # itch.io-Build, mit Musik
```

Beide lesen ihre Dateiliste aus den `<script src>`-Tags in `index.html`, es gibt
keine zweite Liste, die auseinanderlaufen kann.

**Bei jedem Build das `?v=` in allen Script-Tags in `index.html` hochzaehlen.**
itchs CDN liefert die `.js`-Dateien mit 31 Tagen Cache. Ohne neue Query sieht ein
wiederkehrender Spieler den alten Code, ohne jeden Fehler in Konsole oder
Netzwerk-Tab. Das ist stumm und faellt sonst erst Wochen spaeter auf.

## Beim Editieren von `voxeria-terminal.js`

Die Bannerzeile in `termBanner()` traegt die Version, die der Spieler im Terminal
sieht (`World Terminal v2.8`). Bei **jeder** Aenderung an der Datei hochzaehlen,
sonst zeigt das Spiel eine Version, die es nicht mehr gibt.

Zu finden mit `grep -a "World Terminal v"`. Das `-a` ist noetig: die Datei enthaelt
eingebettete Base64-Daten, ohne das Flag haelt grep sie fuer binaer und schweigt.

## Wenn eine neue Datei dazukommt

Zwei Stellen, sonst faellt sie stumm aus:

1. Ein `<script src>`-Tag in `index.html`, an der richtigen Stelle der Reihenfolge.
2. Die `SHIPPED`-Liste oben in `tools/check.js`.

## Vorsicht

* `voxeria-engine.js` hat 11820 Zeilen und 376 Funktionen: Renderer, Physik,
  Input, Audio, Multiplayer, HUD, Crafting, Wetter, Licht. Aenderungen dort
  betreffen alles. Nicht ohne Absprache umbauen.
* 32 Namen sind derzeit in mehreren Dateien als `function` deklariert
  (`updatePlayer` dreimal). Bei geteiltem Scope gewinnt die zuletzt geladene
  Datei stillschweigend. Bekannt, offene Arbeit, `npm run check` listet sie.
* **Kein Prettier, keine Formatierer.** Der Code ist von Hand gesetzt, an einigen
  Stellen ist die Form die Aussage. Ein Formatierer wuerde einen Diff ueber
  zehntausende Zeilen erzeugen und `git blame` wertlos machen.

## Stil

* Kommentare in der Sprache der Datei, in der sie stehen: Deutsch in
  `voxeria-core.js`, `tools/`, `build-zip.js`, Englisch in `voxeria-terminal.js`.
* **Keine Gedankenstriche** (weder `—` noch `–`) in neuem Text: nicht in
  Kommentaren, nicht in UI-Texten, nicht in Commit-Nachrichten.
* Commit-Nachrichten sind deutsch und im Praesens: `fix(check): ...`, `refactor: ...`.
* **Voxeria bleibt 2D.** Die Frage ist beantwortet. Wenn von "mehr Tiefe" die Rede
  ist, ist visuelle Tiefe im Canvas-2D-Renderer gemeint, nie 3D.
