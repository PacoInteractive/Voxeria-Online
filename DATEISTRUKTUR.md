# Voxeria — Dateistruktur

Das Spiel lag vorher komplett in **einer** Datei (`Voxeria_core.html`, ~20.000 Zeilen).
Es ist jetzt aufgeteilt — inhaltlich identisch, nur auf mehrere Dateien verteilt.

## Was liegt wo

| Datei | Inhalt | Wer arbeitet dran |
|---|---|---|
| `index.html` | Grundgerüst: `<head>`, das komplette Stylesheet, die gesamte UI-Markup (HUD, Modals, Hauptmenü) und am Ende die `<script src>`-Tags | gemeinsam |
| `voxeria-engine.js` | Renderer, Physik, Kollision, Input, Audio/Musik, Multiplayer (Firebase), HUD, Crafting, Wetter, Licht, Block-Zugriffsschicht (`getBlock`/`setBlock`) | **nicht anfassen** ohne Absprache |
| `voxeria-worldgen.js` | Die komplette Weltgenerierung: Rauschfelder, Höhenkurve, Dichtefeld, Feature-Gitter mit den drei Wahrzeichen, Spawn-Suche, Set-Pieces und `getChunk` | **Weltgenerierung** |
| `voxeria-dimensions-progress.js` | Pocket-Dimensionen (`generatePocketChunk`), Run-Lifecycle, Portal-Buch, Dimensions-Schmieden, Fortschritts-Speicherung | **Dimensionen & Fortschritt** |
| `voxeria-modding.js` | Mod-Codes, Pieces, Function Graphs + Runtime, Mod-Sprites, Mod-Builder, Pixel-Editor, Block-/Creature-Designer, Node-Editor | **Modding** |
| `voxeria-menu-worlds.js` | Hauptmenü + benannte Welt-Speicherstände (`window.VxWorlds`) | gemeinsam |
| `voxeria-arena.js` | Arena-Modus: Match mit Phasen/Uhr/Punkten, Host-Wahl, Runden-Reset (`window.VxArena`) | **Arena** |
| `voxeria-coop-mods.js` | Geteilte Mods im Raum + farbige Autoren-Zuordnung (`window.VxCoopMods`) | **Koop-Mods** |
| `voxeria-devtools.js` | Verstecktes Entwickler-Werkzeug (Strg+Shift+E, UI-Layout-Editor) | nur intern |
| `voxeria-tests.js` | `voxeriaSelfTest()`: eine Konsolen-Prüfung für die Dinge, die schon einmal kaputt waren (ruft auch `modSelfTest()` und `worldGenSelfTest()`) | nur intern |
| `voxeria-boot.js` | Spawnpunkt, `player`-Objekt, Kamera, und die Zeile, die das Spiel startet | **muss zuletzt geladen werden** |

`Assets/` enthält die Block-Texturen (PNG) und, in `Assets/sfx/`, die
nachgeladenen Soundeffekte (MP3).

Die Musik ist eine Playlist aus drei Stücken (`MUSIC_TRACKS` in
`voxeria-engine.js`). Das erste steckt als Base64 direkt in der Datei und ist
damit immer da; die beiden anderen liegen als MP3 in `Music/` und werden zur
Laufzeit nachgeladen (zusammen ~9 MB — als Base64 wären das ~12 MB, die jeder
Spieler vor dem Start herunterladen müsste). Ein Stück, das sich nicht laden
lässt, fällt still aus der Rotation.

Die Soundeffekte folgen demselben Prinzip, konsequent zu Ende gedacht: sechs
kurze UI-/Mod-Editor-Sounds (Klick, Hover, Tippen, drei Knoten-Sounds) müssen
schon beim allerersten Klick da sein, noch bevor irgendein Asset geladen
werden konnte — die bleiben als Base64-MP3 eingebettet. Alle anderen 24
(Grasgeräusche, Abbau-/Platzier-Samples für Erde/Holz/Stein/Laub) passieren
erst mitten im laufenden Spiel und liegen deshalb als MP3-Dateien in
`Assets/sfx/`, die bei Bedarf nachgeladen werden. Alle 30 waren ursprünglich
rohes, unkomprimiertes WAV als Base64 (~2,2 MB) — jetzt komprimiertes MP3
(~174 KB gesamt für die 24 Dateien). Format ist bewusst MP3, nicht Ogg: Safari
unterstützt Ogg Vorbis in `decodeAudioData` nicht zuverlässig, und die Musik
nutzte aus demselben Grund schon immer MP3.

**Wichtig:** `Music/` muss deshalb mit in den Build. Fehlt der Ordner, spielt
nur das eingebettete Stück — ohne Fehlermeldung, nur eine Warnung in der Konsole.

## Globaler Fehler-Überlag

Das allererste `<script>` in `index.html`, noch vor allem anderen, fängt jeden
nicht abgefangenen Fehler und jede nicht abgefangene Promise-Rejection ab
und zeigt einen ruhigen Hinweis mit Reload-Knopf statt einer stummen weißen
Fläche. Betrifft alles **außerhalb** der Spielschleife (die schon ihren
eigenen `try`/`catch` hat und einen Frame-Fehler übersteht, siehe `gameLoop`
in `voxeria-engine.js`) — Hauptmenü, Mod-Code-Parsing, Firebase-Callbacks,
oder ein Fehler beim Parsen der ~10 MB großen `voxeria-engine.js` selbst.

Steht bewusst ganz am Anfang von `<head>`, damit er schon während des Ladens
der übrigen Skripte scharf ist. Der "Copy details"-Knopf kopiert die
gesammelten Fehler in die Zwischenablage — bei fehlender Berechtigung markiert
er den Text stattdessen zum manuellen Kopieren, statt fälschlich "Copied" zu
zeigen. Praktisch als Fehlerberichts-Kanal für den Playtest.

## Wie die Dateien zusammenhängen

Alle `.js`-Dateien sind **klassische Scripts**, keine ES-Module. Sie teilen sich
also einen einzigen globalen Scope — genau wie vorher, als alles in einer Datei
stand. Eine Funktion aus `voxeria-engine.js` kann ohne `import` direkt aus
`voxeria-dimensions-progress.js` aufgerufen werden und umgekehrt.

**Die Ladereihenfolge in `index.html` ist deshalb wichtig:**

```
voxeria-core.js          <- MUSS die erste sein (siehe unten)
voxeria-engine.js
voxeria-worldgen.js      <- nach engine, vor dimensions-progress (siehe unten)
voxeria-dimensions-progress.js
voxeria-modding.js
voxeria-menu-worlds.js
voxeria-arena.js         <- nach menu-worlds (siehe unten)
voxeria-coop-mods.js
voxeria-devtools.js
voxeria-tests.js         <- nach allem, was es prüft (siehe unten)
voxeria-boot.js          <- muss letzte bleiben
```

Warum `voxeria-core.js` als erste: Es ist das Fundament, auf dem alle anderen
stehen. `BLOCKS`, die Weltgeometrie (`TILE`, `WORLD_H`, `CHUNK_W`), der
Dimensions-Speicher, die Seed-Mathematik samt `seededRandom()`, der
Sitzungszustand (`gameMode`, `activeMod`) und `VxHooks` selbst. Die Datei
ruft nichts auf und kennt weder Renderer noch Weltgenerator noch Mod-System.

Sie ist entstanden, weil zwischen `voxeria-engine.js` und
`voxeria-worldgen.js` ein Ring lag, der sich **nicht** mit einem Hook lösen
liess. Die Engine ruft den Generator 42 Mal, und das ist die richtige Richtung:
ein Renderer braucht Terrain. Umgekehrt las der Generator dreizehn Namen aus der
Engine, und die meisten gehörten keinem von beiden. `BLOCKS`, `CHUNK_W`,
`seededRandom`: das ist gemeinsame Sprache, kein Dienst, den einer dem anderen
leistet. Ein Ring aus gemeinsamer Sprache löst man nur, indem die Sprache ein
eigenes Zuhause bekommt.

Faustregel für neuen Code dort: wenn es ein Canvas, ein DOM-Element oder
Firebase braucht, gehört es **nicht** hinein. `COLS` und `ROWS` stehen
deshalb bewusst weiter in der Engine, das ist die Grösse des Fensters und nicht
die der Welt.

Warum `voxeria-tests.js` so spät: Die Datei liest beim Aufruf `VxTerminal`,
`modSelfTest()` und `worldGenSelfTest()`, muss also nach allen dreien geladen
sein. Sie definiert beim Laden nur eine Funktion und kostet den Seitenstart
nichts, bis jemand in der Konsole `voxeriaSelfTest()` tippt.

Warum `voxeria-arena.js` nach `voxeria-menu-worlds.js`: Der Arena-Modus trägt
sich beim Laden selbst in die dort exportierte `MODES`-Tabelle ein, statt dass
`voxeria-menu-worlds.js` ihn kennen müsste. Dadurch liegt alles, was den Modus
ausmacht, in genau einer Datei — entfernt man das `<script>`-Tag, ist der Modus
restlos weg.

Warum `voxeria-worldgen.js` dort steht: Es liest von `voxeria-engine.js`
`BLOCKS`, `CHUNK_W`, `WORLD_H`, `dimensions` und die Seed-Zufallsfunktionen,
muss also danach kommen. Vor `voxeria-dimensions-progress.js` steht es, weil
dessen Pocket- und Arena-Generatoren von `getChunk()` aufgerufen werden.

Warum `voxeria-boot.js` zuletzt: Beim Start wird der Spieler gespawnt, und dafür
fragt das Spiel den Weltgenerator nach Terrain. Der liegt jetzt in
`voxeria-worldgen.js`. Würde der Boot-Code früher laufen, griffe er auf eine
Dimensions-Ebene zu, die es noch gar nicht gibt.

Die Datei **deklariert dabei nichts mehr**. `player`, `camX`, `camY`,
`initialSpawnX`, `spawnY`, `fallStartY` und `MIN_THUMP_FALL_BLOCKS` stehen in
`voxeria-engine.js`, wo sie hingehören: die Kameraposition und das
Spieler-Objekt sind der Kern des Renderers, kein Startcode. Vorher las die
Engine sie aus der Datei, die als letzte geladen wird, und
`voxeria-dimensions-progress.js` tat dasselbe.

`voxeria-boot.js` **weist nur noch zu**, weil die Startwerte den Weltgenerator
brauchen. Bis dahin stehen in der Engine neutrale Werte, und die liest niemand:
jede Lesestelle sitzt in einer Funktion, die erst nach dem Start läuft.

### In welche Richtung darf ein Aufruf zeigen?

Der Satz oben, dass jede Datei jede andere direkt aufrufen kann, ist technisch
wahr und war lange auch die gelebte Praxis. Genau daraus ist ein Problem
gewachsen: `voxeria-engine.js` rief irgendwann selbst Funktionen aus Dateien
auf, die erst nach ihr geladen werden. Damit gab es keine unterste Schicht
mehr, sondern einen Ring. Nichts ließ sich einzeln öffnen, testen oder
ersetzen, weil kein Teil ohne den Rest lief.

Nachzählen lässt sich das jederzeit:

```
npm run check          Syntax aller ausgelieferten Dateien + Abhängigkeitskarte
npm run check:deps     nur die Karte
npm run check:cycles   nur die Ringe, also die offene Arbeit
node tools/check.js why engine dimensions-progress
```

`cycles` ist der wichtigste davon. Er zeigt nicht, wer wen liest, sondern wo
daraus ein **Ring** wird, und nur der ist das Problem: A benutzt B ist gesund,
A benutzt B und B benutzt A heisst, dass keines von beiden allein laufen,
laden oder getestet werden kann. Die kleinere der beiden Zahlen eines Paars
ist meistens die Arbeit, denn sie zeigt die Richtung, die falsch herum ist.

`npm run check` prüft ausserdem, ob ein Name mit `let`, `const` oder `class` in
**zwei** Dateien auf Spaltenposition 0 steht. Das ist der eine Fehler, den
`node --check` prinzipiell nicht finden kann: es prüft jede Datei für sich,
aber zur Laufzeit teilen sich alle einen globalen Scope, und zwei `let camX`
sind dann ein sofortiger `SyntaxError`, der das ganze Spiel beim Laden anhält.
`function` und `var` sind ausgenommen, denn genau davon lebt das Umhüllen in
`voxeria-modding.js` und `voxeria-arena.js`.

`why` listet für zwei Dateien vollständig auf, welche fremden Namen jede von
der anderen liest.

**Die Regel lautet: Aufrufe zeigen nach unten.** Ein Feature darf die Engine
benutzen. Die Engine darf kein Feature beim Namen kennen. Wo sie trotzdem
etwas zum passenden Zeitpunkt anstoßen muss, macht sie einen benannten Punkt
auf und das Feature trägt sich dort ein:

