// ============================================================================
// VOXERIA -- WORLD TERMINAL
// ----------------------------------------------------------------------------
// The second door into the mod system. The Mod Editor (voxeria-modding.js) is
// the first: you drag blocks from a palette and wire them together. This is the
// same vocabulary as text.
//
// That is the whole design, and it is worth stating plainly because a terminal
// bolted onto a game usually means a second, parallel scripting system. This is
// not one. Every command below is GENERATED from NODE_CATALOG -- the same table
// the editor builds its palette from -- so:
//
//   * a node added to the catalog becomes a terminal command for free
//   * a script compiles to {nodes, wires}, the exact structure the editor edits
//   * that structure runs through graphWalk(), the exact interpreter the
//     editor's saved mods run through
//   * `mod open` hands the compiled script to ngLoadGraph() and the board
//     shows it as nodes; `mod import` reads a saved graph back out as script
//
// So the two are the same mod, seen twice. Neither can do something the other
// cannot express, and that is enforced structurally rather than by discipline:
// there is no code path here that reaches the game except through the catalog.
//
// Why have both, then: the node board is how you learn what the vocabulary is,
// and the terminal is how you use it once you know. Wiring twelve nodes by hand
// to say "for every ore in my inventory, if I'm deeper than 40, give me two
// more" is a chore once you can type it.
//
// The closed-catalog safety rule the whole mod system runs on (see the note
// above NODE_CATALOG) therefore holds here unchanged. A script is parsed into
// catalog nodes and clamped by graphCleanNodeParams() like any other graph. It
// is not eval'd, there is no host object to reach, and a syntactically perfect
// script naming something the game does not have is a parse error, not a hole.
//
// Loaded after voxeria-modding.js, which is where every symbol it reads
// (NODE_CATALOG, graphWalk, VxPieces, ngLoadGraph, ...) is declared.
// ============================================================================

