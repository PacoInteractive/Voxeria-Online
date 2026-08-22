# Voxeria — Dateistruktur

Das Spiel lag vorher komplett in **einer** Datei (`Voxeria_core.html`, ~20.000 Zeilen).
Es ist jetzt aufgeteilt — inhaltlich identisch, nur auf mehrere Dateien verteilt.

## Was liegt wo

| Datei | Inhalt | Wer arbeitet dran |
|---|---|---|
| `index.html` | Grundgerüst: `<head>`, das komplette Stylesheet, die gesamte UI-Markup (HUD, Modals, Hauptmenü) und am Ende die `<script src>`-Tags | gemeinsam |
| `voxeria-engine.js` | Renderer, Physik, Kollision, Overworld-Generierung, Input, Audio/Musik, Multiplayer (Firebase), HUD, Crafting, Wetter, Licht | **nicht anfassen** ohne Absprache |
| `voxeria-dimensions-progress.js` | Pocket-Dimensionen, Dimensions-Weltgenerierung (`getChunk`), Run-Lifecycle, Portal-Buch, Dimensions-Schmieden, Fortschritts-Speicherung | **Dimensionen & Fortschritt** |
| `voxeria-modding.js` | Mod-Codes, Pieces, Function Graphs + Runtime, Mod-Sprites, Mod-Builder, Pixel-Editor, Block-/Creature-Designer, Node-Editor | **Modding** |
| `voxeria-menu-worlds.js` | Hauptmenü + benannte Welt-Speicherstände (`window.VxWorlds`) | gemeinsam |
| `voxeria-arena.js` | Arena-Modus: Match mit Phasen/Uhr/Punkten, Host-Wahl, Runden-Reset (`window.VxArena`) | **Arena** |
| `voxeria-coop-mods.js` | Geteilte Mods im Raum + farbige Autoren-Zuordnung (`window.VxCoopMods`) | **Koop-Mods** |
| `voxeria-devtools.js` | Verstecktes Entwickler-Werkzeug (Strg+Shift+E, UI-Layout-Editor) | nur intern |
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

## Wie die Dateien zusammenhängen

Alle `.js`-Dateien sind **klassische Scripts**, keine ES-Module. Sie teilen sich
also einen einzigen globalen Scope — genau wie vorher, als alles in einer Datei
stand. Eine Funktion aus `voxeria-engine.js` kann ohne `import` direkt aus
`voxeria-dimensions-progress.js` aufgerufen werden und umgekehrt.

**Die Ladereihenfolge in `index.html` ist deshalb wichtig:**

```
voxeria-engine.js
voxeria-dimensions-progress.js
voxeria-modding.js
voxeria-menu-worlds.js
voxeria-arena.js         <- nach menu-worlds (siehe unten)
voxeria-coop-mods.js
voxeria-devtools.js
voxeria-boot.js          <- muss letzte bleiben
```

Warum `voxeria-arena.js` nach `voxeria-menu-worlds.js`: Der Arena-Modus trägt
sich beim Laden selbst in die dort exportierte `MODES`-Tabelle ein, statt dass
`voxeria-menu-worlds.js` ihn kennen müsste. Dadurch liegt alles, was den Modus
ausmacht, in genau einer Datei — entfernt man das `<script>`-Tag, ist der Modus
restlos weg.

Warum `voxeria-boot.js` zuletzt: Beim Start wird der Spieler gespawnt, und dafür
fragt das Spiel den Weltgenerator nach Terrain. Der Weltgenerator liegt in
`voxeria-dimensions-progress.js`. Würde der Boot-Code früher laufen, griffe er
auf eine Dimensions-Ebene zu, die es noch gar nicht gibt.

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