```js
// voxeria-engine.js  -- macht den Punkt auf, kennt niemanden
VxHooks.run('updateLate', dt);

// voxeria-dimensions-progress.js  -- trägt sich ein
VxHooks.on('updateLate', updatePocketDimension);
```

Vorhandene Punkte:

| Punkt | wann | Form |
|---|---|---|
| `update` | Simulation, früh im Frame (vor Tageszeit und Wetter) | `run(dt)` |
| `updateLate` | Simulation, spät im Frame | `run(dt)` |
| `drawCreatures` | am Ende von `drawAnimals()`, vor den Partikeln | `run()` |
| `drawWorld` | in der Zeichenkette, hinter dem Wetter | `run()` |
| `drawAfterPlayer` | hinter dem Spieler, vor der Vordergrund-Parallaxe | `run()` |
| `drawOverlay` | über der fertigen Szene, unter dem Impact-Flash | `run()` |
| `blockPlaced` | nach einer erfolgreichen Platzierung | `run(wx, wy)` |
| `blockMined` | nach einem erfolgreichen Abbau | `run(wx, wy, block)` |
| `enterPortal` | Spieler steht in einem Portalblock, Sperre abgelaufen | `run()` |
| `worldReset` | Weltneustart, nach `currentDim = "OVERWORLD"` | `run()` |
| `generateChunk` | ein Chunk einer fremden Dimension entsteht | `filter(null, cx, chunk)` |
| `multiplayerReady` | Firebase verbunden, eigene Ströme öffnen | `run()` |
| `gameEvent` | Sprung, Tod, Treffer, Abbau, Tagesanbruch, … | `run(typ, ctx)` |
| `keyDown` | Taste gedrückt, Fokus nicht in einem Eingabefeld | `filter(false, key, e)` |
| `seedInput` | Text im Seed-Feld, vor dem Weltneustart | `filter(null, text)` |
| `playerDeath` | bevor die Engine das Sterben abwickelt | `filter(false)` |

Die drei `filter`-Punkte haben alle dieselbe Absprache: wer den Vorgang für
sich beansprucht, gibt etwas zurück, wer sich raushält, gibt nichts zurück.
Bei `playerDeath` heisst `true` "ich habe das Sterben vollständig übernommen,
misch dich nicht ein".

`VxHooks.debug()` in der Konsole zeigt, wer gerade woran hängt.

Zwei Details, die man leicht übersieht:

* Der dritte Parameter von `on(name, fn, order)` bestimmt die Reihenfolge,
  kleiner zuerst. Ohne ihn entschiede die Reihenfolge der `<script>`-Tags, und
  dann hinge der Spielablauf wieder an `index.html` statt an der Datei, die es
  angeht.
* `VxHooks.filter(name, wert, ...)` ist die zweite Form, für Punkte, an denen
  ein Wert verändert statt nur gemeldet wird. `keyDown` ist das Beispiel: wer
  `true` zurückgibt, hat die Taste verbraucht und bekommt das `preventDefault`
  dafür, wer nichts zurückgibt, lässt sie liegen.

Der aufwendigste der Punkte ist `seedInput`, und er lohnt einen eigenen Blick.
Das Eingabefeld nimmt nicht nur Seeds, sondern auch Mod- und Loadout-Codes.
Dafür standen rund sechzig Zeilen in `applySeedFromUI()`, in denen die Engine
wusste, wie ein `VXM3-` und ein `VXL1-` Code aufgebaut ist. Die drei Zweige
waren zu über neunzig Prozent identisch. Ein Zuhörer antwortet jetzt mit einem
von drei Dingen:

```
null                      niemand erkennt den Text, es ist ein Seed
{ error }                 erkannt, aber unbrauchbar: Meldung, Abbruch,
                          die Welt bleibt stehen
{ seed, display, done }   erkannt. seed wird der Seed, display bleibt im
                          Feld stehen, done() läuft sobald die Welt steht
```

Der Zuhörer läuft garantiert **vor** `resetGameAndWorld()`. Das ist die
Reihenfolge, auf die `registerLoadoutPieces()` angewiesen ist: der Reset leert
jede Dimension, und die danach neu erzeugten Chunks lesen `customOreTiers`.

Auch das Aufräumen läuft hierüber. Wer den Text *nicht* erkennt, ist genau in
dem Moment dran, in dem ein vorher aktiver Mod aufhört zu gelten, und kann sich
abbauen, bevor er `null` zurückgibt.

Für den umgekehrten Fall, dass ein Feature einen Ausgang ändern will, den die
Engine sonst schon gefällt hätte, bleibt das Umhüllen bestehen: siehe
`installGraphHooks()` in `voxeria-modding.js`.

### Die Überschreib-Ebene

Sieben Werte oben in `voxeria-engine.js` sind der andere Weg: keine Aufrufe,
sondern Daten, die die Engine liest und ein Mod füllt.

```
blockReskin            Blocktyp -> Blocktyp, rein kosmetisch
creatureToggles        Kreatur-Art -> false blockt das Spawnen
customCreatureTypes    selbstgebaute Kreaturen
graphBlockHardness     Blocktyp -> Härte 1..8
graphBlockSoundFamily  Blocktyp -> Klangfamilie
ruleGravityScale       Faktor, 1 ist neutral
graphYieldMult         Faktor, 1 ist neutral
```

Sie standen früher in `voxeria-modding.js`, und zwei der Lesestellen in der
Engine hatten kein `typeof` davor. Ein Build ohne das Mod-Skript starb damit im
ersten Frame, in dem der Spieler fällt. Die Voreinstellung hier ist jeweils
exakt "kein Mod aktiv", deshalb braucht keine Lesestelle mehr eine Wache.

**Kein `filter` dafür.** `blockReskin` wird pro sichtbarer Kachel und Frame
gelesen, das sind Zehntausende Aufrufe pro Sekunde. Ein Hook mit Schleife und
`try` an dieser Stelle wäre der einzige Punkt der ganzen Umstellung, der
messbar kostet, und für eine reine Tabellenabfrage kauft er nichts.

### Eigenschaften einer Dimension

Nach demselben Muster, zwei Strukturen weiter oben in `voxeria-engine.js`:

```
DIM_SEED_SALT[dim]   Nonce, die in den Hash von seededRandom() wandert.
                     Wer drinsteht, bekommt bei jedem Betreten ein frisches
                     Layout. Wer fehlt, bekommt den unveränderten Schlüssel.
EPHEMERAL_DIMS       Dimensionen, deren Blockänderungen nie gespeichert werden.
```

Wer eine Dimension baut, trägt sie dort ein. `voxeria-dimensions-progress.js`
macht das für seine Pocket-Dimensionen in zwei Zeilen neben `POCKET_DIMS`.

**Bewusst zwei Strukturen**, obwohl heute dieselben Dimensionen drinstehen.
"Entsteht bei jedem Betreten neu" und "wird nie gespeichert" fallen bei den
Pocket-Dimensionen zufällig zusammen. Eine Struktur für beides wäre eine Falle
für die erste Dimension, auf die nur eines von beidem zutrifft.

### Praktische Regel

Neue **Funktionen** (`function foo() {}`) kann man in jeder Datei anlegen — die
werden innerhalb ihrer Datei hochgezogen und sind überall aufrufbar, sobald das
Spiel läuft.

Vorsicht nur bei **`const`/`let` auf oberster Ebene, die beim Laden schon gelesen
werden**. Beispiel: Eine Datei kann keine Konstante aus einer Datei lesen, die
erst später geladen wird. Innerhalb von Funktionen ist das egal, weil die erst
laufen, wenn alles geladen ist.

## Lokal testen

Nicht per Doppelklick über `file://` öffnen — die `<script src>`-Dateien und die
PNGs brauchen einen echten Server. Irgendein statischer Server im Projektordner
reicht, z. B.:

```bash
npx serve .
```

Dann `http://localhost:3000` aufrufen.

## Die drei Modi und wo sie gewählt werden

| Modus | Wo wählbar | Welt |
|---|---|---|
| Exploration | Neue Welt **und** Host Room | normal generiert, endlos |
| Normal | Neue Welt **und** Host Room | normal generiert, endlos |
| Arena | **nur** Host Room | leer, seitlich begrenzt, selbst gewählte Breite |

Arena trägt in `MODES` das Flag `roomOnly: true`. Der Modus wird beim **Erstellen
eines Raums** gewählt, nicht beim Anlegen einer lokalen Welt: er gilt für alle,
die beitreten, und braucht eine Breite, auf die sich alle einigen müssen.
Ist Firebase offline, legt derselbe Knopf eine lokale Welt in demselben Modus
an, statt eine Fehlermeldung zu zeigen.

## Der Arena-Modus

**Die Welt ist das Spielfeld.** Kein markiertes Rechteck im Terrain, sondern
eine eigene Weltart: `generateArenaChunk()` in `voxeria-dimensions-progress.js`
erzeugt einen leeren Kasten — Bedrock-Boden, Bedrock-Wände an der gewählten
Breite, dazwischen Luft, plus eine generierte Startplattform in der Mitte.
Begrenzt wird über **Blockinhalt**, nicht über Index-Prüfungen — genau wie die
Pocket-Dimensionen es schon machen. Eine physische Wand gilt von sich aus für
alles (Kollision, Abbauen, Flüssigkeiten, Kreaturen), ohne dass eine einzige
dieser Stellen davon wissen muss.

Wählbare Breiten: 64, 128, 256 Blöcke — Vielfache der Chunk-Breite von 32, damit
die Wand genau auf einer Chunk-Grenze sitzt.

**Modus und Breite reisen im Raum-Dokument mit.** Beim Beitreten ist die
*Reihenfolge* entscheidend: `joinRoomByCode()` liest erst den Raum-Eintrag und
setzt Modus und Breite, **dann** den Seed. Denn `applySeedFromUI()` ruft
`resetGameAndWorld()` → `getChunk()`, und ab dem ersten erzeugten Chunk steht
die Weltart fest. Der `?room=`-Einladungslink nimmt denselben Weg und wartet
dabei begrenzt auf die Firebase-Anmeldung, die zu diesem Zeitpunkt noch läuft.

### Räume: was ein Aufruf zurückgibt

`createRoom()` und `joinRoomByCode()` sind **async und geben ein Ergebnis
zurück**. Beide können echt scheitern, und beide dürfen dabei nicht so tun als
wäre alles gut:

* `createRoom(mode, width)` → der Raumcode, oder `null`. Der Registry-Eintrag
  wird **abgewartet**; scheitert er, wechselt der Gastgeber gar nicht erst in
  den Raum. (Vorher lief das Schreiben nebenher, und ein Raum, den niemand
  finden konnte, meldete trotzdem „Room created“.)
* `joinRoomByCode(code)` → `{ ok: true, meta }` oder `{ ok: false, reason,
  message }`. Ein **unbekannter Code wird abgelehnt**, statt still in einen
  frisch erzeugten leeren Seed zu führen, der aussieht wie ein Raum, in dem
  gerade niemand ist. Nur der `?room=`-Link darf über `allowUnregistered` auch
  auf einem gewöhnlichen Seed landen; dessen Wert kommt aus `copyRoomInvite()`
  und muss kein Raumcode sein.

Der Raum-Eintrag wird per **`getDoc` auf einer berechenbaren Dokument-Id**
gelesen (`seedToNumber` des Codes), nicht per Sammelabfrage: ein `get` kommt
auch mit Firestore-Regeln zurecht, die `list` nicht erlauben. Die Abfrage bleibt
als zweiter Versuch für Räume aus der Zeit vor dem Id-Schema.

**Ein Raum ist kein benannter Speicherstand.** Beim Betreten wird die laufende
Welt einmal gesichert (`_flushWorldBeforeLeaving()`, **vor** jeder Änderung an
`gameMode`/Arena-Breite, weil `serialize()` beide mitschreibt) und danach
`currentWorldId` bewusst losgelassen. Ohne das schreibt der 20-Sekunden-
Autosave den Raum-Seed in den Datensatz der privaten Welt, aus der man kam.
`worldRunning()` in `voxeria-menu-worlds.js` behandelt einen laufenden Raum
trotzdem als laufende Welt; davon hängen „Back to Game“ und die Freigabe der
Creator-Werkzeuge ab.

Die Datei ändert nur zwei Dinge im Motor durch **Umschließen** — dasselbe
Verfahren, das `installGraphHooks()` in `voxeria-modding.js` benutzt:

| umschlossene Funktion | wofür |
|---|---|
| `updateGraphRuntime` | Frame-Tick (liegt im `!paused`-Block der Spielschleife) |
| `findSafeSpawnX` | In einer leeren Welt findet die normale Spawn-Suche nichts und erzeugt dabei hunderte Chunks; der Wrapper liefert direkt die Plattform-Mitte. |

