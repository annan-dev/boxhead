# Boxhead quality rubric

The critic scores the game after every change against this sheet. The scale
is absolute and anchored, so a score is comparable across loops: a dimension
moves only when something in the game changed that a player could feel, and
every move must cite the evidence (a screenshot, a test, a diff hunk, a
measured number). The overall score is the weighted mean.

## Scale (every dimension)

| Score | Meaning |
|---|---|
| 1-2 | Broken or absent. A player would quit over it. |
| 3-4 | Present but clearly flawed; noticeably worse than a decent free web game. |
| **5** | Functional and unremarkable. **Anything below 5 is bad.** |
| 6 | Solid. Works, a few rough edges a player would mention. |
| 7 | Good. On par with a well-made indie release; nothing a reviewer would dock. |
| 8 | Excellent. Only nits remain; a critic would call it out as a strength. |
| 9 | Best in class for the genre. Hard to name a peer that does it better. |
| 10 | Perfection. Nothing to add or remove. |

Half points are allowed. A dimension cannot gain more than 1.0 in one loop
unless a whole feature that was absent (scored 3 or less) has been added.

## Dimensions and weights

| # | Dimension | Weight | What is judged |
|---|---|---|---|
| 1 | Core feel and controls | 1.5 | Movement, aim, fire response, weapon switching, input latency, camera. Does the character do what the hand asks, immediately, every time? |
| 2 | Feedback and juice | 1.2 | Hit flashes, shove, blood, shake, popups, muzzle flash, kill and multiplier feedback, low-health signals, death. Is every action answered? |
| 3 | Readability and clarity | 1.2 | Can the player always tell where threats are, what they hold, how hurt they are, what the multiplier is about to do, where a placeable will land, what is off screen in a large arena? |
| 4 | Visual polish and consistency | 1.0 | Art, HUD, menus, effects, decals, one visual language across all of it. No stale or mismatched screens. |
| 5 | Audio | 1.0 | Sound design coverage (every action has a sound), mix, positional audio, music where it belongs, nothing grating or missing. |
| 6 | Onboarding and UX flow | 1.0 | First minute: does a new player know what to do? Hints, how-to-play, menu navigation, keyboard and mouse both work, nothing dead-ends. |
| 7 | Difficulty curve and pacing | 1.0 | Waves, awards, downtime, difficulty presets. Tense but fair; no dead air, no cheap deaths, stragglers cannot stall a run. |
| 8 | Progression and replayability | 1.0 | Unlocks, high scores, run stats, reasons to play again, variety between runs and rooms. |
| 9 | Spirit of the original | 0.8 | Feels like Boxhead 2Play: the multiplier ladder, the weapons, the boxy art, the sound, the arena layouts. Departures are deliberate and documented. |
| 10 | Performance and robustness | 1.2 | Frame time at a full wave, memory, no bugs found in a play session, tests pass, determinism kept, edge cases (resize, focus loss, reload). |
| 11 | Multiplayer | 0.7 | Lobby flow, prediction quality, reconnect, deathmatch and co-op rules, clarity of who is who. |
| 12 | Accessibility and options | 0.6 | Rebinding or alternate keys, gamepad, volume controls, colour choices, text size, pause anywhere, settings persist. |

## Out of scope, by the owner's decision

These are not gaps to fill. Do not propose them as fixes, do not score their
absence, and do not add them back:

- **Local two-player on one screen.** No second seat on the keyboard or pad, no
  shared-screen camera or tether, no per-seat HUD strips, tips or heartbeat, no
  room-screen toggle, no local deathmatch. Playing together is online only
  (the lobby, co-op and deathmatch over a server). This was added in loops
  9-14 and removed on 2026-09-08 at the owner's request.

## Procedure

1. Read the previous entry in `SCORES.md` and the commits since it (`git log`).
2. Run the tests (`npm test`) and note the result.
3. Run `node tools/playtest.mjs --url http://localhost:5180/ --out <dir>` and look
   at every screenshot; read `results.json` for sim/draw timings and the bot's
   outcome.
4. Run `node tools/playtest.mjs --url http://localhost:5180/ --out <dir> --fairness 3`
   and read `fairness.json`: median seconds survived per preset by the bot.
   Compare with the previous loop's numbers when judging pacing; a preset
   the bot cannot survive is not by itself unfair (the bot is no expert),
   but a change in the numbers is a change in the curve.
5. Run `node tools/playtest.mjs --url http://localhost:5180/ --out <dir> --coop`,
   which starts a real server, joins it from two headless browsers, readies
   and starts the match and drives both seats for a few seconds. Look at
   `coop-lobby.png`, `coop-host.png` and `coop-guest.png`, and read `coop.json`
   for each client's round trip, unacknowledged commands and corrections, and
   its `reconnect` block: the guest's socket is closed mid-wave and the seat it
   came back to, its state and the ticks it went on to simulate are reported.
6. Read whatever code the change touched, and play-read the paths it affects.
7. Score every dimension. Copy the previous score unless you can cite what
   changed it. Cite the evidence next to each score.
8. List the three highest-value fixes for the next loop, ranked by expected
   score gain per hour of work, each with the dimension it targets.
9. Append the entry to `SCORES.md` in the format used there.
