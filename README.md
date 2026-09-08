# Boxhead

A from-scratch web recreation of *Boxhead 2Play* (Sean T. Cooper, 2008), rebuilt
from the original SWF because Flash has been dead since 2021 and the file is
inert on a modern machine.

```bash
npm install
npm run dev                           # http://localhost:5173
npm start                             # a multiplayer server on :8787
```

Playing together on one screen, as the original's 2Play did: tick **two
players on this screen** when choosing a room. Player 2 takes the gamepad, or
the arrow keys with Enter to fire, and the two of you share one screen, one
score and one multiplier, never more than a screen apart.

Playing together online: one person runs `npm start` and shares the address the
server prints, everyone else opens the game, picks **Multiplayer**, and types
it in, the way a Minecraft server works. See [Multiplayer](#multiplayer).

**Controls** — `WASD` move, mouse aim, click or `space` fire, `1`-`0` weapons,
`Q`/`E` or mouse wheel cycle, `P` quick pause, `Esc` pause menu (resume, restart, options,
quit), `R` restart while paused, `M` mute, `F3` stats. Every key but the weapon numbers can be
rebound in Options, and a standard gamepad works everywhere: sticks move and aim, trigger
fires, bumpers cycle, Start pauses, d-pad and A drive the menus.

## Assets

The art, animation and audio are the original author's copyrighted work,
recovered from the SWF by `npm run extract -- boxhead2play.swf` into
`assets/`. The SWF itself is never committed. The extracted art is, so that
the GitHub Pages build can bake it into the single-file client; the renderer
takes art through an interface, so a redrawn asset set can be dropped in
instead if that ever becomes necessary.

Besides the world art the extractor also writes `bitmaps/screens.json`: the
title logo, one icon per arena and the four character portraits, all lifted
from the original's own menu screens. The menus use them when present and draw
their own stand-ins when not.

## Progression, as the original does it

The game logic classes inside the SWF are control-flow obfuscated: each class
is a jump state machine whose real code is reached through jumps into the
bytes of neighbouring tags, which Flash Player never bounds-checked. Following
the flow across the whole movie recovers every constructor and method, and the
tables in `packages/shared/src/data` are those numbers, converted from the
original's 25Hz ticks and 32px cells.

The design that fell out of it is not what a level-based recreation assumes:

- **Upgrades are awarded by the score multiplier, never by level.** Every kill
  raises the multiplier by one; it drains one step at a time on a window that
  shrinks from three seconds at x1 to a tenth of a second at x100. Each weapon
  and upgrade sits at a threshold (x5 UZI, x10 Shotgun, x15 Barrel, x20
  Grenade, x30 Fake Walls, x40 Claymore, x50 Rocket, x55 Chargepack, x70
  Railgun, on to x125) and is kept once reached.
- **Levels only scale the wave**: 5n+5 zombies, spawning one a second at
  level 1 and near-instantly by level 25, at most 60 alive; devils from level 2;
  every creature moves at 1 + n/10 times its base pace, capped at five.
- **Health regenerates**, fully in thirty seconds. Crates drop on every fifth
  kill of a quick streak and from every devil, and refill one weapon (never
  the pistol); a hurt player may draw "Life up!" instead.
- **Bullets are hitscan**, the shotgun is three near-parallel rays, grenades
  charge while held and lob, mines beep for two seconds once tripped, charge
  packs alternate between placing and detonating on each press, and a blast
  hurts you as much as them. Every hit shoves and stuns whatever it lands on,
  a bite included. Big Bang and Bigger Bang are not a wider blast but two or
  three more full blasts a cell out; Cluster Explode lobs four shells.
- **Zombies never attack objects.** A barricade or barrel is a wall to them;
  they path around it or wait. Only devils raze what stands in their way, and
  bullets, blasts and fireballs wear a fake wall down by their damage. Mines
  and charge packs are immune to everything but their own trigger.
- **Options** are the original's: Difficulty (Beginner / Intermediate / Expert /
  Nightmare) starts the run at level 1/10/20/35 with multiplier 1/10/30/50 and
  every award below it banked; Game Speed (Slow / Normal / Fast) runs the whole
  simulation at half, normal or double pace, exactly as the original scaled its
  logic rate, while the multiplier window and crate timers stay in real
  seconds as the original's did; Devils can be switched off. The original's
  Collisions, Damage and game-count settings only concern its two-player modes
  and are not ported.

### Where this port departs from the original on purpose

- Aim follows the mouse; the original faced the movement keys only.
- Teammates' fire is harmless in co-op (the original's Damage option, on by
  default, lets players hurt each other in every mode).
- Enemies steer freely over a flow field rather than stepping cell to cell
  with turn pauses, and crowds are kept apart by a separation force.