Eine Runde läuft `build → countdown → running → ended → build`. Beim Betreten
des Countdowns sichert **jeder** Client die Welt lokal (lauflängenkodiert,
zusätzlich in `localStorage`, damit es einen Seitenneuladen übersteht); beim
Verlassen der Siegerehrung stellt jeder sie lokal wieder her, und der Host
schreibt die veränderten Kacheln zusätzlich in `voxeria_world_<SEED>` zurück,
damit auch Nachzügler und Neuladende das aufgeräumte Feld bekommen. Der
Snapshot wandert bewusst **nicht** durch Firestore: vor Rundenstart haben alle
ohnehin denselben Weltzustand. Eine 256×120-Arena sind 30.720 Kacheln, nach
Lauflängenkodierung rund 370 Zeichen — sie ist ja fast ganz Luft.

Die Regeln eines Minispiels sind **gewöhnliche Knotenketten** aus dem
Mod-Editor, keine zweite Sprache: `NODE_CATALOG` in `voxeria-modding.js` hat
dafür sieben Arena-Einträge bekommen (`onMatchStart`, `addScore`, `ifInArena`
usw.). Außerhalb des Arena-Modus sind die wirkungslos, aber ladbar — ein
geteilter Mod-Code darf in keiner Welt einen Fehler werfen.

Gebaut wird mit **eigenen Blöcken**: der Block-Katalog hängt einen Abschnitt
„Made by players“ an, gespeist aus `customBlockSource`, jeder Eintrag mit einem
Streifen in der Farbe seines Erfinders. Arena gibt Blöcke frei wie Exploration
— ein Welt-Editor, in dem man das Material erst abbauen muss, wäre widersinnig,
zumal die leere Arena nichts zum Abbauen enthält.

## Das Panorama hinter dem Hauptmenü

Der Startbildschirm war ein flacher schwarz-lila Verlauf, keine Farbe, kein
Hinweis darauf, dass dahinter eine echte, bunte Welt existiert. Jetzt läuft
echtes, prozedural erzeugtes Gelände (Erde, Stein, Gras, Bäume) im Hintergrund
langsam von links nach rechts durch, `drawMenuPanorama()` in
`voxeria-engine.js`, aufgerufen aus `_gameLoopInner` genau dort, wo
`vxMenuIsOpen()` sonst den ganzen Frame überspringt.

**Das eigentliche Risiko dabei, und warum es keins ist:** `getChunk(cx, dim)`
cacht in `dimensions[dim]`, nur nach Chunk-Index, nicht nach Seed.
`resetGameAndWorld()` leert diese Karten nur beim echten Start/Laden einer
Welt, nicht beim bloßen Öffnen des Menüs mitten im Spiel. Würde das Panorama
`dimensions.OVERWORLD` mitbenutzen, könnte es beim Scrollen einen noch nicht
besuchten Chunk-Index dauerhaft mit dem falschen Gelände belegen, ein echter
Speicherfehler im Spielstand. Deshalb bekommt das Panorama eine **eigene,
siebte Dimension** `dimensions.MENU`, die kein echter Spielcode je liest.
Nachgemessen (nicht nur angenommen): derselbe Chunk-Index gleichzeitig in
`OVERWORLD` und in `MENU` erzeugt, mit einem Marker-Block in der echten Welt
davor und danach verglichen, byte-identisch, weil es zwei komplett getrennte
`Uint8Array`-Objekte sind.

Weitere Details:

- **Begrenzt statt endlos:** die Kamera läuft über einen festen Streifen von
  `MENU_PANORAMA_WRAP_CHUNKS` = 96 Chunks und springt dann an den Anfang
  zurück (Modulo auf die Streifenbreite in Pixeln). `dimensions.MENU` wächst
  dadurch nie über einen festen Rahmen hinaus, egal wie lange das Menü offen
  bleibt.
- **Kein zweites Seed-System:** benutzt einfach das ohnehin schon vorhandene
  globale `SEED`, das schon vor der ersten Weltwahl einen sinnvollen Wert hat
  (Wochen-Seed). Erfüllt "irgendein Seed", ohne eine zweite Quelle zu bauen.
- **Kamerahöhe folgt dem Gelände:** `getBiomeHeight()` an der Bildmitte
  bestimmt, wie weit die Kamera nach unten verschoben wird, so dass die
  Oberfläche im oberen Drittel des Bildes sitzt. Erde und Stein füllen den
  Großteil der Fläche, nicht Himmel.
- **Bewusst kein `drawSky()`, `drawBgHills()` oder `drawForegroundParallax()`:**
  ein fester, einfacher Himmelverlauf statt des echten (der an Tag/Nacht/Wetter
  hängt, was vor einer echten Welt nichts Sinnvolles hergibt), und keine der
  gedämpften fernen Bergketten, die das echte Spiel bewusst zurückhält. Genau
  das war der Punkt: nahes, farbiges Blockmaterial soll den Bildschirm füllen.
  `drawCaveBackground()` läuft dagegen bewusst mit (seit 2026-09-01,
  `currentDim !== "OVERWORLD" && currentDim !== "MENU"`-Sperre): ohne sie
  zeigte eine Höhle im scrollenden Streifen einfach blauen Himmel statt einer
  Felswand dahinter.
- **`currentDim`/`camX`/`camY`/`drawCamX`/`drawCamY` werden für die Dauer
  eines einzelnen Aufrufs umgelegt und direkt danach zurückgeschrieben.**
  Sicher, weil während eines Menü-offen-Frames sonst nichts läuft (Physik,
  Sync, jede andere Zeichnung sind schon durch `vxMenuIsOpen()` übersprungen).
- **`#vx-menu` ist jetzt durchsichtig** (ein dunkel getönter Verlauf statt
  `#0b0d14` blickdicht), `index.html`. `.vx-panel` (die Knopfliste) behält
  ihren eigenen deckenden Hintergrund.
- **Die normale Spiel-HUD wird eigens ausgeblendet**, nicht über
  `body.vx-hide-ui` (das ist die F4-Einstellung des Spielers, die das Öffnen
  des Menüs weder lesen noch überschreiben darf), sondern über eine eigene
  Klasse `body.vx-menu-open`, gesetzt in `VxWorlds.show()`/`hide()`
  (`voxeria-menu-worlds.js`), mit derselben CSS-Regelform wie F4 nutzt.

## Die BOOT-Szene vor dem Hauptmenü

Der allererste Ladebildschirm (bevor das Hauptmenü überhaupt zum ersten Mal
erscheint) zeigte nur den Schriftzug „VOXERIA" plus eine rotierende
Scherz-Fortschrittszeile — reiner Text auf dunklem Verlauf, kein Bezug zum
eigentlichen Spiel. Ersetzt (2026-09-01) durch eine kurze, textlose Szene:
der Charakter steht auf einem Grasblock in einem schwarzen Leerraum und baut
sich rechts daneben einen echten Baum, Block für Block. Erst wenn der Baum
fertig ist, blendet die Szene aus und das Hauptmenü erscheint.

**Zwei Momente teilen sich einen gameState, `introKind` trennt sie:**
`updateAndDrawIntro()` in `voxeria-engine.js` verzweigt nach `introKind` in
`_updateAndDrawIntroBoot()` (neu, nur beim allerersten Laden) oder
`_updateAndDrawIntroWorldstart()` (die alte Text+Balken-Fassung, unverändert,
läuft bei jedem `resetGameAndWorld()`-Aufruf — also jedes Mal, wenn tatsächlich
eine Welt gestartet oder geladen wird). Die BOOT-Szene bei jedem Weltstart
erneut abzuspielen hätte wiederkehrende Spieler unnötig ausgebremst.

**Warum die BOOT-Szene vor `vxMenuIsOpen()` gewinnen muss:** normalerweise
überspringt `if (vxMenuIsOpen()) { drawMenuPanorama(dt); return; }` in
`_gameLoopInner` den gesamten restlichen Frame, sobald `#vx-menu` die Klasse
`show` trägt — und die trug sie bisher schon ab `DOMContentLoaded`. Die
Intro-Prüfung stand danach und lief deshalb beim allerersten Laden **nie**,
das eigentliche „langweilige" Ladebild war die separate, reine HTML/CSS-Karte
`#early-loading-hint` (siehe unten), nicht `updateAndDrawIntro()`. Für die
neue Szene musste die Reihenfolge sich ändern: `gameState==="INTRO" &&
introKind==="BOOT"` wird jetzt VOR dem `vxMenuIsOpen()`-Guard geprüft, und
`voxeria-menu-worlds.js` ruft beim `DOMContentLoaded` nicht mehr das volle
`show()` auf (das würde `#vx-menu` sofort sichtbar machen), sondern setzt nur
noch `body.vx-menu-open` direkt (blendet die echte Spiel-HUD aus, dieselbe
Klasse wie beim Panorama oben). Das echte `show()` kommt erst aus
`_updateAndDrawIntroBoot()` selbst, in dem Moment, in dem die Szene fertig
ausgeblendet hat.

**Keine echte Welt, kein `getBlock()`:** jede Dimension, die `getChunk()`
kennt (auch `dimensions.MENU` vom Panorama oben), generiert beim ersten
Zugriff auf einen neuen Chunk-Index vollständiges Gelände — nichts davon ist
„einfach leer". Die Szene hätte also nie einen sauberen schwarzen Leerraum
ergeben, egal welche Dimension man wählt. Statt dessen zeichnet
`_introDrawTile()` die Block-Texturen (`_blockTextures[...]`, dieselben PNGs
wie im echten Spiel, Fallback auf `blockColors`) direkt auf eine selbst
gewählte, komplett erfundene Kachel-Position — kein `dimensions`-Eintrag,
kein `getChunk()`, kein `getBlock()` beteiligt. `planTree()` (siehe unten bei
den Bäumen) bekommt dafür ein `getAt`, das immer `BLOCKS.AIR` zurückgibt, was
für eine vollständige, echte Baumform genügt.

**Kamera/Spieler geliehen, nicht dupliziert:** `drawCamX`/`drawCamY` und
`player.x`/`player.y`/`player.facing` werden für die Dauer eines einzelnen
Aufrufs auf die Szene umgelegt und direkt danach zurückgeschrieben — dasselbe
Leih-Muster wie beim Panorama, sicher aus demselben Grund (während
`gameState==="INTRO"` läuft sonst nichts, das diese Werte lesen könnte).
`player.placeAnimTimer = 14` bei jedem neu enthüllten Blocktile ist derselbe
Wert, den `executePlace()` für eine echte Platzierung benutzt, damit die
„Platzieren"-Pose exakt gleich aussieht.

**Darf nie hängen bleiben:** `_updateAndDrawIntroBoot()` selbst hat noch eine
eigene, wall-clock-basierte Obergrenze (`INTRO_BOOT_MAX_MS` = 12s, unabhängig
von `dt`/Framerate) und ein `try`/`catch` um den Fortschritts-Teil — jeder
Fehler dort (z.B. in `planTree()`) springt sofort zum Menü statt die Szene
für immer im aktuellen Zustand einzufrieren. Grund: eine frühere Fassung
setzte `introBuildPhase = "BUILD"`, BEVOR `introBuildTiles` feststand; flog
dabei eine Ausnahme, blieb die Phase auf "BUILD" haengen, waehrend die Daten
`null` blieben — jeder folgende Frame griff auf `null[...]` zu, warf sofort
wieder, von `gameLoop()`s eigenem try/catch endlos abgefangen: ein Spieler
sah nur einen dauerhaft schwarzen Bildschirm, ohne dass irgendwo ein
sichtbarer Fehler auftauchte. Das Zeichnen selbst steckt aus demselben Grund
in einem `try`/`finally`: ohne das haette ein Fehler mitten im Zeichnen
(z.B. in `drawPlayer()`) die Wiederherstellung von `player.x`/`y` und
`drawCamX`/`drawCamY` übersprungen und den echten Spieler dauerhaft auf die
Szenen-Koordinaten hängen lassen, sobald das eigentliche Spiel beginnt.

**Das Menü muss unabhängig vom Spiel-Loop erreichbar bleiben.** Vor dieser
Änderung lief `show()` bedingungslos direkt bei `DOMContentLoaded` -- das
Menü kam also immer, egal was sonst auf der Seite schiefging. Es jetzt an
das Ende der BOOT-Szene zu haengen, gab diese Garantie auf: startet
`requestAnimationFrame(gameLoop)` in `voxeria-boot.js` aus irgendeinem Grund
nie, blieb rein gar nichts mehr uebrig, das `#vx-menu` je zeigen wuerde --
eine dauerhaft schwarze Seite ohne jeden sichtbaren Fehler. Deshalb steht in
`voxeria-menu-worlds.js` jetzt ein zweites, vom Spiel-Loop komplett
unabhaengiges `setTimeout` (15s, liest `#vx-menu`s Klasse direkt aus dem DOM
statt `window.vxMenuIsOpen()` aufzurufen -- diese Funktion koennte genau
dann fehlen, wenn `voxeria-engine.js` selbst nicht fertig durchgelaufen
ist): zeigt das Menü notfalls trotzdem, egal was mit dem Rest der Engine los
ist. Zusammen mit `INTRO_BOOT_MAX_MS` (12s, siehe oben) ist damit jede
denkbare Fehlerkette zwischen Seitenaufruf und sichtbarem Menü abgesichert --
bewusst zusaetzlich zur eigentlichen Ursache unten, nicht als Ersatz dafuer.

