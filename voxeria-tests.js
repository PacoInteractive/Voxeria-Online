// ============================================================================
// VOXERIA -- SELF TEST
// ----------------------------------------------------------------------------
// One command that answers "did my last change break something": open the
// game, open the console, type
//
//   voxeriaSelfTest()
//
// It runs in seconds and needs no build step, no runner and no network. Same
// shape as modSelfTest() in voxeria-modding.js and worldGenSelfTest() in
// voxeria-worldgen.js, which it also calls, so there is one place to look
// rather than three to remember.
//
// It ships with the build ON PURPOSE. The whole reason it exists is a bug that
// was only ever wrong in a finished zip: the BOOT intro drew itself correctly
// under an opaque black cover, so the game logic was right and the player saw
// nothing. A test that can only run against a working copy would not have
// caught that. This one can be run inside the artifact you are about to
// upload.
//
// TWO KINDS OF CHECK, and the split matters:
//
//   * Logic  -- a sentence goes into `ask`, an exact script has to come out.
//               These catch thinking errors, and they are cheap to add: one
//               line per case.
//   * Visible -- the DOM after the fact. These catch "the code was right and
//               the player still saw nothing", which is a failure no logic
//               test can see. There are only a few of them because each one
//               has to be thought of and written by hand.
//
// WHAT THIS IS NOT: it does not play the game. Feel, balance, progression,
// performance and anything about multiplayer are outside it. Green here means
// "nothing I checked regressed", never "the game is fine".
//
// ADDING A CASE: put one line in ASK_CASES. `say` is what a player types, one
// entry per line including the answers to any questions; `want` is the script
// the draft has to be, with whitespace collapsed. Nothing is ever confirmed
// with "yes", so the suite never installs a rule or touches a world.
// ============================================================================