- Arenas unlock by reaching level 4 in the one before; the original's only
  lock was site exclusivity. Slow speed disqualifies a high score here.
- A wave whose stragglers cannot be reached advances after a grace period;
  the original waits forever.
- Placed objects go one cell ahead with an outline, and are refused where a
  body stands; the original dropped them at the gun hand and grew them
  solid once the player stepped off.

To compare feel directly, run the SWF in [Ruffle](https://ruffle.rs) beside
this build.

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

## Multiplayer

The simulation in `packages/shared` is deterministic and headless, so the same
code runs in the browser and on the server. The server is authoritative: it
owns the world, consumes one command per player per tick, and broadcasts
snapshots about seventeen times a second. Each client predicts ahead by
stepping its own copy with its own inputs, and on every snapshot restores the
server's state and replays the commands the server has not consumed yet, so
your own character answers instantly and the server still has the last word.
Other players' inputs are unknown between snapshots and are guessed from what
they were last seen doing; the correction, when it comes, slides over a tick
rather than snapping. Sounds you caused play at once; everyone else's, along
with score popups and banners, arrive as events from the server.

Up to four seats per room, co-op or deathmatch, chosen by the host (the first
to arrive) in a lobby. A dropped connection holds your seat for a minute and
reconnects on its own; closing the tab and opening the game again within that
time lands you back in the same seat. `F3` shows round trip, unacknowledged commands and
corrections next to the frame timings.

### Hosting a server

```bash
npm ci
npm start            # or: PORT=9000 npm start
```

Node 20 or newer. The server prints every address it is reachable on; share
one with players on your network. For players elsewhere, forward the port on
your router or put everyone on a VPN such as Tailscale. `/health` on the same
port lists rooms. The server also serves the game itself at `/`, so
`http://<address>:8787` is all a player needs to open.

### Joining

Open the game, choose **Multiplayer**, type the address (`host`, `host:port`,
or a full `ws://` URL) and a name. A link of the form
`boxhead.html?server=host:port` opens straight to that screen with the address
filled in.

### The single-file client and GitHub Pages

`npm run build:single` writes `packages/client/dist/boxhead.html`: the whole
game with its art baked in, which runs from a double-click on the file, from
any static host, or served by the game server. The Pages workflow publishes it
at the site root and as a download.

One thing to know: browsers will not let a page served over HTTPS (which is
all GitHub Pages offers) open a plain `ws://` connection to somebody's
computer. The Pages copy is playable on its own and can join servers behind
`wss://`, but to join an ordinary server, download `boxhead.html` from the
site and open it from disk. The multiplayer screen says so when it applies.

## Verifying

```bash
npm test          # determinism, soak, snapshot round-trip, progression, regressions
npm run bench     # headless load test to level 30
npm run build     # typecheck + production bundle
npm run build:single   # the self-contained boxhead.html
npm start         # authoritative server on :8787, /health for status
```

`npm test` includes the networking: two headless clients over real sockets
that must restore identical state from every snapshot, and a mirror that
restores a snapshot and replays its own inputs and must match the server's
hash every time. Anything added to the world that is left out of the snapshot
fails there.

`npm run dev` resolves `@boxhead/shared` straight from its sources, so a change
to the simulation hot-reloads without a rebuild; `npm run build` compiles the
package first and bundles against that.

The determinism test is the one that matters most; it should fail loudly the
moment anything in `shared` reads the clock or reaches for `Math.random`. The
regression tests pin the behaviours that used to break runs: a fake wall can
never be built on top of a body, a refused placement costs no ammo, grenades
always explode, the railgun pierces everything on its line, and bodies and
barrels are solid.

Rendering caches every character pose it has drawn as a bitmap at the current
zoom, so a full late wave costs a few `drawImage` calls per puppet rather than
hundreds of polygon fills. `F3` shows the cache size alongside frame timings.

## Status

Playable: all ten weapons with their original numbers on their original keys,
the multiplier-driven award ladder and banner text recovered from the
bytecode, zombies with flow-field navigation that will chew through a
barricade when the detour is long enough, devils, explosive barrels that block
movement, mines, chain reactions, endless wave progression, the four difficulty
presets, persistent blood and scorch, and positional audio from the original
samples. Bodies are solid: a crowd presses against you and a line of barrels
is a fence.

Menus, a pause menu, arena select with the original level icons, character
select with the original portraits, per-arena high scores and progressive
unlocks are all in.

Online multiplayer: an authoritative server, client-side prediction and
reconciliation, a lobby with co-op and deathmatch, reconnection, and a
single-file client that runs from anywhere.

Not done yet: split-screen local co-op on one keyboard.