(function () {
  'use strict';

  // ==========================================================================
  // NAMING -- node type <-> command name
  // ==========================================================================
  // PowerShell's Verb-Noun shape, because it is the one convention that stays
  // readable when a vocabulary is this wide: you can guess that the thing which
  // gives you an item is Give-Item without having seen it. Events, conditions
  // and loops are bare words instead, since they are grammar (`on X { }`,
  // `if X { }`) rather than calls.
  //
  // An explicit table rather than a name derived from the node type, because a
  // derived name would read like machine output (`setCreatureBehavior` ->
  // `Set-CreatureBehavior`) exactly where a person is meant to type it. The
  // completeness check at the bottom of this section fails loudly if a node
  // ever lands in the catalog without a name here, so "explicit" cannot decay
  // into "incomplete".
  //
  // `pin` on an alias fixes one enum parameter, which is what lets a single
  // node with a Give/Take dropdown read as two verbs at the prompt without
  // being two nodes underneath.
  const TERM_NAMES = {
    // Events -- the `on` heads.
    onWorldStart:  { name: 'WorldStart' },
    onTimer:       { name: 'Timer' },
    onBlock:       { name: 'Block',
                     alias: { Mine:   { pin: { how: 'mines' } },
                              Place:  { pin: { how: 'places' } },
                              Touch:  { pin: { how: 'touches' } } } },
    onPlayer:      { name: 'Player',
                     alias: { Jump:   { pin: { how: 'jumps' } },
                              Hurt:   { pin: { how: 'gets hurt' } },
                              Death:  { pin: { how: 'dies' } } } },
    onEnterDim:    { name: 'EnterDimension' },
    onDayPhase:    { name: 'DayPhase' },
    // Same alias shape as Block/Player above: the verb dropdown reads as three
    // words at the prompt while staying one node underneath.
    onCreature:    { name: 'Creature',
                     alias: { CreatureDeath:  { pin: { how: 'dies' } },
                              CreatureHurt:   { pin: { how: 'is hurt' } },
                              CreatureAttack: { pin: { how: 'attacks' } } } },
    onSignal:      { name: 'Signal' },
    onBeforeHurt:  { name: 'BeforeHurt' },
    onBeforeMine:  { name: 'BeforeMine' },
    onPickup:      { name: 'Pickup' },
    onMatchStart:  { name: 'MatchStart' },
    onMatchEnd:    { name: 'MatchEnd' },
    onAnnounced:   { name: 'Announced' },
    onPlayerJoin:      { name: 'PlayerJoin' },
    onPlayerLeave:     { name: 'PlayerLeave' },
    onPlayerEnterZone: { name: 'PlayerEnterZone' },
    onPlayerLeaveZone: { name: 'PlayerLeaveZone' },
    onPlayerTouch:     { name: 'PlayerTouch' },
    onCountdownEnd:    { name: 'CountdownEnd' },
    onButtonPress:     { name: 'ButtonPress' },

    // Conditions -- the `if` heads.
    ifChance:       { name: 'Chance' },
    ifCompare:      { name: 'Compare' },
    ifTextIs:       { name: 'Compare-Text' },
    ifBlock:        { name: 'HasBlock' },
    ifState:        { name: 'State' },
    ifWorldIs:      { name: 'World' },
    ifBlockAt:      { name: 'BlockAt' },
    ifWearingArmor: { name: 'WearingArmor' },
    ifInArena:      { name: 'InArena' },
    ifInZone:       { name: 'InZone' },
    ifScoreAtLeast: { name: 'ScoreAtLeast' },
    ifLeading:      { name: 'Leading' },
    ifTeamScoreAtLeast: { name: 'TeamScoreAtLeast' },
    ifTeamLeading:      { name: 'TeamLeading' },

    // Loops -- their own grammar, see the parser.
    repeatTimes:   { name: 'repeat' },
    repeatWhile:   { name: 'while' },
    forEachItem:   { name: 'foreach' },
    // `foreach` already means "over what I'm carrying", so the list walker
    // needs its own head rather than a parameter on that one: they are two node
    // types with different parameters, and one keyword that silently became the
    // other depending on its arguments would be the worse trade.
    forEachInList: { name: 'forlist' },

    // Actions -- the Verb-Noun calls.
    // Where the catalog merged two cards behind one verb dropdown, the command
    // NAME answers that dropdown: a thing called Give-Item has already said
    // which way it goes, and making the player type "Give" again as the first
    // argument would be the merge leaking out. The unpinned form stays
    // reachable as -How for anyone who wants it spelled out.
    changeItems:         { name: 'Give-Item', pin: { how: 'Give' },
                           alias: { 'Take-Item': { pin: { how: 'Take away' } } } },
    changeInvolvedItem:  { name: 'Give-Involved', pin: { how: 'Give' },
                           alias: { 'Take-Involved': { pin: { how: 'Take away' } } } },
    showText:            { name: 'Show-Text' },
    changeHealth:        { name: 'Heal-Player', pin: { how: 'Heal' },
                           alias: { 'Hurt-Player': { pin: { how: 'Hurt' } } } },
    setStat:             { name: 'Set-Stat' },
    movePlayer:          { name: 'Teleport-Player', pin: { how: 'teleport by' },
                           alias: { 'Launch-Player': { pin: { how: 'launch with force' } } } },
    setWorld:            { name: 'Set-World' },
    spawnCreature:       { name: 'Spawn-Creature' },
    setCreatureBehavior: { name: 'Set-Creature' },
    setCreatureCombat:   { name: 'Set-Combat' },
    emitParticles:       { name: 'Emit-Particles' },
    shake:               { name: 'Invoke-Shake' },
    playSound:           { name: 'Play-Sound' },
    setPanel:            { name: 'Show-Panel' },
    panelLine:           { name: 'Set-Panel-Line' },
    changeVar:           { name: 'Set-Number' },
    changeText:          { name: 'Set-Text' },
    changeList:          { name: 'Set-List' },
    announce:            { name: 'Send-Announcement' },
    wait:                { name: 'Wait-Seconds' },
    preventIt:           { name: 'Stop-Event' },
    setEventAmount:      { name: 'Set-Amount' },
    remapDrop:           { name: 'Set-Drop' },
    setBlockMining:      { name: 'Set-Mining' },
    fillArea:            { name: 'Fill-Area' },
    markZone:            { name: 'Set-Zone' },
    teleportToZone:      { name: 'Teleport-Zone' },
    setCountdown:        { name: 'Start-Countdown', pin: { how: 'start' },
                           alias: { 'Stop-Countdown': { pin: { how: 'stop' } } } },
    showBoard:           { name: 'Show-Board' },
    showDialog:          { name: 'Show-Dialog' },
    callSignal:          { name: 'Invoke-Signal' },
    returnValue:         { name: 'Return-Value' },
    addScore:            { name: 'Add-Score' },
    endRound:            { name: 'Stop-Round' },
    setTeam:             { name: 'Join-Team' }
  };

  // name (lowercased) -> { type, pin }. Built once; every lookup at the prompt,
  // every completion and every help page reads this one index, so an alias can
  // never resolve to something the catalog does not have.
  const TERM_INDEX = {};
  // type -> canonical display name, for the decompiler and error messages.
  const TERM_CANON = {};

  (function buildIndex() {
    for (const [type, entry] of Object.entries(TERM_NAMES)) {
      if (!NODE_CATALOG[type]) {
        console.warn('Voxeria Terminal: "' + type + '" is named here but not in NODE_CATALOG.');
        continue;
      }
      TERM_CANON[type] = entry.name;
      TERM_INDEX[entry.name.toLowerCase()] = { type, pin: entry.pin || null, name: entry.name };
      for (const [alias, spec] of Object.entries(entry.alias || {})) {
        TERM_INDEX[alias.toLowerCase()] = { type, pin: spec.pin || null, name: alias };
      }
    }
    // The same guarantee checkActionGroupsComplete() gives the editor palette:
    // a node added to the catalog without a name here would silently be
    // unreachable from the terminal while still working everywhere else, which
    // is exactly the kind of drift that makes two systems feel like two
    // systems.
    for (const type of Object.keys(NODE_CATALOG)) {
      if (!TERM_NAMES[type]) {
        console.warn('Voxeria Terminal: "' + type + '" has no command name -- it will not be typeable.');
      }
    }
  })();

  // ==========================================================================
  // LEXER
  // ==========================================================================
  // Tokens: word, string, number, param (-Name), sigil value ($VAR / @stat),
  // parentheses, and the punctuation the grammar uses ({ } and newline).
  // Newline is significant: a statement ends at one. That is what lets a call
  // take positional arguments without needing commas or parentheses.
  const T_WORD = 'word', T_STR = 'str', T_NUM = 'num', T_PARAM = 'param',
        T_VAR = 'var', T_STAT = 'stat', T_TEXTVAR = 'textvar',
        T_OPEN = '{', T_CLOSE = '}',
        T_LPAR = '(', T_RPAR = ')', T_EOL = 'eol', T_EOF = 'eof';

  // Characters that end a bare word AND lex as an operator of their own. `-` is
  // deliberately NOT among them: it is inside half the command names
  // (Give-Item), it introduces a named parameter (-Block) and it starts a
  // negative literal (-5), so it stays a word character and the three shapes are
  // told apart by what follows it. Subtraction is therefore the one operator
  // that has to reach the parser as a bare word, which the expression parser
  // handles explicitly.
  const TERM_OPCHARS = '+*/<>=!';

  // Assignment operators, and the catalog op each one means. `SCORE += 5` and
  // `Set-Number SCORE add 5` build the identical node; the first is simply what
  // anyone who has written code before will reach for. There is no operator for
  // "smallest of" / "largest of", so those keep the spelled-out form.
  // How many values a player-defined block can take, which is exactly how many
  // receiving slots "When called by name" has. Named once so the parser, the
  // help text and the completions cannot drift apart about it.
  const TERM_BLOCK_MAX_PARAMS = 3;
  // A stored block's parameter names, tolerating the single-`param` shape that
  // was written before a block could take more than one. Reading it here rather
  // than migrating the saved file means an older build can still open the same
  // localStorage entry without finding a field it does not understand.
  function termBlockParams(def) {
    if (!def) return [];
    if (Array.isArray(def.params)) return def.params.slice(0, TERM_BLOCK_MAX_PARAMS);
    return def.param ? [def.param] : [];
  }
  // "<power> <angle>" for the help lines and the palette label.
  function termBlockSig(def, open, close) {
    const ps = termBlockParams(def);
    if (!ps.length) return '';
    return ' ' + ps.map(p => (open || '<') + String(p).toLowerCase() + (close || '>')).join(' ');
  }

  const TERM_ASSIGN_OPS = {
    '=':  'set to',
    '+=': 'add',
    '-=': 'subtract',
    '*=': 'multiply by',
    '/=': 'divide by'
  };

  function termLex(src) {
    const out = [];
    let i = 0, line = 1;
    const isSpace = c => c === ' ' || c === '\t' || c === '\r';
    // A bare word runs to the next space or structural character. Deliberately
    // permissive about what is left inside it (dots, colons, digits, dashes) so
    // block ids, decimals and names like "3x3" all arrive as one token and are
    // sorted out by the parameter coercers, which know what shape each slot
    // wants.
    const isWordChar = c => !isSpace(c) && c !== '\n' && c !== '{' && c !== '}' &&
                            c !== '"' && c !== "'" && c !== '#' &&
                            c !== '(' && c !== ')' && c !== '$' && c !== '@' &&
                            c !== '&' &&
                            TERM_OPCHARS.indexOf(c) < 0;

    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { out.push({ t: T_EOL, line }); line++; i++; continue; }
      if (isSpace(c)) { i++; continue; }
      // Comments run to end of line. `#` rather than `//` because a script is
      // read far more often than it is written and `#` is what every other
      // shell uses.
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '{') { out.push({ t: T_OPEN, line }); i++; continue; }
      if (c === '}') { out.push({ t: T_CLOSE, line }); i++; continue; }
      if (c === '(') { out.push({ t: T_LPAR, line }); i++; continue; }
      if (c === ')') { out.push({ t: T_RPAR, line }); i++; continue; }
      // `-=` before everything else that starts with a dash, or it would split
      // into a bare `-` and an `=` and stop meaning "subtract from".
      if (c === '-' && src[i + 1] === '=') { out.push({ t: T_WORD, v: '-=', line }); i += 2; continue; }
      // Maximal munch, so `<=` `>=` `==` `!=` `+=` `*=` `/=` are one token each.
      if (TERM_OPCHARS.indexOf(c) >= 0) {
        let s = '';
        while (i < src.length && TERM_OPCHARS.indexOf(src[i]) >= 0) { s += src[i]; i++; }
        out.push({ t: T_WORD, v: s, line });
        continue;
      }
      if (c === '"' || c === "'") {
        const quote = c; let s = ''; i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\n') break;         // an unterminated string stops at the line, not at EOF
          s += src[i]; i++;
        }
        if (src[i] !== quote) throw termErr(line, 'Unterminated string.');
        i++;
        out.push({ t: T_STR, v: s, line });
        continue;
      }
      // &NAME -- a saved TEXT. Its own sigil rather than reusing $ because the
      // two name different stores: $LINE is a number called LINE, &LINE is a
      // text called LINE, and they can both exist at once. Letting $ mean
      // either one depending on which slot it landed in would make the same
      // spelling read two ways, which is exactly what the sigils exist to
      // prevent. Not '#' -- that starts a comment.
      if (c === '&') {
        let s = ''; i++;
        while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { s += src[i]; i++; }
        if (!s) throw termErr(line, 'Expected a name after "&".');
        out.push({ t: T_TEXTVAR, v: s, line });
        continue;
      }
      // $NAME -- a saved number (VALUE_VAR). @name -- a live reading
      // (one of GRAPH_STATS). The two sigils exist so a slot's source is
      // visible in the script itself: `Give-Item gold 3` and
      // `Give-Item gold $SCORE` differ at a glance, which is the thing the
      // editor shows with a dropdown and plain text otherwise cannot.
      if (c === '$' || c === '@') {
        // Letters, digits and underscore only. A dash may not be swallowed here
        // or `$A-1` would read as a variable literally named "A-1"; that is also
        // why the readings are written @random1100 rather than @random1-100
        // (see termStatToken).
        let s = ''; i++;
        while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { s += src[i]; i++; }
        if (!s) throw termErr(line, 'Expected a name after "' + c + '".');
        // A bracket right after a $NAME turns it from a saved number into a
        // list reading: $ITEMS[3] is the third entry, $ITEMS[count] is how many
        // there are. Lexed here rather than as separate bracket tokens because
        // the two only ever mean anything glued to a name, and a free-floating
        // "[" in the grammar would have to be rejected everywhere else anyway.
        if (c === '$' && src[i] === '[') {
          let inner = ''; i++;
          while (i < src.length && src[i] !== ']' && src[i] !== '\n') { inner += src[i]; i++; }
          if (src[i] !== ']') throw termErr(line, 'Missing a closing "]" after "$' + s + '[".');
          i++;
          const raw = inner.trim();
          const key = raw.toLowerCase();
          // idx is always an object now, tagged by `mode`, so a literal
          // position and a computed one travel the same shape instead of one
          // being a bare number and the other something new bolted on:
          //   lit   -- $L[3]      a position typed in when the mod was authored
          //   count -- $L[count]  how many entries the list holds ([length] too)
          //   var   -- $L[$I]     a position read from a saved number
          //   stat  -- $L[@depth] a position read from a live game value
          // "var"/"stat" are the actual new thing: a position the mod computes,
          // rather than one it was written with. Restricted to a single name,
          // not a full expression like "$I+1" -- that would need the bracket's
          // insides properly tokenised instead of scanned as raw text, and one
          // level of "the index is itself a value" already covers what shared
          // mods actually ask for.
          let idx;
          if (key === 'count' || key === 'length') {
            idx = { mode: 'count' };
          } else if (/^\d+$/.test(raw)) {
            idx = { mode: 'lit', n: Number(raw) };
          } else if (/^\$[A-Za-z0-9_]+$/.test(raw)) {
            idx = { mode: 'var', name: raw.slice(1) };
          } else if (/^@[A-Za-z0-9_]+$/.test(raw)) {
            idx = { mode: 'stat', name: raw.slice(1) };
          } else if (key === 'left') {
            // Dritter Namensraum in derselben Klammer: $ROUND[left] sind die
            // Sekunden auf dem Countdown ROUND. Das Schlüsselwort sagt, worum
            // es geht, so wie [count] es für Listen tut.
            idx = { mode: 'timer' };
          } else {
            throw termErr(line, 'Expected a position number, "count", "left", $SavedNumber or @reading inside "$' + s + '[ ]".',
                          'Examples: $' + s + '[1], $' + s + '[count], $' + s + '[$I], $' + s + '[left].');
          }
          out.push({ t: T_VAR, v: s, idx, line });
          continue;
        }
        out.push({ t: c === '$' ? T_VAR : T_STAT, v: s, line });
        continue;
      }
      // -Name introduces a named parameter, but -5 and -0.5 are numbers. The
      // difference is what follows the dash.
      if (c === '-' && /[A-Za-z]/.test(src[i + 1] || '')) {
        let s = ''; i++;
        while (i < src.length && isWordChar(src[i])) { s += src[i]; i++; }
        out.push({ t: T_PARAM, v: s, line });
        continue;
      }
      let s = '';
      while (i < src.length && isWordChar(src[i])) { s += src[i]; i++; }
      if (!s) { i++; continue; }
      if (/^-?\d+(\.\d+)?$/.test(s)) out.push({ t: T_NUM, v: Number(s), line });
      else out.push({ t: T_WORD, v: s, line });
    }
    out.push({ t: T_EOF, line });
    return out;
  }

  // Parse and compile failures are all this one shape, so the UI has exactly
  // one thing to render and every message carries the line it happened on.
  function termErr(line, msg, hint) {
    const e = new Error(msg);
    e.termLine = line;
    e.termHint = hint || null;
    return e;
  }

  // ==========================================================================
  // PARSER -- tokens to AST
  // ==========================================================================
  // The grammar, whole:
  //
  //   script    := stmt*
  //   stmt      := onBlock | blockDef | ifStmt | loopStmt | assign | call
  //   onBlock   := 'on' NAME args '{' stmt* '}'
  //   blockDef  := 'block' NAME NAME{0,3} '{' stmt* '}'   -- a named helper
  //   ifStmt    := 'if' bool '{' stmt* '}' ('else' ifStmt | 'else' '{' stmt* '}')?
  //   loopStmt  := 'repeat' expr '{' stmt* '}'
  //              | 'while' cmp '{' stmt* '}'
  //              | 'foreach' args '{' stmt* '}'
  //              | 'forlist' args '{' stmt* '}'
  //   assign    := NAME ('='|'+='|'-='|'*='|'/=') expr
  //   call      := NAME args
  //   args      := (value | '(' expr ')' | '-' NAME (value | '(' expr ')'))*
  //
  //   bool      := bool 'or' bool | bool 'and' bool | 'not' bool
  //              | '(' bool ')' | condCall | cmp
  //   condCall  := NAME args                      -- any condition in the catalog
  //   cmp       := expr ('=='|'!='|'<'|'>'|'<='|'>=') expr
  //   expr      := expr ('+'|'-') expr | expr ('*'|'/') expr | '-' expr
  //              | NUMBER | '$NAME' | '@reading' | listRead | '(' expr ')'
  //   listRead  := '$NAME' '[' (NUMBER | 'count' | 'left' | '$NAME' | '@reading') ']'
  //                -- a fixed entry, how many, or an entry at a COMPUTED
  //                   position (one level: the position itself may not be
  //                   another listRead)
  //
  // The bottom half is the part that makes this a language rather than a
  // command list, and it is worth being precise about what it costs. Nothing
  // in it reaches the game: an expression is LOWERED to catalog nodes at
  // compile time, the way a real compiler lowers arithmetic to registers.
  // `$A + $B * 2` becomes a short chain of "Set or change a number" cards
  // writing into a temporary; `and` and `or` become nested condition cards
  // wired so they short-circuit exactly as written.
  //
  // So the closed catalog still bounds everything: the grammar got bigger, the
  // vocabulary did not. A script is still only ever the board said differently,
  // which is what keeps `mod open` honest at any expression complexity.
  function termParse(tokens) {
    let p = 0;
    const peek = () => tokens[p];
    const at = t => tokens[p].t === t;
    const eatEols = () => { while (at(T_EOL)) p++; };

    function parseBlock(endsAtBrace) {
      const body = [];
      for (;;) {
        eatEols();
        if (at(T_EOF)) {
          if (endsAtBrace) throw termErr(peek().line, 'Missing a closing "}".');
          break;
        }
        if (at(T_CLOSE)) {
          if (!endsAtBrace) throw termErr(peek().line, 'Unexpected "}".');
          p++;
          break;
        }
        body.push(parseStmt());
      }
      return body;
    }

    // Words that end an argument run even though they are ordinary words. Only
    // ever non-empty while reading a condition's arguments, where `and`/`or`
    // belong to the boolean grammar around it rather than to the condition:
    // in `if Chance 30 and $HP < 5`, the `30` is the last thing Chance gets.
    let stopWords = null;
    function atStopWord() {
      return stopWords && at(T_WORD) && stopWords.has(String(peek().v).toLowerCase());
    }
    function argsEnd() {
      return at(T_EOL) || at(T_EOF) || at(T_OPEN) || at(T_CLOSE) || at(T_RPAR) || atStopWord();
    }

    // Reads the arguments of one call: bare values are positional, -Name
    // values are keyed. Stops at the end of the line or at a `{`, which is
    // what makes `on Block -How mines {` unambiguous without a separator.
    function parseArgs() {
      const pos = [], named = {};
      for (;;) {
        if (argsEnd()) break;
        if (at(T_PARAM)) {
          const key = peek().v, line = peek().line;
          p++;
          if (argsEnd()) throw termErr(line, 'Parameter -' + key + ' has no value.');
          named[key.toLowerCase()] = readValue();
        } else {
          pos.push(readValue());
        }
      }
      return { pos, named };
    }

    // One argument, still untyped: which of these the target slot wants is
    // decided in the compiler, where the parameter spec is known.
    //
    // A parenthesised group is the one place an argument may be a computed
    // expression. Requiring the brackets is what keeps positional arguments
    // unambiguous: without them `Give-Item gold $SCORE * 2` could equally be
    // read as four separate arguments, and the reading would depend on the
    // command's parameter count, which is exactly the kind of rule nobody
    // should have to hold in their head.
    function readValue() {
      if (at(T_LPAR)) {
        const line = peek().line;
        p++;
        const e = parseExpr();
        if (!at(T_RPAR)) throw termErr(line, 'Missing a closing ")".');
        p++;
        return { k: 'expr', e, line };
      }
      const tk = peek();
      p++;
      if (tk.t === T_NUM)  return { k: 'num',  v: tk.v,  line: tk.line };
      if (tk.t === T_STR)  return { k: 'str',  v: tk.v,  line: tk.line };
      // `idx` rides along so a list reading stays one argument all the way to
      // termResolveValue, which is the only place that knows what to do with it.
      if (tk.t === T_VAR)  return { k: 'var',  v: tk.v,  idx: tk.idx, line: tk.line };
      if (tk.t === T_STAT) return { k: 'stat', v: tk.v,  line: tk.line };
      if (tk.t === T_TEXTVAR) return { k: 'textvar', v: tk.v, line: tk.line };
      if (tk.t === T_WORD) return { k: 'word', v: tk.v,  line: tk.line };
      throw termErr(tk.line, 'Unexpected "' + (tk.v != null ? tk.v : tk.t) + '".');
    }

    // ── Expressions ───────────────────────────────────────────────────────
    // Ordinary precedence climbing. The only unusual rule is the one forced by
    // the lexer keeping `-` inside words: `$A -1` arrives as a variable and a
    // NEGATIVE literal rather than as a subtraction, so an operand appearing
    // where an operator was expected is read as the subtraction it plainly is.
    const CMP_OPS = { '==': 1, '!=': 1, '<': 1, '>': 1, '<=': 1, '>=': 1 };

    function wordIs(v) { return at(T_WORD) && String(peek().v).toLowerCase() === v; }
    function opIs(v) { return at(T_WORD) && peek().v === v; }

    function parseExpr() { return parseAdditive(); }

    function parseAdditive() {
      let a = parseMultiplicative();
      for (;;) {
        if (opIs('+') || opIs('-')) {
          const op = peek().v, line = peek().line; p++;
          a = { k: 'bin', op, a, b: parseMultiplicative(), line };
        } else if (at(T_NUM) && peek().v < 0) {
          // See the note above: this is `- <positive>` that the lexer glued
          // into one negative literal.
          const tk = peek(); p++;
          a = { k: 'bin', op: '-', a, b: { k: 'num', v: -tk.v, line: tk.line }, line: tk.line };
        } else break;
      }
      return a;
    }
    function parseMultiplicative() {
      let a = parseUnary();
      while (opIs('*') || opIs('/')) {
        const op = peek().v, line = peek().line; p++;
        a = { k: 'bin', op, a, b: parseUnary(), line };
      }
      return a;
    }
    function parseUnary() {
      if (opIs('-')) { const line = peek().line; p++; return { k: 'neg', a: parseUnary(), line }; }
      return parsePrimary();
    }
    function parsePrimary() {
      const tk = peek();
      if (tk.t === T_LPAR) {
        p++;
        const e = parseExpr();
        if (!at(T_RPAR)) throw termErr(tk.line, 'Missing a closing ")".');
        p++;
        return e;
      }
      if (tk.t === T_NUM)  { p++; return { k: 'num',  v: tk.v, line: tk.line }; }
      if (tk.t === T_VAR)  { p++; return { k: 'var',  v: tk.v, idx: tk.idx, line: tk.line }; }
      if (tk.t === T_STAT) { p++; return { k: 'stat', v: tk.v, line: tk.line }; }
      throw termErr(tk.line, 'Expected a number, $SavedNumber, @reading or "(" here.');
    }

    // ── Boolean expressions ───────────────────────────────────────────────
    const BOOL_STOP = new Set(['and', 'or']);

    function parseBool() { return parseOr(); }
    function parseOr() {
      let a = parseAnd();
      while (wordIs('or')) { const line = peek().line; p++; a = { k: 'or', a, b: parseAnd(), line }; }
      return a;
    }
    function parseAnd() {
      let a = parseNot();
      while (wordIs('and')) { const line = peek().line; p++; a = { k: 'and', a, b: parseNot(), line }; }
      return a;
    }
    function parseNot() {
      if (wordIs('not')) { const line = peek().line; p++; return { k: 'not', a: parseNot(), line }; }
      return parseBoolAtom();
    }

    function parseBoolAtom() {
      const tk = peek();

      // A bracket here is genuinely ambiguous: `(Chance 30 and ...)` groups a
      // boolean, `($A + 1) > 5` opens an arithmetic operand. Arithmetic is
      // tried first because it is the reading that must end in a comparison,
      // so failing it is cheap and unambiguous; only then is the group read as
      // a boolean.
      if (tk.t === T_LPAR) {
        const save = p;
        try { return parseComparison(); }
        catch (e) {
          p = save;
          p++;
          const inner = parseBool();
          if (!at(T_RPAR)) throw termErr(tk.line, 'Missing a closing ")".');
          p++;
          return inner;
        }
      }

      // A word that names a condition in the catalog is that condition, with
      // its own arguments. Anything else has to be the left-hand side of a
      // comparison, which parseComparison will report on if it is not.
      if (tk.t === T_WORD) {
        const known = TERM_INDEX[String(tk.v).toLowerCase()];
        if (known && NODE_CATALOG[known.type].kind === 'cond') {
          p++;
          const prev = stopWords;
          stopWords = BOOL_STOP;
          const args = parseArgs();
          stopWords = prev;
          return { k: 'condcall', name: tk.v, args, line: tk.line };
        }
        // A real command in the wrong place. Caught here so the message names
        // the mistake, instead of letting the arithmetic parser complain about
        // a word it was never going to understand.
        if (known) {
          const kind = NODE_CATALOG[known.type].kind;
          throw termErr(tk.line, '"' + known.name + '" is ' +
            (kind === 'event' ? 'an event' : kind === 'loop' ? 'a loop' : 'an action') +
            ', not a condition.',
            kind === 'action'
              ? 'Actions go inside the braces: if <condition> { ' + known.name + ' ... }'
              : 'Use it as: ' + known.name + ' ... { ... }');
        }
      }

      return parseComparison();
    }

    function parseComparison() {
      const line = peek().line;
      const a = parseExpr();
      if (at(T_WORD) && CMP_OPS[peek().v]) {
        const op = peek().v; p++;
        return { k: 'cmp', op, a, b: parseExpr(), line };
      }
      // The spelled-out form the catalog's own dropdown uses, so
      // `while $I "is less than" 10` keeps working alongside `while $I < 10`.
      // Both build the identical card; the symbol is simply the one people
      // reach for at a prompt.
      if (at(T_STR) || at(T_WORD)) {
        const word = String(peek().v);
        const hit = GRAPH_VAR_OPS.find(o => termNormaliseName(o) === termNormaliseName(word));
        if (hit) {
          p++;
          return { k: 'cmp', op: TERM_OP_WORDS[hit], a, b: parseExpr(), line };
        }
      }
      throw termErr(line, 'Expected a condition here.',
                    'Either a named one (if Chance 30) or a comparison (if $SCORE >= 10).');
    }

    function expectOpen(what, line) {
      if (!at(T_OPEN)) throw termErr(line, what + ' needs a "{ ... }" body.');
      p++;
    }

    // `if <bool> { } else if <bool> { } else { }`. Recursive rather than a
    // loop, because an `else if` IS an if statement sitting in the else branch
    // once it is compiled -- writing it as one here means the chain, the
    // wiring and the decompiler all get it for free.
    function parseIfRest(line) {
      const cond = parseBool();
      expectOpen('"if"', line);
      const then = parseBlock(true);
      // `else` may sit on the closing brace's line or the next one, because
      // both read naturally and refusing one would be a rule with no reason.
      const save = p;
      eatEols();
      let otherwise = null;
      if (wordIs('else')) {
        p++;
        if (wordIs('if')) { p++; otherwise = [parseIfRest(line)]; }
        else { expectOpen('"else"', line); otherwise = parseBlock(true); }
      } else {
        p = save;
      }
      return { k: 'if', cond, then, otherwise, line };
    }

    function parseStmt() {
      const tk = peek();
      // T_VAR is allowed here for one reason only: `$SCORE = 5`. The sigil adds
      // nothing on the left of an assignment, but it is what someone who just
      // learned it from the value slots will type.
      if (tk.t !== T_WORD && tk.t !== T_VAR) throw termErr(tk.line, 'Expected a command here.');

      // Assignment is checked before the keywords, not after, so a saved number
      // may be called anything at all -- including REPEAT or IF. What makes a
      // statement an assignment is the operator in second position, and no
      // keyword form ever has one there.
      if (tokens[p + 1] && tokens[p + 1].t === T_WORD && TERM_ASSIGN_OPS[tokens[p + 1].v]) {
        // A list reading on the left would be a write into the list, which is a
        // different node ("Change a list") with its own operations. Refused
        // with the spelling rather than quietly assigning to a saved number
        // that merely shares the list's name.
        if (tk.idx !== undefined) {
          const idxText = tk.idx.mode === 'count' ? '<position>'
            : tk.idx.mode === 'lit' ? tk.idx.n
            : tk.idx.mode === 'var' ? '$' + tk.idx.name
            : '@' + tk.idx.name;
          throw termErr(tk.line, 'A list entry cannot be assigned to like a saved number.',
                        'Use: Set-List ' + tk.v + ' "set the item at" <value> ' + idxText);
        }
        const name = tk.v, op = tokens[p + 1].v;
        p += 2;
        return { k: 'assign', name, op, value: parseExpr(), line: tk.line };
      }

      const head = tk.t === T_WORD ? tk.v.toLowerCase() : '';

      if (head === 'on') {
        p++;
        if (!at(T_WORD)) throw termErr(tk.line, '"on" needs an event name, for example: on Mine grass { ... }');
        const nameTk = peek(); p++;
        const args = parseArgs();
        expectOpen('"on ' + nameTk.v + '"', tk.line);
        return { k: 'on', name: nameTk.v, args, body: parseBlock(true), line: tk.line };
      }

      // `block <Name> [<Param>] { ... }` -- a reusable logic block of the
      // player's own. See termDefineBlock for what it becomes; the short
      // version is that the catalog already has "When called by name" and
      // "Call by name", which together are a function, and this is the
      // spelling that makes them feel like one.
      if (head === 'block') {
        p++;
        if (!at(T_WORD)) {
          throw termErr(tk.line, '"block" needs a name, for example: block MeteorStrike POWER { ... }');
        }
        const nameTk = peek(); p++;
        // Up to three, matching the three receiving slots "When called by name"
        // has. A fourth is refused with the ceiling named rather than silently
        // dropped, since a call that quietly loses its last value is the kind of
        // bug that is very hard to see on the board afterwards.
        const params = [];
        while (at(T_WORD) || at(T_VAR)) {
          if (params.length === TERM_BLOCK_MAX_PARAMS) {
            throw termErr(tk.line, 'A block takes at most ' + TERM_BLOCK_MAX_PARAMS + ' values.',
                          'Put the rest in a list and pass that instead.');
          }
          params.push(peek().v); p++;
        }
        expectOpen('"block ' + nameTk.v + '"', tk.line);
        return { k: 'block', name: nameTk.v, params, body: parseBlock(true), line: tk.line };
      }

      if (head === 'if') { p++; return parseIfRest(tk.line); }

      if (head === 'while') {
        p++;
        const cond = parseBool();
        expectOpen('"while"', tk.line);
        return { k: 'while', cond, body: parseBlock(true), line: tk.line };
      }

      if (head === 'repeat' || head === 'foreach' || head === 'forlist') {
        p++;
        const args = parseArgs();
        expectOpen('"' + head + '"', tk.line);
        return { k: 'loop', name: head, args, body: parseBlock(true), line: tk.line };
      }

      p++;
      const args = parseArgs();
      // A call may not be followed by a block: only the four grammar heads
      // above take one, and silently ignoring a stray `{` would hide a typo
      // like `if Chance 30` written as `Chance 30 { ... }`.
      if (at(T_OPEN)) {
        throw termErr(tk.line, '"' + tk.v + '" is a command, not a block. ' +
          'Only on / if / repeat / while / foreach / forlist take a "{ ... }" body.');
      }
      return { k: 'call', name: tk.v, args, line: tk.line };
    }

    return parseBlock(false);
  }

  // ==========================================================================
  // ARGUMENT COERCION -- an AST value into what a catalog slot demands
  // ==========================================================================
  // Everything here narrows toward graphCleanParam(), which has the final say.
  // The point of coercing first rather than handing raw text straight to it is
  // error quality: graphCleanParam silently substitutes a default for anything
  // it does not recognise, which is right for a pasted code from a stranger and
  // wrong for a person typing at a prompt, who needs to be told they misspelled
  // a block instead of quietly getting dirt.

  // Block names as the player knows them, longest first so "deep water" wins
  // over "water" when both could match a prefix. Rebuilt on demand rather than
  // cached, because custom blocks get their runtime ids allocated at load
  // (see CUSTOM_BLOCK_ID_BASE) and a cache built at file scope would miss them.
  function termBlockTable() {
    const out = [];
    for (const [id, label] of Object.entries(typeof blockNames === 'object' ? blockNames : {})) {
      const n = Number(id);
      if (!Number.isInteger(n) || !label) continue;
      out.push({ id: n, label: String(label) });
    }
    return out;
  }
  function termNormaliseName(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  // How a live reading is written in a script. Every non-alphanumeric character
  // is dropped, not just spaces: the lexer stops a sigil name at the first
  // character that is not a letter, digit or underscore, so "random 1-100" has
  // to reach the parser as @random1100. Resolution normalises both sides the
  // same way (see termResolveValue), so the two can never disagree.
  function termStatToken(s) {
    return '@' + String(s).replace(/[^A-Za-z0-9]/g, '');
  }
  function termResolveBlock(raw, spec, line) {
    const wantEmpty = !!spec.allowEmpty;
    if (typeof raw === 'number' && Number.isInteger(raw)) {
      if (wantEmpty && raw === BLOCKS.AIR) return raw;
      if (blockNames[raw] && !NON_ITEM_BLOCK_IDS.has(raw)) return raw;
      throw termErr(line, 'Block id ' + raw + ' is not something a mod can use.');
    }
    const key = termNormaliseName(raw);
    if (!key) throw termErr(line, 'Expected a block name.');
    if (wantEmpty && (key === 'air' || key === 'empty' || key === 'none')) return BLOCKS.AIR;
    // The BLOCKS enum first: those are the stable names a script should be
    // written against, since a display label can be re-worded.
    for (const [enumName, id] of Object.entries(BLOCKS)) {
      if (termNormaliseName(enumName) !== key) continue;
      if (NON_ITEM_BLOCK_IDS.has(id) && !(wantEmpty && id === BLOCKS.AIR)) {
        throw termErr(line, '"' + raw + '" cannot be used here.',
                      'It is world scenery, not an item.');
      }
      return id;
    }
    // Then display labels, which is how a custom painted block is reachable at
    // all: it has no entry in the compile-time enum, only a runtime id.
    for (const b of termBlockTable()) {
      if (termNormaliseName(b.label) === key && !NON_ITEM_BLOCK_IDS.has(b.id)) return b.id;
    }
    throw termErr(line, 'Unknown block "' + raw + '".', 'Run "blocks" to list every block name.');
  }

  // The two operator enums are written out in words in the catalog ("is less
  // than", "multiply by") because the editor shows them in a dropdown, where a
  // sentence reads better than a symbol. At a prompt that is backwards: nobody
  // wants to type `while $I "is less than" 10` when they mean `while $I < 10`.
  // Both spellings resolve to the same catalog value, so a script written
  // either way opens as the identical node.
  const TERM_OP_SYMBOLS = {
    '==': 'is exactly',   '=':  'is exactly',   '!=': 'is not',
    '>':  'is more than', '<':  'is less than',
    '>=': 'is at least',  '<=': 'is at most',
    '+=': 'add',          '-=': 'subtract',
    '*=': 'multiply by',  '/=': 'divide by',
    'min': 'smallest of', 'max': 'largest of'
  };

  // The preferred symbol per word form, for the decompiler. Not simply the
  // inverse of the table above, which maps two spellings onto "is exactly";
  // this picks the one to write back out.
  const TERM_OP_WORDS = {
    'is exactly': '==', 'is not': '!=', 'is more than': '>', 'is less than': '<',
    'is at least': '>=', 'is at most': '<=',
    'set to': '=', 'add': '+=', 'subtract': '-=', 'multiply by': '*=', 'divide by': '/=',
    'smallest of': 'min', 'largest of': 'max'
  };

  function termResolveEnum(raw, list, line, label) {
    const key = termNormaliseName(raw);
    for (const opt of list) if (termNormaliseName(opt) === key) return opt;
    // Symbols are checked against the raw text, not the normalised key: `>=`
    // normalises to the empty string, which is the whole reason the word form
    // could not be skipped before.
    const sym = TERM_OP_SYMBOLS[String(raw).trim()];
    // Only when the list really offers it, so `=` cannot smuggle a comparison
    // into a dropdown that has nothing to do with numbers.
    if (sym && list.includes(sym)) return sym;
    // "set to" is the one word-form with no natural symbol of its own, and `=`
    // is what everyone reaches for. It is listed above as "is exactly" for the
    // comparison enums, so this only fires where that one is not on offer.
    if (String(raw).trim() === '=' && list.includes('set to')) return 'set to';
    // Several of these values are phrases, because a dropdown reads better as
    // one ("as a banner", "floating on the player"). Typing the whole phrase in
    // quotes to pick one of two is a tax, so a fragment that matches exactly
    // one entry is accepted. Exactly one: an ambiguous fragment is an error,
    // never a guess, since guessing here would silently build the wrong node.
    if (key) {
      const near = list.filter(opt => termNormaliseName(opt).includes(key));
      if (near.length === 1) return near[0];
      if (near.length > 1) {
        throw termErr(line, '"' + raw + '" is ambiguous for ' + label + '.',
                      'It matches: ' + near.join(', '));
      }
    }
    throw termErr(line, 'Unknown value "' + raw + '" for ' + label + '.',
                  'Allowed: ' + list.join(', '));
  }

  // Looks up "@name" against GRAPH_STATS the same way the plain arg.k==='stat'
  // branch below does. Shared with a dynamic list index ($LIST[@depth]), which
  // needs the identical name-to-stat resolution one level deeper.
  function termResolveStatName(name, line) {
    const key = termNormaliseName(name);
    const stat = GRAPH_STATS.find(s => termNormaliseName(s) === key);
    if (!stat) {
      throw termErr(line, 'Unknown reading "@' + name + '".',
                    'Available: ' + GRAPH_STATS.map(s => termStatToken(s)).join(', '));
    }
    return stat;
  }

  // The three value-slot sources, from the three token shapes. This is the one
  // place the sigils mean anything; everywhere else a slot is just a slot.
  function termResolveValue(arg, spec, line) {
    const allowed = spec.sources || VALUE_SOURCE_KEYS;
    if (arg.k === 'var') {
      // $NAME[3], $NAME[count], $NAME[$I] and $NAME[@reading] are the four
      // list readings; a bare $NAME is still the saved number it always was.
      if (arg.idx && arg.idx.mode === 'count') {
        if (!allowed.includes(VALUE_LIST_LEN)) throw termErr(line, 'This slot cannot take a list length.');
        return graphCleanValue(spec, { s: VALUE_LIST_LEN, v: arg.v, n: spec.def });
      }
      if (arg.idx && arg.idx.mode === 'timer') {
        if (!allowed.includes(VALUE_COUNTDOWN)) throw termErr(line, 'This slot cannot take a countdown.');
        return graphCleanValue(spec, { s: VALUE_COUNTDOWN, v: arg.v, n: spec.def });
      }
      if (arg.idx && arg.idx.mode === 'lit') {
        if (!allowed.includes(VALUE_LIST)) throw termErr(line, 'This slot cannot take a list entry.');
        // Reported rather than clamped, the same way a plain number out of
        // range is below: asking for position 40 of a list that can hold 20 is
        // a mistake worth seeing.
        if (arg.idx.n < 1 || arg.idx.n > GRAPH_MAX_LIST) {
          throw termErr(line, 'Position ' + arg.idx.n + ' is outside a list, which holds 1 to ' + GRAPH_MAX_LIST + '.');
        }
        // The position rides in `n`, which the slot clamps to its own range.
        // A slot whose range cannot hold the position (one that only allows 1
        // to 9, say) would silently read a different entry, so that is refused
        // here instead.
        if (arg.idx.n < spec.min || arg.idx.n > spec.max) {
          throw termErr(line, 'This slot cannot read position ' + arg.idx.n + ': it only allows ' + spec.min + ' to ' + spec.max + '.',
                        'Walk the list with "forlist" instead, which has no such limit.');
        }
        return graphCleanValue(spec, { s: VALUE_LIST, v: arg.v, n: arg.idx.n });
      }
      if (arg.idx && (arg.idx.mode === 'var' || arg.idx.mode === 'stat')) {
        // A position the mod computes rather than one it was authored with.
        // Not range-checked here the way a literal position is: what the
        // saved number or live reading will actually be is not known until
        // the mod runs, and graphGetListItem already answers "out of range"
        // with 0 rather than a crash, the same as it does for a literal one.
        if (!allowed.includes(VALUE_LIST_DYNAMIC)) throw termErr(line, 'This slot cannot take a list entry at a computed position.');
        const idxSlot = arg.idx.mode === 'var'
          ? { s: VALUE_VAR, v: arg.idx.name, n: 0 }
          : { s: termResolveStatName(arg.idx.name, line), n: 0, v: 'SCORE' };
        return graphCleanValue(spec, { s: VALUE_LIST_DYNAMIC, v: arg.v, n: spec.def, idx: idxSlot });
      }
      if (!allowed.includes(VALUE_VAR)) throw termErr(line, 'This slot cannot take a saved number.');
      return graphCleanValue(spec, { s: VALUE_VAR, v: arg.v, n: spec.def });
    }
    if (arg.k === 'stat') {
      const key = termNormaliseName(arg.v);
      const stat = GRAPH_STATS.find(s => termNormaliseName(s) === key);
      if (!stat) {
        throw termErr(line, 'Unknown reading "@' + arg.v + '".',
                      'Available: ' + GRAPH_STATS.map(s => termStatToken(s)).join(', '));
      }
      if (!allowed.includes(stat)) throw termErr(line, 'This slot cannot take a live reading.');
      return graphCleanValue(spec, { s: stat, n: spec.def, v: 'SCORE' });
    }
    if (arg.k === 'num') {
      if (!allowed.includes(VALUE_FIXED)) throw termErr(line, 'This slot cannot take a plain number.');
      // Reported rather than clamped: a script asking for 500 where the ceiling
      // is 200 is a mistake worth seeing, and graphCleanValue would have turned
      // it into a silent 200.
      if (arg.v < spec.min || arg.v > spec.max) {
        throw termErr(line, arg.v + ' is outside the allowed range ' + spec.min + ' to ' + spec.max + '.');
      }
      return graphCleanValue(spec, { s: VALUE_FIXED, n: arg.v, v: 'SCORE' });
    }
    if (arg.k === 'word' || arg.k === 'str') {
      const key = termNormaliseName(arg.v);
      if ((key === 'none' || key === 'nothing') && allowed.includes(VALUE_NONE)) {
        return graphCleanValue(spec, { s: VALUE_NONE, n: spec.def, v: 'SCORE' });
      }
    }
    throw termErr(line, 'Expected a number, $SavedNumber or @reading here.');
  }

  function termCoerce(spec, arg, params, line) {
    const ln = arg && arg.line != null ? arg.line : line;
    if (spec.kind === 'value') return termResolveValue(arg, graphSpecRange(spec, params), ln);
    // A text slot takes a quoted string or an &Name, mirroring how a value slot
    // takes a plain number or a $Name. A bare word is accepted too, so
    // `Set-Text LINE set Ready` needs no quotes for a single word -- the same
    // leniency the enum and block slots already give.
    if (spec.kind === 'textvalue') {
      if (arg.k === 'textvar') return graphCleanTextValue(spec, { s: TEXT_VAR, v: arg.v });
      if (arg.k === 'str' || arg.k === 'word') return graphCleanTextValue(spec, { s: TEXT_FIXED, t: arg.v });
      if (arg.k === 'num') return graphCleanTextValue(spec, { s: TEXT_FIXED, t: String(arg.v) });
      throw termErr(ln, 'Expected text in quotes or an &SavedText for -' + spec.k + '.');
    }
    if (spec.kind === 'num') {
      const r = graphSpecRange(spec, params);
      if (arg.k !== 'num') throw termErr(ln, 'Expected a number for -' + spec.k + '.');
      if (arg.v < r.min || arg.v > r.max) {
        throw termErr(ln, arg.v + ' is outside the allowed range ' + r.min + ' to ' + r.max + '.');
      }
      return graphCleanParam(spec, arg.v, params);
    }
    if (spec.kind === 'block') {
      if (arg.k !== 'word' && arg.k !== 'str' && arg.k !== 'num') {
        throw termErr(ln, 'Expected a block name for -' + spec.k + '.');
      }
      return termResolveBlock(arg.v, spec, ln);
    }
    if (spec.kind === 'creature') {
      if (arg.k !== 'num') throw termErr(ln, 'Expected a creature slot number for -' + spec.k + '.');
      return graphCleanParam(spec, arg.v, params);
    }
    if (spec.kind === 'enum') {
      if (arg.k !== 'word' && arg.k !== 'str' && arg.k !== 'num') {
        throw termErr(ln, 'Expected a name for -' + spec.k + '.');
      }
      return termResolveEnum(arg.v, graphSpecList(spec, params), ln, '-' + spec.k);
    }
    if (spec.kind === 'varname') {
      // $SCORE and SCORE both land here, because a name slot is already a name
      // and the sigil adds nothing -- but people who just learned it from the
      // value slots will type it anyway, and refusing that would be pedantry.
      if (arg.k !== 'word' && arg.k !== 'str' && arg.k !== 'var') {
        throw termErr(ln, 'Expected a name for -' + spec.k + '.');
      }
      return graphCleanParam(spec, arg.v, params);
    }
    if (arg.k === 'num') return graphCleanParam(spec, String(arg.v), params);
    if (arg.k !== 'word' && arg.k !== 'str') throw termErr(ln, 'Expected text for -' + spec.k + '.');
    return graphCleanParam(spec, arg.v, params);
  }

  // Fills one node's params from parsed arguments. Positional arguments are
  // consumed in spec order, skipping any slot a -Name already claimed and any
  // slot an alias pinned, so `Take-Item gold 3` lines up with -Block and -Count
  // rather than trying to feed 'gold' to the Give/Take dropdown the alias
  // already answered.
  function termBuildParams(type, args, pin, line) {
    const specs = NODE_CATALOG[type].params;
    const byKey = {};
    for (const s of specs) byKey[s.k.toLowerCase()] = s;

    for (const key of Object.keys(args.named)) {
      if (!byKey[key]) {
        const known = specs.map(s => '-' + s.k).join(' ');
        throw termErr(line, 'Unknown parameter -' + key + '.',
                      known ? 'This command takes: ' + known : 'This command takes no parameters.');
      }
    }

    const claimed = new Set(Object.keys(args.named));
    for (const k of Object.keys(pin || {})) claimed.add(k.toLowerCase());

    const out = {};
    let next = 0;
    // Built in spec order and fed back in, exactly like graphDefaultParams():
    // a dependent spec (ifWorldIs.value, setStat.to) has to see the value its
    // controlling sibling just got, or its list/range would be the wrong one.
    for (const spec of specs) {
      const key = spec.k.toLowerCase();
      // A pin is what the command NAME already answered, so it fills the slot
      // and keeps it out of the positional run. An explicit -Name still wins:
      // the player spelled it out, and silently ignoring that would make
      // `Give-Item -How "Take away"` do the opposite of what it says.
      if (pin && Object.prototype.hasOwnProperty.call(pin, spec.k) &&
          !Object.prototype.hasOwnProperty.call(args.named, key)) {
        out[spec.k] = graphCleanParam(spec, pin[spec.k], out);
        continue;
      }
      let arg = null;
      if (Object.prototype.hasOwnProperty.call(args.named, key)) arg = args.named[key];
      else if (!claimed.has(key) && next < args.pos.length) arg = args.pos[next++];

      out[spec.k] = arg
        ? termCoerce(spec, arg, out, line)
        : (spec.kind === 'value'
            ? graphCleanValue(graphSpecRange(spec, out), undefined)
            : graphCleanParam(spec, spec.def, out));
    }

    if (next < args.pos.length) {
      throw termErr(line, 'Too many values for "' + (TERM_CANON[type] || type) + '".',
                    'It takes ' + specs.length + ': ' + specs.map(s => '-' + s.k).join(' '));
    }
    return out;
  }

  // ==========================================================================
  // COMPILER -- AST to {nodes, wires}
  // ==========================================================================
  // The output is a graph in exactly the shape decodeGraphCode() produces and
  // ngLoadGraph() consumes. Nothing downstream can tell a script-built graph
  // from a hand-wired one, which is the property that makes `mod open` work at
  // all rather than being a picture of the script.
  //
  // Layout matters more than it looks: a compiled graph that opens as a heap of
  // overlapping cards would technically prove the bridge and practically deny
  // it. Chains run left to right, nested bodies step down and in, so a script
  // opened on the board reads in the same direction it was written.
  const TERM_COL = 250;   // horizontal step between two chained nodes
  const TERM_ROW = 130;   // vertical step into a nested body
  const TERM_GAP = 90;    // blank space between two top-level chains

  function termCompile(ast) {
    const nodes = [];
    const wires = [];
    let nextId = 1;
    // The lowest y any node has been placed at, so the next top-level chain
    // starts below everything the previous one grew into rather than on top
    // of it.
    let frontier = 0;

    function add(type, params, x, y) {
      if (nodes.length >= GRAPH_MAX_NODES) {
        throw termErr(0, 'This script needs more than ' + GRAPH_MAX_NODES + ' blocks.',
                      'That is the same ceiling the Mod Editor board has.');
      }
      // The editor's own id scheme (see ngLoadGraph, which restarts its counter
      // by reading these back), so nodes added on the board after `mod open`
      // cannot collide with ones the compiler made.
      const node = { id: 'n' + (nextId++).toString(36), type, x, y, params };
      nodes.push(node);
      frontier = Math.max(frontier, y);
      return node;
    }
    function wire(from, fromPort, to) {
      if (wires.length >= GRAPH_MAX_WIRES) {
        throw termErr(0, 'This script needs more than ' + GRAPH_MAX_WIRES + ' connections.');
      }
      wires.push({ from: from.id, fromPort, to: to.id });
    }

    // Resolves one statement head to a catalog entry, with the kind it is
    // required to be. Getting this wrong is the most likely mistake a person
    // will make, so the message says what the name actually is rather than
    // just that it is not what was wanted.
    function lookup(name, wantKind, line) {
      let hit = TERM_INDEX[String(name).toLowerCase()];
      // A player-defined block resolves to "Call by name" with the signal
      // already filled in. Because `signal` is pinned, the positional
      // arguments line up on `arg` and `result` by themselves -- a custom
      // block needs no special case anywhere past this point.
      if (!hit) {
        const custom = termFindBlock(name);
        if (custom) {
          hit = { type: 'callSignal', pin: { signal: custom.key }, name: custom.name, custom };
        }
      }
      if (!hit) {
        const near = termSuggest(String(name).toLowerCase());
        throw termErr(line, 'Unknown command "' + name + '".',
                      near ? 'Did you mean "' + near + '"?' : 'Run "help" for the full list.');
      }
      const kind = NODE_CATALOG[hit.type].kind;
      if (wantKind && kind !== wantKind) {
        const how = { event: 'on ' + hit.name + ' { ... }', cond: 'if ' + hit.name + ' { ... }',
                      loop: hit.name + ' ... { ... }', action: hit.name + ' ...' }[kind];
        throw termErr(line, '"' + hit.name + '" is ' +
          (kind === 'cond' ? 'a condition' : kind === 'event' ? 'an event' :
           kind === 'loop' ? 'a loop' : 'an action') + ', not ' +
          (wantKind === 'cond' ? 'a condition' : wantKind === 'event' ? 'an event' : 'an action') + '.',
          'Use it as: ' + how);
      }
      return hit;
    }

    // ── Lowering expressions to catalog nodes ─────────────────────────────
    // The part that turns this from a command list into a language. There is
    // no expression evaluator anywhere in the runtime and there must not be:
    // the graph interpreter only knows how to run cards. So `$A + $B * 2` is
    // COMPILED, into the sequence of "Set or change a number" cards that
    // computes it into a temporary, exactly the way a real compiler lowers
    // arithmetic into registers.
    //
    // The temporaries are ordinary saved numbers with reserved names, so they
    // are visible on the board like everything else rather than being a hidden
    // side channel. `vars` hides them because they are compiler bookkeeping,
    // not something the player named.
    let tempN = 0;
    function newTemp() { return '_T' + (++tempN); }
    const CHANGEVAR_TO = NODE_CATALOG.changeVar.params.find(s => s.k === 'to');
    const ARITH_OPS = { '+': 'add', '-': 'subtract', '*': 'multiply by', '/': 'divide by' };

    // A cursor that lays preamble cards left to right and remembers the last
    // one, so whatever needs the computed value can be chained after it.
    function preamble(x, y) {
      return {
        x, y, head: null, tail: null,
        emit(type, params) {
          const n = add(type, params, this.x, this.y);
          this.x += TERM_COL;
          if (this.tail) wire(this.tail, 'out', n);
          if (!this.head) this.head = n;
          this.tail = n;
          return n;
        }
      };
    }

    // Returns a value-slot object for `expr`, emitting whatever cards are
    // needed to compute it into `pre` first. A leaf costs nothing: a plain
    // number, a saved number and a live reading are already slots, which is why
    // simple scripts compile to exactly the nodes they used to.
    function lowerNum(expr, pre) {
      if (expr.k === 'num')  return graphCleanValue(CHANGEVAR_TO, { s: VALUE_FIXED, n: expr.v, v: 'SCORE' });
      // A list reading is a leaf too, so `$BEST = $SCORES[1] + 10` and
      // `$BEST = $SCORES[$I] + 10` both cost the same one temporary a saved
      // number would.
      if (expr.k === 'var' && expr.idx && expr.idx.mode === 'count') {
        return graphCleanValue(CHANGEVAR_TO, { s: VALUE_LIST_LEN, v: expr.v, n: 0 });
      }
      if (expr.k === 'var' && expr.idx && expr.idx.mode === 'timer') {
        return graphCleanValue(CHANGEVAR_TO, { s: VALUE_COUNTDOWN, v: expr.v, n: 0 });
      }
      if (expr.k === 'var' && expr.idx && expr.idx.mode === 'lit') {
        if (expr.idx.n < 1 || expr.idx.n > GRAPH_MAX_LIST) {
          throw termErr(expr.line, 'Position ' + expr.idx.n + ' is outside a list, which holds 1 to ' + GRAPH_MAX_LIST + '.');
        }
        return graphCleanValue(CHANGEVAR_TO, { s: VALUE_LIST, v: expr.v, n: expr.idx.n });
      }
      if (expr.k === 'var' && expr.idx && (expr.idx.mode === 'var' || expr.idx.mode === 'stat')) {
        const idxSlot = expr.idx.mode === 'var'
          ? { s: VALUE_VAR, v: expr.idx.name, n: 0 }
          : { s: termResolveStatName(expr.idx.name, expr.line), n: 0, v: 'SCORE' };
        return graphCleanValue(CHANGEVAR_TO, { s: VALUE_LIST_DYNAMIC, v: expr.v, n: 0, idx: idxSlot });
      }
      if (expr.k === 'var')  return graphCleanValue(CHANGEVAR_TO, { s: VALUE_VAR, v: expr.v, n: 0 });
      if (expr.k === 'stat') {
        const key = termNormaliseName(expr.v);
        const stat = GRAPH_STATS.find(s => termNormaliseName(s) === key);
        if (!stat) {
          throw termErr(expr.line, 'Unknown reading "@' + expr.v + '".',
                        'Available: ' + GRAPH_STATS.map(s => termStatToken(s)).join(', '));
        }
        return graphCleanValue(CHANGEVAR_TO, { s: stat, n: 0, v: 'SCORE' });
      }
      if (expr.k === 'neg') {
        // 0 - x. One card more than a negation instruction would be, and the
        // catalog has no negation instruction.
        const t = newTemp();
        pre.emit('changeVar', graphCleanNodeParams('changeVar',
          { name: t, op: 'set to', to: { s: VALUE_FIXED, n: 0, v: 'SCORE' } }));
        const inner = lowerNum(expr.a, pre);
        pre.emit('changeVar', graphCleanNodeParams('changeVar', { name: t, op: 'subtract', to: inner }));
        return graphCleanValue(CHANGEVAR_TO, { s: VALUE_VAR, v: t, n: 0 });
      }
      if (expr.k === 'bin') {
        const op = ARITH_OPS[expr.op];
        if (!op) throw termErr(expr.line, 'Unknown operator "' + expr.op + '".');
        // Left side into a temporary first, then the right side applied to it.
        // Evaluation order is left-then-right, which matters because a live
        // reading on either side is sampled at the moment its card runs.
        const left = lowerNum(expr.a, pre);
        const t = newTemp();
        pre.emit('changeVar', graphCleanNodeParams('changeVar', { name: t, op: 'set to', to: left }));
        const right = lowerNum(expr.b, pre);
        pre.emit('changeVar', graphCleanNodeParams('changeVar', { name: t, op, to: right }));
        return graphCleanValue(CHANGEVAR_TO, { s: VALUE_VAR, v: t, n: 0 });
      }
      throw termErr(expr.line || 0, 'That is not a number expression.');
    }

    function isLeafExpr(e) { return e && (e.k === 'num' || e.k === 'var' || e.k === 'stat'); }

    // Lowers a boolean expression to a tree of condition cards and reports the
    // ports still waiting to be told where "true" and "false" go.
    //
    // `and` / `or` are built purely out of wiring, which is what makes them
    // short-circuit for free: in `A and B`, B's card is only ever reached
    // through A's `yes` port, so a false A never runs B at all. That is the
    // same evaluation order the words imply, achieved without the runtime
    // knowing the words exist.
    function lowerBool(expr, x, y) {
      if (expr.k === 'and' || expr.k === 'or') {
        const A = lowerBool(expr.a, x, y);
        const B = lowerBool(expr.b, x + TERM_COL, Math.max(y, A.bottom) + TERM_ROW);
        const link = expr.k === 'and' ? A.trueTails : A.falseTails;
        for (const t of link) wire(t.node, t.port, B.head);
        return expr.k === 'and'
          ? { head: A.head, trueTails: B.trueTails,
              falseTails: A.falseTails.concat(B.falseTails), bottom: B.bottom }
          : { head: A.head, trueTails: A.trueTails.concat(B.trueTails),
              falseTails: B.falseTails, bottom: B.bottom };
      }
      if (expr.k === 'not') {
        // Nothing is emitted: negation is the two ports swapped.
        const A = lowerBool(expr.a, x, y);
        return { head: A.head, trueTails: A.falseTails, falseTails: A.trueTails, bottom: A.bottom };
      }
      if (expr.k === 'condcall') {
        const hit = lookup(expr.name, 'cond', expr.line);
        const node = add(hit.type, termBuildParams(hit.type, expr.args, hit.pin, expr.line), x, y);
        return { head: node, trueTails: [{ node, port: 'yes' }],
                 falseTails: [{ node, port: 'no' }], bottom: y };
      }
      if (expr.k === 'cmp') {
        const pre = preamble(x, y);
        const a = lowerNum(expr.a, pre);
        const b = lowerNum(expr.b, pre);
        const op = TERM_OP_SYMBOLS[expr.op];
        if (!op || !GRAPH_VAR_OPS.includes(op)) {
          throw termErr(expr.line, 'Unknown comparison "' + expr.op + '".');
        }
        const node = add('ifCompare', graphCleanNodeParams('ifCompare', { a, op, b }), pre.x, y);
        if (pre.tail) wire(pre.tail, 'out', node);
        return { head: pre.head || node, trueTails: [{ node, port: 'yes' }],
                 falseTails: [{ node, port: 'no' }], bottom: y };
      }
      throw termErr(expr.line || 0, 'That is not a condition.');
    }

    // Compiles a list of statements into a chain and returns its head and its
    // open tails. Tails are a LIST because an `if` leaves two of them, one per
    // branch, and both have to be wired to whatever comes next. That is the
    // whole reason this returns a shape instead of a node: it is how a script's
    // straight-line reading becomes a graph's fork and rejoin.
    //
    // A tail is { node, port }. An empty tail list means the chain cannot be
    // continued (everything below it ended in a loop's body, say), which is
    // legal and simply means later statements are unreachable.
    function chain(stmts, x, y) {
      let head = null;
      let tails = [];
      let cx = x, cy = y;

      for (const st of stmts) {
        const built = statement(st, cx, cy);
        if (!built.head) continue;
        if (!head) head = built.head;
        for (const t of tails) wire(t.node, t.port, built.head);
        tails = built.tails;
        cx += TERM_COL;
        // A branching statement grew downward; keep the rest of the chain
        // below whatever it produced so nothing overlaps it.
        cy = Math.max(cy, built.bottom);
      }
      return { head, tails, bottom: cy };
    }

    // Computes any parenthesised expression arguments into temporaries, then
    // rewrites them as plain saved-number arguments. By the time
    // termBuildParams sees the argument list it is the same shape it always
    // was, so nothing downstream needs to know expressions exist.
    function lowerArgs(args, pre) {
      function conv(a) {
        if (!a || a.k !== 'expr') return a;
        if (isLeafExpr(a.e)) {
          // `(5)` and `($SCORE)` are just brackets around a leaf; no card.
          return Object.assign({}, a.e, { line: a.line });
        }
        const slot = lowerNum(a.e, pre);
        return { k: 'var', v: slot.v, line: a.line };
      }
      const named = {};
      for (const k of Object.keys(args.named)) named[k] = conv(args.named[k]);
      return { pos: args.pos.map(conv), named };
    }

    function statement(st, x, y) {
      if (st.k === 'call') {
        const hit = lookup(st.name, null, st.line);
        const kind = NODE_CATALOG[hit.type].kind;
        if (kind !== 'action') lookup(st.name, 'action', st.line);
        const pre = preamble(x, y);
        const args = lowerArgs(st.args, pre);
        const node = add(hit.type, termBuildParams(hit.type, args, hit.pin, st.line), pre.x, y);
        if (pre.tail) wire(pre.tail, 'out', node);
        // The two "Before ..." overrides end their chain by design: nothing
        // after them in the same branch would run, so they have no open tail.
        const terminal = hit.type === 'preventIt';
        return { head: pre.head || node, tails: terminal ? [] : [{ node, port: 'out' }], bottom: y };
      }

      if (st.k === 'assign') {
        const pre = preamble(x, y);
        const op = TERM_ASSIGN_OPS[st.op];
        let node;
        // `SCORE = $SCORE + 1` is the same card as `SCORE += 1`, and writing it
        // the long way should not cost an extra temporary. Recognised here
        // rather than in the parser because it is an optimisation, not a
        // meaning: both spellings already mean this.
        const selfOp = st.op === '=' && st.value.k === 'bin' &&
                       st.value.a.k === 'var' &&
                       termNormaliseName(st.value.a.v) === termNormaliseName(st.name) &&
                       ARITH_OPS[st.value.op];
        if (selfOp) {
          const slot = lowerNum(st.value.b, pre);
          node = add('changeVar', graphCleanNodeParams('changeVar',
            { name: st.name, op: selfOp, to: slot }), pre.x, y);
        } else {
          const slot = lowerNum(st.value, pre);
          node = add('changeVar', graphCleanNodeParams('changeVar',
            { name: st.name, op, to: slot }), pre.x, y);
        }
        if (pre.tail) wire(pre.tail, 'out', node);
        return { head: pre.head || node, tails: [{ node, port: 'out' }], bottom: y };
      }

      if (st.k === 'if') {
        const cond = lowerBool(st.cond, x, y);
        const branchX = x + TERM_COL * 2;
        const thenChain = chain(st.then, branchX, y);
        let bottom = Math.max(cond.bottom, thenChain.bottom);
        const tails = [];
        if (thenChain.head) {
          for (const t of cond.trueTails) wire(t.node, t.port, thenChain.head);
          tails.push(...thenChain.tails);
        } else {
          tails.push(...cond.trueTails);
        }

        if (st.otherwise) {
          const elseChain = chain(st.otherwise, branchX, bottom + TERM_ROW);
          bottom = Math.max(bottom, elseChain.bottom);
          if (elseChain.head) {
            for (const t of cond.falseTails) wire(t.node, t.port, elseChain.head);
            tails.push(...elseChain.tails);
          } else {
            tails.push(...cond.falseTails);
          }
        } else {
          // No else branch: the false ports are the chain's natural
          // continuation, which is what makes an if-without-else read as
          // "skip this part" rather than "stop here".
          tails.push(...cond.falseTails);
        }
        return { head: cond.head, tails, bottom };
      }

      if (st.k === 'while') {
        // "Repeat while" holds ONE comparison, and it re-asks it before every
        // pass. A compound condition cannot be lowered into that: the cards
        // computing it would run once, before the loop, and the loop would then
        // re-ask a question whose answer could no longer change. Rejected
        // rather than silently compiled into an infinite or single pass.
        const c = st.cond;
        if (c.k !== 'cmp' || !isLeafExpr(c.a) || !isLeafExpr(c.b)) {
          throw termErr(st.line, '"while" takes one simple comparison.',
            'Compound conditions cannot be re-checked each pass. ' +
            'Use "repeat <n> { if ... }" instead.');
        }
        const pre = preamble(x, y);
        const a = lowerNum(c.a, pre), b = lowerNum(c.b, pre);
        const op = TERM_OP_SYMBOLS[c.op];
        if (!op || !GRAPH_VAR_OPS.includes(op)) {
          throw termErr(st.line, 'Unknown comparison "' + c.op + '".');
        }
        const node = add('repeatWhile', graphCleanNodeParams('repeatWhile', { a, op, b }), x, y);
        const body = chain(st.body, x + TERM_COL, y + TERM_ROW);
        if (body.head) wire(node, 'body', body.head);
        return { head: node, tails: [{ node, port: 'done' }], bottom: Math.max(y, body.bottom) };
      }

      if (st.k === 'loop') {
        const hit = lookup(st.name, 'loop', st.line);
        const pre = preamble(x, y);
        const args = lowerArgs(st.args, pre);
        const node = add(hit.type, termBuildParams(hit.type, args, hit.pin, st.line), pre.x, y);
        if (pre.tail) wire(pre.tail, 'out', node);
        const body = chain(st.body, pre.x + TERM_COL, y + TERM_ROW);
        if (body.head) wire(node, 'body', body.head);
        // The body's own tails are intentionally left open: graphWalk restarts
        // each pass at the body head and moves to `done` when the loop is
        // finished, so wiring the body's end to anything would be a second,
        // wrong exit. See its loop branch.
        return { head: pre.head || node, tails: [{ node, port: 'done' }],
                 bottom: Math.max(y, body.bottom) };
      }

      if (st.k === 'block') {
        throw termErr(st.line, 'A "block" definition cannot sit inside another block.',
                      'Define it on its own, then call it by name from in here.');
      }
      throw termErr(st.line, 'An "on" block cannot be nested inside another block.');
    }

    for (const st of ast) {
      const y = nodes.length ? frontier + TERM_ROW + TERM_GAP : 0;

      // A definition is an event chain like any other; the "event" is simply
      // the catalog's "When called by name" rather than something the world
      // fires. That is the whole trick, and it is why a custom block needs no
      // new machinery in the runtime.
      if (st.k === 'block') {
        const key = termBlockKey(st.name);
        if (!key) throw termErr(st.line, 'That is not a usable block name.');
        // Each named parameter fills the matching receiving slot; the ones the
        // definition does not name keep the catalog's defaults, which a call
        // that passes nothing there never writes to anyway.
        const ps = (st.params || []).map(termBlockKey).filter(Boolean);
        const sigParams = { signal: key };
        if (ps[0]) sigParams.argVar  = ps[0];
        if (ps[1]) sigParams.argVar2 = ps[1];
        if (ps[2]) sigParams.argVar3 = ps[2];
        const ev = add('onSignal', graphCleanNodeParams('onSignal', sigParams), 0, y);
        const body = chain(st.body, TERM_COL, y);
        if (body.head) wire(ev, 'out', body.head);
        continue;
      }

      if (st.k !== 'on') {
        throw termErr(st.line, 'Only "on <Event> { ... }" and "block <Name> { ... }" can sit at the top level.',
                      'A bare command runs immediately instead -- type it on its own.');
      }
      const hit = lookup(st.name, 'event', st.line);
      const ev = add(hit.type, termBuildParams(hit.type, st.args, hit.pin, st.line), 0, y);
      const body = chain(st.body, TERM_COL, y);
      if (body.head) wire(ev, 'out', body.head);
    }

    return { name: 'Terminal Script', nodes, wires };
  }

  // Immediate mode: a bare statement list with no `on` head. Compiled the same
  // way, into a chain with nothing in front of it, then walked directly. This
  // is the one place the terminal does something the board cannot -- not a
  // different capability, a different MOMENT: the board can only describe what
  // would happen when an event fires (see ngSimulateChain's dry run), while
  // this runs the same nodes against the world the player is standing in, now.
  function termCompileImmediate(ast) {
    for (const st of ast) {
      if (st.k === 'on') {
        throw termErr(st.line, 'An "on" block defines a rule rather than doing something now.',
                      'It is installed instead -- see "rules".');
      }
    }
    const fake = { name: 'immediate', nodes: [], wires: [] };
    // Reuses the compiler by wrapping the statements in a throwaway event whose
    // node is then dropped, so there is exactly one code path that turns
    // statements into nodes rather than a second, subtly different one here.
    const wrapped = termCompile([{ k: 'on', name: 'WorldStart', args: { pos: [], named: {} },
                                   body: ast, line: ast.length ? ast[0].line : 1 }]);
    const evId = wrapped.nodes[0] && wrapped.nodes[0].id;
    fake.nodes = wrapped.nodes.filter(n => n.id !== evId);
    fake.wires = wrapped.wires.filter(w => w.from !== evId);
    const startWire = wrapped.wires.find(w => w.from === evId);
    const start = startWire ? fake.nodes.find(n => n.id === startWire.to) : null;
    return { graph: fake, start };
  }

  // ==========================================================================
  // DECOMPILER -- {nodes, wires} back to script text
  // ==========================================================================
  // The return leg of the bridge, and the honest test of it: a graph built by
  // dragging cards has to come back as script a person could have typed. Where
  // it cannot (a board wired into a shape the grammar has no spelling for, such
  // as two chains meeting in the middle) it says so in a comment instead of
  // emitting something that would not compile back.
  function termValueToText(v) {
    if (!v || typeof v !== 'object') return String(v);
    if (v.s === VALUE_NONE) return 'none';
    if (v.s === VALUE_FIXED) return String(v.n);
    if (v.s === VALUE_VAR) return '$' + v.v;
    if (v.s === VALUE_LIST) return '$' + v.v + '[' + v.n + ']';
    if (v.s === VALUE_LIST_DYNAMIC) return '$' + v.v + '[' + termValueToText(v.idx) + ']';
    if (v.s === VALUE_LIST_LEN) return '$' + v.v + '[count]';
    if (v.s === VALUE_COUNTDOWN) return '$' + v.v + '[left]';
    return termStatToken(String(v.s));
  }
  // The text counterpart of termValueToText. Always quotes a fixed text, even
  // a single word that would lex fine bare: a decompiled script is read as an
  // example of the language, and an unquoted word next to a quoted one would
  // teach the wrong lesson about which is the normal form.
  function termTextValueToText(v) {
    if (typeof v === 'string') return '"' + v.replace(/"/g, "'") + '"';
    if (!v || typeof v !== 'object') return '""';
    if (v.s === TEXT_VAR) return '&' + v.v;
    return '"' + String(v.t == null ? '' : v.t).replace(/"/g, "'") + '"';
  }
  function termParamToText(spec, value, params) {
    if (spec.kind === 'value') return termValueToText(value);
    if (spec.kind === 'textvalue') return termTextValueToText(value);
    if (spec.kind === 'block') {
      if (value === BLOCKS.AIR) return 'air';
      for (const [enumName, id] of Object.entries(BLOCKS)) {
        if (id === value) return enumName.toLowerCase();
      }
      const label = blockNames[value];
      return label ? '"' + label + '"' : String(value);
    }
    // `varname` steht hier mit drin, seit ein Name leer sein DARF ("answer
    // into" auf Show-Dialog: leer heisst kein Eingabefeld). Ein leerer Name
    // faellt sonst als leeres Stueck aus dem Join heraus, mit genau der
    // Verrutschung, vor der der Kommentar unten warnt.
    if (spec.kind === 'enum' || spec.kind === 'text' || spec.kind === 'varname') {
      const s = String(value);
      // Ein LEERER Text muss als "" dastehen und darf nicht einfach wegfallen.
      // Sonst rutscht beim Zurueckkompilieren jeder folgende Wert eine Stelle
      // nach vorn: aus `Show-Dialog "Frage" "Rot" "Blau" "" "hold me still"`
      // wuerde ein Dialog, dessen dritter Knopf "hold me still" heisst. Ein
      // Rundlauf, der den Mod veraendert, ist genau das, was ein Decompiler
      // nicht tun darf.
      if (s === '') return '""';
      // Symbol form where there is one, so a decompiled mod reads the way a
      // person would have typed it rather than the way the dropdown spells it.
      if (spec.kind === 'enum' && TERM_OP_WORDS[s] && (spec.list || []).includes(s)) {
        return TERM_OP_WORDS[s];
      }
      return /[^A-Za-z0-9_.]/.test(s) ? '"' + s.replace(/"/g, "'") + '"' : s;
    }
    return String(value);
  }
  // Picks the spelling that fits this node's actual parameters. A node whose
  // `how` is "Take away" must come back as Take-Item, not as Give-Item with the
  // dropdown quietly overwritten -- that would be a round trip that changes the
  // mod, which is the one thing a decompiler may never do.
  function termNameFor(node) {
    let best = null;
    for (const v of Object.values(TERM_INDEX)) {
      if (v.type !== node.type) continue;
      const pin = v.pin || {};
      const keys = Object.keys(pin);
      if (!keys.every(k => node.params[k] === pin[k])) continue;
      // The most specific match wins, so a pinned name beats the bare one
      // wherever both would be correct.
      if (!best || keys.length > Object.keys(best.pin || {}).length) best = v;
    }
    return best || { name: TERM_CANON[node.type] || node.type, pin: null };
  }

  function termNodeToText(node) {
    const def = NODE_CATALOG[node.type];
    const hit = termNameFor(node);
    const pin = hit.pin || {};
    const parts = [hit.name];
    // Every non-pinned parameter is written, including ones that happen to sit
    // at their default. Eliding them would be shorter and would still compile
    // back to the same node, but this text is mostly read rather than re-run --
    // "rules", "mod import", the Terminal button on the editor -- and a rule
    // that prints as "on Mine" when it fires on grass is a rule the player
    // cannot check. Pinned parameters are the one exception, because the
    // command name already said them out loud.
    for (const spec of def.params) {
      if (Object.prototype.hasOwnProperty.call(pin, spec.k)) continue;
      parts.push(termParamToText(spec, node.params[spec.k], node.params));
    }
    return parts.join(' ');
  }

  // "If a number ..." is the card the `<` in a script compiles to, so it is
  // also what a script should get back: `if $SCORE >= 10`, not
  // `if Compare $SCORE >= 10`. Both spellings parse to this identical card;
  // this picks the one a person would have written.
  function termCondToText(node) {
    if (node.type !== 'ifCompare') return termNodeToText(node);
    const p = node.params;
    const op = TERM_OP_WORDS[p.op];
    if (!op) return termNodeToText(node);
    return termValueToText(p.a) + ' ' + op + ' ' + termValueToText(p.b);
  }

  // Same idea for "Set or change a number": `SCORE += 1` rather than
  // `Set-Number SCORE += 1`. The two operations with no operator spelling
  // ("smallest of", "largest of") keep the command form.
  function termActionToText(node) {
    // A call to one of the player's own blocks reads as that block, not as the
    // "Call by name" card underneath it. The card is what runs; this is what it
    // was written as.
    if (node.type === 'callSignal') {
      const def = termFindBlock(node.params.signal);
      if (def) {
        const parts = [def.name];
        const arg = termValueToText(node.params.arg);
        if (arg !== 'none') parts.push(arg);
        // Only worth printing when the called block can actually return
        // something into it; the default name is noise otherwise.
        if (arg !== 'none' && node.params.result && node.params.result !== 'RESULT') {
          parts.push(node.params.result);
        }
        return parts.join(' ');
      }
    }
    if (node.type !== 'changeVar') return termNodeToText(node);
    const p = node.params;
    const op = TERM_OP_WORDS[p.op];
    if (!op || !TERM_ASSIGN_OPS[op]) return termNodeToText(node);
    return p.name + ' ' + op + ' ' + termValueToText(p.to);
  }

  // ── Reading a boolean region back out of the wiring ──────────────────────
  // `and` and `or` compile to pure wiring (see lowerBool), which means several
  // condition cards can share one destination: `A or B` sends BOTH true ports
  // to the same card. A plain tree walk cannot express that -- it arrives at
  // the shared card twice and has to call the second visit a rejoin -- so
  // without this the readback of any `or` silently lost a branch.
  //
  // What this does is the inverse of lowerBool: find the cluster of condition
  // cards that share exactly two exits, then rebuild the expression that wires
  // them that way. It is the honest half of the round trip, and it is what lets
  // "rules" and "mod import" show a script somebody could paste back.
  function termBoolRegion(head, graph, byId) {
    const isCond = n => !!n && NODE_CATALOG[n.type].kind === 'cond';
    const next = (n, port) => {
      const w = graph.wires.find(x => x.from === n.id && x.fromPort === port);
      return w ? byId.get(w.to) : null;
    };
    if (!isCond(head)) return null;

    // "The chain simply ends here". A port wired to nothing is an exit like any
    // other -- `if A or B { X }` with nothing after it leaves both false ports
    // dangling, and treating that as unreconstructable was what made exactly
    // those scripts read back wrong.
    const END = ' end';

    // Everything the cluster points at that is not itself in the cluster.
    function exitsOf(region) {
      const ex = new Set();
      for (const id of region) {
        const n = byId.get(id);
        for (const port of ['yes', 'no']) {
          const t = next(n, port);
          if (!t) { ex.add(END); continue; }
          if (!region.has(t.id)) ex.add(t.id);
        }
      }
      return ex;
    }

    // Which exit is "true": following `yes` ports from the head, while they
    // stay inside the cluster, always lands on it. That is what tells the two
    // exits apart without guessing.
    function trueExitOf(region) {
      let t = head, guard = 0;
      while (t && region.has(t.id) && guard++ < 32) t = next(t, 'yes');
      return t ? t.id : END;
    }

    let used = new Set();
    // Rebuilds the expression for the cards between `node` and the two given
    // exits. Every case is one of lowerBool's own shapes read backwards.
    function build(node, wantT, wantF, depth) {
      if (!isCond(node) || depth > 24) return null;
      const yes = next(node, 'yes'), no = next(node, 'no');
      const yid = yes ? yes.id : END, nid = no ? no.id : END;
      const self = { expr: termCondToText(node), top: null };

      if (yid === wantT && nid === wantF) { used.add(node.id); return self; }
      // `node or rest`: a false node falls through to the rest, a true one is
      // already done.
      if (yid === wantT) {
        const rest = build(no, wantT, wantF, depth + 1);
        if (!rest) return null;
        used.add(node.id);
        return { expr: self.expr + ' or ' + rest.expr, top: 'or' };
      }
      // `node and rest`: a true node goes on to the rest, a false one is done.
      if (nid === wantF) {
        const rest = build(yes, wantT, wantF, depth + 1);
        if (!rest) return null;
        used.add(node.id);
        return { expr: self.expr + ' and ' + paren(rest, 'or'), top: 'and' };
      }
      // Both ports lead back into the cluster, so the head belongs to a group
      // of its own. Split it either way and keep whichever reconstructs.
      const a1 = build(node, yid, wantF, depth + 1), b1 = build(yes, wantT, wantF, depth + 1);
      if (a1 && b1) return { expr: paren(a1, 'or') + ' and ' + paren(b1, 'or'), top: 'and' };
      const a2 = build(node, wantT, nid, depth + 1), b2 = build(no, wantT, wantF, depth + 1);
      if (a2 && b2) return { expr: a2.expr + ' or ' + b2.expr, top: 'or' };
      return null;
    }
    // `and` binds tighter than `or`, so only a looser sub-expression needs
    // brackets to survive being read back.
    function paren(sub, looser) { return sub.top === looser ? '(' + sub.expr + ')' : sub.expr; }

    // Grow the cluster one condition at a time, and accept a step only if the
    // result still has exactly two exits and still reconstructs. That invariant
    // is what stops it swallowing conditions that are not part of this
    // expression at all: the condition heading an `else if` sits on the false
    // exit, and absorbing it would split the exits three ways.
    function tryBuild(region) {
      const ex = exitsOf(region);
      if (!ex || ex.size !== 2) return null;
      const T = trueExitOf(region);
      if (!ex.has(T)) return null;
      const others = Array.from(ex).filter(id => id !== T);
      if (others.length !== 1) return null;
      const F = others[0];
      used = new Set();
      const built = build(head, T, F, 0);
      if (!built) return null;
      return { expr: built.expr, used,
               trueTarget: T === END ? null : (byId.get(T) || null),
               falseTarget: F === END ? null : (byId.get(F) || null) };
    }

    // Grow the cluster one condition at a time and keep the LARGEST version
    // that has exactly two exits and reconstructs. Growth is unconditional
    // because a correct cluster is not always reachable one node at a time:
    // `(A or B) and (C or D)` only settles back to two exits once BOTH halves
    // of the second bracket are in, so a step that insists on staying valid
    // would stop at the first bracket and lose the rest.
    //
    // Over-growing is safe: `build` verifies the wiring against those two
    // exits exactly, so a cluster that reconstructs is equivalent to what is
    // on the board, and one that does not simply leaves `best` where it was.
    let region = new Set([head.id]);
    let best = null;
    for (let step = 0; step < 24; step++) {
      // A lone condition needs no reconstruction; the plain walk already
      // handles it and produces identical output.
      if (region.size > 1) {
        const got = tryBuild(region);
        if (got) best = got;
      }
      const ex = exitsOf(region);
      if (!ex) break;
      const grow = Array.from(ex).find(id => isCond(byId.get(id)));
      if (!grow) break;
      region.add(grow);
    }
    return best;
  }

  function termDecompile(graph) {
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const out = [];
    const seen = new Set();
    // How many wires point AT each node. Anything above one is a rejoin, which
    // the grammar can only express when it is the natural end of an if/else --
    // and detecting that properly is not worth it, so a rejoin is written out
    // as a labelled jump instead of being silently flattened.
    const inbound = new Map();
    for (const w of graph.wires) inbound.set(w.to, (inbound.get(w.to) || 0) + 1);

    function nextOf(id, port) {
      const w = graph.wires.find(x => x.from === id && x.fromPort === port);
      return w ? byId.get(w.to) : null;
    }

    // Everything reachable forward from a node, by any port. Used to find where
    // an if's two branches come back together.
    function forward(from) {
      const hit = new Set();
      const stack = [from];
      while (stack.length) {
        const n = stack.pop();
        if (!n || hit.has(n.id)) continue;
        hit.add(n.id);
        for (const w of graph.wires) if (w.from === n.id) stack.push(byId.get(w.to));
      }
      return hit;
    }

    // The first card both branches lead to: where the if ends and the rest of
    // the chain resumes. Without this the walker cannot tell a then-branch from
    // the continuation after it, and writes the whole rest of the chain inside
    // the braces -- then meets it again down the other branch and has to call
    // it a rejoin. Breadth-first from the false side so the join found is the
    // nearest one rather than any shared descendant.
    function findJoin(a, b) {
      if (!a || !b) return null;
      const fromA = forward(a);
      const queue = [b];
      const seenB = new Set();
      while (queue.length) {
        const n = queue.shift();
        if (!n || seenB.has(n.id)) continue;
        seenB.add(n.id);
        if (fromA.has(n.id)) return n;
        for (const w of graph.wires) if (w.from === n.id) queue.push(byId.get(w.to));
      }
      return null;
    }

    // What one `if` looks like on the board, without emitting anything yet.
    // Shared by the emitter and by the else-if check below, so the two can
    // never disagree about where a branch ends.
    function ifShape(node) {
      // A cluster of conditions wired together by `and`/`or` is rebuilt as one
      // expression; a lone condition is simply itself.
      const region = termBoolRegion(node, graph, byId);
      const text = region ? region.expr : termCondToText(node);
      const yes = region ? region.trueTarget : nextOf(node.id, 'yes');
      const no = region ? region.falseTarget : nextOf(node.id, 'no');
      return { text, yes, no, used: region ? region.used : null,
               // Where the two branches meet again, if they do. Everything from
               // there on belongs after the closing brace, not inside a branch.
               join: findJoin(yes, no) };
    }

    // Emits one if-statement and returns the node the chain continues at.
    // `lead` is what opens it: "if " normally, "} else if " when this if IS the
    // whole of another if's else branch, which is what keeps a chain of
    // branches reading as the chain it was written as instead of nesting one
    // level deeper on every arm.
    function emitIf(node, depth, lead) {
      const pad = '  '.repeat(depth);
      const s = ifShape(node);
      if (s.used) for (const id of s.used) seen.add(id);

      out.push(pad + lead + s.text + ' {');
      if (s.join && s.join === s.no) {
        // The false port IS the continuation: an if with no else.
        walk(s.yes, depth + 1, s.no);
        out.push(pad + '}');
        return s.no;
      }
      walk(s.yes, depth + 1, s.join);

      if (s.no && s.no !== s.join) {
        // An else branch that is nothing but one more if is written as
        // `else if`. Recognised by that inner if ending exactly where this one
        // does: if it ended anywhere earlier there would be more statements
        // after it, still inside the else, and the braces would be needed.
        const inner = NODE_CATALOG[s.no.type].kind === 'cond' && !seen.has(s.no.id)
          ? ifShape(s.no) : null;
        if (inner && inner.join === s.join) {
          seen.add(s.no.id);
          emitIf(s.no, depth, '} else if ');
          return s.join;
        }
        out.push(pad + '} else {');
        walk(s.no, depth + 1, s.join);
      }
      out.push(pad + '}');
      return s.join;
    }

    function walk(node, depth, stopAt) {
      const pad = '  '.repeat(depth);
      while (node && node !== stopAt) {
        if (seen.has(node.id)) { out.push(pad + '# (rejoins an earlier step)'); return; }
        seen.add(node.id);
        const kind = NODE_CATALOG[node.type].kind;

        if (kind === 'cond') {
          const join = emitIf(node, depth, 'if ');
          if (join) { node = join; continue; }
          return;
        }
        if (kind === 'loop') {
          const body = nextOf(node.id, 'body');
          out.push(pad + termNodeToText(node) + ' {');
          if (body) walk(body, depth + 1, null);
          out.push(pad + '}');
          node = nextOf(node.id, 'done');
          continue;
        }
        out.push(pad + termActionToText(node));
        node = nextOf(node.id, 'out');
      }
    }

    const events = graph.nodes.filter(n => NODE_CATALOG[n.type].kind === 'event');
    for (const ev of events) {
      // "When called by name" under a name the player defined is that
      // definition, and should read as the `block` it was written as.
      const asBlock = ev.type === 'onSignal' ? termFindBlock(ev.params.signal) : null;
      if (asBlock) {
        // Only the slots the definition actually named are printed, and a slot
        // still sitting on its catalog default is treated as unnamed, so a
        // one-value block does not come back out as a three-value one.
        const named = [ev.params.argVar, ev.params.argVar2, ev.params.argVar3]
          .filter((v, i) => v && v !== ['ARG', 'ARG2', 'ARG3'][i]);
        out.push('block ' + asBlock.name + (named.length ? ' ' + named.join(' ') : '') + ' {');
      } else {
        out.push('on ' + termNodeToText(ev) + ' {');
      }
      seen.add(ev.id);
      const first = nextOf(ev.id, 'out');
      if (first) walk(first, 1, null);
      out.push('}');
      out.push('');
    }
    // Nodes no event can reach are still part of the board, and dropping them
    // silently would make a round trip lose work.
    const orphans = graph.nodes.filter(n => !seen.has(n.id) && NODE_CATALOG[n.type].kind !== 'event');
    if (orphans.length) {
      out.push('# ' + orphans.length + ' block(s) on the board are not connected to any event:');
      for (const o of orphans) out.push('#   ' + termNodeToText(o));
    }
    return out.join('\n').trim();
  }

  // ==========================================================================
  // SESSION STATE -- what the terminal has installed
  // ==========================================================================
  // Rules defined with `on` live in one graph that the terminal owns and keeps
  // in activeGraphs alongside the player's saved mods. Session-only on purpose:
  // a rule typed at a prompt is an experiment, and persisting it silently would
  // mean a world that behaves strangely tomorrow because of a line typed today.
  // `mod save` is how an experiment becomes permanent.
  // ==========================================================================
  // CUSTOM LOGIC BLOCKS -- the player's own vocabulary
  // ==========================================================================
  // "Write the complicated part once, then use it by name." A block called
  // MeteorStrike is defined with a script and afterwards behaves like any other
  // command, in the terminal AND as a card in the Mod Editor palette.
  //
  // The important part is what it is NOT. It is not a new NODE_CATALOG entry.
  // The catalog is closed on purpose (see the note above it): decodeGraphCode
  // DROPS node types it does not recognise, so a graph built on a home-made
  // node type would silently lose half of itself the moment it was shared with
  // somebody who did not have that block.
  //
  // Instead a block is a macro over two cards the catalog already has:
  //
  //   block MeteorStrike POWER { ... }   ->  "When called by name" + the body
  //   MeteorStrike 5                     ->  "Call by name", passing 5
  //
  // Those two are already a function with one argument in and one value back
  // (see GRAPH_ACTIONS.callSignal). So a script using custom blocks is still
  // nothing but catalog cards: it saves, shares, opens on the board and runs
  // through the same interpreter as everything else. Somebody who receives the
  // mod without the definition gets a call that matches nothing, which is
  // inert rather than broken.
  //
  // The definition itself is saved as an ordinary mod in the piece library, so
  // it loads with every world exactly like a hand-wired one. This registry only
  // remembers the name, the parameter and where the definition went, which is
  // what the palette and the completion need in order to offer it.
  const TERM_BLOCKS_KEY = 'voxeria_terminal_blocks';
  let termBlocks = {};

  function termLoadBlocks() {
    try {
      const raw = JSON.parse(localStorage.getItem(TERM_BLOCKS_KEY));
      termBlocks = (raw && typeof raw === 'object') ? raw : {};
    } catch (e) { termBlocks = {}; }
    termSyncBlocks();
  }

  // ── Keeping the registry honest ───────────────────────────────────────────
  // This registry is a CACHE. The truth about a definition lives in two places
  // it does not own: the piece library (does the mod still exist, is it
  // enabled) and activeGraphs (is its chain actually loaded in this world).
  // Both can change without the terminal being involved at all -- the Mod
  // Editor's own piece list can delete, disable or re-save any mod, and loading
  // somebody else's loadout swaps the whole set out.
  //
  // A cache nothing invalidates is a cache that lies, and the lie here is the
  // worst shape available: the palette and the completion keep offering a block
  // whose call now matches nothing, so the script compiles, runs, and silently
  // does nothing at that step. So nothing is assumed below; every question is
  // asked of the real thing each time.

  // The saved mod backing a definition, found by what is INSIDE it rather than
  // by the id it was saved under. Editing a block on the board and pressing
  // Save writes a new piece and retires the old one (see ngSave), so an id
  // stored at definition time stops resolving the moment somebody edits the
  // block in the editor -- which is exactly the workflow the palette entry
  // invites.
  function termBlockPiece(key) {
    for (const p of VxPieces.list('GRAPH')) {
      if (!isGraphCode(p.code)) continue;
      let g;
      try { g = decodeGraphCode(p.code); } catch (e) { continue; }
      if (!g) continue;
      if (g.nodes.some(n => n.type === 'onSignal' && n.params.signal === key)) return p;
    }
    return null;
  }

  // Is the definition's chain loaded in the world right now? A piece that is
  // present but switched off, or a world running a foreign loadout, both land
  // here as false.
  function termBlockActive(key) {
    if (typeof activeGraphs === 'undefined') return false;
    return activeGraphs.some(g => g.nodes &&
      g.nodes.some(n => n.type === 'onSignal' && n.params.signal === key));
  }

  // Drops definitions whose mod is gone for good, and refreshes the piece id
  // for the ones that merely moved. Called after anything that can change the
  // piece library or the loaded set.
  function termSyncBlocks() {
    let changed = false;
    for (const key of Object.keys(termBlocks)) {
      const b = termBlocks[key];
      if (!b) { delete termBlocks[key]; changed = true; continue; }
      const piece = termBlockPiece(key);
      if (!piece) { delete termBlocks[key]; changed = true; continue; }
      if (b.pieceId !== piece.localId) { b.pieceId = piece.localId; changed = true; }
      // Remembered so the listing can say WHY a block is inert rather than
      // just that it is.
      const off = piece.enabled === false;
      if (b.disabled !== off) { b.disabled = off; changed = true; }
    }
    if (changed) termSaveBlocks();
    return changed;
  }

  // reapplyCustomPieces() is what every path that touches the library ends at:
  // the editor's enable checkbox, its delete button, ngSave, and the loadout
  // swap. Wrapping it is therefore one place that covers all of them, the same
  // technique used on registerCustomGraphPieces below and on the engine's own
  // functions in installGraphHooks.
  const _origReapply = window.reapplyCustomPieces;
  if (typeof _origReapply === 'function') {
    window.reapplyCustomPieces = function () {
      const r = _origReapply.apply(this, arguments);
      try { termSyncBlocks(); termRefreshPalette(); } catch (e) {
        console.warn('Voxeria Terminal: block registry sync failed.', e);
      }
      return r;
    };
  }
  function termSaveBlocks() {
    try { localStorage.setItem(TERM_BLOCKS_KEY, JSON.stringify(termBlocks)); return true; }
    catch (e) {
      console.warn('Voxeria Terminal: could not store the block list.', e);
      showNotification('⚠️ No space left to save. Delete a piece or a saved world and try again.');
      return false;
    }
  }
  // Uppercased and stripped the same way graphCleanParam treats a varname, so
  // the key here and the signal name stored in the card can never drift apart.
  function termBlockKey(name) {
    return String(name == null ? '' : name).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16);
  }
  function termFindBlock(name) {
    const k = termBlockKey(name);
    return k && termBlocks[k] ? termBlocks[k] : null;
  }

  // ── The palette group ─────────────────────────────────────────────────────
  // A defined block has to be reachable from the board too, or the two halves
  // of the mod system would stop agreeing about what the vocabulary is -- which
  // is the one thing this whole design exists to prevent. Injected from here
  // rather than built into ngInit's own palette loop, because the list changes
  // whenever a block is defined and ngInit deliberately runs only once.
  // The Actions tab's count pill, set from what the panel really holds.
  //
  // ngInit computes it as `kind === 'action'`, but that panel also carries the
  // three loop cards (see ACTION_GROUPS, whose first cluster is "Loops"), so it
  // has always read three short -- 23 over a list of 26 -- before custom blocks
  // existed at all. Counting the buttons rather than predicting them is the
  // version that cannot drift again when either list changes.
  function termRefreshPaletteCount() {
    const pill = document.getElementById('ng-pal-n-action');
    const box = document.getElementById('ng-pal-action');
    if (!pill || !box) return;
    pill.textContent = String(box.querySelectorAll('.ng-pal-btn').length);
  }

  function termRefreshPalette() {
    const box = document.getElementById('ng-pal-action');
    if (!box) return;                       // editor markup not present
    let wrap = document.getElementById('ng-pal-myblocks');
    const names = Object.keys(termBlocks).sort((a, b) =>
      termBlocks[a].name.localeCompare(termBlocks[b].name));
    if (!names.length) { if (wrap) wrap.remove(); termRefreshPaletteCount(); return; }

    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'ng-pal-myblocks';
      wrap.className = 'ng-pal-subgroup';
      // First in the Actions tab: these are the player's own, and scrolling
      // past eight built-in clusters to reach them would be backwards.
      box.insertBefore(wrap, box.firstChild);
    }
    wrap.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ng-pal-subgroup-label';
    head.textContent = 'My blocks';
    wrap.appendChild(head);


    for (const key of names) {
      const def = termBlocks[key];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ng-pal-btn k-action';
      if (typeof ngMakeIcon === 'function') b.appendChild(ngMakeIcon('callSignal', 'ng-pal-icon'));
      const lab = document.createElement('span');
      // The palette's search filter matches on textContent, so the name has to
      // be real text here rather than anything drawn.
      lab.textContent = def.name + termBlockSig(def, '(', ')');
      b.appendChild(lab);
      const live = termBlockActive(key);
      b.title = live
        ? 'Your own block. Runs the chain you defined with: block ' + def.name
        : 'Your own block, currently switched off in the mod list below, so a call does nothing.';
      if (!live) { b.style.opacity = '0.5'; lab.textContent += '  (off)'; }
      b.addEventListener('click', () => ngAddNode('callSignal', { signal: key }));
      wrap.appendChild(b);
    }
    termRefreshPaletteCount();
  }

  // Never reassigned, only emptied and refilled. activeGraphs holds a reference
  // to this exact object, so swapping in a fresh one would leave the old graph
  // in there still firing while every check here looked at the new, empty one --
  // a "reset" that reported success and changed nothing.
  const termSession = { name: 'Terminal Session', nodes: [], wires: [], isTerminalSession: true };

  function termSessionLive() {
    return termSession.nodes.length > 0;
  }
  function termSessionClear() {
    termSession.nodes.length = 0;
    termSession.wires.length = 0;
  }

  // registerCustomGraphPieces() rebuilds activeGraphs from the saved library
  // whenever the loadout changes, which would drop the session graph. Wrapping
  // it (the same technique installGraphHooks uses on the engine's own
  // functions) keeps the terminal's rules alive across a reload without
  // voxeria-modding.js needing to know this file exists.
  const _origRegister = window.registerCustomGraphPieces;
  window.registerCustomGraphPieces = function (pieceCodes) {
    const r = _origRegister.apply(this, arguments);
    termSyncSession();
    return r;
  };

  function termSyncSession() {
    if (typeof activeGraphs === 'undefined') return;
    // Matched by flag rather than by identity, so a stale copy left behind by
    // anything that rebuilt the list still gets cleared out.
    for (let i = activeGraphs.length - 1; i >= 0; i--) {
      if (activeGraphs[i] && activeGraphs[i].isTerminalSession) activeGraphs.splice(i, 1);
    }
    if (termSessionLive()) activeGraphs.push(termSession);
  }

  // ==========================================================================
  // BOARD VISIBILITY -- a rule typed in the terminal shows up on the board
  // ==========================================================================
  // Before this, a rule typed with `on` lived only in the session until
  // somebody typed "mod open": opening the Mod Editor on its own showed
  // whatever was already there, which after typing a fresh rule was nothing.
  // That is the gap. The fix has one rule of its own: never destroy work
  // sitting on the board to show it.
  //
  //   * board is EMPTY        -> loaded straight in, nothing to protect.
  //   * board has something   -> a banner offers to add the rules in, and
  //                              only an explicit click does it.
  //
  // Checked at the two moments new terminal content can become relevant to
  // somebody looking at the board: opening the Mod Editor, and closing the
  // Terminal back down onto an editor that was open underneath it.
  function termBoardBannerEl() {
    let el = document.getElementById('term-board-banner');
    if (el) return el;
    const modal = document.getElementById('mod-editor-modal');
    const head = modal && modal.querySelector('.ae-head');
    if (!head) return null;
    el = document.createElement('div');
    el.id = 'term-board-banner';
    el.style.cssText =
      'display:none;align-items:center;gap:10px;padding:7px 14px;' +
      'background:rgba(168,85,247,0.12);border-bottom:1px solid rgba(168,85,247,0.35);' +
      'font-family:var(--font-mono,monospace);font-size:12px;color:var(--text-1,#fff);';
    const label = document.createElement('span');
    label.id = 'term-board-banner-label';
    el.appendChild(label);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Add to this board';
    btn.style.cssText =
      'margin-left:auto;background:var(--accent,#a855f7);border:none;color:#fff;' +
      'font-family:inherit;font-size:11.5px;padding:4px 10px;cursor:pointer;';
    btn.addEventListener('click', termMergeSessionOntoBoard);
    el.appendChild(btn);
    head.insertAdjacentElement('afterend', el);
    return el;
  }
  function termShowBoardBanner(n) {
    const el = termBoardBannerEl();
    if (!el) return;
    document.getElementById('term-board-banner-label').textContent =
      '🧩 ' + n + ' rule' + (n === 1 ? '' : 's') + ' from the Terminal aren\'t on this board yet.';
    el.style.display = 'flex';
  }
  function termHideBoardBanner() {
    const el = document.getElementById('term-board-banner');
    if (el) el.style.display = 'none';
  }

  // Adds copies of the session's nodes to whatever is already on the board,
  // wired only to each other -- exactly as separate as two chains typed on
  // different lines already are. Placed below the lowest existing node, the
  // same stacking rule termInstall itself uses, so the two never overlap.
  function termMergeSessionOntoBoard() {
    if (typeof ngGraph === 'undefined' || !termSessionLive()) { termHideBoardBanner(); return; }
    if (typeof ngCommit === 'function') ngCommit();          // one undo step for the whole merge
    const lowest = ngGraph.nodes.reduce((m, n) => Math.max(m, n.y), -TERM_ROW - TERM_GAP);
    const shiftY = ngGraph.nodes.length ? lowest + TERM_ROW + TERM_GAP : 0;
    const idOf = new Map();
    for (const n of termSession.nodes) {
      const id = typeof ngNewId === 'function' ? ngNewId() : 'n' + Math.random().toString(36).slice(2, 8);
      idOf.set(n.id, id);
      ngGraph.nodes.push({ id, type: n.type, x: n.x, y: n.y + shiftY,
                            params: JSON.parse(JSON.stringify(n.params)) });
    }
    for (const w of termSession.wires) {
      ngGraph.wires.push({ from: idOf.get(w.from), fromPort: w.fromPort, to: idOf.get(w.to) });
    }
    if (typeof ngRender === 'function') ngRender();
    termHideBoardBanner();
    if (typeof showNotification === 'function') {
      showNotification('🧩 Terminal rules added to the board.');
    }
  }

  // The single check, run at both trigger points. An empty board is filled
  // straight away (see the header note); anything else gets the banner, which
  // is refreshed every time in case a rule was added or removed since it was
  // last shown.
  function termSyncBoardVisibility() {
    const modal = document.getElementById('mod-editor-modal');
    if (!modal || !modal.classList.contains('open')) return;
    if (typeof ngGraph === 'undefined') return;
    if (!termSessionLive()) { termHideBoardBanner(); return; }

    if (ngGraph.nodes.length === 0) {
      ngLoadGraph({
        name: termSession.name,
        nodes: termSession.nodes.map(n => Object.assign({}, n, { params: JSON.parse(JSON.stringify(n.params)) })),
        wires: termSession.wires.map(w => Object.assign({}, w))
      });
      termHideBoardBanner();
      if (typeof showNotification === 'function') {
        showNotification('🧩 Showing your Terminal rules.');
      }
      return;
    }

    // Only worth the banner if something from the session is not already
    // sitting on the board -- reopening after already clicking "Add to this
    // board" should not nag again.
    const onBoard = new Set(ngGraph.nodes.map(n => n.type + '|' + JSON.stringify(n.params)));
    const missing = termSession.nodes.filter(n => !onBoard.has(n.type + '|' + JSON.stringify(n.params)));
    if (missing.length) {
      const ruleCount = termSession.nodes.filter(n => NODE_CATALOG[n.type].kind === 'event').length;
      termShowBoardBanner(ruleCount);
    } else {
      termHideBoardBanner();
    }
  }

  // ==========================================================================
  // BUILT-IN COMMANDS -- the terminal's own verbs
  // ==========================================================================
  // These are the only commands that are NOT catalog nodes, and every one of
  // them is about the terminal itself: what can I say, what have I said, where
  // does it go. None of them touches the world -- that is the catalog's job,
  // and keeping the line clean is what stops this from becoming the parallel
  // scripting system the header promises it is not.
  const TERM_BUILTINS = {};

  function builtin(name, usage, desc, run, opts) {
    TERM_BUILTINS[name.toLowerCase()] = Object.assign({ name, usage, desc, run }, opts || {});
  }

  builtin('help', 'help [command]', 'List every command, or explain one in full', (args, io) => {
    if (args.length) { termHelpFor(args[0], io); return; }
    io.head('VOXERIA WORLD TERMINAL');
    io.text('Everything below is a block from the Mod Editor palette. Same vocabulary,');
    io.text('typed instead of dragged. A bare command runs now; an "on" block installs a rule.');
    io.blank();

    io.head('TERMINAL');
    for (const key of Object.keys(TERM_BUILTINS)) {
      const b = TERM_BUILTINS[key];
      if (b.name.toLowerCase() !== key) continue;   // skip alias entries
      io.pair(b.usage, b.desc);
    }
    io.blank();

    const byKind = { event: [], cond: [], loop: [], action: [] };
    for (const [type, entry] of Object.entries(TERM_NAMES)) {
      const def = NODE_CATALOG[type];
      if (!def) continue;
      byKind[def.kind].push({ name: entry.name, label: def.label, type });
    }
    io.head('EVENTS -- on <Event> { ... }');
    for (const e of byKind.event) io.pair(e.name, e.label);
    io.blank();
    io.head('CONDITIONS -- if <Condition> { ... } else { ... }');
    for (const e of byKind.cond) io.pair(e.name, e.label);
    io.blank();
    io.head('LOOPS -- <loop> ... { ... }');
    for (const e of byKind.loop) io.pair(e.name, e.label);
    io.blank();
    // Grouped exactly the way the editor's Actions tab groups them, so the two
    // lists read as one list seen twice rather than two inventories.
    io.head('ACTIONS');
    for (const g of ACTION_GROUPS) {
      const rows = g.types.filter(t => TERM_CANON[t] && NODE_CATALOG[t].kind === 'action');
      if (!rows.length) continue;
      io.sub(g.label);
      for (const t of rows) io.pair(TERM_CANON[t], NODE_CATALOG[t].label);
    }
    io.blank();
    io.head('LANGUAGE');
    io.pair('12   $SCORE   @health', 'a fixed amount, a saved number, a live reading');
    io.pair('SCORE = $A + $B * 2', 'assign; + - * / and brackets, usual precedence');
    io.pair('SCORE += 1', 'also -= *= /=');
    io.pair('Give-Item gold ($N * 2)', 'a computed argument, in brackets');
    io.pair('if $HP < 5 and Chance 30', 'and / or / not, comparisons, named conditions');
    io.pair('} else if ... else {', 'chained branches');
    io.pair('repeat 5 { }', 'a fixed number of passes');
    io.pair('while $I < 10 { }', 'one simple comparison, re-asked each pass');
    io.pair('foreach ITEM COUNT { }', 'every slot in the inventory');
    io.pair('# note', 'comment to end of line');
    io.blank();
    io.head('YOUR OWN BLOCKS');
    io.pair('block Name PARAM { ... }', 'define a reusable block of your own');
    io.pair('Name 5', 'use it, anywhere, like any other command');
    io.pair('Return-Value ...', 'hand one number back to the caller');
    io.text('Defined blocks are saved, appear in the Mod Editor palette under "My blocks",');
    io.text('and are built from the same cards as everything else. See "logic".');
    io.blank();
    io.text('Arithmetic and and/or are compiled into the same cards the board offers:');
    io.text('a computed value becomes a short chain of "Set or change a number", and and/or');
    io.text('become nested conditions that short-circuit. "mod open" shows exactly that.');
    io.blank();
    io.text('Type "help Give-Item" for one command in full, or "blocks" to list block names.');
  });

  function termHelpFor(name, io) {
    const key = String(name).toLowerCase();
    const b = TERM_BUILTINS[key];
    if (b) {
      io.head(b.name);
      io.text(b.desc + '.');
      io.blank();
      io.sub('Usage');
      io.text('  ' + b.usage);
      if (b.long) { io.blank(); for (const l of b.long) io.text(l); }
      return;
    }
    const hit = TERM_INDEX[key];
    if (!hit) {
      io.err('No command called "' + name + '".');
      const near = termSuggest(key);
      if (near) io.hint('Did you mean "' + near + '"?');
      return;
    }
    const def = NODE_CATALOG[hit.type];
    const kind = def.kind;
    io.head(hit.name);
    io.text(def.label + '.');
    io.blank();
    io.sub('Usage');
    // A pinned parameter is left out: the command name already answered it, so
    // showing it here would describe a positional slot that does not exist.
    // It stays listed under Parameters, because -How can still override it.
    const argHint = def.params
      .filter(s => !(hit.pin && Object.prototype.hasOwnProperty.call(hit.pin, s.k)))
      .map(s => '<' + s.k + '>').join(' ');
    if (kind === 'event') io.text('  on ' + hit.name + (argHint ? ' ' + argHint : '') + ' { ... }');
    else if (kind === 'cond') io.text('  if ' + hit.name + (argHint ? ' ' + argHint : '') + ' { ... } else { ... }');
    else if (kind === 'loop') io.text('  ' + hit.name + (argHint ? ' ' + argHint : '') + ' { ... }');
    else io.text('  ' + hit.name + (argHint ? ' ' + argHint : ''));

    if (hit.pin) {
      io.blank();
      io.hint('This name is a shorthand: it fixes ' +
        Object.entries(hit.pin).map(([k, v]) => '-' + k + ' ' + v).join(', ') + '.');
    }
    if (def.params.length) {
      io.blank();
      io.sub('Parameters');
      for (const spec of def.params) {
        io.pair('-' + spec.k, termSpecSummary(spec));
      }
    }
    // Named the other way round too: knowing that Take-Item and Give-Item are
    // one node is the fact that makes the whole system make sense.
    const family = Object.entries(TERM_INDEX)
      .filter(([, v]) => v.type === hit.type && v.name !== hit.name)
      .map(([, v]) => v.name);
    if (family.length) {
      io.blank();
      io.hint('Same block, other spellings: ' + family.join(', '));
    }
    io.blank();
    io.hint('On the Mod Editor board this is the "' + def.label + '" card.');
  }

  function termSpecSummary(spec) {
    if (spec.kind === 'value') {
      const r = graphSpecRange(spec, {});
      const src = (spec.sources || VALUE_SOURCE_KEYS).includes(VALUE_NONE) ? ', or none' : '';
      return 'number ' + r.min + ' to ' + r.max + ', $saved or @reading' + src;
    }
    if (spec.kind === 'textvalue') {
      return '"text in quotes" or &SavedText, up to ' + (spec.max || GRAPH_MAX_TEXT) + ' characters';
    }
    if (spec.kind === 'num') return 'number ' + spec.min + ' to ' + spec.max;
    if (spec.kind === 'block') return 'block name' + (spec.allowEmpty ? ' (air allowed)' : '');
    if (spec.kind === 'creature') return 'creature slot number';
    if (spec.kind === 'varname') return 'a name, e.g. SCORE';
    if (spec.kind === 'enum') {
      const list = graphSpecList(spec, {});
      // A dependent list is only true for whatever the controlling parameter
      // happens to be, so say so rather than presenting one branch as the law.
      return (spec.listBy ? 'depends on the other parameter: ' : '') + list.join(' | ');
    }
    return 'text, up to ' + (spec.max || 48) + ' characters';
  }

  // Cheap edit distance, used only to turn "unknown command" into "did you
  // mean". Bounded by the short list of names, so the naive implementation is
  // fine here.
  function termSuggest(key) {
    let best = null, bestScore = 3;
    const names = Object.keys(TERM_INDEX).concat(Object.keys(TERM_BUILTINS));
    for (const n of names) {
      const d = termDistance(key, n);
      if (d < bestScore) { bestScore = d; best = n; }
    }
    if (!best) return null;
    const hit = TERM_INDEX[best];
    return hit ? hit.name : (TERM_BUILTINS[best] ? TERM_BUILTINS[best].name : best);
  }
  function termDistance(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 99;
    const prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let last = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
        last = tmp;
      }
    }
    return prev[b.length];
  }

  builtin('blocks', 'blocks [filter]', 'List block names a command can take', (args, io) => {
    const filter = termNormaliseName(args[0] || '');
    const rows = [];
    for (const [enumName, id] of Object.entries(BLOCKS)) {
      if (NON_ITEM_BLOCK_IDS.has(id)) continue;
      if (filter && !termNormaliseName(enumName).includes(filter)) continue;
      rows.push({ name: enumName.toLowerCase(), label: blockNames[id] || enumName, id });
    }
    // Custom painted blocks have no entry in the compile-time enum, so they are
    // reachable only by their label -- worth showing separately rather than
    // mixed in, because the two are typed differently (bare vs quoted).
    const custom = termBlockTable().filter(b =>
      b.id >= (typeof CUSTOM_BLOCK_ID_BASE !== 'undefined' ? CUSTOM_BLOCK_ID_BASE : 200) &&
      !NON_ITEM_BLOCK_IDS.has(b.id) &&
      (!filter || termNormaliseName(b.label).includes(filter)));

    if (!rows.length && !custom.length) { io.err('No block matches "' + (args[0] || '') + '".'); return; }
    if (rows.length) {
      io.head('BLOCKS (' + rows.length + ')');
      for (const r of rows) io.pair(r.name, r.label);
    }
    if (custom.length) {
      io.blank();
      io.head('YOUR PAINTED BLOCKS (' + custom.length + ')');
      for (const c of custom) io.pair('"' + c.label + '"', 'custom block, id ' + c.id);
    }
  });

  builtin('stats', 'stats', 'Show every live reading and its value right now', (args, io) => {
    io.head('LIVE READINGS');
    io.text('Usable in any number slot as @name.');
    io.blank();
    for (const s of GRAPH_STATS) {
      let v = '?';
      try {
        const fn = GRAPH_STAT_READERS[s];
        if (fn) { const n = Number(fn()); v = isFinite(n) ? String(Math.round(n * 100) / 100) : '?'; }
      } catch (e) { v = 'unavailable'; }
      io.pair(termStatToken(s), s + ' = ' + v);
    }
  });

  builtin('vars', 'vars', 'Show every saved number the mods are holding', (args, io) => {
    const all = Object.keys(graphVars || {});
    // _T1, _T2 ... are the temporaries the expression compiler writes into (see
    // newTemp). They are real saved numbers and deliberately visible on the
    // board, but listing them here would bury the ones the player named under
    // compiler bookkeeping.
    const keys = all.filter(k => !/^_T\d+$/.test(k));
    const hidden = all.length - keys.length;
    if (!keys.length) {
      io.text('No saved numbers yet. Set one with:  SCORE = 10');
      if (hidden) io.hint(hidden + ' compiler temporary/temporaries not shown.');
      return;
    }
    io.head('SAVED NUMBERS');
    for (const k of keys.sort()) io.pair('$' + k, String(graphVars[k]));
    if (hidden) { io.blank(); io.hint(hidden + ' compiler temporary/temporaries hidden.'); }
  });

  builtin('rules', 'rules', 'Show the rules this terminal session has installed', (args, io) => {
    if (!termSessionLive()) {
      io.text('No rules installed. Define one with an "on" block, for example:');
      io.blank();
      io.script('on Mine grass {');
      io.script('  if Chance 25 {');
      io.script('    Give-Item gold 1');
      io.script('  }');
      io.script('}');
      return;
    }
    io.head('INSTALLED RULES (session only)');
    io.text(termSession.nodes.length + ' blocks, ' + termSession.wires.length + ' connections. Live in this world right now.');
    io.blank();
    for (const line of termDecompile(termSession).split('\n')) io.script(line);
    io.blank();
    io.hint('Opening the Mod Editor already shows these -- "mod open" is only for');
    io.hint('pulling them in yourself when the board has other work on it.');
    io.hint('"mod save <name>" keeps them. "reset" removes them.');
  });

  builtin('reset', 'reset', 'Remove every rule this session installed', (args, io) => {
    if (!termSessionLive()) { io.text('Nothing to remove.'); return; }
    const n = termSession.nodes.length;
    termSessionClear();
    termSyncSession();
    io.ok('Removed ' + n + ' block(s). Saved mods are untouched.');
  });

  builtin('mod', 'mod list|save|open|import|code <name>', 'Move work between the terminal and the Mod Editor', (args, io) => {
    const sub = String(args[0] || '').toLowerCase();

    if (sub === 'list' || !sub) {
      const mods = VxPieces.list('GRAPH');
      if (!mods.length) { io.text('No saved mods yet.'); return; }
      io.head('SAVED MODS (' + mods.length + ')');
      for (const m of mods) {
        const g = decodeGraphCode(m.code);
        io.pair(m.name, (g ? g.nodes.length + ' blocks' : 'unreadable') +
                        (m.enabled === false ? ', disabled' : ''));
      }
      io.blank();
      io.hint('"mod import <name>" reads one back as script.');
      return;
    }

    if (sub === 'save') {
      const name = args.slice(1).join(' ').trim();
      if (!name) { io.err('Usage: mod save <name>'); return; }
      if (!termSessionLive()) { io.err('Nothing to save. Define a rule with an "on" block first.'); return; }
      const graph = { name: name.slice(0, 24), nodes: termSession.nodes, wires: termSession.wires };
      const code = encodeGraphCode(graph);
      if (!VxPieces.save('GRAPH', code, graph.name)) return;   // VxPieces reports its own failure
      reapplyCustomPieces();
      io.ok('Saved "' + graph.name + '" to your mods, switched off.');
      io.hint('Tick it under "My mods" in the Mod Editor to run it. Until then the');
      io.hint('rules you typed here keep running for this session only.');
      return;
    }

    if (sub === 'open') {
      if (!termSessionLive()) { io.err('Nothing to show. Define a rule with an "on" block first.'); return; }
      // The bridge, made literal. Same object shape ngLoadGraph gets from a
      // decoded shared code, so the board cannot tell where it came from.
      ngLoadGraph({ name: termSession.name,
                    nodes: termSession.nodes.map(n => Object.assign({}, n)),
                    wires: termSession.wires.map(w => Object.assign({}, w)) });
      termClose();
      if (!document.getElementById('mod-editor-modal').classList.contains('open')) toggleModEditor();
      showNotification('🧩 Terminal script opened on the board.');
      return;
    }

    if (sub === 'import') {
      const name = args.slice(1).join(' ').trim();
      if (!name) { io.err('Usage: mod import <name>'); return; }
      const mods = VxPieces.list('GRAPH');
      const hit = mods.find(m => termNormaliseName(m.name) === termNormaliseName(name));
      if (!hit) { io.err('No saved mod called "' + name + '".'); io.hint('Run "mod list".'); return; }
      const g = decodeGraphCode(hit.code);
      if (!g) { io.err('"' + hit.name + '" could not be read.'); return; }
      io.head(hit.name.toUpperCase() + ' -- as script');
      for (const line of termDecompile(g).split('\n')) io.script(line);
      io.blank();
      io.hint('Paste it back in (edited or not) to install it in this session.');
      return;
    }

    if (sub === 'code') {
      if (!termSessionLive()) { io.err('Nothing to encode yet.'); return; }
      io.head('SHAREABLE CODE');
      io.code(encodeGraphCode({ name: termSession.name, nodes: termSession.nodes, wires: termSession.wires }));
      io.blank();
      io.hint('Anyone can paste this into their seed field to get these rules.');
      return;
    }

    io.err('Unknown: mod ' + sub);
    io.hint('Try: mod list | mod save <name> | mod open | mod import <name> | mod code');
  }, {
    long: [
      'list    every mod in your library, with its size',
      'save    keep this session\'s rules as a permanent mod',
      'open    show this session\'s rules on the Mod Editor board',
      'import  read a saved mod back out as script text',
      'code    the shareable VXG1 code for this session\'s rules'
    ]
  });

  builtin('logic', 'logic [show|delete <Name>]', 'Your own logic blocks', (args, io) => {
    const sub = String(args[0] || '').toLowerCase();
    const names = Object.keys(termBlocks).sort();

    if (!sub || sub === 'list') {
      if (!names.length) {
        io.text('You have not defined any blocks yet.');
        io.blank();
        io.text('A block is the complicated part, written once and then used by name:');
        io.blank();
        io.script('block MeteorStrike POWER {');
        io.script('  repeat 4 {');
        io.script('    Fill-Area air 3 3');
        io.script('    Emit-Particles player orange 20 8');
        io.script('  }');
        io.script('  Invoke-Shake ($POWER * 3)');
        io.script('}');
        io.blank();
        io.text('After that, "MeteorStrike 5" works anywhere, and the block appears');
        io.text('in the Mod Editor palette under "My blocks".');
        return;
      }
      io.head('MY BLOCKS (' + names.length + ')');
      let off = 0;
      for (const k of names) {
        const d = termBlocks[k];
        const live = termBlockActive(k);
        if (!live) off++;
        io.pair(d.name + termBlockSig(d),
                d.nodes + ' blocks' + (live ? '' : '   NOT ACTIVE'));
      }
      if (off) {
        io.blank();
        io.err(off + ' of these are not running in this world.');
        io.hint('Either switched off in the Mod Editor\'s mod list, or this world is');
        io.hint('using somebody else\'s loadout. A call to one does nothing at that step.');
      }
      io.blank();
      io.hint('"logic show <Name>" prints one. "logic delete <Name>" removes it.');
      return;
    }

    if (sub === 'show') {
      const d = termFindBlock(args.slice(1).join(' ').trim());
      if (!d) { io.err('No block called "' + (args[1] || '') + '".'); io.hint('Run "logic".'); return; }
      io.head(d.name.toUpperCase());
      for (const line of String(d.source || '').split('\n')) io.script(line);
      io.blank();
      io.hint('Paste it back in, edited, to redefine it.');
      return;
    }

    if (sub === 'delete' || sub === 'remove') {
      const raw = args.slice(1).join(' ').trim();
      const d = termFindBlock(raw);
      if (!d) { io.err('No block called "' + raw + '".'); io.hint('Run "logic".'); return; }
      // The saved mod goes with it. Anything still calling the name keeps
      // running, it just reaches nothing -- the same inert shape a shared mod
      // has on a machine that never had the definition.
      // Resolved by content at the moment of deletion rather than trusting the
      // stored id, for the same reason termBlockPiece exists at all.
      const piece = termBlockPiece(d.key) || (d.pieceId ? VxPieces.get(d.pieceId) : null);
      if (piece) VxPieces.delete(piece.localId);
      delete termBlocks[d.key];
      termSaveBlocks();
      reapplyCustomPieces();
      termRefreshPalette();
      io.ok('Deleted "' + d.name + '".');
      io.hint('Any script still calling it now does nothing at that step.');
      return;
    }

    io.err('Unknown: logic ' + sub);
    io.hint('Try: logic | logic show <Name> | logic delete <Name>');
  }, {
    long: [
      'A block is your own command, built from the same cards as everything else.',
      '',
      '  block <Name> [<Param>] { ... }   define it',
      '  <Name> [value]                   use it',
      '',
      'It takes one value in, and can hand one back with Return-Value.',
      'Definitions are saved like mods, so they survive a reload.'
    ]
  });

  builtin('history', 'history', 'Everything typed this session', (args, io) => {
    if (!termHistory.length) { io.text('Nothing yet.'); return; }
    termHistory.forEach((h, i) => io.pair(String(i + 1).padStart(3, ' '), h));
  });

  builtin('clear', 'clear', 'Empty the screen', (args, io) => { io.clear(); });
  TERM_BUILTINS['cls'] = TERM_BUILTINS['clear'];

  builtin('exit', 'exit', 'Close the terminal', () => { termClose(); });
  TERM_BUILTINS['quit'] = TERM_BUILTINS['exit'];

  // ==========================================================================
  // ASK -- plain language in, script out, questions in between
  // ==========================================================================
  // The third door, and the only one that adds no vocabulary at all. `ask`
  // takes an ordinary sentence, works out which catalog commands it is
  // describing, and writes the script. What it does NOT do is run anything:
  // the script is printed, and it reaches the game through termExecute() only
  // after the player says yes. So the closed-catalog rule this file's header
  // describes holds here for the plainest possible reason: everything this
  // produces is text the player could have typed, checked by the same lexer,
  // parser and compiler as text that was typed. There is no second path in.
  //
  // The questions are the important half. "give me gold when I mine grass"
  // does not say how much gold, and inventing an amount would be the worst
  // thing this could do: the player would get a rule that reads right and
  // quietly means something else. So anything the sentence did not state is
  // asked about, one slot at a time, using the same description `help` prints
  // for that slot. Guessing is reserved for what the sentence actually said.
  //
  // Matching is deliberately shallow: fold the words, score them against the
  // command names, the catalog labels and a hand-written German/English
  // synonym list, take the best per kind. That covers the shapes people
  // actually type at a game prompt, and everything else falls into a question
  // rather than into a wrong answer. When a real model is wired up later (see
  // askTranslate), it replaces this scoring step and nothing else: the
  // questions, the validation and the confirmation stay exactly as they are,
  // because those are what make an answer safe rather than merely plausible.

  // Folded for matching: lowercase, umlauts flattened, everything that is not
  // a letter or a digit becomes a space. German input has to survive this, so
  // "Abbauen", "abbaust" and "ABBAU" all land on the same key.
  function askFold(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
      .replace(/ß/g, 'ss')
      // A decimal point belongs to its number rather than being punctuation
      // between two of them, so "wait 0.5 seconds" has to stay one number
      // instead of becoming a nought and a five. The dot survives the strip
      // below and is then dropped everywhere it is not sitting between two
      // digits, written as a replacer rather than a lookbehind so it does not
      // depend on how new the engine running the page is.
      .replace(/(\d),(\d)/g, '$1.$2')
      .replace(/[^a-z0-9.]+/g, ' ')
      .replace(/\./g, (m, at, str) => {
        const before = str.charAt(at - 1), after = str.charAt(at + 1);
        return (before >= '0' && before <= '9' && after >= '0' && after <= '9') ? '.' : ' ';
      })
      .replace(/\s+/g, ' ')
      .trim();
  }
  function askWords(s) { const f = askFold(s); return f ? f.split(' ') : []; }

  // The words of a whole sentence, with commas turned into the conjunction
  // they stand for. "give me 10 gold, 5 iron and 3 coal" lists three things
  // the same way "10 gold and 5 iron and 3 coal" does, and askClauses below
  // only has to know about one of those spellings. Safe to do bluntly because
  // a comma inside quoted text is read from the raw string, never from here.
  function askSentenceTokens(text) {
    return askWords(String(text == null ? '' : text).replace(/[,;]+/g, ' und '));
  }

  // Words that end one thing being asked for and start the next.
  const ASK_SPLIT = new Set(['und', 'and', 'dann', 'then', 'danach', 'sowie', 'plus', 'ausserdem']);

  // A sentence cut into the separate things it asks for, as ranges over the
  // token list rather than as their own arrays, so every index stays valid in
  // the one space the whole plan shares. This is what makes "give me 100
  // obsidian and 100 gold" two actions instead of one action that quietly
  // dropped half the sentence.
  function askClauses(tokens) {
    const out = [];
    let start = 0;
    tokens.forEach((t, i) => {
      if (!ASK_SPLIT.has(t)) return;
      if (i > start) out.push({ start, end: i });
      start = i + 1;
    });
    if (start < tokens.length) out.push({ start, end: tokens.length });
    return out.length ? out : [{ start: 0, end: tokens.length }];
  }

  // Words that carry no signal about WHICH command is meant. "player" is in
  // here because it appears in a third of the catalog labels: left in, it
  // would make "Spieler" match almost everything with equal confidence, which
  // is the same as matching nothing at all.
  const ASK_STOP = new Set([
    'the', 'and', 'that', 'this', 'with', 'for', 'from', 'into', 'out', 'not',
    'you', 'your', 'them', 'they', 'when', 'then', 'something', 'number',
    'player', 'players', 'all', 'any', 'one', 'two', 'its', 'get', 'gets',
    'der', 'die', 'das', 'ein', 'eine', 'einen', 'einem', 'einer', 'den', 'dem',
    'ich', 'mir', 'mich', 'mein', 'meine', 'meinem', 'ist', 'sind', 'soll',
    'sollen', 'will', 'wenn', 'dann', 'und', 'oder', 'auf', 'bei', 'mit', 'von',
    'fur', 'sich', 'nicht', 'auch', 'etwas', 'was', 'wie', 'man', 'wird',
    'werden', 'hat', 'haben', 'sein', 'spieler', 'immer', 'jedes', 'jedem',
    'jede', 'sobald', 'dass', 'damit', 'aber', 'noch', 'schon', 'ganz'
  ]);

  // Trigger words per command NAME, not per node type: Mine and Place are
  // separate entries on purpose, because "abbauen" and "platzieren" are
  // different words for what is one node with a dropdown underneath, and the
  // alias is exactly the spelling that already fixes that dropdown.
  //
  // Written folded (see askFold) and matched as prefixes, so one entry covers
  // abbaue / abbaust / abbauen / abgebaut without a stemmer. German first,
  // English after, because the command names already carry the English and
  // this table exists to cover what they do not.
  const ASK_SYN = {
    // Events
    'Mine':        ['abbau', 'abgebaut', 'grab', 'zerstor', 'kaputt', 'mine', 'mining', 'break', 'dig'],
    'Place':       ['platzier', 'setz', 'gesetzt', 'hinstell', 'place', 'build', 'put'],
    'Touch':       ['beruhr', 'anfass', 'touch'],
    'Jump':        ['spring', 'gesprungen', 'hupf', 'jump'],
    'Hurt':        ['verletzt', 'schaden nehm', 'getroffen', 'hurt', 'damag'],
    'Death':       ['sterb', 'stirbt', 'gestorben', 'tod', 'die', 'dies', 'death', 'dead'],
    'Timer':       ['sekund', 'takt', 'regelmassig', 'timer', 'second', 'interval', 'tick'],
    'WorldStart':  ['weltstart', 'spielstart', 'spielbeginn', 'weltbeginn', 'worldstart'],
    'EnterDimension': ['dimension', 'betret', 'portal'],
    'DayPhase':    ['nacht', 'tageszeit', 'abend', 'morgen', 'dammer', 'night', 'dusk', 'dawn'],
    'Pickup':      ['aufheb', 'aufsammel', 'einsammel', 'pickup', 'picks'],
    'PlayerJoin':  ['beitritt', 'joint', 'dazukommt', 'join'],
    'PlayerLeave': ['verlasst', 'weggeht', 'leaves', 'disconnect'],

    // Conditions
    'Chance':      ['manchmal', 'zufall', 'zufallig', 'selten', 'gelegentlich',
                    'chance', 'sometimes', 'random', 'occasion'],
    'Compare':     ['vergleich', 'grosser', 'kleiner', 'tiefer', 'hoher',
                    'compare', 'greater', 'deeper'],
    'HasBlock':    ['besitz', 'inventar', 'holding', 'carries'],
    'WearingArmor': ['rustung', 'panzer', 'armor', 'armour', 'wearing'],
    'InZone':      ['zone', 'bereich', 'gebiet'],
    'ScoreAtLeast': ['punktestand', 'score'],

    // Actions
    'Give-Item':   ['gib', 'gebe', 'geben', 'gibt', 'bekomm', 'krieg', 'erhalt', 'schenk',
                    'belohn', 'give', 'grant', 'award', 'reward'],
    'Take-Item':   ['nimm', 'nehm', 'wegnehm', 'abzieh', 'entzieh', 'klau', 'take', 'remove'],
    'Show-Text':   ['zeig', 'nachricht', 'meldung', 'schreib', 'anzeig', 'show',
                    'messag', 'tell', 'display', 'print'],
    'Heal-Player': ['heil', 'gesund', 'heal', 'restore'],
    'Hurt-Player': ['schadet', 'schade', 'wehtun', 'weh', 'verletze', 'autsch'],
    'Teleport-Player': ['teleport', 'versetz', 'beam'],
    'Launch-Player': ['schleuder', 'katapult', 'launch', 'fling'],
    'Emit-Particles': ['partikel', 'funken', 'sternchen', 'effekt', 'particl', 'spark'],
    'Invoke-Shake': ['wackel', 'ruttel', 'beben', 'erschutter', 'shake', 'rumble'],
    'Play-Sound':  ['gerausch', 'klang', 'sound'],
    'Set-Number':  ['zahler', 'variable', 'merk', 'counter'],
    'Add-Score':   ['punkt', 'score', 'point'],
    'Spawn-Creature': ['spawn', 'erschaff', 'monster', 'kreatur', 'gegner', 'creature', 'mob', 'enemy'],
    'Fill-Area':   ['flache', 'fulle', 'ausfull', 'fill', 'area'],
    'Wait-Seconds': ['wart', 'pause', 'verzoger', 'wait', 'delay'],
    'Send-Announcement': ['ankundig', 'verkund', 'announc'],
    'Show-Dialog': ['dialog', 'gesprach'],
    'Show-Panel':  ['panel', 'tafel', 'anzeigefeld'],
    'Stop-Event':  ['verhinder', 'unterbind', 'prevent'],
    'Set-Drop':    ['beute', 'loot', 'droppt', 'ausbeute'],
    'Set-Mining':  ['abbaugeschwindigkeit', 'harte'],
    'Join-Team':   ['mannschaft', 'team'],
    'Start-Countdown': ['countdown', 'ruckwarts']
  };

  // Block names a player is likely to type in German. Only the ones whose
  // English name is not already a prefix away: "gold" and "sand" need no help,
  // "holz" and "erde" do. Everything not in here still resolves through the
  // ordinary label match below, so this is a shortcut, never a gate.
  // Written against the BLOCKS enum, not against the display labels, because
  // several ores are NOT called what a player would guess: iron ore shows as
  // "Moganite", diamond ore as "Aquamarine", rainbow ore as "Bixbit". Mapping
  // "eisen" to a label would therefore find nothing, while the enum name it
  // actually has is stable.
  const ASK_BLOCK_DE = {
    holz: 'log', stamm: 'log', baumstamm: 'log', bretter: 'planks', planken: 'planks',
    erde: 'dirt', boden: 'dirt', stein: 'stone', fels: 'stone',
    gras: 'grass', rasen: 'grass', blatt: 'leaves', blatter: 'leaves', laub: 'leaves',
    // No "wasser" here: water and deep water are world scenery rather than
    // items (NON_ITEM_BLOCK_IDS), so no block slot can hold one and a
    // shortcut to them could only ever fail.
    lava: 'lava', kohle: 'coal_ore', eisen: 'iron_ore', gold: 'gold_ore',
    diamant: 'diamond_ore', aquamarin: 'diamond_ore',
    glas: 'glass', eis: 'ice', kaktus: 'cactus', fackel: 'torch', blume: 'flower',
    koralle: 'coral', dynamit: 'diamond_dynamite', goldziegel: 'gold_brick'
  };
  // The same completeness check ASK_SYN gets, and for the same reason: a
  // shortcut pointing at a block that was renamed or removed would quietly
  // stop working and look like the translator simply not understanding German.
  (function checkAskBlockDe() {
    for (const [word, target] of Object.entries(ASK_BLOCK_DE)) {
      try { termResolveBlock(target, {}, 0); }
      catch (e) {
        console.warn('Voxeria Terminal: ask maps "' + word + '" to "' + target + '", which is not a block.');
      }
    }
  })();

  // command key -> { hit, kind, words: Map(word -> weight) }. Built from the
  // same TERM_INDEX every other lookup in this file reads, so a command that
  // does not exist cannot be scored into existence by a typo in ASK_SYN.
  const ASK_TRIGGERS = [];
  (function buildAskTriggers() {
    for (const [key, hit] of Object.entries(TERM_INDEX)) {
      const def = NODE_CATALOG[hit.type];
      if (!def) continue;
      const words = new Map();
      const add = (text, weight) => {
        for (const part of askWords(text)) {
          if (part.length < 3 || ASK_STOP.has(part)) continue;
          words.set(part, Math.max(words.get(part) || 0, weight));
        }
      };
      // Three tiers, and the gaps between them both matter.
      //
      // A name word is worth reaching the threshold on its own: typing a
      // command's actual name has to be enough, and weighting it below the
      // threshold meant "hurt me" scored 2 for Hurt-Player and was rejected.
      //
      // A synonym outranks it, because several commands can share a name word
      // while only one has been given that word deliberately. "give me gold"
      // is Give-Item, not Give-Involved, and both carry "give" in their names;
      // what separates them is that one of them was taught the word.
      //
      // A label word is worth least: a label is a sentence written for a node
      // board and shares its words with every neighbouring card.
      add(hit.name.replace(/[-_]/g, ' '), 3);
      add(def.label, 1);
      for (const syn of (ASK_SYN[hit.name] || [])) add(syn, 4);
      ASK_TRIGGERS.push({ key, hit, kind: def.kind, words });
    }
    // The same completeness discipline buildIndex() applies: a synonym list
    // pointing at a command that was later renamed would silently stop
    // helping, and silence is the failure mode this whole file is written
    // against.
    for (const name of Object.keys(ASK_SYN)) {
      if (!TERM_INDEX[name.toLowerCase()]) {
        console.warn('Voxeria Terminal: ask names "' + name + '", which is not a command.');
      }
    }
  })();

  // A token counts for a trigger word when either is a prefix of the other and
  // the shorter one is at least four characters. That is what turns "abbau"
  // into a match for "abbaust" without a stemmer, while stopping "tod" from
  // matching "today".
  function askWordHit(token, word) {
    if (token === word) return true;
    const short = token.length < word.length ? token : word;
    const long = token.length < word.length ? word : token;
    return short.length >= 4 && long.indexOf(short) === 0;
  }

  // `at` is the list of token positions that made this command match. It is
  // what lets a block name be attached to the command it stands next to: in
  // "give me 10 gold whenever I mine grass" both "gold" and "grass" are real
  // blocks, and the only thing that says which belongs to which is that one
  // sits beside "give" and the other beside "mine".
  function askScore(tokens, kinds) {
    const out = [];
    for (const entry of ASK_TRIGGERS) {
      if (kinds.indexOf(entry.kind) < 0) continue;
      let score = 0;
      const at = [];
      for (const [word, weight] of entry.words) {
        let matched = false;
        tokens.forEach((t, i) => { if (askWordHit(t, word)) { matched = true; at.push(i); } });
        if (matched) score += weight;
      }
      if (score > 0) out.push({ entry, score, at });
    }
    // Shorter name wins a tie, because the short spellings are the pinned
    // aliases (Mine, Jump) and those are the ones a sentence usually means.
    out.sort((a, b) => b.score - a.score || a.entry.hit.name.length - b.entry.hit.name.length);
    return out;
  }

  // ---- slots ---------------------------------------------------------------
  // The parameters a command still needs from the player. A pinned one is left
  // out for the same reason `help` leaves it out: the command name already
  // answered it, so asking would be asking about a slot that does not exist.
  function askSpecs(hit) {
    const def = NODE_CATALOG[hit.type];
    return def.params.filter(s => !(hit.pin && Object.prototype.hasOwnProperty.call(hit.pin, s.k)));
  }

  // An id back into the word a script should carry. The BLOCKS enum first,
  // exactly the order termResolveBlock reads it in, so what comes back out is
  // what would have gone in.
  function askBlockToken(id) {
    for (const [enumName, value] of Object.entries(BLOCKS)) {
      if (value === id) return enumName.toLowerCase();
    }
    const row = termBlockTable().find(b => b.id === id);
    return row ? JSON.stringify(row.label) : String(id);
  }

  // An enum option as it has to appear in a script: quoted when it contains a
  // space, or the lexer reads "gets hurt" as two arguments.
  function askEnumToken(option) {
    return /\s/.test(option) ? JSON.stringify(option) : option;
  }

  // Turns whatever the player typed into a script fragment for one slot, or
  // throws with a message worth showing. Every branch goes through the same
  // resolver the parser uses, so an answer accepted here cannot fail later.
  function askFormatValue(spec, raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) throw new Error('Nothing given.');

    if (spec.kind === 'block') return askBlockToken(termResolveBlock(text, spec, 0));
    if (spec.kind === 'enum') {
      const list = graphSpecList(spec, {});
      return askEnumToken(termResolveEnum(text, list, 0, spec.label || spec.k));
    }
    if (spec.kind === 'varname') {
      const name = text.replace(/^\$/, '').toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        throw new Error('A name has to start with a letter, e.g. SCORE.');
      }
      return name;
    }
    // A creature slot is a plain number, and the parser insists on one. It
    // used to fall through to the text branch at the bottom and be written as
    // "1", which then failed to compile with "expected a creature slot
    // number" -- an answer the player gave correctly, rejected by the draft.
    if (spec.kind === 'creature') {
      const slot = Number(text);
      if (!Number.isInteger(slot) || slot < 0) {
        throw new Error('A creature slot is a whole number, e.g. 0.');
      }
      return String(slot);
    }
    if (spec.kind === 'num' || spec.kind === 'value') {
      // A live reading or a saved number is a perfectly good answer wherever
      // the slot takes a value, and refusing it here would make `ask` weaker
      // than the language it is writing for.
      if (spec.kind === 'value' && /^[$@][A-Za-z0-9_]+$/.test(text)) return text;
      // "none" the same way: termSpecSummary offers it in the very hint the
      // question prints, so refusing the word it just suggested would be the
      // question arguing with its own answer. Accepted only where the slot
      // really allows it, which is the same test the parser makes.
      if (spec.kind === 'value' && /^(none|nothing|nichts|keine|keins)$/i.test(text)) {
        const allowed = spec.sources || VALUE_SOURCE_KEYS;
        if (allowed.indexOf(VALUE_NONE) >= 0) return 'none';
        throw new Error('This one needs an actual value.');
      }
      const n = Number(text.replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error('That is not a number.');
      const range = spec.kind === 'num'
        ? { min: spec.min, max: spec.max }
        : graphSpecRange(spec, {});
      if (n < range.min || n > range.max) {
        throw new Error('Has to be between ' + range.min + ' and ' + range.max + '.');
      }
      return String(spec.dec ? n : Math.round(n));
    }
    // text and textvalue: always quoted, so a sentence with spaces in it stays
    // one argument.
    return JSON.stringify(text.replace(/^["']|["']$/g, ''));
  }

  // ---- reading the sentence ------------------------------------------------
  // Numbers are consumed in the order they were written, by the event first,
  // then the condition, then the action. "every 5 seconds give me 2 gold" is
  // the shape this gets right, and it is the shape people type.
  // Every number in the sentence, each remembering WHICH word it was, so a
  // clause can take the numbers standing inside it and leave the rest alone.
  // A percentage is flagged by value rather than by position: the "%" does not
  // survive folding, so it is looked for in the raw text and matched back.
  function askNumbers(text, tokens) {
    const percent = new Set();
    const re = /(\d+(?:[.,]\d+)?)\s*(%|prozent|percent)/gi;
    let m;
    while ((m = re.exec(String(text))) !== null) percent.add(m[1].replace(',', '.'));
    const out = [];
    tokens.forEach((t, i) => {
      if (/^\d+(?:\.\d+)?$/.test(t)) out.push({ i, text: t, percent: percent.has(t) });
    });
    return out;
  }

  // The next number this part is allowed to use: inside its own clause and not
  // already spent. A percentage slot takes ONLY a number written as a
  // percentage, and every other slot takes only numbers that were not. The two
  // halves of that rule matter equally: without the first, "sometimes give me
  // 2 coal" hands the 2 to the chance and then has nothing left for the coal;
  // without the second, "40% chance of 3 gold" hands the 40 to the amount.
  // A percentage slot with no percentage in the sentence is left to ask.
  function askNextNumber(numbers, range, used, wantPercent) {
    for (const n of numbers) {
      if (used.has(n.i)) continue;
      if (range && (n.i < range.start || n.i >= range.end)) continue;
      if (wantPercent !== !!n.percent) continue;
      return n;
    }
    return null;
  }

  // One word, at most one block. An exact spelling wins outright, and among
  // the rest the SHORTEST label wins: "gold" has to mean gold rather than gold
  // brick, and the player who wants the brick has the word for it.
  function askBlockForToken(token) {
    if (token.length < 3) return null;
    const german = ASK_BLOCK_DE[token];
    if (german) {
      try { return { id: termResolveBlock(german, {}, 0), exact: true }; } catch (e) {}
    }
    let best = null;
    for (const row of termBlockTable()) {
      if (NON_ITEM_BLOCK_IDS.has(row.id)) continue;
      const label = askFold(row.label).replace(/ /g, '');
      if (label.length < 3) continue;
      if (label === token) return { id: row.id, exact: true };
      if (askWordHit(token, label) && (!best || label.length < best.len)) {
        best = { id: row.id, exact: false, len: label.length };
      }
    }
    return best;
  }

  // The block this particular command is talking about. `near` is where the
  // command itself was recognised, `used` the words earlier slots already
  // took, so a sentence naming two blocks hands each of them to the command
  // standing next to it instead of handing the same one to both.
  function askFindBlock(tokens, near, used, range) {
    const found = [];
    tokens.forEach((token, i) => {
      if (used && used.has(i)) return;
      if (range && (i < range.start || i >= range.end)) return;
      const hit = askBlockForToken(token);
      if (hit) found.push({ i, id: hit.id, exact: !!hit.exact });
    });
    if (!found.length) return null;
    const distance = c => (near && near.length
      ? Math.min.apply(null, near.map(n => Math.abs(n - c.i)))
      : c.i);
    found.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || distance(a) - distance(b));
    return found[0];
  }

  // Fills what the sentence stated and leaves the rest null. Returning nulls
  // rather than defaults is the whole point: a null becomes a question, a
  // default would become a silent guess.
  // `scope` is everything about where in the sentence this part is allowed to
  // look: { tokens, text, numbers, near, used, range }. `notes` is the other
  // half of the answer -- when the sentence DID state something and it could
  // not be used, the reason is kept and shown with the question. Silently
  // asking for a number the player just gave is what makes a translator feel
  // like it is not listening.
  function askFillSlots(hit, scope) {
    const specs = askSpecs(hit);
    const args = specs.map(() => null);
    const notes = specs.map(() => null);
    const tokens = scope.tokens, used = scope.used || new Set();
    const inRange = i => !scope.range || (i >= scope.range.start && i < scope.range.end);

    specs.forEach((spec, i) => {
      if (spec.kind === 'block') {
        const found = askFindBlock(tokens, scope.near, used, scope.range);
        if (found) { args[i] = askBlockToken(found.id); used.add(found.i); }
        return;
      }
      if (spec.kind === 'enum') {
        const list = graphSpecList(spec, {});
        for (const option of list) {
          const folded = askFold(option).replace(/ /g, '');
          if (folded.length < 3) continue;
          const at = tokens.findIndex((t, j) => inRange(j) && askWordHit(t, folded));
          if (at >= 0) { args[i] = askEnumToken(option); return; }
        }
        return;
      }
      if (spec.kind === 'num' || spec.kind === 'value') {
        const wantPercent = /percent|chance/i.test(spec.k) || /%/.test(spec.label || '');
        const next = askNextNumber(scope.numbers || [], scope.range, used, wantPercent);
        if (!next) return;
        try {
          args[i] = askFormatValue(spec, next.text);
          used.add(next.i);
        } catch (e) {
          // The number was said out loud and rejected, so say why rather than
          // asking from scratch as if nothing had been said. It stays spent
          // either way, or the next slot would pick up the same bad value.
          notes[i] = 'You said ' + next.text + '. ' +
                     (e && e.message ? e.message : 'That does not fit here.');
          used.add(next.i);
        }
        return;
      }
      if (spec.kind === 'text' || spec.kind === 'textvalue') {
        const quoted = String(scope.text || '').match(/"([^"]*)"|'([^']*)'/);
        if (quoted) args[i] = JSON.stringify(quoted[1] != null ? quoted[1] : quoted[2]);
        return;
      }
    });
    return { specs, args, notes };
  }

  // ---- the plan ------------------------------------------------------------
  // Words that say "this is a rule, not a one-off". Without one of these, a
  // sentence naming an action is taken as a command to run once, which is the
  // difference between "give me 10 gold" and "give me 10 gold when I jump".
  const ASK_RULE_WORDS = ['wenn', 'immer', 'sobald', 'jedesmal', 'falls',
                          // "if I touch grass then spawn a creature" is a rule
                          // in every ordinary reading of it, and leaving "if"
                          // out meant the trigger was dropped and only the
                          // action survived.
                          'if', 'when', 'whenever', 'each', 'every', 'always'];
  const ASK_YES = new Set(['ja', 'j', 'yes', 'y', 'ok', 'okay', 'run', 'los', 'go', 'jo']);
  const ASK_NO = new Set(['nein', 'n', 'no', 'cancel', 'abbrechen', 'abbruch', 'stop',
                          'exit', 'quit', 'verwerfen', 'nope']);
  const ASK_EDIT = new Set(['edit', 'bearbeiten', 'andern', 'change']);

  let askSession = null;
  // Bumped for every attempt, so an answer that arrives late can tell whether
  // the question it belongs to is still the one on screen.
  let askToken = 0;

  // askScore over part of a sentence, with the positions it reports translated
  // back into the whole sentence's numbering, so a score taken from one clause
  // can still be compared and used alongside everything else.
  function askScoreRange(tokens, kinds, range) {
    const out = askScore(range ? tokens.slice(range.start, range.end) : tokens, kinds);
    if (range) for (const entry of out) entry.at = entry.at.map(i => i + range.start);
    return out;
  }

  // `force` pins one part to a command the player has already chosen, which is
  // what lets an answered "which one did you mean?" rebuild the WHOLE sentence
  // instead of keeping a half-built plan. Before this, answering that question
  // threw away everything the sentence said after it.
  function askPlan(text, force) {
    const tokens = askSentenceTokens(text);
    const numbers = askNumbers(text, tokens);
    // Shared across every part: a word handed to the event is gone before the
    // actions look for one of their own, and one action's item cannot be the
    // next one's as well.
    const used = new Set();
    const plan = { original: text, event: null, cond: null, actions: [], choices: null };
    const pinned = force || {};

    // "every 5 seconds" is the one phrase worth reading directly: Timer scores
    // well on "seconds" alone, but the number belongs to it and would
    // otherwise be eaten by whatever action comes later in the sentence.
    const timer = askFold(text).match(/(?:alle|every|all)\s+(\d+)\s*(?:sek|sec)/);

    const clauses = askClauses(tokens);
    const actions = askScore(tokens, ['action']);
    const conds = askScore(tokens, ['cond']);

    const wantsRule = ASK_RULE_WORDS.some(w => tokens.indexOf(w) >= 0) || !!timer;

    // Where to look for the trigger: inside the clause the rule word sits in,
    // when the sentence has more than one clause. "when i touch grass, hurt
    // me" names two things the catalog knows, Touch and Hurt, and the only
    // thing saying which of them is the trigger is which side of "when" it is
    // on. Searching the whole sentence made those two tie and turned a
    // perfectly clear sentence into a question.
    const ruleClause = clauses.length > 1
      ? clauses.find(c => {
          for (let i = c.start; i < c.end; i++) {
            if (ASK_RULE_WORDS.indexOf(tokens[i]) >= 0) return true;
          }
          return false;
        }) || null
      : null;
    // Only the SEARCH is narrowed, never the clauses the actions may use: a
    // rule word can sit in the same clause as one of the things being asked
    // for ("give me 5 iron when I jump"), and that clause still has to be able
    // to contribute its action.
    const events = askScoreRange(tokens, ['event'], ruleClause);

    if (timer && TERM_INDEX['timer']) {
      const hit = TERM_INDEX['timer'];
      // Those seconds belong to the timer, so the token carrying them is
      // marked spent before anything else goes looking for a number.
      const seconds = numbers.find(n => n.text === timer[1]);
      const filled = askFillSlots(hit, {
        tokens: [], text: '', numbers: [{ i: -1, text: timer[1], percent: false }],
        near: [], used: new Set()
      });
      if (seconds) used.add(seconds.i);
      plan.event = { hit, specs: filled.specs, args: filled.args, notes: filled.notes };
    // Without a word like "when", an event has to beat the best action
    // outright before the sentence is read as a rule. "wait 0.5 seconds" names
    // both Wait-Seconds and, through "seconds", the Timer event; a tie there
    // means the player asked for the action they named, not for a rule they
    // did not. A rule word settles it on its own, so this only decides the
    // cases where nothing in the sentence says which was meant.
    } else if (events.length &&
               (wantsRule || events[0].score > (actions.length ? actions[0].score : 0))) {
      // Two events that fit equally well is the one ambiguity worth stopping
      // for: picking either would silently change what the rule reacts to.
      if (!pinned.event && events.length > 1 && events[1].score === events[0].score) {
        plan.choices = { part: 'event', options: events.slice(0, 4).map(e => e.entry) };
        return plan;
      }
      const hit = pinned.event || events[0].entry.hit;
      const near = pinned.event ? [] : events[0].at;
      const filled = askFillSlots(hit, { tokens, text, numbers, near, used, range: ruleClause });
      plan.event = { hit, specs: filled.specs, args: filled.args, notes: filled.notes };
    }

    if (conds.length && conds[0].score >= 3) {
      const hit = conds[0].entry.hit;
      const filled = askFillSlots(hit, { tokens, text, numbers, near: conds[0].at, used });
      plan.cond = { hit, specs: filled.specs, args: filled.args, notes: filled.notes };
    }

    // One action per thing the sentence asks for. A clause with no verb of its
    // own but with something to act on ("... and 100 gold") continues the one
    // before it, because that is what the sentence means: the verb was said
    // once and applies to both halves.
    let previous = null;
    let pinnedActionLeft = pinned.action || null;
    for (const clause of askClauses(tokens)) {
      const scored = askScoreRange(tokens, ['action'], clause);
      let hit = null, near = [];
      if (scored.length && scored[0].score >= 3) {
        // A pinned action answers the first clause that had a verb in it,
        // which is the clause the question was asked about.
        if (pinnedActionLeft) {
          hit = pinnedActionLeft;
          near = scored[0].at;
          pinnedActionLeft = null;
        } else {
          // Only worth stopping the whole sentence for on the FIRST action:
          // asking which of two commands was meant, twice, for one sentence,
          // is worse than showing a draft that can be corrected.
          if (scored.length > 1 && scored[1].score === scored[0].score && !plan.actions.length) {
            plan.choices = { part: 'action', options: scored.slice(0, 4).map(a => a.entry) };
            return plan;
          }
          hit = scored[0].entry.hit;
          near = scored[0].at;
        }
      } else if (previous && askClauseCarries(tokens, clause, used)) {
        hit = previous;
      }
      if (!hit) continue;
      const filled = askFillSlots(hit, { tokens, text, numbers, near, used, range: clause });
      plan.actions.push({ hit, specs: filled.specs, args: filled.args, notes: filled.notes });
      previous = hit;
    }

    return plan;
  }

  // Whether a verbless clause is naming something at all, which is what tells
  // "and 100 gold" (a second thing to give) apart from "and then I win" (a
  // remark). A block or a number is enough; anything less would attach the
  // previous command to words that were never about it.
  function askClauseCarries(tokens, clause, used) {
    for (let i = clause.start; i < clause.end; i++) {
      if (used.has(i)) continue;
      if (/^\d+(?:\.\d+)?$/.test(tokens[i])) return true;
      if (askBlockForToken(tokens[i])) return true;
    }
    return false;
  }

  // ---- writing it out ------------------------------------------------------
  function askPartText(part) {
    const args = part.args.map(a => (a == null ? '?' : a));
    return part.hit.name + (args.length ? ' ' + args.join(' ') : '');
  }

  // Every action the sentence asked for, one line each, wrapped once in
  // whatever trigger and condition were found. The wrapper is shared rather
  // than repeated per action, which is both what the sentence said and what
  // the compiler wants: one event card feeding a chain.
  function askScript(plan) {
    const body = plan.actions.map(askPartText);
    const lines = [];
    const indent = (depth, rows) => rows.map(r => '  '.repeat(depth) + r);
    if (plan.event && plan.cond) {
      lines.push('on ' + askPartText(plan.event) + ' {');
      lines.push('  if ' + askPartText(plan.cond) + ' {');
      lines.push.apply(lines, indent(2, body));
      lines.push('  }');
      lines.push('}');
    } else if (plan.event) {
      lines.push('on ' + askPartText(plan.event) + ' {');
      lines.push.apply(lines, indent(1, body));
      lines.push('}');
    } else if (plan.cond) {
      lines.push('if ' + askPartText(plan.cond) + ' {');
      lines.push.apply(lines, indent(1, body));
      lines.push('}');
    } else {
      lines.push.apply(lines, body);
    }
    return lines.join('\n');
  }

  // Every slot still empty, in the order they will be asked about, each
  // carrying the part it belongs to rather than a key, since there can now be
  // several actions. Event first, because what a rule reacts to is the part a
  // wrong guess would damage most.
  function askOpenSlots(plan) {
    const out = [];
    const collect = part => {
      if (!part) return;
      part.args.forEach((value, i) => { if (value == null) out.push({ part, i }); });
    };
    collect(plan.event);
    collect(plan.cond);
    plan.actions.forEach(collect);
    return out;
  }

  // ---- the session ---------------------------------------------------------
  function askShowQuestion(io) {
    const plan = askSession.plan;
    if (plan.choices) {
      io.text('Which one did you mean?');
      plan.choices.options.forEach((entry, i) => {
        io.pair('  ' + (i + 1) + '  ' + entry.hit.name, NODE_CATALOG[entry.hit.type].label);
      });
      io.hint('Answer with the number or the name. "cancel" drops it.');
      return;
    }
    const slot = askSession.slots[0];
    const part = slot.part;
    const spec = part.specs[slot.i];
    // Which one, but only when the sentence asked for several things at once:
    // then "Give-Item obsidian" names the line being asked about, where a bare
    // "Give-Item" would leave the player guessing which of two they are
    // answering for. With a single action there is nothing to tell apart, and
    // the extra words would only make the question harder to read.
    const many = plan.actions.length > 1 && plan.actions.indexOf(part) >= 0;
    const settled = many ? part.args.filter(a => a != null) : [];
    const which = settled.length ? ' ' + settled[0] : '';
    io.text('"' + part.hit.name + which + '" still needs ' + (spec.label || spec.k) + '.');
    // The reason first, when there is one: the sentence DID say something for
    // this slot and it could not be used, and hearing that back is the
    // difference between a question and a translator that ignored you.
    if (part.notes && part.notes[slot.i]) {
      io.hint(part.notes[slot.i]);
      part.notes[slot.i] = null;
    }
    io.hint(termSpecSummary(spec));
    io.hint('Answer in one line. "cancel" drops it.');
  }

  function askShowDraft(io) {
    const plan = askSession.plan;
    const script = askScript(plan);
    askSession.script = script;

    // Validated before it is offered, through the same stages a typed script
    // goes through, and branching the same way termExecute() branches: a rule
    // is compiled as a rule, a bare command as an immediate chain. Checking
    // both against termCompile() would fail every immediate command on a rule
    // about top-level statements that does not apply to it. A draft that does
    // not compile is still shown, since it is the most useful starting point
    // the player has, but it is not offered for running, because "yes" has to
    // mean something.
    let valid = true;
    try {
      const ast = termParse(termLex(script));
      if (ast.some(st => st.k === 'on')) termCompile(ast);
      else termCompileImmediate(ast);
    }
    catch (e) {
      valid = false;
      askSession.error = e && e.message ? e.message : String(e);
    }

    io.blank();
    for (const line of script.split('\n')) io.script('  ' + line);
    io.blank();

    if (!valid) {
      io.err('That does not compile: ' + askSession.error);
      io.hint('Type "edit" to load it into the prompt and fix it by hand.');
      askSession.stage = 'broken';
      return;
    }
    askSession.stage = 'confirm';
    io.text(plan.event ? 'This installs a rule for this session.' : 'This runs once, now.');
    io.hint('"yes" runs it, "no" drops it, "edit" loads it into the prompt,');
    io.hint('or just say what is wrong and it gets rebuilt.');
  }

  // Either asks the next question or shows the finished draft. One place, so
  // there is no way to reach a draft with a slot still open.
  function askAdvance(io) {
    const plan = askSession.plan;
    if (plan.choices) { askSession.stage = 'choose'; askShowQuestion(io); return; }
    if (!plan.actions.length) {
      io.text('I got the trigger, but not what should happen.');
      io.hint('Say it as an action, e.g. "give me 10 gold" or "show a message".');
      io.hint('"cancel" leaves this, and "help" then lists every action.');
      askSession.stage = 'needAction';
      return;
    }
    askSession.slots = askOpenSlots(plan);
    if (askSession.slots.length) { askSession.stage = 'slot'; askShowQuestion(io); return; }
    askShowDraft(io);
  }

  function askStart(text, io) {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      io.head('ASK');
      io.text('Describe what you want in ordinary words and get the script for it.');
      io.blank();
      io.text('  ask give me 10 gold whenever I mine grass');
      io.text('  ask every 5 seconds heal me by 2');
      io.text('  ask shake the screen when I die');
      io.blank();
      io.text('Anything the sentence does not say is asked about rather than guessed,');
      io.text('and nothing runs until you say yes. German works too.');
      return;
    }

    // A model, when one is wired up, gets first go; the word matcher below is
    // the fallback for no backend, a failed request and an answer that does
    // not compile. Written this way round so the offline path is the one that
    // always exists rather than the one that is bolted on afterwards.
    const remote = askTranslate(trimmed);
    if (remote) {
      const token = ++askToken;
      askSession = {
        plan: { original: trimmed, event: null, cond: null, actions: [], choices: null },
        slots: [], stage: 'waiting', script: '', error: '', token
      };
      io.text('Working on it...');
      remote.then(script => askRemoteDraft(script, trimmed, token, io))
            .catch(e => {
              console.error('Voxeria Terminal: VoxeriaAI.translate failed:', e);
              if (askSession && askSession.token === token) askLocal(trimmed, io);
            });
      return;
    }
    askLocal(trimmed, io);
  }

  function askLocal(text, io) {
    const trimmed = String(text || '').trim();
    askSession = {
      plan: askPlan(trimmed), slots: [], stage: 'slot',
      script: '', error: '', token: ++askToken
    };
    const plan = askSession.plan;

    if (!plan.event && !plan.cond && !plan.actions.length && !plan.choices) {
      askSession = null;
      io.err('I could not match that to any command.');
      const near = askScore(askWords(trimmed), ['action', 'event', 'cond']).slice(0, 3);
      if (near.length) {
        io.hint('Closest guesses:');
        for (const n of near) io.pair('  ' + n.entry.hit.name, NODE_CATALOG[n.entry.hit.type].label);
      }
      io.hint('Try naming the action plainly, e.g. "give me gold" or "show a message".');
      return;
    }
    askAdvance(io);
  }

  // Every line typed while a session is open lands here. The session owns the
  // prompt on purpose, since a half-answered question competing with the
  // command parser would make both worse, so every branch that can leave is
  // listed above and every question prints the way out.
  function askHandleLine(line, io) {
    const raw = String(line).trim();
    const folded = askFold(raw);

    if (ASK_NO.has(folded)) { askSession = null; io.text('Dropped.'); return; }
    if (/^ask\b/i.test(raw)) { askStart(raw.replace(/^ask\b/i, '').trim(), io); return; }

    const stage = askSession.stage;

    // An answer is still in flight. Nothing here can be usefully answered yet,
    // and silently queueing the line would make it act on a draft the player
    // has not seen.
    if (stage === 'waiting') {
      io.hint('Still working on that one. "cancel" drops it.');
      return;
    }

    if (stage === 'confirm' || stage === 'broken') {
      if (ASK_EDIT.has(folded)) {
        const script = askSession.script;
        askSession = null;
        // Into the prompt rather than into the world: the player asked to take
        // it from here.
        if (termInputEl) { termInputEl.value = script; termAutosize(); termInputEl.focus(); }
        io.text('Loaded into the prompt. Edit it and press Enter.');
        return;
      }
      if (stage === 'confirm' && ASK_YES.has(folded)) {
        const script = askSession.script;
        askSession = null;
        io.blank();
        io.echo(script);
        // The one and only way anything from here reaches the game, and it is
        // the same call the Enter key makes for a hand-typed script.
        termExecute(script, io);
        return;
      }
      // A draft is an offer, not a mode. Anything that is a real command wins
      // over it, so typing "help" or "clear" while a draft is on screen does
      // what it says instead of being read as a complaint about the draft.
      // The open question stages below stay strict, because there an answer
      // like "10" must not be able to mean something else.
      const first = raw.split(/\s+/)[0].toLowerCase();
      if (TERM_BUILTINS[first] || TERM_INDEX[first] || /[{}\n]/.test(raw)) {
        askSession = null;
        termExecute(raw, io);
        return;
      }
      // Otherwise it is a correction, folded back into the sentence, which is
      // how "silver not gold" is meant to work.
      askStart(askSession.plan.original + ' ' + raw, io);
      return;
    }

    if (stage === 'choose') {
      const options = askSession.plan.choices.options;
      const asNumber = Number(raw);
      let picked = null;
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
        picked = options[asNumber - 1];
      } else {
        picked = options.find(o => askFold(o.hit.name) === folded) || null;
      }
      if (!picked) { io.err('Pick one by number or name.'); askShowQuestion(io); return; }
      // The whole sentence is read again with the answer pinned, rather than
      // that one part being filled into the half-built plan the question was
      // asked from. The plan was abandoned mid-build when the ambiguity was
      // found, so everything the sentence said after that point had never been
      // looked at: answering "Touch" for "when i touch grass, hurt me" used to
      // lose the "hurt me" entirely.
      const original = askSession.plan.original;
      const force = {};
      force[askSession.plan.choices.part] = picked.hit;
      askSession.plan = askPlan(original, force);
      askAdvance(io);
      return;
    }

    if (stage === 'needAction') {
      // Only the action half is re-read, so the trigger the player already
      // settled is not re-guessed from a sentence that no longer mentions it.
      const tokens = askSentenceTokens(raw);
      const actions = askScore(tokens, ['action']);
      if (!actions.length || actions[0].score < 3) {
        io.err('Still not an action I know.');
        io.hint('Name it plainly, e.g. "give me gold", "heal me", "shake the screen".');
        return;
      }
      const hit = actions[0].entry.hit;
      const filled = askFillSlots(hit, {
        tokens, text: raw, numbers: askNumbers(raw, tokens),
        near: actions[0].at, used: new Set()
      });
      askSession.plan.actions = [{ hit, specs: filled.specs, args: filled.args, notes: filled.notes }];
      askAdvance(io);
      return;
    }

    // stage 'slot': this line answers the question at the head of the queue.
    const slot = askSession.slots[0];
    const part = slot.part;
    const spec = part.specs[slot.i];
    let value;
    try { value = askFormatValue(spec, raw); }
    catch (e) {
      io.err(e && e.message ? e.message : String(e));
      askShowQuestion(io);
      return;
    }
    part.args[slot.i] = value;
    askSession.slots.shift();
    if (askSession.slots.length) { askShowQuestion(io); return; }
    askShowDraft(io);
  }

  // The seam a real model plugs into. A page that wants one defines
  //
  //   window.VoxeriaAI = { translate(text, ctx) { ... } }
  //
  // and returns script text, or a promise of it, or null to say "I have
  // nothing". Anything it hands back goes through askShowDraft like a locally
  // built draft does, which means through the lexer, the parser and the
  // compiler before a player is ever offered "yes". A model is therefore
  // allowed to be wrong here without being able to be dangerous: the worst it
  // can produce is a draft that fails to compile, and that falls back to the
  // word matcher below rather than reaching the game.
  //
  // Nothing is wired to it in this build on purpose. The API key for a real
  // model cannot ship inside a client anyone can open, so this waits for a
  // proxy, and until then `ask` works with no network at all -- which is also
  // what keeps it working in the Electron build and inside itch's sandboxed
  // iframe, the two places a round trip is least reliable.
  function askTranslate(text) {
    if (!window.VoxeriaAI || typeof window.VoxeriaAI.translate !== 'function') return null;
    try {
      return Promise.resolve(window.VoxeriaAI.translate(text, {
        commands: Object.keys(TERM_INDEX).map(k => TERM_INDEX[k].name)
      }));
    } catch (e) {
      console.error('Voxeria Terminal: VoxeriaAI.translate threw:', e);
      return null;
    }
  }

  // Turns a model's answer into a draft, or hands the sentence back to the
  // word matcher. `token` is what makes a slow answer safe: if the player
  // cancelled or asked something else while it was in flight, the session it
  // belonged to is gone and its reply is dropped rather than overwriting a
  // question that has since moved on.
  function askRemoteDraft(script, text, token, io) {
    if (!askSession || askSession.token !== token) return;
    const clean = typeof script === 'string' ? script.trim() : '';
    if (!clean) { askLocal(text, io); return; }
    try {
      const ast = termParse(termLex(clean));
      if (ast.some(st => st.k === 'on')) termCompile(ast);
      else termCompileImmediate(ast);
    } catch (e) {
      io.hint('The suggestion did not compile, falling back to word matching.');
      askLocal(text, io);
      return;
    }
    askSession.plan = { original: text, event: null, cond: null, actions: [], choices: null };
    askSession.script = clean;
    askSession.stage = 'confirm';
    io.blank();
    for (const line of clean.split('\n')) io.script('  ' + line);
    io.blank();
    io.text(/\bon\b/.test(clean.split('\n')[0]) ? 'This installs a rule for this session.' : 'This runs once, now.');
    io.hint('"yes" runs it, "no" drops it, "edit" loads it into the prompt,');
    io.hint('or just say what is wrong and it gets rebuilt.');
  }

  builtin('ask', 'ask <what you want, in words>',
    'Describe a rule in plain language and get the script for it', (args, io) => {
      askStart(args.join(' '), io);
    }, {
      long: [
        'Takes an ordinary sentence and writes the script that means it. German and',
        'English both work. Nothing is guessed: whatever the sentence leaves open is',
        'asked about one question at a time, and nothing runs until you answer "yes".',
        ' ',
        '  ask give me 10 gold whenever I mine grass',
        '  ask alle 5 sekunden heile mich um 2',
        ' ',
        'The result is ordinary script, so you can say "edit" to take it into the',
        'prompt yourself, or open it as nodes afterwards with "mod open". This adds',
        'no commands of its own: it can only write what "help" already lists.'
      ]
    });

  // ==========================================================================
  // EXECUTION
  // ==========================================================================
  // One entry point for everything typed. The order matters: a builtin wins
  // over a catalog command, because `help` and `clear` must never be shadowed
  // by a node someone adds later.
  function termExecute(src, io) {
    const trimmed = src.trim();
    if (!trimmed) return;

    // A question from `ask` is open: this line answers it rather than starting
    // something new. The session owns the prompt until it is answered or left,
    // which is why every question it prints names the way out (see
    // askHandleLine). Checked before the builtin lookup below so that an answer
    // like "help" is read as an answer, not as a command.
    if (askSession) { askHandleLine(trimmed, io); return; }

    // A single line with no braces MIGHT be a builtin. Checked before lexing
    // so builtin arguments (a mod name with spaces, a filter) do not have to
    // survive the script lexer's rules about quoting.
    if (!/[{}\n]/.test(trimmed)) {
      const parts = trimmed.split(/\s+/);
      const b = TERM_BUILTINS[parts[0].toLowerCase()];
      if (b) {
        try { b.run(parts.slice(1), io); }
        catch (e) { io.err(e.message || String(e)); console.error('Voxeria Terminal:', e); }
        return;
      }
    }

    let ast;
    try {
      ast = termParse(termLex(trimmed));
    } catch (e) {
      termReportError(e, io);
      return;
    }
    if (!ast.length) return;

    const hasBlock = ast.some(st => st.k === 'block');
    const hasRule = ast.some(st => st.k === 'on');
    const hasImmediate = ast.some(st => st.k !== 'on' && st.k !== 'block');
    if ((hasBlock ? 1 : 0) + (hasRule ? 1 : 0) + (hasImmediate ? 1 : 0) > 1) {
      io.err('Mix of definitions, rules and immediate commands.');
      io.hint('A "block" defines, an "on" installs a rule, a bare command runs now. Send them separately.');
      return;
    }

    if (hasBlock) { termDefineBlocks(ast, io); return; }
    if (hasRule) { termInstall(ast, io); return; }
    termRunNow(ast, io);
  }

  // Turns `block X { ... }` into a saved mod plus a registry entry. Saved
  // rather than kept in the session, because the whole point is that the
  // complicated part is written once: a definition that vanished on reload
  // would be a snippet, not a block.
  function termDefineBlocks(ast, io) {
    let compiled;
    try { compiled = termCompile(ast); }
    catch (e) { termReportError(e, io); return; }

    for (const st of ast) {
      const key = termBlockKey(st.name);
      // Only the cards belonging to THIS definition. Several definitions in one
      // paste each become their own mod, so deleting one later cannot take a
      // neighbour with it.
      const evIdx = compiled.nodes.findIndex(n => n.type === 'onSignal' && n.params.signal === key);
      if (evIdx < 0) { io.err('Could not build "' + st.name + '".'); continue; }
      const keep = new Set();
      const stack = [compiled.nodes[evIdx].id];
      while (stack.length) {
        const id = stack.pop();
        if (keep.has(id)) continue;
        keep.add(id);
        for (const w of compiled.wires) if (w.from === id) stack.push(w.to);
      }
      const nodes = compiled.nodes.filter(n => keep.has(n.id))
                                 .map(n => Object.assign({}, n, { y: n.y - compiled.nodes[evIdx].y }));
      const wires = compiled.wires.filter(w => keep.has(w.from) && keep.has(w.to));

      const label = 'Block: ' + st.name;
      const code = encodeGraphCode({ name: label.slice(0, 24), nodes, wires });
      const previous = termBlocks[key];
      // Found BEFORE the new copy is written, or the search would match the
      // one just saved and retire it immediately.
      const stale = termBlockPiece(key);
      const id = VxPieces.save('GRAPH', code, label.slice(0, 24));
      if (!id) return;                       // VxPieces reports its own failure
      // Ein eigener Baustein wird sofort eingeschaltet, anders als ein Mod.
      // Er ist keine Regel, die von selbst in die Welt eingreift, sondern nur
      // ein benanntes Stueck Kette, das erst laeuft, wenn es aufgerufen wird.
      // Ausgeschaltet waere er schlicht kaputt: der Aufruf fuende nichts vor.
      VxPieces.setEnabled(id, true);
      // Replace only once the new copy is safely stored, the same order bdSave
      // and ngSave use.
      if (stale) VxPieces.delete(stale.localId);
      else if (previous && previous.pieceId) VxPieces.delete(previous.pieceId);

      termBlocks[key] = {
        key,
        name: String(st.name).slice(0, 24),
        params: (st.params || []).map(termBlockKey).filter(Boolean),
        pieceId: id,
        nodes: nodes.length,
        source: ''
      };
      // Written back out only once the name is registered, so the decompiler
      // recognises its own calls and prints them as the block rather than as
      // a raw signal.
      termBlocks[key].source = termBlockSource(st);
      if (!termSaveBlocks()) return;
      reapplyCustomPieces();
      termRefreshPalette();

      io.ok((previous ? 'Redefined' : 'Defined') + ' "' + termBlocks[key].name + '" (' +
            nodes.length + ' blocks).');
      io.hint('Use it anywhere: ' + termBlocks[key].name + termBlockSig(termBlocks[key]) +
              '   -- also in the Mod Editor palette, under "My blocks".');
    }
  }

  // The definition written back out as script, kept alongside the mod so
  // "logic show" can print what was actually typed rather than a decompile of
  // it. Cheap, and it is the thing a person wants to see before editing.
  function termBlockSource(st) {
    try {
      const g = termCompile([st]);
      return termDecompile(g);
    } catch (e) { return ''; }
  }

  // A "Call by name" that nothing answers is legal and inert: that is exactly
  // what a shared mod looks like on a machine without the definition, and
  // refusing to compile it would break sharing. But when it happens to a block
  // this player HAS defined, the cause is almost always that its mod is
  // switched off, and silence would leave them re-reading a script that is
  // fine. So it compiles, and says so.
  function termWarnDeadCalls(graph, io) {
    const seen = new Set();
    for (const n of graph.nodes) {
      if (n.type !== 'callSignal') continue;
      const key = n.params.signal;
      if (seen.has(key)) continue;
      seen.add(key);
      if (termBlockActive(key)) continue;
      const def = termBlocks[key];
      // A bare "Call by name" to a signal defined inside this same script is
      // fine; only a call with no answer anywhere is worth mentioning.
      const answered = graph.nodes.some(x => x.type === 'onSignal' && x.params.signal === key);
      if (answered) continue;
      if (def) {
        io.err('"' + def.name + '" is not running in this world, so that call does nothing.');
        io.hint('Check the Mod Editor\'s mod list, or run "logic".');
      }
    }
  }

  function termReportError(e, io) {
    if (e && e.termLine != null) {
      io.err((e.termLine ? 'Line ' + e.termLine + ': ' : '') + e.message);
      if (e.termHint) io.hint(e.termHint);
    } else {
      io.err(e && e.message ? e.message : String(e));
      console.error('Voxeria Terminal:', e);
    }
  }

  function termInstall(ast, io) {
    let compiled;
    try { compiled = termCompile(ast); }
    catch (e) { termReportError(e, io); return; }

    // Appended rather than replacing, so a session builds up the way a script
    // file would. Ids are re-issued because two compiles both start at n1 and
    // a collision would silently reroute a wire.
    const offset = termSession.nodes.length;
    if (offset + compiled.nodes.length > GRAPH_MAX_NODES) {
      io.err('That would push this session past ' + GRAPH_MAX_NODES + ' blocks.');
      io.hint('Run "mod save <name>" to keep what you have, then "reset".');
      return;
    }
    const remap = new Map();
    // Placed below whatever is already installed, so `mod open` shows one
    // readable column of rules rather than a pile.
    const lowest = termSession.nodes.reduce((m, n) => Math.max(m, n.y), -TERM_ROW - TERM_GAP);
    const shift = termSession.nodes.length ? lowest + TERM_ROW + TERM_GAP : 0;
    for (const n of compiled.nodes) {
      const id = 'n' + (offset + remap.size + 1).toString(36);
      remap.set(n.id, id);
      termSession.nodes.push({ id, type: n.type, x: n.x, y: n.y + shift, params: n.params });
    }
    for (const w of compiled.wires) {
      termSession.wires.push({ from: remap.get(w.from), fromPort: w.fromPort, to: remap.get(w.to) });
    }
    termSyncSession();

    const events = compiled.nodes.filter(n => NODE_CATALOG[n.type].kind === 'event');
    io.ok('Installed ' + events.length + ' rule' + (events.length === 1 ? '' : 's') +
          ' (' + compiled.nodes.length + ' blocks). Live now.');
    termWarnDeadCalls(compiled, io);
    for (const ev of events) io.hint('when: ' + NODE_CATALOG[ev.type].label.toLowerCase());
  }

  function termRunNow(ast, io) {
    if (typeof player === 'undefined' || !player) {
      io.err('No world is running.');
      return;
    }
    let built;
    try { built = termCompileImmediate(ast); }
    catch (e) { termReportError(e, io); return; }
    if (!built.start) { io.err('Nothing to run.'); return; }

    // The same interpreter every saved mod runs through, with the same step
    // budget. Not a shortcut around graphWalk -- a call into it.
    const byId = new Map(built.graph.nodes.map(n => [n.id, n]));
    try {
      graphWalk(built.graph, byId, built.start, {}, { n: 0 }, false);
    } catch (e) {
      io.err('The command failed: ' + (e && e.message ? e.message : String(e)));
      console.error('Voxeria Terminal:', e);
      return;
    }
    // Reported as blocks rather than "done", because a chain with a condition
    // in it may have run only part of what was typed and saying "done" would
    // paper over that.
    const n = built.graph.nodes.length;
    io.ok('Ran ' + n + ' block' + (n === 1 ? '' : 's') + '.');
    termWarnDeadCalls(built.graph, io);
    if (typeof drawHotbar === 'function') drawHotbar();
  }

  // ==========================================================================
  // UI
  // ==========================================================================
  // Injected from here rather than living in index.html, so the whole feature
  // is one file: delete the script tag and the terminal is gone, the same way
  // voxeria-arena.js registers its own mode.
  const TERM_CSS = `
  /* Above the Mod Editor (z 100060), not merely above the game: the terminal
     is opened FROM that editor, so anything lower would put it behind the
     window the player just pressed a button in. */
  #vx-terminal{
    position:fixed; inset:0; z-index:100070; display:none;
    align-items:center; justify-content:center; padding:28px;
    background:rgba(6,6,10,0.72); backdrop-filter:blur(3px);
    font-family:var(--font-mono, ui-monospace, Consolas, monospace);
  }
  #vx-terminal.open{ display:flex; }
  #vx-terminal .vxt-win{
    width:min(1080px, 100%); height:min(760px, 100%);
    display:flex; flex-direction:column;
    background:var(--surface-1,#14141c);
    border:2px solid var(--hud-border,rgba(255,255,255,0.14));
    box-shadow:0 30px 80px -24px rgba(0,0,0,0.7);
  }
  #vx-terminal .vxt-bar{
    display:flex; align-items:center; gap:10px; flex-shrink:0;
    padding:9px 12px; background:var(--surface-2,#1c1c26);
    border-bottom:2px solid var(--hud-border,rgba(255,255,255,0.14));
  }
  #vx-terminal .vxt-dots{ display:flex; gap:6px; }
  #vx-terminal .vxt-dot{
    width:8px; height:8px; background:var(--surface-3,#25252f);
    border:1px solid var(--hud-border,rgba(255,255,255,0.14));
  }
  #vx-terminal .vxt-name{
    font-family:var(--font-display,'Silkscreen',monospace); font-size:12px;
    color:var(--text-1,rgba(255,255,255,0.94));
  }
  #vx-terminal .vxt-tag{
    margin-left:auto; font-family:var(--font-display,'Silkscreen',monospace); font-size:9px;
    color:var(--accent-hover,#b974fa); background:rgba(168,85,247,0.15);
    border:1px solid rgba(168,85,247,0.5); padding:3px 7px;
  }
  #vx-terminal .vxt-x{
    background:none; border:none; color:var(--text-3,rgba(255,255,255,0.42));
    font-size:15px; cursor:pointer; padding:0 4px; line-height:1;
  }
  #vx-terminal .vxt-x:hover{ color:var(--text-1,#fff); }
  #vx-terminal .vxt-log{
    flex:1; overflow-y:auto; padding:16px 18px;
    font-size:13px; line-height:1.55; color:var(--text-2,rgba(255,255,255,0.62));
    white-space:pre-wrap; word-break:break-word;
  }
  /* The input area anchors the popup, which opens UPWARD: the prompt sits at
     the bottom of the window, so a list dropping down would leave the screen. */
  #vx-terminal .vxt-inwrap{ position:relative; flex-shrink:0; }
  #vx-terminal .vxt-pop{
    display:none; position:absolute; bottom:100%; left:14px; right:14px;
    max-height:230px; overflow-y:auto; z-index:2;
    background:var(--surface-0,#0b0b10);
    border:1px solid var(--accent-line,rgba(168,85,247,0.5));
    box-shadow:0 -12px 30px -12px rgba(0,0,0,0.8);
  }
  #vx-terminal .vxt-pop-row{
    display:flex; align-items:baseline; gap:10px; padding:5px 10px;
    font-size:12.5px; cursor:pointer; border-bottom:1px solid var(--line-1,rgba(255,255,255,0.09));
  }
  #vx-terminal .vxt-pop-row:last-child{ border-bottom:none; }
  #vx-terminal .vxt-pop-row.sel{ background:rgba(168,85,247,0.18); }
  #vx-terminal .vxt-pop-row:hover{ background:rgba(168,85,247,0.10); }
  #vx-terminal .pop-kind{
    flex:0 0 34px; font-size:9px; letter-spacing:0.04em; text-transform:uppercase;
    color:var(--text-3,rgba(255,255,255,0.42));
  }
  /* Dieselbe Palette wie die Skriptausgabe, damit das Kürzel links im
     Vorschlag und der getippte Befehl später dieselbe Farbe tragen. */
  #vx-terminal .pop-kind.k-event  { color:#b07cf5; }
  #vx-terminal .pop-kind.k-cond   { color:#ffd54a; }
  #vx-terminal .pop-kind.k-action { color:#7fc4e0; }
  #vx-terminal .pop-kind.k-loop   { color:#4fd07f; }
  #vx-terminal .pop-kind.k-builtin{ color:#f093c8; }
  #vx-terminal .pop-kind.k-keyword{ color:#e8e4f5; }
  #vx-terminal .pop-kind.k-mine{ color:var(--accent-hover,#b974fa); }
  #vx-terminal .pop-kind.k-read{ color:#5fd3c4; }
  #vx-terminal .pop-kind.k-var{ color:#ffab6b; }
  #vx-terminal .pop-text{ flex:0 0 auto; color:var(--text-1,rgba(255,255,255,0.94)); }
  #vx-terminal .vxt-pop-row.sel .pop-text{ color:var(--accent-hover,#b974fa); }
  #vx-terminal .pop-detail{
    flex:1 1 auto; text-align:right; color:var(--text-3,rgba(255,255,255,0.42));
    font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  /* Signature help: which command you are inside and which slot is next. */
  #vx-terminal .vxt-sig{
    display:none; align-items:baseline; gap:7px; flex-wrap:wrap;
    padding:5px 18px; font-size:11.5px;
    background:var(--surface-1,#14141c);
    border-top:1px solid var(--line-1,rgba(255,255,255,0.09));
  }
  #vx-terminal .sig-name{ color:var(--accent-hover,#b974fa); }
  #vx-terminal .sig-part{ color:var(--text-3,rgba(255,255,255,0.42)); }
  #vx-terminal .sig-part.on{
    color:var(--text-1,rgba(255,255,255,0.94));
    border-bottom:1px solid var(--accent,#a855f7);
  }
  #vx-terminal .sig-detail{
    margin-left:auto; color:var(--text-3,rgba(255,255,255,0.42));
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:55%;
  }
  #vx-terminal .vxt-in{
    display:flex; align-items:flex-start; gap:9px; flex-shrink:0;
    padding:11px 18px; background:var(--surface-2,#1c1c26);
    border-top:2px solid var(--hud-border,rgba(255,255,255,0.14));
  }
  #vx-terminal .vxt-caret{
    color:var(--accent,#a855f7); font-weight:700; font-size:13px; line-height:1.55; flex-shrink:0;
  }
  #vx-terminal textarea{
    flex:1; background:transparent; border:none; outline:none; resize:none;
    color:var(--text-1,rgba(255,255,255,0.94));
    font-family:inherit; font-size:13px; line-height:1.55;
    min-height:20px; max-height:180px; overflow-y:auto;
  }
  #vx-terminal .vxt-foot{
    flex-shrink:0; padding:7px 18px; background:var(--surface-1,#14141c);
    border-top:1px solid var(--line-1,rgba(255,255,255,0.09));
    font-size:11px; color:var(--text-3,rgba(255,255,255,0.42));
    display:flex; gap:16px; flex-wrap:wrap;
  }
  #vx-terminal .vxt-foot b{ color:var(--text-2,rgba(255,255,255,0.62)); font-weight:600; }
  #vx-terminal .l-logo{ color:var(--accent-hover,#b974fa); }
  #vx-terminal .l-head{
    color:var(--text-1,rgba(255,255,255,0.94));
    font-family:var(--font-display,'Silkscreen',monospace); font-size:11px; letter-spacing:0.04em;
  }
  #vx-terminal .l-sub{ color:var(--accent-hover,#b974fa); }
  #vx-terminal .l-cmd{ color:var(--text-1,rgba(255,255,255,0.94)); }
  #vx-terminal .l-ok{ color:#59d68c; }
  #vx-terminal .l-err{ color:#e0596a; }
  #vx-terminal .l-hint{ color:var(--text-3,rgba(255,255,255,0.42)); }
  #vx-terminal .l-code{ color:#7fc4e0; }
  /* ── Einfärbung nach TYP ────────────────────────────────────────────────
     Die Farbe eines Befehls sagt, WAS er ist, nicht welcher er ist. Alle
     Ereignisse teilen sich eine Farbe, alle Bedingungen eine, und so weiter.
     Die Zuordnung kommt aus NODE_CATALOG, nicht aus einer Liste hier: eine
     neue Karte bekommt ihre Farbe damit von selbst und kann nicht vergessen
     werden.

     Die vier Kartenarten benutzen bewusst DIESELBEN Farbtöne wie die Karten
     im Editor (siehe .ng-node.k-* in index.html), nur aufgehellt, weil hier
     Text auf dunklem Grund steht statt einer gefüllten Kopfzeile. Was auf dem
     Board grün ist, ist im Terminal grün. */
  #vx-terminal .t-event  { color:#b07cf5; }
  #vx-terminal .t-cond   { color:#ffd54a; }
  #vx-terminal .t-action { color:#7fc4e0; }
  #vx-terminal .t-loop   { color:#4fd07f; }
  #vx-terminal .t-builtin{ color:#f093c8; }
  #vx-terminal .t-mine   { color:#b974fa; font-weight:600; }
  #vx-terminal .t-kw     { color:#e8e4f5; font-weight:600; }
  #vx-terminal .t-var    { color:#ffab6b; }
  #vx-terminal .t-stat   { color:#5fd3c4; }
  #vx-terminal .t-str    { color:#d9c58a; }
  #vx-terminal .t-num    { color:#c9b8ff; }
  #vx-terminal .t-com    { color:rgba(255,255,255,0.32); font-style:italic; }
  #vx-terminal .l-key{ color:var(--accent-hover,#b974fa); }
  #vx-terminal .l-pair{ display:flex; gap:12px; }
  #vx-terminal .l-pair .k{
    color:var(--accent-hover,#b974fa); flex:0 0 auto; min-width:170px;
  }
  #vx-terminal .l-pair .v{ color:var(--text-2,rgba(255,255,255,0.62)); }
  @media (max-width:720px){
    #vx-terminal{ padding:0; }
    #vx-terminal .vxt-win{ height:100%; border:none; }
    #vx-terminal .l-pair{ flex-direction:column; gap:0; }
    #vx-terminal .l-pair .k{ min-width:0; }
  }

  /* ── PLAIN MODE (F9) ────────────────────────────────────────────────────
     For people who want a terminal, not a themed window. Everything removed
     here is decoration: the wordmark, the fake traffic lights, the title bar,
     the accent colour, the blurred backdrop, the key-hint footer and the
     explanatory half of the banner.

     Nothing FUNCTIONAL is removed, and that line is the whole design of this
     mode. The suggestion list stays, the signature bar stays, Tab still
     completes: those are how the terminal is usable at all, and a "simple"
     mode that took them away would just be a worse terminal rather than a
     plainer one. What goes is only what was there to look like something.

     Full-bleed and pure black on purpose: a centred window with a margin is
     itself a decoration, and at this point the screen IS the terminal. */
  #vx-terminal.plain{
    padding:0; background:#000; backdrop-filter:none;
  }
  #vx-terminal.plain .vxt-win{
    width:100%; height:100%; border:none; box-shadow:none; background:#000;
  }
  #vx-terminal.plain .vxt-bar,
  #vx-terminal.plain .vxt-foot{ display:none; }
  /* The verbose half of the banner: logo, the explanation, the worked
     examples. Hidden rather than never printed, so F9 is instant both ways and
     the scrollback a player has already built up survives the switch. */
  #vx-terminal.plain .verbose{ display:none; }
  #vx-terminal.plain .vxt-log,
  #vx-terminal.plain .vxt-in,
  #vx-terminal.plain .vxt-sig{ background:#000; border:none; }
  #vx-terminal.plain .vxt-log{ padding:12px 14px; color:#c8c8c8; }
  #vx-terminal.plain .vxt-in{ padding:6px 14px; border-top:1px solid #262626; }
  #vx-terminal.plain .vxt-caret,
  #vx-terminal.plain .l-logo,
  #vx-terminal.plain .l-sub,
  #vx-terminal.plain .l-key,
  #vx-terminal.plain .sig-name,
  #vx-terminal.plain .l-pair .k{ color:#c8c8c8; }
  /* The three states that still have to be distinguishable at a glance keep a
     colour, because "did that work" is information, not decoration. Muted to
     sit inside a grey scheme rather than shout out of it. */
  #vx-terminal.plain .l-ok{ color:#8fbf8f; }
  #vx-terminal.plain .l-err{ color:#d08c8c; }
  #vx-terminal.plain .l-head{
    color:#e8e8e8; font-family:inherit; font-size:13px; letter-spacing:0;
  }
  #vx-terminal.plain .l-code{ color:#a8a8a8; }
  /* Die Typfarben bleiben auch hier, aus demselben Grund wie OK und ERR
     darüber: welcher Art ein Befehl ist, ist Information und keine
     Verzierung. Stark entsättigt, damit sie in einem grauen Schema sitzen
     statt daraus hervorzuspringen. */
  #vx-terminal.plain .t-event  { color:#a99ab8; }
  #vx-terminal.plain .t-cond   { color:#c0b48a; }
  #vx-terminal.plain .t-action { color:#90a6b0; }
  #vx-terminal.plain .t-loop   { color:#90b89c; }
  #vx-terminal.plain .t-builtin{ color:#bb9aae; }
  #vx-terminal.plain .t-mine   { color:#d0d0d0; }
  #vx-terminal.plain .t-kw     { color:#e8e8e8; }
  #vx-terminal.plain .t-var    { color:#b8a894; }
  #vx-terminal.plain .t-stat   { color:#94b0ac; }
  #vx-terminal.plain .t-str    { color:#b0a88c; }
  #vx-terminal.plain .t-num    { color:#a8a2b8; }
  #vx-terminal.plain .t-com    { color:#6a6a6a; }
  #vx-terminal.plain .pop-kind.k-event,
  #vx-terminal.plain .pop-kind.k-cond,
  #vx-terminal.plain .pop-kind.k-action,
  #vx-terminal.plain .pop-kind.k-loop,
  #vx-terminal.plain .pop-kind.k-builtin,
  #vx-terminal.plain .pop-kind.k-keyword,
  #vx-terminal.plain .pop-kind.k-var{ color:#9a9a9a; }
  #vx-terminal.plain .vxt-pop{
    background:#000; border:1px solid #333; box-shadow:none;
  }
  #vx-terminal.plain .vxt-pop-row{ border-bottom:1px solid #1c1c1c; }
  #vx-terminal.plain .vxt-pop-row.sel{ background:#1e1e1e; }
  #vx-terminal.plain .vxt-pop-row:hover{ background:#161616; }
  #vx-terminal.plain .vxt-pop-row.sel .pop-text,
  #vx-terminal.plain .pop-kind.k-mine,
  #vx-terminal.plain .pop-kind.k-read{ color:#e8e8e8; }
  #vx-terminal.plain .sig-part.on{ color:#e8e8e8; border-bottom:1px solid #666; }`;

  // The wordmark. ANSI Shadow, the same block-letter style every serious CLI
  // greets you with, because the point of a banner is to say "you are in a
  // tool now" before the first line of output does.
  const TERM_LOGO = [
    ' ██╗   ██╗ ██████╗ ██╗  ██╗███████╗██████╗ ██╗ █████╗ ',
    ' ██║   ██║██╔═══██╗╚██╗██╔╝██╔════╝██╔══██╗██║██╔══██╗',
    ' ██║   ██║██║   ██║ ╚███╔╝ █████╗  ██████╔╝██║███████║',
    ' ╚██╗ ██╔╝██║   ██║ ██╔██╗ ██╔══╝  ██╔══██╗██║██╔══██║',
    '  ╚████╔╝ ╚██████╔╝██╔╝ ██╗███████╗██║  ██║██║██║  ██║',
    '   ╚═══╝   ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝'
  ];

  let termEl = null, termLogEl = null, termInputEl = null;
  let termHistory = [];
  let termHistoryPos = -1;
  let termDraft = '';

  function termBuildDom() {
    if (termEl) return;
    const style = document.createElement('style');
    style.textContent = TERM_CSS;
    document.head.appendChild(style);

    termEl = document.createElement('div');
    termEl.id = 'vx-terminal';
    termEl.innerHTML =
      '<div class="vxt-win" role="dialog" aria-label="World Terminal">' +
        '<div class="vxt-bar">' +
          '<div class="vxt-dots"><div class="vxt-dot"></div><div class="vxt-dot"></div><div class="vxt-dot"></div></div>' +
          '<div class="vxt-name">World Terminal</div>' +
          '<div class="vxt-tag">Mod Editor</div>' +
          '<button type="button" class="vxt-x" aria-label="Close the terminal">&#10005;</button>' +
        '</div>' +
        '<div class="vxt-log" id="vxt-log" tabindex="0"></div>' +
        '<div class="vxt-inwrap">' +
          '<div class="vxt-pop" id="vxt-pop" role="listbox" aria-label="Suggestions"></div>' +
          '<div class="vxt-sig" id="vxt-sig"></div>' +
          '<div class="vxt-in">' +
            '<span class="vxt-caret">&gt;</span>' +
            '<textarea id="vxt-input" rows="1" spellcheck="false" autocomplete="off"' +
              ' aria-label="Terminal input"></textarea>' +
          '</div>' +
        '</div>' +
        '<div class="vxt-foot">' +
          '<span><b>Enter</b> run / accept</span>' +
          '<span><b>Shift+Enter</b> new line</span>' +
          '<span><b>Tab</b> complete</span>' +
          '<span><b>Up/Down</b> pick / history</span>' +
          '<span><b>Esc</b> dismiss / close</span>' +
          '<span><b>F9</b> plain mode</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(termEl);

    termLogEl = termEl.querySelector('#vxt-log');
    termInputEl = termEl.querySelector('#vxt-input');
    termPopEl = termEl.querySelector('#vxt-pop');
    termSigEl = termEl.querySelector('#vxt-sig');
    termEl.querySelector('.vxt-x').addEventListener('click', termClose);
    // Clicking the backdrop closes; clicking inside must not. Anywhere in the
    // window that is not itself interactive puts the caret back in the input,
    // which is what a terminal is expected to do.
    termEl.addEventListener('mousedown', e => {
      if (e.target === termEl) { termClose(); return; }
      if (e.target === termLogEl || e.target.closest('.vxt-in')) {
        // Not when text is being selected -- stealing focus mid-drag would
        // cancel the selection the player is making to copy something.
        if (String(window.getSelection() || '') === '') {
          setTimeout(() => termInputEl && termInputEl.focus(), 0);
        }
      }
    });
    termInputEl.addEventListener('input', () => { termAutosize(); termPopRefresh(); });
    // Moving the caret with the mouse or arrows changes which slot is active,
    // so the suggestions have to follow it, not only follow typing.
    termInputEl.addEventListener('click', termPopRefresh);
    termInputEl.addEventListener('blur', () => setTimeout(termPopHide, 120));
    termInputEl.addEventListener('keydown', termKey);
  }

  function termAutosize() {
    termInputEl.style.height = 'auto';
    termInputEl.style.height = Math.min(180, termInputEl.scrollHeight) + 'px';
  }

  // The writer handed to every command. A tiny interface on purpose: a command
  // that wants to draw something the terminal has no verb for is a command that
  // is doing too much.
  // ==========================================================================
  // EINFÄRBUNG DER SKRIPTAUSGABE
  // ==========================================================================
  // Rein für die Anzeige. Bewusst NICHT der echte Lexer aus diesem Modul:
  // der wirft bei kaputter Eingabe, verwirft Leerraum und kennt keine
  // Positionen. Eine Ausgabe darf aber niemals daran scheitern, dass die Zeile,
  // die sie zeigen soll, unvollständig ist. Dieser hier ordnet nur zu und kann
  // nichts kaputt machen.
  //
  // Die Farbe kommt aus NODE_CATALOG über TERM_INDEX, also aus derselben
  // Tabelle, aus der Editor-Palette und Terminal-Befehle stammen. Damit gilt
  // "gleiche Art, gleiche Farbe" strukturell und nicht per Pflege einer Liste.
  const TERM_GRAMMAR_WORDS = new Set(['on', 'block', 'if', 'else', 'and', 'or', 'not']);

  function termEsc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function termWordClass(word) {
    const lw = String(word).toLowerCase();
    if (TERM_GRAMMAR_WORDS.has(lw)) return 't-kw';
    const hit = TERM_INDEX[lw];
    if (hit && NODE_CATALOG[hit.type]) return 't-' + NODE_CATALOG[hit.type].kind;
    if (TERM_BUILTINS[lw]) return 't-builtin';
    try { if (termFindBlock(word)) return 't-mine'; } catch (e) {}
    return null;
  }

  // Kommentar, Zeichenkette, $Name (mit optionaler Klammer), @Messwert, Zahl,
  // Wort. Alles dazwischen bleibt ungefärbt.
  const TERM_TOKEN_RE = new RegExp([
    '(#[^\\n]*)',
    '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')',
    '(\\$[A-Za-z0-9_]+(?:\\[[^\\]]*\\])?)',
    '(@[A-Za-z0-9_]+)',
    '(-?\\d+(?:\\.\\d+)?)',
    '([A-Za-z][A-Za-z0-9_-]*)'
  ].join('|'), 'g');

  function termColorize(line) {
    const src = String(line);
    let out = '', last = 0, m;
    TERM_TOKEN_RE.lastIndex = 0;
    while ((m = TERM_TOKEN_RE.exec(src)) !== null) {
      if (m.index > last) out += termEsc(src.slice(last, m.index));
      const [, com, str, v, stat, num, word] = m;
      let cls = null;
      if (com) cls = 't-com';
      else if (str) cls = 't-str';
      else if (v) cls = 't-var';
      else if (stat) cls = 't-stat';
      else if (num) cls = 't-num';
      else if (word) cls = termWordClass(word);
      out += cls ? '<span class="' + cls + '">' + termEsc(m[0]) + '</span>' : termEsc(m[0]);
      last = m.index + m[0].length;
    }
    if (last < src.length) out += termEsc(src.slice(last));
    return out;
  }

  const io = {
    raw(text, cls) {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = text;
      termLogEl.appendChild(div);
      return div;
    },
    text(t) { this.raw(t, ''); },
    head(t) { this.raw(t, 'l-head'); },
    sub(t)  { this.raw(t, 'l-sub'); },
    ok(t)   { this.raw('OK  ' + t, 'l-ok'); },
    err(t)  { this.raw('ERR ' + t, 'l-err'); },
    hint(t) { this.raw('    ' + t, 'l-hint'); },
    // `code` bleibt ungefärbt: es zeigt auch den geteilten VXG2-Code, und ein
    // eingefärbter Base64-Block wäre Unsinn. Skripte gehen durch `script`.
    code(t) { this.raw(t, 'l-code'); },
    script(t) {
      const div = document.createElement('div');
      div.className = 'l-code';
      // Scheitert die Einfärbung, wird die Zeile trotzdem gezeigt: eine Ausgabe
      // darf nicht daran hängen, dass sie hübsch aussieht.
      try { div.innerHTML = termColorize(t); }
      catch (e) { div.textContent = t; }
      termLogEl.appendChild(div);
      return div;
    },
    blank() { this.raw(' ', ''); },
    pair(k, v) {
      const row = document.createElement('div');
      row.className = 'l-pair';
      const ke = document.createElement('span'); ke.className = 'k'; ke.textContent = k;
      const ve = document.createElement('span'); ve.className = 'v'; ve.textContent = v;
      row.appendChild(ke); row.appendChild(ve);
      termLogEl.appendChild(row);
    },
    clear() { termLogEl.innerHTML = ''; },
    // The banner's explanatory half. Printed exactly like the plain variants
    // above but tagged `verbose`, which is the single hook plain mode (F9)
    // hides. Kept as its own trio rather than an extra argument on text/code/
    // hint, because every OTHER caller of those is command output and must
    // never be hideable — a result that vanishes in one display mode is a bug,
    // not a preference.
    vtext(t) { this.raw(t, 'verbose'); },
    vcode(t) { this.raw(t, 'l-code verbose'); },
    // Die Beispiele im Begrüßungstext. Eingefärbt wie jede andere
    // Skriptausgabe, denn sie sind das Erste, woran jemand die Sprache liest.
    vscript(t) {
      const div = this.script(t);
      div.className = 'l-code verbose';
      return div;
    },
    vhint(t) { this.raw('    ' + t, 'l-hint verbose'); },
    vblank() { this.raw(' ', 'verbose'); },
    vpair(k, v) {
      const row = document.createElement('div');
      row.className = 'l-pair verbose';
      const ke = document.createElement('span'); ke.className = 'k'; ke.textContent = k;
      const ve = document.createElement('span'); ve.className = 'v'; ve.textContent = v;
      row.appendChild(ke); row.appendChild(ve);
      termLogEl.appendChild(row);
    },
    echo(cmd) {
      // Multi-line input is echoed with its own continuation carets so a
      // scrolled-back script still reads as one thing rather than as several
      // unrelated commands.
      //
      // Coloured with the same termColorize() the banner examples and every
      // printed script go through. It used to be flat white, so the moment you
      // pressed Enter the line you had just written stopped looking like the
      // language and the log read as two different things: colourful examples
      // above, plain text below. Same failure mode as io.script -- if the
      // colouring throws, the line is still shown, because an echo must never
      // depend on looking nice.
      const lines = cmd.split('\n');
      lines.forEach((l, i) => {
        const div = document.createElement('div');
        div.className = 'l-cmd';
        const caret = i === 0 ? '> ' : '  ';
        try { div.innerHTML = termEsc(caret) + termColorize(l); }
        catch (e) { div.textContent = caret + l; }
        termLogEl.appendChild(div);
      });
    }
  };

  function termBanner() {
    io.clear();
    for (const row of TERM_LOGO) io.raw(row, 'l-logo verbose');
    io.vblank();
    // The one line that survives plain mode, because it is the only line here
    // that is not decoration: what this is, and where to go next.
    io.raw('World Terminal v2.8   Script access to the mod engine   (F9 plain)', 'l-head');
    io.blank();
    // The paragraph the whole feature stands on. It is here, at the top of
    // every session, because someone opening a terminal in a block game will
    // otherwise reasonably assume it is a cheat console.
    io.vtext('This is the Mod Editor\'s vocabulary as text. Every command below is one of the');
    io.vtext('same blocks the node board offers, so anything you type here can be opened as');
    io.vtext('nodes, and any mod you built there can be read back as script.');
    io.vblank();
    io.vpair('Node board', 'visual, for learning the vocabulary and quick builds');
    io.vpair('Terminal (here)', 'textual, same blocks, faster once you know them');
    io.vblank();
    io.vtext('A bare command runs immediately. An "on" block installs a rule.');
    io.vblank();
    io.vscript('  Give-Item gold 10');
    io.vscript('  BONUS = @depth / 10 + 1');
    io.vscript('  on Mine grass {');
    io.vscript('    if Chance 25 and @depth > 40 {');
    io.vscript('      Give-Item gold ($BONUS * 2)');
    io.vscript('    }');
    io.vscript('  }');
    io.vblank();
    io.vtext('Write the complicated part once and it becomes a command of your own:');
    io.vblank();
    io.vscript('  block MeteorStrike POWER {');
    io.vscript('    repeat 4 { Emit-Particles player orange 20 8 }');
    io.vscript('    Invoke-Shake ($POWER * 3)');
    io.vscript('  }');
    io.vscript('  MeteorStrike 5');
    io.vblank();
    // The readings that see past your own player. Called out by name here
    // because they are the ones nobody guesses exist: every other live value
    // describes you, so a player who has not been told will not think to look
    // for one that describes somebody else.
    io.vtext('A rule can also read the OTHER players in the world, which is what a minigame');
    io.vtext('is built out of:');
    io.vblank();
    io.vscript('  on Timer 1 {');
    io.vscript('    if @nearestplayerdistance <= 3 and @myteam != @nearestplayerteam {');
    io.vscript('      Add-Score 1');
    io.vscript('    }');
    io.vscript('  }');
    io.vblank();
    io.vtext('Not sure how to write one of these? Describe it in plain words instead and');
    io.vtext('the terminal writes the script for you, asking about anything you left open:');
    io.vblank();
    io.vscript('  ask give me 10 gold whenever I mine grass');
    io.vblank();
    io.vhint('Suggestions appear as you type. Tab or Enter takes one, Esc dismisses them.');
    io.vhint('Type "help" for every command, "logic" for your own blocks, "mod open" for nodes.');
    io.vhint('F9 strips this down to a plain black terminal with no banner or chrome.');
    io.blank();
  }

  // ==========================================================================
  // COMPLETION -- what the terminal already knows about what you are typing
  // ==========================================================================
  // The catalog carries a full description of every command: how many
  // parameters, of what kind, and for an enum the exact set of values that slot
  // will accept. All of that is already loaded. Not offering it would mean
  // making the player memorise a table the program is holding in its hand.
  //
  // So this works out WHICH parameter the caret is sitting on and offers that
  // parameter's real values -- block names for a block slot, the enum's own
  // entries for a dropdown, live readings and saved numbers for a number slot.
  // That is the difference between completing words and completing meaning.

  // A whitespace-and-quotes tokeniser for one line, keeping each token's
  // position so the caret can be located among them. Deliberately not termLex:
  // this has to cope with a half-typed line, where an unterminated string is
  // the normal state rather than an error.
  function termLineTokens(line) {
    const out = [];
    let i = 0;
    while (i < line.length) {
      while (i < line.length && /\s/.test(line[i])) i++;
      if (i >= line.length) break;
      const start = i;
      let text = '', quoted = false;
      if (line[i] === '"' || line[i] === "'") {
        const q = line[i]; quoted = true; i++;
        while (i < line.length && line[i] !== q) { text += line[i]; i++; }
        if (i < line.length) i++;
      } else {
        while (i < line.length && !/\s/.test(line[i])) { text += line[i]; i++; }
      }
      out.push({ text, start, end: i, quoted });
    }
    return out;
  }

  // Everything the completer needs to know about the caret's position.
  function termContext() {
    const el = termInputEl;
    const caret = el.selectionStart;
    const upto = el.value.slice(0, caret);
    const lineStart = upto.lastIndexOf('\n') + 1;
    const line = upto.slice(lineStart);
    const col = caret - lineStart;

    const toks = termLineTokens(line);
    // The token the caret is inside or immediately after; otherwise we are
    // starting a fresh one.
    let idx = -1;
    for (let i = 0; i < toks.length; i++) {
      if (col > toks[i].start && col <= toks[i].end) { idx = i; break; }
    }
    const onFresh = idx < 0;
    const frag = onFresh ? '' : toks[idx].text.slice(0, col - toks[idx].start - (toks[idx].quoted ? 1 : 0));
    const fragStart = onFresh ? col : toks[idx].start;
    const pos = onFresh ? toks.length : idx;

    // Where the current statement begins. A grammar word does not only occur at
    // the start of a line: `if Chance 30 and ` puts one in the middle, and
    // everything after it is a fresh condition rather than more arguments for
    // Chance. Scanning for the LAST one before the caret is what makes the
    // suggestions after `and` as good as the ones after `if`.
    let boundary = -1;
    for (let i = 0; i < Math.min(pos, toks.length); i++) {
      const w = toks[i].text.toLowerCase();
      if (w === '{' || w === '}' || w === 'else' || w === 'on' || w === 'if' ||
          w === 'while' || w === 'and' || w === 'or' || w === 'not') {
        boundary = i;
      }
    }
    const leadWord = boundary >= 0 ? toks[boundary].text.toLowerCase() : '';
    const headAt = boundary + 1;
    const headTok = toks[headAt];
    const head = headTok ? headTok.text : '';

    // How deep in braces the caret sits, counted over the whole input rather
    // than the current line: an event can only ever start a chain, so once we
    // are inside any block it is the one thing that must NOT be offered, and
    // the brace that opened the block is usually on an earlier line.
    let depth = 0;
    for (const ch of upto) { if (ch === '{') depth++; else if (ch === '}') depth--; }

    return { line, col, toks, frag, fragStart, pos, headAt, head, leadWord, onFresh,
             depth: Math.max(0, depth) };
  }

  // The parameter spec the caret is currently filling, if any.
  function termActiveSpec(ctx) {
    if (!ctx.head || ctx.pos <= ctx.headAt) return null;
    const hit = TERM_INDEX[ctx.head.toLowerCase()] ||
                (termFindBlock(ctx.head)
                  ? { type: 'callSignal', pin: { signal: termBlockKey(ctx.head) } } : null);
    if (!hit) return null;
    const def = NODE_CATALOG[hit.type];
    if (!def) return null;
    const pinned = hit.pin || {};
    const specs = def.params.filter(s => !Object.prototype.hasOwnProperty.call(pinned, s.k));

    // Walk the tokens between the command and the caret the same way
    // termBuildParams consumes them, so the slot named here is the slot the
    // compiler would actually fill.
    let slot = 0;
    const named = new Set();
    for (let i = ctx.headAt + 1; i < ctx.pos; i++) {
      const t = ctx.toks[i].text;
      if (/^-[A-Za-z]/.test(t)) {
        const key = t.slice(1).toLowerCase();
        named.add(key);
        i++;                                  // its value belongs to it
        continue;
      }
      slot++;
    }
    // Typing the value of an explicit -Name.
    const prev = ctx.toks[ctx.pos - 1];
    if (prev && /^-[A-Za-z]/.test(prev.text)) {
      const key = prev.text.slice(1).toLowerCase();
      const s = specs.find(x => x.k.toLowerCase() === key) ||
                def.params.find(x => x.k.toLowerCase() === key);
      return s ? { spec: s, def, hit, specs, index: specs.indexOf(s) } : null;
    }
    let n = 0, chosen = null;
    for (const s of specs) {
      if (named.has(s.k.toLowerCase())) continue;
      if (n === slot) { chosen = s; break; }
      n++;
    }
    return chosen ? { spec: chosen, def, hit, specs, index: specs.indexOf(chosen) } : null;
  }

  // Values that make sense in one particular slot. This is the part that turns
  // "a list of words" into "the answer".
  function termSlotValues(spec, params) {
    const out = [];
    const quote = v => /[^A-Za-z0-9_.]/.test(v) ? '"' + v + '"' : v;

    if (spec.kind === 'enum') {
      for (const v of graphSpecList(spec, params || {})) {
        out.push({ text: quote(v), label: v, detail: 'option' });
      }
      return out;
    }
    if (spec.kind === 'block') {
      if (spec.allowEmpty) out.push({ text: 'air', label: 'air', detail: 'empty' });
      for (const [enumName, id] of Object.entries(BLOCKS)) {
        if (NON_ITEM_BLOCK_IDS.has(id)) continue;
        out.push({ text: enumName.toLowerCase(), label: enumName.toLowerCase(),
                   detail: blockNames[id] || 'block' });
      }
      const base = typeof CUSTOM_BLOCK_ID_BASE !== 'undefined' ? CUSTOM_BLOCK_ID_BASE : 200;
      for (const b of termBlockTable()) {
        if (b.id < base || NON_ITEM_BLOCK_IDS.has(b.id)) continue;
        out.push({ text: '"' + b.label + '"', label: b.label, detail: 'your block' });
      }
      return out;
    }
    if (spec.kind === 'value' || spec.kind === 'num') {
      const r = graphSpecRange(spec, params || {});
      // The plain number first: it is what a number slot gets filled with
      // nine times out of ten, and burying it under ten live readings would
      // make the common case the slowest one.
      out.push({ text: String(r.def), label: String(r.def), detail: 'default (' + r.min + ' to ' + r.max + ')' });
      if (spec.kind === 'value') {
        const allowed = spec.sources || VALUE_SOURCE_KEYS;
        if (allowed.includes(VALUE_NONE)) out.push({ text: 'none', label: 'none', detail: 'leave empty' });
        for (const k of Object.keys(graphVars || {})) {
          if (/^_T\d+$/.test(k)) continue;
          out.push({ text: '$' + k, label: '$' + k, detail: 'saved = ' + graphVars[k] });
        }
        for (const s of GRAPH_STATS) {
          out.push({ text: termStatToken(s), label: termStatToken(s), detail: s });
        }
      }
      return out;
    }
    if (spec.kind === 'textvalue') {
      for (const k of Object.keys(graphTexts || {})) {
        out.push({ text: '&' + k, label: '&' + k, detail: 'saved text = “' + graphTexts[k] + '”' });
      }
      return out;
    }
    if (spec.kind === 'varname') {
      for (const k of Object.keys(graphVars || {})) {
        if (/^_T\d+$/.test(k)) continue;
        out.push({ text: k, label: k, detail: 'saved = ' + graphVars[k] });
      }
      // A name slot on a text card names a TEXT, so the texts already in play
      // are the useful suggestions there, not the numbers above.
      for (const k of Object.keys(graphTexts || {})) {
        out.push({ text: k, label: k, detail: 'saved text = “' + graphTexts[k] + '”' });
      }
      return out;
    }
    if (spec.kind === 'creature') {
      for (let i = 0; i < 4; i++) out.push({ text: String(i), label: String(i), detail: 'creature slot' });
      return out;
    }
    return out;
  }

  // Every command that may start a statement here, described.
  function termCommandPool(wantKind) {
    const out = [];
    const seen = new Set();
    for (const v of Object.values(TERM_INDEX)) {
      const def = NODE_CATALOG[v.type];
      if (wantKind && def.kind !== wantKind) continue;
      if (seen.has(v.name)) continue;
      seen.add(v.name);
      out.push({ text: v.name, label: v.name, detail: def.label, kind: def.kind });
    }
    // The player's own blocks rank alongside the built-in commands, because to
    // the person typing there is no difference.
    for (const key of Object.keys(termBlocks)) {
      const d = termBlocks[key];
      if (wantKind && wantKind !== 'action') continue;
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      const live = termBlockActive(key);
      out.push({ text: d.name, label: d.name,
                 detail: (live ? 'your block' : 'your block (switched off)') + termBlockSig(d),
                 kind: 'mine' });
    }
    if (!wantKind) {
      for (const k of Object.keys(TERM_BUILTINS)) {
        const b = TERM_BUILTINS[k];
        if (seen.has(b.name)) continue;
        seen.add(b.name);
        out.push({ text: b.name, label: b.name, detail: b.desc, kind: 'builtin' });
      }
      for (const w of ['on', 'block', 'if', 'else', 'repeat', 'while', 'foreach', 'forlist']) {
        out.push({ text: w, label: w, detail: 'keyword', kind: 'keyword' });
      }
    }
    return out;
  }

  // The ranked list for wherever the caret is.
  function termSuggestions(ctx) {
    const frag = ctx.frag;
    let pool = [];

    if (frag.startsWith('@')) {
      pool = GRAPH_STATS.map(s => ({ text: termStatToken(s), label: termStatToken(s), detail: s, kind: 'read' }));
    } else if (frag.startsWith('$')) {
      pool = Object.keys(graphVars || {}).filter(k => !/^_T\d+$/.test(k))
        .map(k => ({ text: '$' + k, label: '$' + k, detail: 'saved = ' + graphVars[k], kind: 'var' }));
    } else if (frag.startsWith('-')) {
      const act = termActiveSpec(ctx);
      const hit = TERM_INDEX[String(ctx.head).toLowerCase()];
      const def = act ? act.def : (hit ? NODE_CATALOG[hit.type] : null);
      if (def) {
        pool = def.params.map(s => ({ text: '-' + s.k, label: '-' + s.k,
                                      detail: termSpecSummary(s), kind: 'param' }));
      }
    } else if (ctx.pos <= ctx.headAt) {
      // The command itself. After `on` only events can follow, after
      // `if`/`while`/`and`/`or`/`not` only conditions -- offering anything else
      // there would be offering a guaranteed error.
      const w = ctx.leadWord;
      const wantKind = w === 'on' ? 'event'
                     : (w === 'if' || w === 'while' || w === 'and' || w === 'or' || w === 'not') ? 'cond'
                     : null;
      pool = termCommandPool(wantKind);
      // Inside a block, the things that can only ever start one are noise.
      if (!wantKind && ctx.depth > 0) {
        pool = pool.filter(p => p.kind !== 'event' &&
                                !(p.kind === 'keyword' && (p.text === 'on' || p.text === 'block')));
      }
      // With nothing typed the order IS the answer, so it follows what is
      // actually likely here: inside a block you are almost always about to do
      // something, at the top level you are almost always about to start a
      // rule. Catalog order decides within a group, because that order was
      // chosen to read well in the editor's palette.
      if (!wantKind) {
        const rank = ctx.depth > 0
          ? { mine: 0, action: 1, loop: 2, cond: 3, keyword: 4, builtin: 5 }
          : { event: 0, keyword: 1, mine: 2, action: 3, loop: 4, cond: 5, builtin: 6 };
        pool = pool.map((p, i) => ({ p, i }))
                   .sort((a, b) => (rank[a.p.kind] ?? 9) - (rank[b.p.kind] ?? 9) || a.i - b.i)
                   .map(x => x.p);
      }
    } else {
      const act = termActiveSpec(ctx);
      if (act) {
        pool = termSlotValues(act.spec, {}).map(v => Object.assign({ kind: 'value' }, v));
      } else if (ctx.leadWord === 'if' || ctx.leadWord === 'while' || ctx.leadWord === 'and' ||
                 ctx.leadWord === 'or' || ctx.leadWord === 'not') {
        // Inside a comparison rather than a command's arguments: `if $SCORE > `
        // has no parameter spec to consult, but the two things that can go
        // there are still perfectly well known.
        for (const k of Object.keys(graphVars || {})) {
          if (/^_T\d+$/.test(k)) continue;
          pool.push({ text: '$' + k, label: '$' + k, detail: 'saved = ' + graphVars[k], kind: 'var' });
        }
        for (const s of GRAPH_STATS) {
          pool.push({ text: termStatToken(s), label: termStatToken(s), detail: s, kind: 'read' });
        }
      }
    }

    if (!pool.length) return [];
    const lower = frag.toLowerCase();
    if (!lower) return pool.slice(0, 40);
    const starts = [], contains = [];
    for (const p of pool) {
      const t = p.text.toLowerCase().replace(/^["']/, '');
      if (t.startsWith(lower)) starts.push(p);
      else if (t.includes(lower)) contains.push(p);
    }
    const byLen = (a, b) => a.text.length - b.text.length || a.text.localeCompare(b.text);
    return starts.sort(byLen).concat(contains.sort(byLen)).slice(0, 40);
  }

  // The line above the input: which command you are in and which of its
  // parameters the caret is on. Borrowed straight from an IDE's signature help,
  // because "what does this one want next" is the question that actually slows
  // a person down.
  function termSignature(ctx) {
    if (!ctx.head || ctx.pos <= ctx.headAt) return null;
    const custom = termFindBlock(ctx.head);
    const hit = TERM_INDEX[ctx.head.toLowerCase()];
    if (!hit && !custom) return null;
    const act = termActiveSpec(ctx);
    if (custom) {
      // Which value the caret is on, so a three-parameter block highlights the
      // one being typed rather than always the first.
      const ps = termBlockParams(custom);
      const at = act ? act.index : 0;
      return { name: custom.name,
               parts: ps.map((pn, i) => ({ text: '<' + String(pn).toLowerCase() + '>', active: i === at })),
               detail: 'your block' };
    }
    const specs = act ? act.specs
      : NODE_CATALOG[hit.type].params.filter(s => !(hit.pin &&
          Object.prototype.hasOwnProperty.call(hit.pin, s.k)));
    return {
      name: hit.name,
      parts: specs.map((s, i) => ({ text: '<' + s.k + '>', active: !!act && i === act.index })),
      detail: act ? termSpecSummary(act.spec) : NODE_CATALOG[hit.type].label
    };
  }

  // ── The popup ─────────────────────────────────────────────────────────────
  let termPopEl = null, termSigEl = null;
  let termPopItems = [];
  let termPopSel = 0;
  let termPopOpen = false;

  function termPopHide() {
    termPopOpen = false;
    termPopItems = [];
    if (termPopEl) {
      // Emptied, not just hidden: a hidden list still holding the previous
      // suggestions is a list that flashes the wrong answers for one frame the
      // next time it opens.
      termPopEl.innerHTML = '';
      termPopEl.style.display = 'none';
    }
    if (termSigEl) termSigEl.style.display = 'none';
  }

  // Recomputed on every keystroke. Cheap enough: the pools are a few hundred
  // short strings and the filtering is a prefix test.
  function termPopRefresh() {
    if (!termPopEl) return;
    const ctx = termContext();

    const sig = termSignature(ctx);
    if (sig) {
      termSigEl.innerHTML = '';
      const name = document.createElement('span');
      name.className = 'sig-name';
      name.textContent = sig.name;
      termSigEl.appendChild(name);
      for (const part of sig.parts) {
        const s = document.createElement('span');
        s.className = 'sig-part' + (part.active ? ' on' : '');
        s.textContent = part.text;
        termSigEl.appendChild(s);
      }
      const d = document.createElement('span');
      d.className = 'sig-detail';
      d.textContent = sig.detail || '';
      termSigEl.appendChild(d);
      termSigEl.style.display = 'flex';
    } else {
      termSigEl.style.display = 'none';
    }

    // Silent on a blank statement with nothing to go on: dropping the entire
    // vocabulary over the screen the moment the box is focused would be noise,
    // not help. After `on` or `if` there IS something to go on, so the filtered
    // list appears straight away -- that moment is the whole point of knowing
    // what the player is about to write.
    const blankStart = !ctx.frag && ctx.pos <= ctx.headAt && !ctx.leadWord;
    const items = blankStart ? [] : termSuggestions(ctx);
    // A single suggestion identical to what is already typed is not a
    // suggestion, it is a restatement.
    if (!items.length || (items.length === 1 && items[0].text.toLowerCase() === ctx.frag.toLowerCase())) {
      termPopHide();
      return;
    }
    termPopItems = items;
    termPopSel = 0;
    termPopDraw();
    termPopOpen = true;
    termPopEl.style.display = 'block';
  }

  function termPopDraw() {
    termPopEl.innerHTML = '';
    termPopItems.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'vxt-pop-row' + (i === termPopSel ? ' sel' : '');
      const k = document.createElement('span');
      k.className = 'pop-kind k-' + (it.kind || 'value');
      k.textContent = ({ event: 'evt', cond: 'if', action: 'act', loop: 'loop',
                         builtin: 'cmd', keyword: 'key', param: 'arg', mine: 'mine',
                         read: 'read', var: 'num' })[it.kind] || 'val';
      const t = document.createElement('span');
      t.className = 'pop-text';
      t.textContent = it.label;
      const d = document.createElement('span');
      d.className = 'pop-detail';
      d.textContent = it.detail || '';
      row.appendChild(k); row.appendChild(t); row.appendChild(d);
      // mousedown, not click: click fires after the textarea has already lost
      // focus, which would put the caret nowhere.
      row.addEventListener('mousedown', e => { e.preventDefault(); termPopSel = i; termPopAccept(); });
      termPopEl.appendChild(row);
    });
    const sel = termPopEl.querySelector('.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  function termPopMove(delta) {
    if (!termPopOpen || !termPopItems.length) return false;
    termPopSel = (termPopSel + delta + termPopItems.length) % termPopItems.length;
    termPopDraw();
    return true;
  }

  function termPopAccept() {
    if (!termPopOpen || !termPopItems.length) return false;
    const pick = termPopItems[termPopSel];
    const ctx = termContext();
    const el = termInputEl;
    const lineStart = el.value.slice(0, el.selectionStart).lastIndexOf('\n') + 1;
    const from = lineStart + ctx.fragStart;
    const to = el.selectionStart;
    // A trailing space only where something else is expected next, so accepting
    // the last argument does not leave a dangling one.
    el.setRangeText(pick.text + ' ', from, to, 'end');
    termPopHide();
    termAutosize();
    // The next slot's suggestions, immediately. This is what makes filling in a
    // command feel like being led through it rather than like guessing twice.
    termPopRefresh();
    return true;
  }

  function termScroll() { termLogEl.scrollTop = termLogEl.scrollHeight; }

  function termKey(e) {
    // Nothing typed in here may reach the game: the document keydown handler
    // bails on a focused INPUT but this is a TEXTAREA in a modal, and letting
    // W/A/S/D through would walk the player around behind the terminal.
    e.stopPropagation();

    // F9 strips the window down to a plain terminal. Handled before every
    // other key and without touching the input, so it works mid-line: this is
    // a display preference, not an edit, and pressing it should never cost the
    // half-typed command in front of you.
    if (e.key === 'F9') { e.preventDefault(); termTogglePlain(); return; }

    // Escape dismisses the suggestions first and the terminal only if there
    // were none: closing the whole window because somebody wanted the list gone
    // is the single most annoying thing an editor can do.
    if (e.key === 'Escape') {
      e.preventDefault();
      if (termPopOpen) { termPopHide(); return; }
      termClose();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (termPopOpen) { termPopAccept(); return; }
      termPopRefresh();
      if (termPopOpen) termPopAccept();
      return;
    }
    // While the list is up the arrows belong to it. History is still one press
    // away, because the list is gone as soon as it has nothing to offer.
    if (termPopOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      termPopMove(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter takes the highlighted suggestion rather than running a
      // half-typed line, matching every editor people already use.
      if (termPopOpen) { e.preventDefault(); termPopAccept(); return; }
      e.preventDefault();
      const src = termInputEl.value;
      if (!src.trim()) return;
      termPopHide();
      io.echo(src);
      termHistory.push(src);
      termHistoryPos = -1;
      termDraft = '';
      termInputEl.value = '';
      termAutosize();
      try { termExecute(src, io); }
      catch (err) {
        io.err('Unexpected failure: ' + (err && err.message ? err.message : String(err)));
        console.error('Voxeria Terminal:', err);
      }
      io.blank();
      termScroll();
      return;
    }

    // History only when the caret is on the first/last line, so arrow keys
    // still navigate a multi-line script the way they should.
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      const upto = termInputEl.value.slice(0, termInputEl.selectionStart);
      if (upto.includes('\n')) return;
      if (!termHistory.length) return;
      e.preventDefault();
      if (termHistoryPos === -1) { termDraft = termInputEl.value; termHistoryPos = termHistory.length; }
      termHistoryPos = Math.max(0, termHistoryPos - 1);
      termInputEl.value = termHistory[termHistoryPos];
      termAutosize();
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey) {
      if (termHistoryPos === -1) return;
      const after = termInputEl.value.slice(termInputEl.selectionStart);
      if (after.includes('\n')) return;
      e.preventDefault();
      termHistoryPos++;
      if (termHistoryPos >= termHistory.length) {
        termHistoryPos = -1;
        termInputEl.value = termDraft;
      } else {
        termInputEl.value = termHistory[termHistoryPos];
      }
      termAutosize();
      return;
    }

    // Typing a closing brace on a line of its own outdents it, so a pasted or
    // hand-typed block ends up looking like the examples rather than drifting
    // right. Small thing; it is the difference between a text box and a tool.
    if (e.key === '}') {
      const upto = termInputEl.value.slice(0, termInputEl.selectionStart);
      const line = upto.slice(upto.lastIndexOf('\n') + 1);
      if (/^\s\s+$/.test(line)) {
        e.preventDefault();
        const cut = termInputEl.selectionStart - 2;
        termInputEl.setRangeText('}', cut, termInputEl.selectionStart, 'end');
        termAutosize();
      }
    }
  }

  // ── Plain mode ────────────────────────────────────────────────────────────
  // Remembered across sessions, because it is a statement about how somebody
  // wants to work rather than a per-visit choice: a player who strips the
  // chrome once should not have to strip it again every time they open this.
  //
  // Stored under the same voxeria_ prefix the rest of the game's settings use.
  // A blocked or full localStorage (private windows, some embedded contexts)
  // must not stop the terminal from opening at all, hence the try/catch on
  // both ends: the worst case is that the preference does not stick.
  const TERM_PLAIN_KEY = 'voxeria_terminal_plain';
  let termPlain = false;
  try { termPlain = localStorage.getItem(TERM_PLAIN_KEY) === '1'; } catch (e) { termPlain = false; }

  function termApplyPlain() {
    if (termEl) termEl.classList.toggle('plain', termPlain);
  }
  function termTogglePlain() {
    termPlain = !termPlain;
    termApplyPlain();
    try { localStorage.setItem(TERM_PLAIN_KEY, termPlain ? '1' : '0'); } catch (e) { /* preference just won't stick */ }
    // Said out loud, and in the log rather than as a toast: in plain mode the
    // footer that would otherwise advertise F9 is gone, so this line is the
    // only thing telling somebody how to get back.
    io.hint(termPlain ? 'Plain mode on. F9 brings the full terminal back.'
                      : 'Full terminal. F9 strips it down again.');
    termScroll();
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  let termOpen = false;

  function termShow() {
    // The same gate every other creator tool uses (see vxCreatorBlocks): the
    // terminal edits a world, and a Normal run is a fixed one. Not a separate
    // rule of its own, so a mode that later becomes creative-capable opens this
    // door too without anyone remembering to update it here.
    if (typeof vxCreatorAllowed === 'function' && !vxCreatorAllowed()) {
      if (typeof vxCreatorDenied === 'function') vxCreatorDenied();
      return;
    }
    termBuildDom();
    termOpen = true;
    termEl.classList.add('open');
    // Before the banner, so a plain-mode session never flashes the wordmark on
    // its way to hiding it.
    termApplyPlain();
    if (!termLogEl.childNodes.length) termBanner();
    termScroll();
    // One frame, for the same reason toggleCommandConsole waits one: focusing
    // in the same tick as the class change can lose the keystroke that opened
    // this on some browsers.
    requestAnimationFrame(() => { termInputEl.focus(); termAutosize(); });
  }

  function termClose() {
    if (!termEl) return;
    termOpen = false;
    termEl.classList.remove('open');
    termInputEl.blur();
    // Covers: open the editor, use its own ">_ Terminal" button, type a new
    // rule, close the terminal -- back on the editor, which should already
    // show it rather than needing a second, separate trip through "mod open".
    termSyncBoardVisibility();
  }

  function termToggle() {
    if (termOpen) termClose(); else termShow();
  }

  // Ctrl+T. Captured at the document level rather than added to the engine's
  // own keydown handler, because that one returns early on a focused INPUT and
  // the terminal has to be closeable from inside itself.
  document.addEventListener('keydown', e => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key !== 't' && e.key !== 'T') return;
    e.preventDefault();
    e.stopPropagation();
    termToggle();
  }, true);

  // F9, for when the terminal is open but the caret is not in the input --
  // after clicking into the log to select something, say. termKey already
  // covers the normal case; this covers the rest, and is gated on the terminal
  // actually being open so F9 stays free for the game everywhere else.
  document.addEventListener('keydown', e => {
    if (e.key !== 'F9' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!termOpen) return;
    // Skipped when the textarea has focus: termKey handles it there, and
    // running both would toggle twice and land back where it started.
    if (document.activeElement === termInputEl) return;
    e.preventDefault();
    e.stopPropagation();
    termTogglePlain();
  }, true);

  window.toggleWorldTerminal = termToggle;
  window.VxTerminal = {
    open: termShow,
    close: termClose,
    plain: termTogglePlain,
    // Exposed for the same reason modSelfTest() is: a language with a compiler
    // in it should be checkable from the console without a UI in the way.
    run: (src) => { termBuildDom(); termExecute(String(src), io); termScroll(); },
    compile: (src) => termCompile(termParse(termLex(String(src)))),
    decompile: termDecompile
  };

  // The palette group is rebuilt every time the editor opens, not only when a
  // block is defined: ngInit builds the rail lazily on first open, so a group
  // injected before that would be dropped, and the terminal can define a block
  // while the editor has never been opened at all.
  // The board's own dry-run and node tooltips describe a "Call by name" card by
  // its raw signal. Once that signal is a block the player named, saying
  // `Call by name "METEORSTRIKE"` instead of `MeteorStrike` is the editor
  // forgetting a name the player just gave it. Wrapped rather than edited into
  // voxeria-modding.js so removing this file removes the behaviour with it.
  const _origDescribeNode = window.ngDescribeNode;
  if (typeof _origDescribeNode === 'function') {
    window.ngDescribeNode = function (node) {
      if (node && node.type === 'callSignal') {
        const def = termFindBlock(node.params.signal);
        if (def) {
          // All three passing slots, not just the first: a call that hands over
          // three values should not read on the board as if it handed over one.
          const passed = [node.params.arg, node.params.arg2, node.params.arg3]
            .map(termValueToText).filter(t => t !== 'none');
          return 'Your block "' + def.name + '"' + (passed.length ? ', with ' + passed.join(' and ') : '') +
                 (termBlockActive(def.key) ? '' : '  (not active, so this does nothing)');
        }
      }
      return _origDescribeNode.apply(this, arguments);
    };
  }

  const _origToggleModEditor = window.toggleModEditor;
  if (typeof _origToggleModEditor === 'function') {
    window.toggleModEditor = function () {
      const r = _origToggleModEditor.apply(this, arguments);
      const modal = document.getElementById('mod-editor-modal');
      if (modal && modal.classList.contains('open')) { termRefreshPalette(); termSyncBoardVisibility(); }
      return r;
    };
  }

  // A button in the Mod Editor's own header, added from here so index.html
  // stays unaware of this file. Placed next to the close button because that
  // is where the editor's window-level controls already live.
  document.addEventListener('DOMContentLoaded', () => {
    // Read back before anything can ask what blocks exist. Needs VxPieces,
    // which voxeria-modding.js sets up at file scope, so DOMContentLoaded is
    // comfortably late enough.
    termLoadBlocks();

    const head = document.querySelector('#mod-editor-modal .ae-head');
    const close = document.getElementById('close-mod-editor-top');
    if (!head || !close) return;
    const btn = document.createElement('button');
    btn.id = 'open-world-terminal';
    btn.type = 'button';
    btn.textContent = '>_ Terminal';
    btn.title = 'Write this mod as script instead (Ctrl+T)';
    btn.style.cssText =
      'background:var(--surface-2,#1c1c26);border:1px solid rgba(168,85,247,0.5);' +
      'color:var(--accent-hover,#b974fa);font-family:var(--font-mono,monospace);' +
      'font-size:12px;padding:5px 10px;cursor:pointer;margin-left:auto;';
    btn.addEventListener('click', () => {
      // Whatever is on the board comes with you. Without this the button would
      // be a link to an empty prompt, and the claim that the two are one system
      // would be something the player has to take on faith.
      if (typeof ngGraph !== 'undefined' && ngGraph && ngGraph.nodes && ngGraph.nodes.length) {
        termBuildDom();
        if (!termLogEl.childNodes.length) termBanner();
        io.raw('# ' + (ngGraph.name || 'the board') + ', as script', 'l-hint');
        for (const line of termDecompile(ngGraph).split('\n')) io.script(line);
        io.blank();
      }
      termShow();
    });
    close.parentNode.insertBefore(btn, close);
  });
})();
