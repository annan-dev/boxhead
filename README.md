# Boxhead

A from-scratch web recreation of *Boxhead 2Play* (Sean T. Cooper, 2008), rebuilt
from the original SWF because Flash has been dead since 2021 and the file is
inert on a modern machine.

```bash
npm install
npm run extract -- boxhead2play.swf   # rebuild the art from your own copy
npm run dev                           # http://localhost:5173
```

**Controls** — `WASD` move, mouse aim, click or `space` fire, `1`-`0` weapons,
`Q`/`E` cycle, `P` pause, `R` restart, `M` mute, `Esc` menu, `F3` stats.

## Assets

The art, animation and audio are the original author's copyrighted work. They
are **not** in this repository and never will be: `npm run extract` rebuilds
them locally from a SWF you supply, into a gitignored `assets/` directory. The
renderer takes art through an interface, so a redrawn asset set can be dropped
in if this ever needs to be distributed.

## Layout

```
packages/shared    the entire simulation - headless and deterministic
packages/client    Vite + TypeScript: rendering, input, audio, HUD
packages/server    Node + ws authoritative server
packages/extract   SWF -> JSON/PNG/MP3 asset pipeline
```

### The load-bearing decision

**The whole simulation lives in `packages/shared` and is pure.** No DOM, no
canvas, no `window`, no wall-clock reads, no `Math.random`. It runs on a fixed
20ms step (the original's 50fps) with a seeded xorshift128+ generator, so the
same seed and the same inputs always produce the same world.

That single constraint is what makes online multiplayer a feature rather than a
rewrite. The same module runs in the browser for single player today and on the
server as the authority tomorrow, with clients predicting against it. Input is
already commands, ticks are already numbered, state is already serialisable, and
`npm test` asserts a restored snapshot keeps simulating in lockstep with the
world it came from.

### Tick order

`sim/World.ts` runs a fixed phase list, and that list is the only description of
what happens when:

```
nav -> spawn -> players -> enemies -> movement -> separation -> shots
    -> placeables -> affects -> pickups -> effects -> score -> prune
```

Two orderings are deliberate. Weapons *queue* fire requests and spawn them in a
later phase, so iteration is never invalidated mid-pass. Explosions queue their
area effects for the *following* tick, which bounds chain reactions and
reproduces the original's staggered chain-explosion rhythm.

## The arenas

All 18 rooms are the originals. Each `ROOM_Single_*` symbol is a MovieClip whose
timeline places the level: a floor plate, a set of `Piece.*` blocks, and
`World_Init_*` markers giving the player start, zombie and devil spawns, barrels,
pickups and destructible walls. The extractor reads those placements, so the
layouts are the real ones rather than approximations.

Each block carries a pure-blue region in the source art. That is the author's
footprint marker -- the ground the block occupies -- and it is what collision is
rasterised from, with the rest of the geometry giving the height it stands at.

Arenas unlock by reaching level 4 in the one before, and high scores, unlocks
and settings persist in `localStorage`.

## How the art works

The characters are not sprites. 4.64 MB of the 6.47 MB SWF is a single
ActionScript data block — 93,506 `InitArray` and 24,305 `InitObject` opcodes
over 732,808 numeric literals — describing articulated 2.5D vector puppets
exported from Softimage XSI.

`packages/extract` runs the AVM1 stack machine to reconstruct that graph, then
emits 40 animation clips as flat polygons with per-face materials and shading.
The renderer draws them with `Path2D`, so the art is resolution-independent and
the four playable skins are material overrides rather than separate assets —
exactly how the original did it.

A character is composed at draw time from layers: a base `Player` body, an
optional head overlay (`Zombie`, `Devil`), and a weapon-arm overlay carrying its
own muzzle anchor. That is why one rig covers every creature in the game.

## Verifying

```bash
npm test          # determinism, soak, snapshot round-trip, progression
npm run build     # typecheck + production bundle
npm run server    # authoritative server on :8787, /health for status
```

`packages/shared/test/bench.ts` plays headless to level 30 and measures the tick
cost. Current numbers: **0.42 ms mean, 2.1 ms worst, 140 concurrent enemies** —
roughly 48x headroom against the 20ms budget, so the renderer is the limit, not
the simulation.

The determinism test is the one that matters most; it should fail loudly the
moment anything in `shared` reads the clock or reaches for `Math.random`.

## Status

Playable: all ten weapons on their original keys, the upgrade table and banner
text recovered from the bytecode, zombies with flow-field navigation that will
chew through a barricade when the detour is long enough, devils, explosive
barrels, mines, chain reactions, the multi-kill score multiplier, endless wave
progression, persistent blood and scorch, and positional audio from the original
samples.

Menus, arena select with generated minimaps, character select with live-rendered
portraits, per-arena high scores and progressive unlocks are all in.

Not done yet: split-screen co-op and deathmatch, and the netcode itself —
prediction and reconciliation on top of the server that already runs.