**Die tatsaechliche Ursache, als das zuerst live auf itch.io schwarz blieb,
war simpler und lag gar nicht im Spielcode:** siehe "Build für itch.io" weiter
unten, Cache-Control auf den Skript-Dateien. Der obige Loop-Unabhaengigkeits-
Fallback haette diesen konkreten Fall gar nicht behoben (ein 31 Tage alter,
gecachter Codestand ist ja nicht "kaputt", er laeuft nur nicht mehr durch bis
zu dem Punkt, der `show()` aufruft) -- bleibt trotzdem drin, weil "das Menü
kommt so oder so" unabhängig von dieser einen Ursache weiter gilt.

**`#early-loading-hint` (`index.html`) ist jetzt nur noch reines Schwarz**,
kein Text, kein Logo — sie ist immer noch nötig (rein inline HTML/CSS, malt
sich schon, bevor das restliche, riesige Skript überhaupt geladen ist), aber
ihr Inhalt sollte verschwinden. Sie bleibt einfach schwarz, bis die
BOOT-Szene selbst (die auf demselben Schwarz startet) sie entfernt — dadurch
gibt es beim Übergang keinen Sprung oder Blitz. Der 15-Sekunden-Hard-Timeout,
der sie notfalls trotzdem entfernt, ist unverändert geblieben.

## Overworld-Weltgenerierung

Die Oberwelt entsteht in zwei Stufen. Die **Höhenkurve** liegt in
`voxeria-engine.js` (`getBiomeHeight`), das **Aufschneiden zu echtem Fels** in
`voxeria-dimensions-progress.js` (`getChunk`).

### Stufe 0: das Klima

Biom ist **keine Chunk-Eigenschaft mehr**. `getBiome(cx)` gibt es weiter und
liefert weiter `"FOREST"` oder `"SNOW"`, aber es ist nur noch ein Etikett für
Dinge, die eine Antwort für die ganze Gegend brauchen: Wetter, Musikstimmung,
HUD-Anzeige, Bauwerks-Würfe. Es liest jetzt die **Chunkmitte** statt der linken
Kante, damit ein Chunk das Biom meldet, das ihn tatsächlich dominiert.

Darunter liegen zwei neue Funktionen, beide in `voxeria-engine.js`:

| Funktion | Rückgabe | Wer liest sie |
|---|---|---|
| `getSnowWeight(x)` | 0 bis 1, stetig | die Höhenkurve, `isSnowColumn` |
| `isSnowColumn(x)` | ja/nein pro Spalte | Bodentextur, Bäume, Schnee unter den Füßen |

`getSnowWeight` ist ein **tent-gewichteter Mittelwert der Ja/Nein-Entscheidung**
über `CLIMATE_BLEND` = 128 Blöcke, nicht ein geglättetes Temperaturfeld. Zwei
Anläufe über die Temperatur selbst kamen zu schmal heraus, und zwar aus demselben
Grund: der Domain-Warp lässt das Feld an einer Stelle langsam und an der nächsten
abrupt über die Schwelle laufen. Eine feste Breite in Temperatureinheiten ergibt
dann 20 Blöcke hier und 400 dort; die Breite aus dem gemessenen Gradienten
abzuleiten tauscht das nur gegen einen anderen Fehler, weil der Warp schneller
wackelt als jede Basislinie, über die man die Steigung messen kann (gemessen:
Median 40 Blöcke, also gut ein Chunk). Wer stattdessen die **Entscheidung**
mittelt, umgeht die Form des Feldes ganz: der Übergang ist per Konstruktion so
breit wie der Filter. Die Tent-Gewichtung statt eines Kastenfilters ist das, was
daraus eine S-Kurve macht.

`isSnowColumn` **verzerrt die Grenze** (Domain Warp), statt zu dithern: es fragt
das Klima ein Stück weiter links oder rechts, wobei Rauschen entscheidet wie weit.
Wo dieser Versatz über die Grenze wackelt, kippt die Antwort hin und her, und
genau das legt einzelne Schneenester vor die Schneegrenze und Waldinseln
dahinter. Die naheliegende Variante (Gewicht gegen einen Rauschwert vergleichen)
war der erste Versuch und ist auf eine leicht zu übersehende Art falsch:
fraktales Rauschen ist eine Summe von Oktaven, seine Werte häufen sich also um
0.5 statt sich gleichmäßig zu verteilen. Gemessen sprang das von fast keinem
Schnee bei Gewicht 0.25 auf 81 % bei 0.46 und warf damit fast den ganzen
Übergang weg, für den das Klimafeld gerade gebaut worden war.

Gemessen über 192.000 Spalten und sechs Seeds: **jeder echte Biomwechsel ist
mindestens 3,2 Chunks breit** (Median 3,5, p90 8,9). Der Schneeanteil pro Spalte
folgt dem Klimagewicht nahezu linear (0.2 → 7 %, 0.5 → 41 %, 0.8 → 90 %). Der
Schnee-Anteil der Welt bleibt bei 11,8 %, also unverändert gegenüber vorher.

### Stufe 1: die Höhenkurve

`TERRAIN_BASE` bleibt bei 65, weil jede Tiefenangabe im Spiel relativ dazu
geschrieben ist (Erz-`minDepth`, Höhlenstart, `depthOffset` der Hintergrund-
ebenen). Darauf liegen sechs Felder:

| Feld | Frequenz | Wirkung |
|---|---|---|
| `getRelief` | 0.0012 | Wie dramatisch ist diese Gegend? Skaliert alles Übrige. Ohne dieses Feld hat die ganze Welt überall denselben Charakter. |
| `getMountainBoost` | 0.004 | Bergketten, an `relief` gekoppelt statt überall |
| `getValleyCut` | 0.0022 | Schneidet Täler und Canyons nach unten, mit steilen Flanken |
| `getTerraceAmount` | 0.0016 | Rastet die Höhe auf Stufen von `TERRACE_STEP` = 6 ein |
| `getPlateau` | 0.0009 | Hebt den Grundpegel breitflächig an, **ohne** Rauheit |
| `getRuggedness` | 0.0018 | Verschiebt dieselbe Amplitude zwischen sanft und zerklüftet |

`getBiomeHeight(x)` hat **kein `biome`-Argument mehr**. Es liest den Schneeanteil
selbst, statt sich ein Ja/Nein sagen zu lassen, das nur chunkgenau war. Das
allein nimmt eine sichtbare Naht aus den Parallax-Hügeln, die vorher an
Chunk-Grenzen ihr Profil wechselten.

### Sub-Zonen

`getPlateau` und `getRuggedness` sind bewusst **getrennt von `getRelief`**.
Relief beantwortet „wie viel Höhe passiert hier", die beiden anderen „welche
Form nimmt sie an", und das ist eine andere Frage: ein Hochplateau und ein
zerklüfteter Grat können dasselbe Relief tragen und sind trotzdem zwei Orte,
die man verschieden beschreiben würde.

Schnee senkt die Schwelle für ein Plateau (`gate = 0.52 - snow * 0.13`), weil
eine Schneegrenze in Wirklichkeit eine Höhenlage **ist**. Ohne diese Kopplung war
das verschneite Hochplateau ein seltener Zufall aus zwei unabhängigen Feldern
(0,3 % der Welt); mit ihr ist es ein Ort, an dem man ankommt (2,3 %).

Aus der Kreuzung der drei Achsen fallen die Zonen heraus, ohne dass irgendwo
eine Liste von Zonen stünde. Gemessen über 24.000 Chunks (768.000 Spalten),
`y` wächst nach unten, kleineres `y` ist also höheres Gelände:

| Zone | Anteil | mittleres `y` | Spanne | Stufen | Einschnitte ≥ 25 |
|---|---|---|---|---|---|
| Verschneites Hochplateau | 1,3 % | **51,7** | **8,7** | **0,58** | **1,9 %** |
| Gletscher-Schlucht | 1,3 % | **51,7** | 11,3 | 1,04 | **6,7 %** |
| Flaches Taldickicht | 23,8 % | **62,1** | 10,7 | 0,90 | 2,6 % |
| Steiles Hochgebirge | 6,1 % | 57,9 | **13,1** | **1,71** | **9,2 %** |
| ganze Welt | 100 % | 59,4 | 11,4 | 1,20 | 4,8 % |

Die aussagekräftigste Zeile ist das Paar oben: Plateau und Schlucht liegen auf
**derselben Höhe** (51,7), aber die Schlucht ist dreieinhalb Mal so oft tief
eingeschnitten. Genau das war der Zweck, dieselbe Hochlage einmal ruhig und
einmal durchschnitten.

### Warum `getBiomeHeight` und `getSnowWeight` gecacht sind

Beide sind **nicht nur Weltgenerierung**. Der Hintergrund-Renderer ruft
`getBiomeHeight` einmal pro sichtbarer Spalte pro Frame auf (drei Parallax-Ebenen
plus die Höhlen-Rückwand), also einige tausend Mal pro Sekunde, und die Funktion
war schon vor den Sub-Zonen 14 Rausch-Oktaven tief. Die Caches sind
**direkt abgebildet** (Index = `x & (N-1)`) statt eine `Map`: beide Verbraucher
lesen einen zusammenhängenden Spaltenbereich, Kollisionen innerhalb eines
Durchgangs sind damit praktisch ausgeschlossen, es gibt keine Allokation und
nichts, was unbegrenzt wächst.

**Eine Falle steckt darin:** die Parallax-Ebenen tasten bei `wx * 0.28` ab, also
an **gebrochenen** x. Die auf ganze Blöcke zu runden würde drei, vier
Bildschirmspalten dieselbe Höhe geben, die fernen Hügel kämen als Treppe statt
als Grat heraus. Gebrochene x nehmen deshalb den direkten Weg am Cache vorbei.
`getSnowWeight` darf dagegen runden: sein Feld läuft mit Frequenz 0.0035, also
rund 286 Blöcke pro Zelle.

Gemessen: der Parallax-Pfad kostet 0,045 ms pro Frame statt vorher 0,037 ms
(0,3 % eines 60-Hz-Frames), der ganzzahlige Pfad ist mit Cache **schneller** als
vorher ohne (0,002 statt 0,003 ms). Ungültig wird der Cache über einen
Zahlen-Fingerabdruck aus `SEED` und den Mod-Feldern, geprüft bei jedem Zugriff,
statt über die sieben Stellen, die `SEED` oder `activeMod` zuweisen.

Die Terrassierung ist der wichtigste Teil und der am leichtesten zu übertreibende.
Sie ist **das einzige Feld, das eine senkrechte Wand erzeugen kann**: glattes
Rauschen bewegt sich weit unter einem Block pro Spalte, eine „steile" Bergflanke
ist also eine 60-Grad-Rampe, niemals eine Wand. Nur wo die Höhe auf ein Raster
einrastet, passiert die ganze Stufe zwischen zwei benachbarten Spalten. Genau
diese Kante wird in Stufe 2 unterhöhlt. Gemessen eingestellt: rund 30 % der Welt
ist überhaupt terrassiert, etwa 9 % stark.

### Stufe 2: das Dichtefeld

Bis hierher ist alles eine **Heightmap**, also genau eine Oberflächenreihe pro
Spalte. Das ist eine Silhouette, die man ohne Absetzen zeichnen kann, weshalb
die Welt nur Hügel sein konnte, egal wie dramatisch die Höhenkurve wird. Ein
Überhang braucht zwei Oberflächen in einer Spalte und ist dort gar nicht
darstellbar.

Früher standen hier zwei handgeschriebene Durchgänge: einer unterhöhlte den Fuß
einer Steilwand, der andere ließ die obersten zwei Reihen über die Kante ragen.
Zusammen konnten sie genau **eine** Form erzeugen, und jede weitere Form hätte
einen eigenen Durchgang mit eigenen Regeln gebraucht. Beide sind weg.

Stattdessen beantwortet `terrainSolidAt(wx, y, sy, gateUp, gateDown)` in
`voxeria-engine.js` eine einzige Frage: **ist an dieser Stelle Fels?** Überhänge,
Felsbögen, freistehende Türme und Höhleneingänge sind alle dieselbe Antwort
darauf. Wo das Feld keine Erlaubnis hat, fällt es exakt auf die Heightmap
zurück, es ist also eine strenge Erweiterung dessen, was vorher da war.

| Konstante | Wert | Bedeutung |
|---|---|---|
| `DENSITY_UP` | 9 | Reihen über der Höhenlinie, die zu Fels werden dürfen |
| `DENSITY_DOWN` | 22 | Reihen darunter, die zu Luft werden dürfen |
| `DENSITY_FLIP` | 0.38 | wie stark das Feld drücken muss, um die Höhenlinie zu überstimmen |