(function () {
  'use strict';

  // Every case here is a bug that actually happened, kept as the shape that
  // exposed it. That is why the list looks arbitrary: it is a scar record, not
  // a feature list.
  const ASK_CASES = [
    { name: 'rule with an item and a block',
      say: ['ask give me 10 gold whenever I mine grass'],
      want: 'on Mine grass { Give-Item gold_ore 10 }' },

    // The trigger has to be read from the clause the rule word is in. Searched
    // over the whole sentence, "touch" and "hurt" tie and this became a
    // pointless question.
    { name: 'trigger comes from the "when" half',
      say: ['ask when i touch grass, hurt me', '2'],
      want: 'on Touch grass { Hurt-Player 2 }' },

    // "if" counts as a rule word, and a creature slot is a bare number rather
    // than a quoted string.
    { name: '"if ... then ..." is a rule, creature slot is a number',
      say: ['ask if i touch grass then spawn my creature', '0'],
      want: 'on Touch grass { Spawn-Creature 0 }' },

    // Two things asked for in one sentence have to become two commands, and
    // each has to keep its own block instead of both grabbing the first one.
    { name: 'two items in one sentence',
      say: ['ask give me 100 obsidian and 100 gold', '64', '64'],
      want: 'Give-Item obsidian 64 Give-Item gold_ore 64' },

    { name: 'a list separated by commas',
      say: ['ask gib mir 10 gold, 5 eisen und 3 kohle'],
      want: 'Give-Item gold_ore 10 Give-Item iron_ore 5 Give-Item coal_ore 3' },

    // The chance must not eat the amount: "manchmal 2 kohle" has no percentage
    // in it, so the chance is asked for and the 2 stays with the coal.
    { name: 'a chance without a percentage leaves the amount alone',
      say: ['ask wenn ich stein abbaue gib mir manchmal 2 kohle', '25'],
      want: 'on Mine stone { if Chance 25 { Give-Item coal_ore 2 } }' },

    // And the other direction: a number written as a percentage belongs to the
    // chance, never to the amount.
    { name: 'a percentage goes to the chance',
      say: ['ask gib mir 3 gold wenn ich springe mit 40% chance'],
      want: 'on Jump { if Chance 40 { Give-Item gold_ore 3 } }' },

    // "seconds" also names the Timer event. Without a rule word the action the
    // player actually named has to win.
    { name: 'a named action beats an event it merely mentions',
      say: ['ask warte 0.5 sekunden'],
      want: 'Wait-Seconds 0.5' },

    { name: 'every N seconds',
      say: ['ask alle 5 sekunden heile mich um 2'],
      want: 'on Timer 5 { Heal-Player 2 }' },

    { name: 'the take spelling of the give block',
      say: ['ask nimm mir 5 gold weg'],
      want: 'Take-Item gold_ore 5' },

    // The rule word sits in the last clause, which still has to contribute its
    // own item rather than being swallowed by the trigger.
    { name: 'rule word in the last clause, both items survive',
      say: ['ask gib mir 10 gold und 5 eisen wenn ich springe'],
      want: 'on Jump { Give-Item gold_ore 10 Give-Item iron_ore 5 }' },

    { name: 'a bare command with no trigger',
      say: ['ask heile mich um 4'],
      want: 'Heal-Player 4' },

    // Answering "which one did you mean?" used to throw away everything the
    // sentence said after the ambiguity, so the trigger vanished.
    { name: 'answering an ambiguity keeps the rest of the sentence',
      say: ['ask zeig ein panel wenn ich springe', '2', 'INFO', 'show', 'top right', 'Status'],
      want: 'on Jump { Show-Panel INFO show "top right" "Status" }' }
  ];

  function flat(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  function logEl() { return document.getElementById('vxt-log'); }

  // Runs one case and hands back what the draft ended up being, plus anything
  // the terminal reported as an error while getting there.
  function runAsk(lines) {
    const log = logEl();
    log.innerHTML = '';
    for (const line of lines) window.VxTerminal.run(line);
    const script = [].slice.call(log.querySelectorAll('.l-code'))
      .map(d => d.textContent.trim()).join(' ');
    const errors = [].slice.call(log.querySelectorAll('.l-err'))
      .map(d => d.textContent.trim());
    const notes = log.textContent;
    // Never leave a half-answered question behind for the next case.
    window.VxTerminal.run('cancel');
    return { script: flat(script), errors: errors, notes: notes };
  }

  function voxeriaSelfTest() {
    const fails = [];
    const skipped = [];
    let checks = 0;

    if (!window.VxTerminal || typeof window.VxTerminal.run !== 'function') {
      console.log('❌ voxeriaSelfTest: VxTerminal is missing, nothing could be checked.');
      return ['VxTerminal missing'];
    }

    // The terminal DOM has to exist before anything can be read back out of
    // it, and whatever the player already had in the log is put back at the
    // end: a self test that wipes your session is a test you stop running.
    window.VxTerminal.open();
    const log = logEl();
    const savedLog = log ? log.innerHTML : '';

    try {
      // -- logic ------------------------------------------------------------
      for (const c of ASK_CASES) {
        checks++;
        let got;
        try { got = runAsk(c.say); }
        catch (e) { fails.push(c.name + ': threw ' + (e && e.message ? e.message : e)); continue; }
        if (got.script !== flat(c.want)) {
          fails.push(c.name + '\n      wanted: ' + flat(c.want) + '\n      got:    ' + (got.script || '(nothing)'));
        } else if (got.errors.length) {
          // The right script, reported as broken, is still a bug: the draft is
          // offered for running only when it compiles.
          fails.push(c.name + ': the script was right but the terminal reported "' + got.errors[0] + '"');
        }
      }

      // A number the sentence stated and the slot cannot take has to be
      // explained rather than silently dropped, or the question reads as if
      // nothing had been said.
      checks++;
      const explained = runAsk(['ask give me 100 obsidian']);
      if (explained.notes.indexOf('You said 100') < 0) {
        fails.push('a rejected number is not explained back to the player');
      }

      // -- visible ------------------------------------------------------------
      // The BOOT intro used to draw itself under this cover, so the logic was
      // right and the screen was black.
      //
      // The invariant is not "the cover is gone" but "once a frame has been
      // drawn, the cover is gone" -- that is exactly what the fix promises,
      // and stating it that way is what keeps the check from lying in both
      // directions. A cover still up before the loop has run at all is not a
      // bug, it is the loading screen doing its job; a cover still up after
      // frames have been drawn is the bug, whatever the clock says. And once
      // index.html's own 15s fallback has fired there is no longer any way to
      // tell who removed it, so past that point the honest answer is "cannot
      // tell" rather than a pass.
      checks++;
      const cover = document.getElementById('early-loading-hint');
      const drawn = (typeof frameCount === 'number') ? frameCount : 0;
      if (cover && drawn > 0) {
        fails.push('the black loading cover is still up after ' + drawn +
                   ' drawn frame(s) -- whatever is on the canvas is invisible underneath it');
      } else if (cover) {
        skipped.push('loading cover: the game loop has not drawn a frame yet, so there is nothing to hide behind it');
      } else if (performance.now() > 15000) {
        skipped.push('loading cover: the page has been open past the 15s fallback in index.html, so it can no longer be told whether the intro removed the cover or the fallback did -- reload and re-run to check this one');
      }

      // Typed input used to echo as flat white, so the moment you pressed
      // Enter your own line stopped looking like the language.
      checks++;
      const input = document.getElementById('vxt-input');
      if (!input) {
        fails.push('the terminal input is missing');
      } else {
        log.innerHTML = '';
        input.value = 'help';   // a builtin, so it colours, and it changes nothing
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const echoed = log.querySelector('.l-cmd');
        if (!echoed) fails.push('typing a command did not echo it into the log');
        else if (!echoed.querySelector('span')) fails.push('the echoed command line is not coloured');
      }
    } finally {
      if (log) log.innerHTML = savedLog;
    }

    // -- the two older self tests, so there is one command to remember -------
    let nested = 0;
    if (typeof window.modSelfTest === 'function') {
      checks++;
      const modFails = window.modSelfTest() || [];
      nested += modFails.length;
      if (modFails.length) fails.push('modSelfTest reported ' + modFails.length + ' problem(s), listed above');
    } else {
      skipped.push('modSelfTest is not loaded');
    }
    if (typeof window.worldGenSelfTest === 'function') {
      checks++;
      // It prints its own verdict; a thrown error is the only thing that would
      // otherwise go unnoticed here.
      try { window.worldGenSelfTest(); }
      catch (e) { fails.push('worldGenSelfTest threw: ' + (e && e.message ? e.message : e)); }
    } else {
      skipped.push('worldGenSelfTest is not loaded');
    }

    console.log(fails.length
      ? '❌ voxeriaSelfTest: ' + fails.length + ' problem(s) out of ' + checks + ' checks'
      : '✅ voxeriaSelfTest passed (' + checks + ' checks)');
    fails.forEach(f => console.log('   ' + f));
    skipped.forEach(s => console.log('   (skipped) ' + s));
    return fails;
  }

  window.voxeriaSelfTest = voxeriaSelfTest;
})();