**Simplex statt Value Noise.** Das vorhandene `fractalNoise2D` reicht für eine
Höhen*kurve*, weil man dort nur eine Achse sieht. Ein Dichtefeld schaut man in
zwei Dimensionen gleichzeitig an, und da verrät sich Value Noise: seine Extrema
sitzen auf dem ganzzahligen Gitter, geschnittene Formen richten sich also zu
waagerechten und senkrechten Streifen aus. `simplex2D` legt Nullstellen aufs
Gitter statt Extrema und arbeitet mit Dreieckszellen, es gibt also keine Achse,
an der sich das Auge festhalten kann. **Rückgabebereich beachten:**
`fractalSimplex2D` liefert [-1, 1], `fractalNoise1D`/`2D` liefern [0, 1].

**Der Gate ist der Sicherheitsgurt.** Auf flachem Boden ist er null, deshalb
bleiben Wiesen begehbar und die Welt wird kein Schwamm. Die beiden Richtungen
sind **absichtlich unsymmetrisch**: Fels *über* der Höhenlinie ist ein Sims oder
ein Bogen und ergibt nur an einer Wand Sinn, braucht also echte Steilheit. Luft
*darunter* ist eine Unterhöhlung und bekommt einen Grundbetrag von 0.30, der für
sich allein unter der Schwelle liegt.

**Drei Zahlen wurden gemessen statt geschätzt, und alle drei waren beim ersten
Versuch falsch:**

* `DENSITY_FLIP` stand auf 0.52. Drei Oktaven Simplex haben aber eine
  Standardabweichung von 0.305 und erreichen im Extrem nur 0.89, also brauchte
  es selbst bei vollem Gate `|n| > 0.43`. Ergebnis: 0,1 % des Bandes verändert,
  1 % Überhang-Spalten, **kein einziger Bogen**.
* Die Steilheitsrampe lief über `(slope - 0.8) / 1.8`. Nur 13,6 % der Spalten
  ändern ihre Höhe um 1,4 Reihen oder mehr, die Rampe stand auf einer Wand also
  bei 0,33 und verlangte danach `|n| > 0.93` aus einem Feld, das 0.89 nie
  überschreitet. Klippen bekamen buchstäblich nichts.
* Das Profil quer durchs Band war ein reines Zelt. Das drosselt das Feld genau
  dann, wenn es loslegt, und deckelte Überhänge bei drei Reihen. Jetzt liegt in
  der inneren Hälfte volle Erlaubnis und erst außen die Verjüngung. Die
  Verjüngung selbst muss bleiben, sonst endet das Schnitzen an einer waagerechten
  Linie, und die läge als Naht durch die ganze Welt.

Dazu die Persistenz: **0.35 statt der üblichen 0.5**. Am Rand des Bandes liegt
der Gate nahe an der Schwelle, dort entscheidet ein kleines Zittern über eine
Zelle, und damit entscheidet die feinste Oktave allein. Bei 0.5 trug sie 14 %
der Amplitude und ließ ein Block breite Lamellen mitten in sauberen Hohlräumen
stehen; bei 0.35 sind es 8 %, und einzelne Lamellen machen noch 0,61 % aus.

### Der Chunk-Rand, und wie er endlich verschwand

Der Fels wird in einem Fenster gebaut, das den Chunk um **`MARGIN` = 24 Spalten
auf jeder Seite überragt**; nur die Mitte wird behalten.

Der alte Kommentar sagte, der Nachbar sei „von hier gar nicht lesbar". Das stimmt
für seinen **Chunk**, aber nicht für sein **Gelände**: Höhe und Dichte sind reine
Funktionen der Weltposition, die Nachbarspalten lassen sich hier also einfach
neu ausrechnen, ohne `getChunk` anzufassen und ohne Rekursion.

Das zählt für genau einen Schritt, und dort vollständig: **die Entscheidung, was
noch am Boden hängt.** Ein Felsstück, das von etwas zwei Spalten im Nachbarchunk
getragen wird, sieht unverbunden aus, wenn man nur diesen Chunk sehen kann, und
es zu löschen schneidet eine Kerbe die Chunk-Grenze hinunter. Bei den absichtlich
winzigen alten Schnitten war das ein seltener Kratzer. Unter einem Dichtefeld
sind Formationen so groß wie die Marge, und es wäre eine sichtbare Narbe an
jeder Naht der Welt geworden. Nachgemessen: Stufen ab 4 Blöcken liegen an den
Chunk-Grenzen bei **3,52 %** und im Chunk-Inneren bei **6,48 %**, die Nähte sind
also nicht auffälliger als der Rest, sondern ruhiger.

### Traglast: was stehen bleiben darf

Das Feld kennt keine Schwerkraft und lässt Fels in der Luft stehen. Das meiste
davon sind Krümel, ein bis drei Blöcke von einem Sims abgeschabt, und die sehen
nach einem Fehler aus, weil sie einer sind. Ein echter Bogen, der ein Bein
verloren hat, ist dagegen ein Wahrzeichen. Die alte Regel („alles löschen, was
nicht mit dem Grundgestein verbunden ist") konnte beide nicht unterscheiden,
weil sie nie nach der **Größe** fragte.

Jetzt wird jedes losgelöste Stück gemessen und überlebt, wenn es mindestens
`MIN_ISLAND` = 10 Blöcke groß ist **und** `floatingAllowed()` für seine Gegend
gilt (11,8 % der Welt). Alles andere fliegt raus.

Ein Stück, das den **Rand des Fensters** berührt, bleibt ohne Nachfrage stehen.
Seine wahre Ausdehnung ist von hier nicht bekannt, es kann also weiter hinten
sehr wohl am Boden hängen, und Stehenlassen ist der harmlose Fehler: eine
Formation zu viel, die niemandem auffällt, statt eines Lochs, wo die Welt
aufhört. Es macht die Entscheidung außerdem zwischen Nachbarchunks konsistent,
die denselben Fels durch verschiedene Fenster sehen.

**Wichtig:** Das alles läuft **vor** `cmap.set()`. `getBlock`/`localSetBlock`
greifen über Chunk-Grenzen und ziehen Nachbar-Chunks in die Existenz; von hier
gerufen wäre das eine Rekursion in `getChunk` hinein. Der Höhlen-Carver weiter
unten darf sie benutzen, genau weil er nach `cmap.set()` läuft. Das Fenster
umgeht diese Regel nicht, es rechnet neu statt zu lesen.

### Oberflächenmaterial

Gras nur auf sanftem, himmeloffenem Boden; nackter Fels an Steilwänden und
oberhalb der Baumgrenze (Reihe 32); unter einem Überhangdach niemals Erde.
`surfaceY` wird hier aus dem **fertigen** Fels neu bestimmt, weil das Dichtefeld
die Oberfläche verschoben hat und alles Weitere (Erz, Bäume, Ruinen, Höhlen,
Spawn) sie liest. Ein Bogen legt die Oberkante seiner Spalte ein Dutzend Reihen
über den Boden darunter.

### Gemessen

Feld isoliert, 20.000 Spalten (ohne Höhlen, Erz und Bauwerke, damit nur das
Dichtefeld gemessen wird):

| | vorher | jetzt |
|---|---|---|
| Spalten mit Überhang | 3 % | **17,7 %** |
| Spalten mit Bogen (3+ Oberflächen) | 0 % | **3,6 %** |
| Überhangtiefe Median / p90 / max | 1 / 2 / 10 | **4 / 8 / 17** |
| Spalten mit Sims über der Höhenlinie | 0 % | **9,5 %** |

Fertige Welt, 200 Chunks am Stück:

| | |
|---|---|
| Erzeugungszeit | 0,49 ms/Chunk mit Feld, 0,38 ms ohne |
| blockierende Stufen (aufwärts ≥ 4) | 3,22 % (Sprunghöhe 3,78 Blöcke, dazu Doppelsprung) |
| Höhenspanne | 101 Blöcke |
| schwebender Fels | 8.570 Blöcke, 361 Cluster (Basiswert vor dem Umbau: 5.115 / 421) |

Bäume, Gras, Erz und Bauwerke sind **unverändert**: mit und ohne Dichtefeld
gegengemessen ergibt 359 gegen 360 Bäume, 4.981 gegen 4.985 Gras, 429 gegen 429
Planken. Das Feld ändert rund 1 % aller Kacheln, nur eben die sichtbaren.

Erzeugung ist **deterministisch und reihenfolgeunabhängig**: derselbe Chunk
kommt identisch heraus, ob er allein, von links oder von rechts erzeugt wird.
Das ist keine Kosmetik, davon hängt der Mehrspieler ab.

**Wichtig zu wissen, was diese Messung nicht sagt:** „kein schwebendes Gestein"
gilt für den Chunk **am Ende der Traglastprüfung**. Danach laufen noch Erz,
Bäume, Ruinen, Verliese, Minenschächte und der Höhlen-Carver, und die schneiden
sehr wohl Fels los. Über 200 Chunks am Stück gemessen (Flutfüllung über die
ganze Spanne, damit Chunk-Grenzen nicht fälschlich trennen) sind das rund 5.000
Blöcke in gut 400 Clustern. Das ist **kein neuer Zustand**: mit der alten
Höhenkurve gegengemessen kommen dieselben Größenordnungen heraus (5.115 Blöcke,
421 Cluster, größter Cluster 1.307 gegen 6.669 / 410 / 1.355). Wer die
Traglastprüfung anfasst, sollte diese Zahl kennen, sonst hält er den
Normalzustand für den eigenen Fehler.

### Das Feature-Gitter: Abstand ohne Gedächtnis

`featureWinner(cx, radius, chance, channel)` in `voxeria-engine.js`. Ein Chunk
trägt das Merkmal, wenn er seinen eigenen Torwurf besteht **und** jeden anderen
bestehenden Chunk im Umkreis `radius` im Punktwert schlägt. Zwei Gewinner
innerhalb eines Radius sind rechnerisch unmöglich, jeder müsste den anderen
schlagen. Das **garantiert** einen Mindestabstand von `radius + 1` Chunks.

**Warum das kein laufender Puffer ist**, obwohl es genau danach aussieht: ein
Puffer, der sich merkt, was in der Nähe schon erzeugt wurde, macht das Ergebnis
von der **Reihenfolge** abhängig, in der Chunks entstehen. Die hängt davon ab,
wohin der Spieler läuft, und allein die Spawn-Suche baut hunderte Chunks, bevor
irgendjemand irgendetwas sieht. Zwei Spieler im selben Raum mit demselben Seed
bekämen unterschiedliches Gelände, und eine Welt käme nach dem Neuladen anders
zurück. Diese Funktion ist eine reine Funktion des Chunk-Index, sie kann das
also nicht.

Nachgemessen über **72.000 Chunks und sechs Seeds**:

| | Anteil der Chunks | kleinster Abstand |
|---|---|---|
| Wahrzeichen (alle drei Arten) | 8,9 bis 9,1 % | **6 Chunks** |
| Ruinen | 5,4 bis 5,7 % | **6 Chunks** |

Ruinen liefen vorher auf einem freien 5-%-Wurf, der zwei Ruinen in
Nachbarchunks legen konnte. Der Torwert steht jetzt auf 8 %, weil das Gitter
ausdünnt; die Häufigkeit bleibt also praktisch gleich, nur der Mindestabstand
ist neu. **Verliese und Minenschächte bleiben bewusst ohne Gitter**: sie liegen
unter Tage, wiederholen sich also nicht sichtbar, und sie auszudünnen wäre eine
Änderung am Beuteangebot, nicht an der Landschaft.

### Die drei Wahrzeichen

**Ein** Gitter für alle drei Arten, nicht eines je Art. Getrennte Gitter ließen
eine Felsspitze und eine Schlucht im selben Chunk landen, und verlangt ist, dass
sich eine Gegend auch nicht *in ähnlicher Form* wiederholt.

| Art | wirkt auf | Form |
|---|---|---|
| `CANYON` | Höhenkurve | `+ s⁴ · 30`, ein schmaler tiefer Schlitz |
| `SPIRE` | Höhenkurve | `− s⁵ · 20`, ein schmaler hoher Turm |
| `OVERHANG` | Dichte-Gates | `up += s · 1.3`, `down += s · 0.9` |

`s` ist `sin²` der Position im Chunk: null an **beiden** Rändern und flach dabei.
Ein Wahrzeichen, das an der Chunk-Grenze einfach anginge, endete in einer
senkrechten Wand genau auf der Naht, und das ist der eine Ort, an dem eine
Landform keine Kante haben darf. Die hohen Potenzen (`s⁴`, `s⁵`) machen die
Formen schmal; `sin²` allein gäbe eine breite weiche Mulde und eine breite
weiche Kuppe, und beides ist kein Wahrzeichen.

Die beiden Höhenkurven-Wahrzeichen werden **nach** der Terrassierung
aufgetragen. Eine Schlucht, die danach noch auf ein Sechser-Raster einrastet,
käme als Treppe heraus, und der Sinn an ihr ist der glatte Absturz.

Chunk 0 bleibt immer schlicht: dort startet die Spawn-Suche, und eine Schlucht
an der Stelle wäre das Erste, was jede neue Welt zeigt.

Gemessen (1.500 Chunks, Überhang-Spalten je Chunk):

| Chunk-Art | Überhang-Spalten | mittlere größte Tiefe |
|---|---|---|
| `OVERHANG` | **14,0** | 7,8 |
| `CANYON` | 11,4 | 9,0 |
| `SPIRE` | 11,1 | 8,7 |
| gewöhnlich | 5,0 | 5,2 |

Höhe in der Chunkmitte gegen den Durchschnitt der Nachbarchunks: Schlucht
**29,5 Blöcke tiefer**, Felsspitze **20,7 Blöcke höher**, Überhang-Wahrzeichen
4 Blöcke (es ändert die Höhe ja nicht). Sprung genau auf der Chunk-Grenze: 0
bis 1 Block.

Kosten: 0,66 ms je Chunk statt 0,60 ohne Gitter.

### Micro-Varianz, und was davon messbar war

`microVariance(wx)` ist ein chunk-eigener Hash, der **über** die Chunk-Grenze
glatt interpoliert statt an ihr zu springen. Die Stützstellen sitzen exakt auf
den Chunk-Indizes, jeder Chunk bekommt also wirklich seinen eigenen Seed, aber
der Wert springt nie. Ein roher Wert pro Chunk gelesen setzte eine sichtbare
Stufe auf jede Naht.

Er hängt an den Dichte-Gates, damit nicht jede Wand gleicher Steilheit gleich
geschnitten wird.

**Ehrlich zum Ergebnis:** der messbare Zugewinn ist klein. Bei Chunks im selben
Steilheitsband liegt die Streuung der Überhang-Spalten mit Varianz bei 3,75 und
ohne bei 3,71. Der Grund ist kein Fehler, sondern eine Eigenschaft des Systems:
die Welt hatte schon zwölf unabhängige Rauschfelder, ein dreizehntes fügt einer
Sache, die ohnehin stark streut, wenig hinzu. Wie stark sie streut, zeigt
dieselbe Messung: Chunks **gleicher Steilheit** haben zwischen **1 und 26**
Überhang-Spalten.

**Drei Versuche, Baumgruppen so zu steuern, sind gemessen gescheitert** und
wurden wieder entfernt, statt als wirkungslose Regler stehen zu bleiben:
Spaltenwurf skalieren, Mindestabstand schwanken lassen, Boden-Steilheit
schwanken lassen. Keiner saß am Flaschenhals. Von den bestandenen Baum-Würfen
scheitern **91 % am Boden** (kein Gras, weil Fels oder Überhangdach) und nur
**0,2 % am Abstand**. Wie dicht ein Waldstück wird, entscheidet allein, wie viel
Gras das Gelände übrig lässt. Baumgruppen folgen damit der Landschaft statt
einem zweiten Regler daneben, und enger stellen ginge ohnehin nicht: die halbe
Kronenbreite ist nachgemessen 3, zwei Bäume im Abstand 6 berühren sich also
schon.

### Zustand nach allen drei Stufen

200 Chunks am Stück, aufgewärmt gemessen:

| | |
|---|---|
| Erzeugungszeit | 0,66 ms/Chunk |
| blockierende Stufen (aufwärts ≥ 4) | 3,78 % |
| Stufen an Chunk-Nähten / im Inneren | 6,03 % / 7,60 % |
| Höhenspanne | 101 Blöcke |
| schwebender Fels | 7.630 Blöcke, 388 Cluster (Basis vor dem Umbau: 5.115 / 421) |

Erzeugung ist **reihenfolgeunabhängig**: derselbe Chunk kommt identisch heraus,
ob die Nachbarschaft von links, von rechts oder in zufälliger Reihenfolge
erzeugt wird.

Ein Chunk **isoliert** erzeugt unterscheidet sich dagegen von demselben Chunk
mit Nachbarn, und das ist **kein neues Verhalten**: der Höhlen-Carver läuft nach
`cmap.set()` und gräbt per `localSetBlock` in Nachbarchunks hinein. Gemessen
betrifft das 18 von 36 gewöhnlichen Chunks genauso wie die Wahrzeichen-Chunks,
und die Unterschiede sind ausnahmslos `STONE -> AIR`.

### Bauwerke an der Oberfläche

Es gibt noch **zwei**: die **Ruine** (5 % der Wald-/Schnee-Chunks, Layout-Raster
mit Steindach) und die **Kohlenmine** (Kammer-Variante im Höhlen-Carver, 25 %
der Kammern). Der Wachturm und das Dorfhaus sind entfernt.

Mit dem Dorfhaus verschwand auch die einzige Stelle, die das Höhenfeld
überschrieb: es planierte neun Spalten auf eine Höhe, damit das Haus eben steht.
Der Boden ist jetzt überall genau das, was `getBiomeHeight` liefert.

Die Ruine wird gegen **eine** Oberflächenreihe gezeichnet und braucht deshalb
ebenen Grund. Zwei Dinge sichern das ab: ihre Grundfläche wird oben im
Klippen-Abschnitt reserviert (`reservedCol`), damit sie nicht unterhöhlt wird,
und sie erscheint nur, wenn der Höhenunterschied über die Grundfläche höchstens
3 Blöcke beträgt. Beides wurde mit der dramatischeren Landschaft nötig; vorher
war praktisch alles eben genug. Wichtig dabei: `hasRuins` und `ruinX` werden
**einmal** oben gewürfelt und unten gelesen, nicht zweimal gewürfelt.

## Handy und Hochformat

Hochformat war gesperrt (`#rotate-overlay` nahm den Bildschirm, `#game-wrapper`
war ausgeblendet). Die Sperre ist weg, Hochformat ist eine unterstützte
Ausrichtung.

Der knappe Rohstoff im Hochformat ist **Höhe**: jede Zeile Bedienleiste geht
direkt von der sichtbaren Welt ab. Deshalb:

* Die Knopfleiste (`#info-bar`) ist im Hochformat **eine seitlich scrollende
  Zeile** statt eines umbrechenden Rasters. Sieben Knöpfe à 112 px ergaben auf
  375 px drei gestapelte Zeilen; jetzt ist es eine (52 px), und die Welt bekommt
  93 % des Bildschirms.
* Der Kompaktierungs-Block galt nur für `orientation: landscape`. Er greift
  jetzt zusätzlich bei `max-width: 820px`, sonst bekäme ein Hochformat-Handy die
  volle Desktop-Optik.
* **Der Blickwinkel wird aufgezogen.** `COLS`/`ROWS` leiten sich vom
  Backing-Store ab, und das Element wird per CSS auf seine Box gestreckt, also
  ist ein größerer Backing-Store genau ein Herauszoomen. Ohne das sind 375 px
  bei `TILE = 28` dreizehn Spalten Welt, und dreizehn Spalten sind in einem
  Seitenscroller ein Korridor. Der Faktor 1.4 greift **nur** bei hochkant und
  schmal und liegt **vor** der Leistungsprüfung, damit er das Budget der
  Auflösungsleiter nicht umgeht. Ergebnis: 18 × 37 statt 13 × 26.
* Die drei Creator-Werkzeuge sind ein Drei-Spalten-Raster mit einer Stufe bei
  1100 px. Unter 760 px stapeln sie sich zu **einer** Spalte. Dabei muss
  `max-height` auf dem Malraster ausdrücklich gelöscht werden: die Desktop-Regel
  deckelt es auf 100 % der Bühne, was in einer gestapelten Spalte das
  `aspect-ratio` aussticht und das Raster zu 308 × 194 quetscht.
* Tippziele mindestens 38 bis 42 px, Eingabefelder 16 px (darunter zoomt iOS
  Safari beim Fokus die ganze Seite hinein).

Alles davon steckt in Media Queries; Desktop ist nachweislich unverändert
(51 × 30 Blöcke, Raster-Layout, 797 px Malfläche).

### Querformat-Handys (die zweite Runde)

Die erste Fassung deckte nur `orientation: portrait` ab. Ein Handy quer
(z. B. 844 × 390) ist aber genauso knapp an Höhe wie ein Handy hochkant an
Breite, nur andersherum — `orientation: landscape` sagt für sich genommen
nicht „Handy quer", sondern trifft ebenso auf einen breiten Desktop-Monitor
zu. Deshalb sind die höhenkritischen Regeln (Knopfleiste als einzelne Zeile,
Touch-Steuerung, Hotbar) jetzt an **einen kurzen Bildschirm** gebunden statt an
eine Ausrichtung: `(orientation: portrait) and (max-width: 820px)` **oder**
`(orientation: landscape) and (max-height: 500px)`. 500 px trennt Handys
(höchstens ~430 px quer) zuverlässig von Tablets (mindestens ~768 px quer).
Die breiten-getriebenen Regeln (Panel-Breiten, Menü-Polsterung) bleiben
Hochformat-exklusiv, weil ein Handy quer davon genug hat.

Beim Nachmessen bei 844 × 390 und dem noch kleineren 568 × 320 (iPhone SE quer)
kamen drei echte Fehler zum Vorschein, alle aus demselben Grundmuster: mehrere
Panels (`#game-menu-panel`, `#settings-popover`, der einmalige
`#intro-hint-banner`, `#mod-builder-modal`, `#room-panel`, …) öffnen sich per
Opacity-/Sichtbarkeits-Übergang statt `display:none`, damit die Animation
funktioniert — ein **geschlossenes** Panel behält also seine volle Layout-Box.
Auf einem gewöhnlichen Bildschirm ist das folgenlos; bei 320 px Höhe reicht
diese Box über den Bildschirmrand hinaus und blähte
`document.documentElement.scrollHeight` auf, sodass die **ganze Seite**
scrollte statt nur der Welt-Ausschnitt.

Statt jedes Panel einzeln zu flicken (es gibt gut ein Dutzend mit demselben
Muster), sitzt die eigentliche Bremse jetzt an der Wurzel: `#game-wrapper`
bekommt bei kurzem Bildschirm `overflow: hidden`. Da `#game-wrapper` exakt
bildschirmhoch ist (`height: 100dvh`), kappt das jedes Panel, das versucht,
darüber hinauszuragen — ohne das eigene `overflow-y: auto` der Panels
anzutasten, das weiterhin innerhalb der Panel-Box scrollt. Zwei Panels
brauchten zusätzlich einen gezielten Fix: `#game-menu-panel` und
`#settings-popover` bekamen ein `max-height` gebunden an ihren eigenen
`top`-Versatz (das reine Abschneiden hätte sie sonst unten kappen statt
intern scrollen zu lassen), und `#mod-builder-modal`/`#mod-creator-modal`
wechseln bei kurzem Bildschirm auf `position: fixed`, weil sie sich sonst auf
`#canvas-wrapper` zentrieren — das ist durch Infoleiste und Hotbar bereits
geschrumpft, während ihr eigenes `max-height: 88vh` sich auf die volle
Bildschirmhöhe bezieht, wodurch das Panel oben oder unten abgeschnitten
wurde, obwohl die Seite selbst schon nicht mehr scrollte.

Geprüft mit allen genannten Panels gleichzeitig offen bei 320, 390 und 812 px
Höhe: kein Seiten-Scroll, jedes Panel bleibt sichtbar und intern scrollbar.
Desktop (1440 × 900) unverändert — die Regeln greifen ausschließlich unter der
500-/820-px-Schwelle.

## Text als Datentyp im Mod-System

Ein Mod kennt drei Speicher: Zahlen (`graphVars`), Listen (`graphLists`) und
**Texte** (`graphTexts`), alle drei in `voxeria-modding.js`. Der Textspeicher ist
der jüngste und kehrt eine frühere Entscheidung um. Vorher hieß es „nur Zahlen,
eine Textvariable wäre bloß eine schlechtere Art, ‚Show a message‘ zu sagen“.
Das galt genau so lange, wie Text nicht **gebaut** werden konnte: mit
„join with“ setzt ein Mod jetzt eine Zeile zusammen, die beim Bauen niemand
eingetippt hat, und kann zwei Texte vergleichen. Das ist eine Art von Daten, die
der Zahlenspeicher nicht ausdrücken konnte.

Zwei neue Karten, jeweils im Zuschnitt ihres Zahlen-Geschwisters:

| Karte | entspricht |
|---|---|
| `changeText` „Set or change a text“ | `changeVar`, mit `set to` / `join with` / `join with a space` |
| `ifTextIs` „If a text ...“ | `ifCompare`, mit `is` / `is not` / `contains` / `is empty` |

Dazu ein **eigener Slot-Typ** `kind: 'textvalue'`, gespeichert als `{s, t, v}`
parallel zum `{s, n, v}` der Zahlen. Bewusst kein vierter Quelltyp am
Zahlen-Slot, aus zwei Gründen, und der zweite trägt die Entscheidung:

* Jeder vorhandene Slot verspricht seinem Leser eine **Zahl** (eine Anzahl, ein
  Radius, ein Stat). Eine Quelle, die Text zurückgeben könnte, hieße: jeder
  dieser Leser braucht eine Antwort auf „und wenn da ein Wort steht?“, wegen der
  zwei Stellen, die tatsächlich eins wollen.
* Die gespeicherte Form **jedes je geteilten Mod-Codes** hätte ein Feld
  dazubekommen. So ändert sich kein einziges Byte an einem bestehenden Code.

Die Regel lautet deshalb: ein Zahlen-Slot bleibt Zahlen, ein Text-Slot bleibt
Text. Sie treffen sich an genau einer Stelle, „Show text or a number“, die von
jedem eins hat und immer hatte.

**Rückwärtskompatibilität.** `showText.text` und `showDialog.title` waren feste
Zeichenketten und sind jetzt Text-Slots. `graphCleanTextValue` nimmt eine rohe
Zeichenkette weiterhin an und hebt sie auf `{s: 'a fixed text', t: …}` an, ein
alter Code zeigt also wortgleich dasselbe Banner. Nachgemessen am geteilten
Code aus `depth_gauntlet_mod_code.txt` (55 Karten, 9 Banner): alle Parameter
aller Karten kommen nach einem Encode/Decode-Rundlauf byte-identisch zurück.

**Absichtlich fest geblieben** sind die Knopfbeschriftungen von
„Ask with buttons“ und das `button`-Feld von „When a dialog button is pressed“.
Die werden über ihre **wörtliche Aufschrift** gematcht; wäre sie berechenbar,
könnte ein Knopf etwas anderes zeigen als das, worauf das Ereignis wartet.

Im Terminal ist das Sigil **`&NAME`** (`$NAME` ist für Zahlen vergeben, `#`
beginnt einen Kommentar). Die Befehle heißen `Set-Text` und `Compare-Text` und
sind, wie alle anderen, aus `NODE_CATALOG` generiert.

Begrenzt ist ein Text auf `GRAPH_MAX_TEXT` = 48 Zeichen, dieselbe Länge, die das
Eingabefeld schon erlaubte. Das ist kein Schönheitswert: ohne ihn könnte ein
„join with“ auf einem Timer eine Zeichenkette unbegrenzt wachsen lassen, genau
wie `graphClampNum` das für „add 999“ verhindert.

### Das Eingabefeld im Dialog

„Ask with buttons” hat einen sechsten Parameter, `into`. Leer gelassen heißt
„kein Eingabefeld”, also genau der Dialog, den es vorher gab; steht ein Name
drin, bekommt der Kasten ein Textfeld, und beim Knopfdruck liegt das Getippte
als gespeicherter Text unter diesem Namen. Dieselbe Konvention, unter der ein
leer gelassener Knopf nicht gezeigt wird. Damit schließt sich der Kreis: der
Spieler tippt etwas, der Mod merkt es sich, setzt es zusammen und zeigt es an.

Der Parameter hängt **ans Ende** der Liste, obwohl er inhaltlich unter die
Frage gehörte: die Reihenfolge in `NODE_CATALOG` ist zugleich die Reihenfolge
der Stellungsargumente im Terminal, ein Einschub in der Mitte hätte also jedes
geteilte `Show-Dialog`-Skript um eine Stelle verrutschen lassen.

Drei Dinge, die dabei nicht offensichtlich sind:

* **Die Tastatur gehört dem Feld.** Die Engine steigt in ihrem eigenen
  `keydown`/`keyup` aus, sobald ein `INPUT` den Fokus hat (`voxeria-engine.js`),
  ein getipptes „a” lässt die Figur also nicht loslaufen. Das gilt auch bei
  „let me keep moving”: ein Dialog mit Eingabefeld nimmt die Tastatur immer.
  Die Einstellung wirkt weiter auf die Physik, nicht mehr auf die Tasten.
* **Gedrückte Tasten werden beim Öffnen geleert.** Derselbe Ausstieg schluckt
  auch das Loslassen, eine beim Öffnen gehaltene Taste bliebe also dauerhaft
  „unten” und die Figur liefe nach dem Schließen von selbst weiter.
* **Der Text wird vor dem Ereignis gesichert.** `commit()` läuft vor
  `fireGraphEvent('onButtonPress')`, damit eine Regel die Antwort sofort
  benutzen kann statt erst im nächsten Frame.

Enter drückt den ersten Knopf (es gibt immer einen, `showDialog` ergänzt
notfalls „OK”). Das Feld steht auf 16px, weil iOS Safari darunter beim Fokus
die ganze Seite hineinzoomt.

**Ungefährlich trotz freier Eingabe:** `showNotification` und der Dialog-Titel
schreiben über `textContent`, die schwebende Schrift wird auf die Leinwand
gemalt, und die Debug-Anzeige läuft durch `escapeHtml`. Markup in einem Text
ist also überall inert, auch wenn der Mod von einem Fremden kommt.

## Panels: die eigene Anzeige eines Mods

Alles, was ein Mod zeigen konnte, war vorher **flüchtig** (Banner 2,5 Sekunden,
schwebende Schrift) oder **fest gebaut** (die Arena-Punktetafel). Eine Zeile,
die stehen bleibt und fortgeschrieben wird, „Welle 3", „Leben: 2", „noch 45s",
war nicht sagbar. Genau das braucht aber jedes Minispiel.

Zwei Karten, beide in `voxeria-modding.js`:

| Karte | Terminal | wofür |
|---|---|---|
| `setPanel` „Show or hide a panel" | `Show-Panel` | wo der Kasten hängt, wie er heißt, `show` / `hide` / `clear` |
| `panelLine` „Write a line on a panel" | `Set-Panel-Line` | was in Zeile *n* steht, mit Text **und** Zahl wie „Show text or a number" |

**Bewusst zwei Karten**, obwohl der Katalog sonst zusammenlegt: die eine sagt
*wo*, die andere *was*. Auf einer Karte wären es acht Felder, von denen je nach
Auswahl die Hälfte wirkungslos ist, und das liest ein Anfänger nicht mehr auf
einen Blick.

**Bewusst keine freie Oberfläche.** Ein Panel ist ein Kasten in einer Ecke mit
Überschrift und bis zu sechs Zeilen. Ein Mod beschreibt nur, was in Zeile 3
steht, und schreibt nie Markup in die Seite. Gezeichnet wird über `textContent`,
nicht `innerHTML`. Das ist die Bedingung dafür, dass ein geteilter Mod von einem
Fremden harmlos bleibt, dieselbe Regel, unter der schon der Dialog steht.

Vier Behälter, einer je Ecke, jeder eine Flex-Spalte: dass Panels sich
**stapeln** statt sich zu überlagern, fällt damit dem Layout zu und muss
nirgends gerechnet werden. `pointer-events: none` auf allem, ein Mod darf den
Bildschirm beschriften, aber niemals einen Klick abfangen, der der Welt galt.

Grenzen wie bei `graphZones` und aus demselben Grund: höchstens 4 Panels, 6
Zeilen. Eine Regel, die jeden Frame läuft, darf den Bildschirm nicht unbegrenzt
zupflastern.

Details, die beim Bauen nötig wurden:

* **Angelegt beim ersten Schreiben**, wie `graphGetList` eine Liste anlegt. Wer
  nur eine Zeile zeigen will, braucht die erste Karte gar nicht.
* **`hide` und `clear` legen nichts an.** Ein Panel zu verstecken, das es nicht
  gibt, tut nichts, statt einen der vier Plätze zu verbrauchen.
* **Eine leer geschriebene Zeile verschwindet**, statt als Lücke stehen zu
  bleiben. So räumt eine Regel eine einzelne Zeile ab, ohne eigene Karte dafür.
* **Oben rechts sitzt die Arena-Punktetafel.** Die Spalte dort weicht um deren
  gemessene Höhe nach unten aus, solange sie sichtbar ist, und nimmt den Platz
  zurück, sobald sie weg ist. Deshalb ruft `graphRenderBoard`/`graphHideBoard`
  auch `graphRenderPanels()`.
* **Beim Weltwechsel geleert**, sonst blieben die Kästen des vorigen Mod-Satzes
  stehen, obwohl die Regel dahinter weg ist.

Die Palette hat dafür ein eigenes Bündel **„On-screen display"** bekommen
(`showText`, `showDialog`, `setPanel`, `panelLine`). Die beiden ersten lagen
vorher unter „Spawning & effects", zwischen Kreaturen und Partikeln, wo sie
niemand sucht.

## Farben in Block- und Kreatur-Designer

Beide Designer malen mit **beliebigen RGB-Farben**, nicht mehr mit einer festen
16er-Palette. Die sechzehn eingebauten Farbfelder sind nur noch der *Startpunkt*
einer Zeichnung; „+ New colour“ hängt jede gewünschte Farbe an, „Edit colour“
färbt ein Feld nachträglich um und damit jeden Pixel, der es benutzt.

Technisch trägt jedes Stück seine **eigene Farbtabelle** im Code mit. Der
Pixel-Payload hat dafür zwei neue Modi bekommen (`voxeria-modding.js`):

| Modus | Inhalt |
|---|---|
| `P` / `R` | 4 Bit pro Pixel gegen die eingebaute 16er-Palette (unverändert) |
| `D` / `C` | Farbtabelle + 8 Bit pro Pixel (`C` zusätzlich lauflängenkodiert) |

`encodePiecePixels()` wirft vorher alle Farben weg, die in der fertigen
Zeichnung gar nicht vorkommen, und wählt dann die kürzeste Variante. Eine
Zeichnung, die nur eingebaute Farben benutzt, ergibt deshalb **byteweise
denselben Code wie vorher**: jeder alte Code bleibt lesbar, und ein neuer Code
aus einer schlichten Zeichnung bleibt auch für ältere Spielstände lesbar. Ein
typisches handgemaltes Stück liegt bei rund 370 Zeichen.

**Wichtig für alles, was Pixel zeichnet:** `pixels` und `palette` gehören
zusammen. `_pieceCanvasFromPixels(pixels, palette)` und
`_blockPixelsAverageColor(pixels, palette)` ohne Palette aufzurufen heißt „diese
Indizes meinen die eingebaute Palette“: richtig für die `P`/`R`-Modi und für
die prozedurale Demo-Kunst im Hauptmenü, falsch für alles andere.

## Geteilte Mods (Modus 2) und die Block-ID-Falle

In den Modi mit Creator-Werkzeugen (Exploration, Arena) veröffentlicht jeder
Spieler seine aktivierten Bibliotheks-Stücke in den Raum, und jeder bekommt die
der anderen — ohne Installation, weil ein Mod hier nur ein Textcode aus einem
geschlossenen Katalog ist.

**Der heikle Punkt sind die Block-IDs.** Eigene Blöcke bekommen zur Laufzeit
Nummern aus 200–255, und *diese Nummer* landet beim Bauen in der Welt und
wandert über Firestore zu den anderen. Zwei Regeln halten sie stabil:

1. Die Autoren-Reihenfolge ist **anhängend**, nicht sortiert — sie richtet sich
   nach `since` (wann jemand in dieser Welt zum ersten Mal veröffentlicht hat),
   das im Dokument des Autors steht. Nach UID zu sortieren wäre naheliegend und
   falsch: ein Beitretender mit kleinerer UID hätte sich vor alle geschoben.
2. Jeder Autor bekommt eine **feste Scheibe** von 8 IDs. Ohne das verschiebt
   schon ein einzelner neuer Block alle Nummern der späteren Autoren — mitten
   in der Sitzung, während die alten Nummern bereits verbaut in der Welt
   stehen. Ungenutzte Plätze gehen als `null` an `registerCustomBlockPieces`.

Daraus folgt das Limit: **7 Modder pro Welt** können Blöcke teilen (56 IDs ÷ 8).

Blöcke und Kreaturen laufen immer bei allen — sie sind, woraus die Welt
besteht. Regeln (Knotengraphen) ändern dagegen, wie sich das Spiel für *dich*
anfühlt, und sind deshalb abschaltbar, ohne dass die Welt auseinanderfällt.

Die Zuordnung ist **farbig**: jeder Autor erscheint in seiner Spielerfarbe —
derselben, in der man ihn durch die Welt laufen sieht. Im Mods-Panel als
Balken, Punkt und Name; im Spiel als Ring um den Block, den man gerade in der
Hand hält.

## Die Mod-Galerie im Hauptmenü

`window.VxGallery` (`voxeria-gallery.js`, geladen nach `voxeria-modding.js`
und `voxeria-menu-worlds.js`, vor `voxeria-boot.js`) ist eine öffentliche,
durchstöberbare Liste veröffentlichter Mods. **Zwei Ansichten:** die
durchsichtige Seitenleiste links neben `#vx-menu` zeigt nur die **fünf
neuesten** als Appetithappen, dahinter öffnet "See all mods" das volle
Galerie-Fenster mit Kategoriefiltern und einer Karte pro Mod. Baut komplett
auf dem bestehenden Mod-Code-System auf, statt etwas Neues zu erfinden:

- **Eine Karte** zeigt ein Weltbild, Titel/Autor und genau drei Knöpfe:
  Melden (Flagge), Details (i) und Spielen (Dreieck). Alle Icons sind
  **selbst gezeichnet**, nie System-Emoji: die sehen auf jedem Betriebssystem
  anders aus und passten nicht neben 32×32-Blockgrafik. Gleiches Rezept wie
  die bestehenden `drawIcon*` in voxeria-engine.js (flache Rechtecke, dieselben
  zwei Farbtöne, danach `_vxCrispen`), aber in `voxeria-gallery.js` selbst
  definiert, damit das Löschen des Script-Tags weiterhin alles mitnimmt.
  `terrain` wird aus dem bestehenden `VX_ICONS` wiederverwendet — das Bild
  gab es schon und passt für die Kategorie "World" exakt.
- **Kategorien werden aus dem Code abgeleitet, nie vom Autor gewählt**
  (`deriveTags()`): welche Stück-Arten enthalten sind (Block/Kreatur/Regel),
  plus "World", wenn die Mod-Hälfte tatsächlich etwas gegenüber
  `modDefaults()` ändert. Dadurch kann nichts falsch einsortiert werden und
  das Veröffentlichen braucht kein zusätzliches Feld.
- **Der Details-Knopf zeigt ebenfalls nur Abgeleitetes** (`describeEntry()`):
  Anzahl und Namen der Stücke, welche Bereiche der Mod ändert, Seed,
  Veröffentlichungsdatum — nichts davon ist von Hand eingetippt, also kann
  eine Beschreibung auch nichts behaupten, was der Code nicht tut.
- **Das Weltbild** ist derselbe 9×9-Block-Schnappschuss von Chunk 0, den die
  "Welt laden"-Kacheln benutzen (`captureWorldThumb()` in
  voxeria-menu-worlds.js ist dort privat, die Galerie hat die ~20 Zeilen
  deshalb als `captureGalleryThumb()` bei sich — ein Export hätte hier mehr
  gekostet als gespart). Aufgenommen beim Veröffentlichen, also die Welt des
  Autors, gespeichert als PNG-Data-URL im Dokument (~3 KB, unkritisch fürs
  1-MB-Limit von Firestore). Fehlt eines, zeigt die Karte einen leeren
  Schraffur-Rahmen statt einer kaputten Grafik.
- **Jedes Feld aus der Datenbank gilt als feindlich.** Die Collection ist
  für jeden angemeldeten Client beschreibbar (die Firestore-Rules prüfen
  `request.auth`, nicht den Inhalt — genau wie bei `voxeria_rooms`), also
  kann ein Dokument beliebige Werte enthalten. Der `code` selbst ist
  ungefährlich, er landet nur in den Decodern, die ihn per Prüfsumme und
  Klemmung entschärfen. Drei Felder gehen aber ins Markup und werden deshalb
  geprüft, nicht geglaubt: `thumb` muss auf eine echte Bild-Data-URL passen
  (sonst zeigt die Karte den leeren Rahmen — ein präparierter String könnte
  sonst aus dem `src`-Attribut ausbrechen), `id` läuft durch `escapeHtml`
  (Firestore-IDs sind nicht garantiert anführungszeichenfrei), und
  `pieceCount` wird auf eine Ganzzahl gezwungen. Titel und Autor kommen
  ohnehin aus dem decodierten Code und gehen zusätzlich durch `escapeHtml`.
  Mit einem absichtlich bösartigen Testdokument nachgeprüft: keiner der vier
  Vektoren führt Code aus.
- **Was bewusst offen bleibt:** Wortfilter und Abkühlzeit laufen im Client
  und sind mit einem veränderten Client umgehbar, und die Sortierung nach
  `createdAt` kann jemand mit einem Datum weit in der Zukunft dauerhaft
  oben festnageln. Beides ist erst mit echten Firestore-Rules lösbar (dort
  gehört es auch hin), nicht im Spielcode — dasselbe Vertrauensmodell, das
  im Rest des Spiels ohnehin schon gilt.
- **Melden** schreibt nach `voxeria_gallery_reports`, Doc-ID =
  `<eintrag>_<uid>`: dieselbe Person kann denselben Eintrag beliebig oft
  melden, es entsteht aber nur ein Dokument statt eines Stapels Duplikate.
  Mehrere Gründe gleichzeitig sind erlaubt (Mehrfachauswahl), mindestens
  einer ist Pflicht. Es gibt bewusst noch **keine** Admin-Ansicht dafür — die
  Meldungen sammeln sich erstmal, ausgewertet wird später.
- **Ein Eintrag = ein Loadout-Code** (`VXL1-<mod>~<stück>~<stück>…`,
  `encodeLoadoutCode`/`decodeLoadoutCode` in voxeria-modding.js), auch bei
  0 Stücken — damit `playGalleryEntry()` nur eine Code-Form behandeln muss.
  Kein eigenes Titel/Autor-Feld: `mod.name`/`mod.author` stecken schon im
  Code (dort beim Bauen im Mod Builder gesetzt).
- **Das erste Feld akzeptiert auch einen alleinstehenden Block-/Kreatur-/
  Regel-Code** (z.B. `VXG2-`, was der "Export"-Knopf im Node-Graph-Editor
  direkt ausgibt — kein Mod drumherum, das ist normal und der häufigste
  Fall bei reinen Regel-Mods). `submitPublish()` erkennt das über
  `isAnyPieceCode()` und verpackt es dann selbst in einen `modDefaults()`
  mit `mod.name` = dem Namen des Stücks, damit weiterhin immer nur die eine
  VXL1-Form gespeichert wird. Ursprünglich übersehen — nur `isModCode()`/
  `isLoadoutCode()` wurden geprüft, ein reiner Regel-Code lief ins Leere.
- **Firestore-Collections** (`artifacts/{appId}/public/data/...`, gleiches
  Namensschema wie `voxeria_rooms`): `voxeria_gallery` (ein Dokument pro
  Veröffentlichung, Auto-ID, Felder `code`/`authorUid`/`pieceCount`/`tags`/
  `thumb`/`createdAt`), `voxeria_gallery_cooldown` (Doc-ID = `userId`, eine
  simple Abkühlzeit von 5 Minuten pro Person) und `voxeria_gallery_reports`.
  Gelesen wird mit **einem** `getDocs` (bis zu 60, neueste zuerst), das beide
  Ansichten speist — bewusst kein Live-`onSnapshot`: eine fremde
  Veröffentlichung mitten im Stöbern würde sonst die Einflug-Animation neu
  auslösen und wie ein Glitch wirken.
- **Spielen überspringt den normalen "Neue Welt"-Dialog komplett** und ruft
  `VxWorlds.applySave({...}, true)` direkt auf — genau der Pfad, den
  `createWorld()` für einen normalen Menü-Klick auch geht. `applySave` war
  bis dahin privat; die einzige Änderung an einer bestehenden Datei ist eine
  Zeile in `voxeria-menu-worlds.js`, die sie im Rückgabeobjekt von
  `VxWorlds` exportiert, statt ihre Logik ein zweites Mal nachzubauen (Gefahr:
  auseinanderlaufen, wenn `applySave` sich später ändert und die Kopie nicht
  mitgepflegt wird).
- **Moderation ist bewusst minimal**: ein fest einprogrammierter Wortfilter
  (`containsBlockedWord()`, komplett neuer Code — es gab vorher **keinen**
  Filter irgendwo im Projekt) auf `mod.name`/`mod.author` beim
  Veröffentlichen, kein Melde-System. Lehnt mit einer konkreten Meldung ab,
  kürzt nie still. Nutzt zusätzlich die schon vorhandene `_bannedUids`-Liste
  (dieselbe, die die Admin-Ban-Funktion live per `onSnapshot` hält) — ein
  gesperrter Spieler kann nicht veröffentlichen, ohne dass dafür ein zweites
  Sperrsystem gebaut wurde.
- **Kein eigener Look, keine `--hud-*`-Token**: diese sind seit der
  HUD-Überarbeitung bewusst blickdicht (`--hud-blur: 0px`, siehe deren
  eigene Definition) — der Sidebar-Hintergrund ist stattdessen aus derselben
  Familie wie `#vx-menu`s eigener durchsichtiger Verlauf, plus
  `backdrop-filter: blur()` für den "Minecraft-Launcher"-Effekt.
- **Sidebar/Modal sitzen als Geschwister außerhalb von `#vx-menu`**, nicht
  als Flex-Kind darin: `#vx-menu` zentriert seinen eigenen Inhalt als Gruppe
  (`flex-direction: column`), eine "links davon"-Seitenleiste würde diese
  Zentrierung stören. Sichtbarkeit läuft rein über einen CSS-Geschwister-
  Selektor (`#vx-menu.show ~ #vx-gallery-sidebar`), kein JS-Hook in
  `VxWorlds.show()`/`hide()` nötig.
- **Unter 980px Breite verschwindet die Seitenleiste** (eigene, an der
  tatsächlichen Größe gemessene Regel — weder die 760px- noch die
  820px-`orientation:portrait`-Regel im Menü sind dafür gedacht, siehe deren
  eigene Kommentare). Bleibt ein Desktop-Bonus; das Menü selbst ist auf dem
  Handy unverändert.

Ein Tag (`<script src="voxeria-gallery.js">`) entfernen macht das Feature
restlos weg — Sidebar/Modal in `index.html` bleiben dann einfach leer und
unsichtbar, nichts sonst im Spiel ruft in diese Datei hinein.

## Lokal testen ohne Node

`.claude/serve.ps1` ist ein kleiner statischer Server in PowerShell, für den
Fall dass weder Node noch Python installiert sind:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/serve.ps1
```

Dann `http://localhost:4173` aufrufen.

## Build für itch.io

`Voxeria_itch_build.zip` enthält `index.html` + alle `.js`-Dateien + `Assets/` +
`Music/`, alles auf oberster Ebene (itch.io erwartet `index.html` im
ZIP-Wurzelverzeichnis).

**Ein neuer Build kann für wiederkehrende Spieler trotzdem alt aussehen --
Browser-Cache, nicht itch.** Nachgemessen am 2026-09-01 (echte
Response-Header von `https://html-classic.itch.zone/html/<id>/...`): itchs
CDN liefert `index.html` selbst UND jede der `voxeria-*.js`-Dateien mit
`Cache-Control: max-age=2678400` (31 Tage). itch haengt bei jedem neuen
Upload zwar ein frisches `?v=<timestamp>` an die AEUSSERE iframe-URL
(`.../index.html?v=...`) -- das erzwingt einen echten Netzwerk-Request für
`index.html` selbst, egal was der Browser schon gecacht hat. Aber die
`<script src="...">`-Tags DARIN zeigten bisher auf die exakt gleiche,
unversionierte URL wie beim letzten Build (z.B. `voxeria-engine.js`, keine
Query) -- und genau die liefert der Browser dann einfach aus seinem
31-Tage-Cache, ganz ohne Netzwerk-Request. Ergebnis: ein Spieler, der die
Seite schon kannte, sah nach einem frischen Upload weiterhin exakt den alten
JS-Stand, ohne jeden Fehler in Konsole oder Netzwerk-Tab, der das verraten
hätte -- der neue Code lag ja tatsächlich auf dem Server, wurde nur nie
abgerufen. Deshalb tragen alle `<script src="...">`-Tags in `index.html`
jetzt `?v=2`: bump die Zahl bei **jedem** neuen itch/pitch-Build, sonst
bringt dieser Mechanismus für genau diesen Build nichts (siehe den
Kommentar direkt über den Script-Tags in `index.html`). `build-zip.js`s
eigener Regex, der die Script-Liste aus `index.html` liest, überspringt die
Query beim Dateinamen-Abgleich -- ein `?v=`-Query auf einem Tag bricht den
Build selbst nicht.

## `index.html` + die zehn Skripte sind die einzige Quelle

Es gibt nur noch **ein** System: `index.html` zusammen mit den zehn
`voxeria-*.js`-Dateien. Das gilt für Web **und** Electron gleichermaßen —
`main.js` lädt dieselbe `index.html`, nicht mehr eine separate Desktop-Fassung.
Jede Änderung an einer der beiden Fassungen war vorher eine potentielle
Divergenz; die gibt es jetzt nicht mehr, weil es nur noch eine Fassung gibt.

Der alte Monolith (`Voxeria_core.html`, der Stand vor der Aufteilung) liegt
archiviert in `archive/` — als reine Nachschlage-Referenz, nicht versioniert
(siehe `.gitignore`) und in keinem Build enthalten. Änderungen darin haben
keine Wirkung auf das Spiel.
