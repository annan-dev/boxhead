/**
 * Entry point: loads the extracted art, builds a world, and runs the game.
 *
 * The simulation lives in @boxhead/shared and knows nothing about the browser.
 * This module owns everything the simulation must not: the canvas, the clock,
 * input devices, and drawing.
 */
import {
  ROOMS,
  TICK_MS,
  World,
  emptyCommand,
  type ArtPack,
  type RoomDef,
} from '@boxhead/shared';
import { Loop } from './loop/Loop.js';
import { Input } from './input/Input.js';
import { Camera } from './render/Camera.js';
import { GameRenderer } from './render/GameRenderer.js';
import { Hud } from './ui/Hud.js';
import { AudioEngine, SOUND_NAMES } from './audio/AudioEngine.js';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #07080a; overflow: hidden; }
    body { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #dfe3e8; }
    #view { display: block; width: 100vw; height: 100vh; cursor: crosshair; }
    #boot { position: fixed; inset: 0; display: grid; place-content: center; gap: 10px;
            text-align: center; background: #07080a; }
    #boot h1 { margin: 0; font-size: 15px; letter-spacing: .3em; color: #8b939e;
               text-transform: uppercase; }
    #boot p { margin: 0; color: #6f7883; max-width: 460px; line-height: 1.6; }
    #boot code { color: #ffd88a; }
    #help { position: fixed; left: 16px; top: 14px; color: #6f7883; line-height: 1.7;
            pointer-events: none; text-shadow: 0 1px 2px #000; }
    #help b { color: #aab2bd; }
    #help.hidden { display: none; }
  </style>
  <canvas id="view"></canvas>
  <div id="help">
    <b>WASD</b> move &nbsp; <b>mouse</b> aim &nbsp; <b>click / space</b> fire<br>
    <b>1-0</b> weapon &nbsp; <b>Q/E</b> cycle &nbsp; <b>P</b> pause &nbsp; <b>R</b> restart<br>
    <b>M</b> mute &nbsp; <b>F3</b> stats &nbsp; <b>H</b> hide this
  </div>
  <div id="boot"><h1>Boxhead</h1><p>Loading art&hellip;</p></div>
`;

/**
 * Roughly how much arena to keep on screen, in world units. These set how
 * zoomed-in the game feels; the camera covers the canvas with whichever axis
 * needs the larger scale.
 */
const VIEW_WORLD_WIDTH = 720;
const VIEW_WORLD_HEIGHT = 460;

const canvas = app.querySelector<HTMLCanvasElement>('#view')!;
const ctx = canvas.getContext('2d', { alpha: false })!;
const boot = app.querySelector<HTMLDivElement>('#boot')!;
const help = app.querySelector<HTMLDivElement>('#help')!;

let pack: ArtPack;
try {
  const response = await fetch('art.json');
  if (!response.ok) throw new Error(String(response.status));
  pack = (await response.json()) as ArtPack;
} catch {
  boot.innerHTML = `
    <h1>Boxhead</h1>
    <p>The art pack is missing. Extract it from your own copy of the SWF:</p>
    <p><code>npm run extract -- boxhead2play.swf</code></p>
    <p>Assets are never committed to the repository.</p>`;
  throw new Error('art.json is unavailable');
}
boot.remove();

const room: RoomDef = ROOMS[0]!;
let world = new World({ room, seed: Date.now() & 0xffff, playerCount: 1 });
let renderer = new GameRenderer(world, pack, room.floorStyle ?? 'concrete');
let hud = new Hud(world);
const camera = new Camera(canvas.width, canvas.height, world.map.width, world.map.height);
const input = new Input(canvas);

const audio = new AudioEngine();
void audio.init(SOUND_NAMES);
// Browsers will not start an AudioContext until the player interacts.
const unlock = (): void => {
  audio.resume();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

/** Cheap noise source for cosmetic ambience; never touches the simulation. */
let ambienceSeed = 0x1a2b3c;
const ambienceRandom = (): number => {
  ambienceSeed = (Math.imul(ambienceSeed, 1664525) + 1013904223) >>> 0;
  return ambienceSeed / 4294967296;
};

let paused = false;
let showStats = false;
/** Rolling average of simulation cost, for the F3 overlay. */
let stepAverage = 0;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // The element can measure zero before the first layout, which would make the
  // camera scale non-finite; fall back until real dimensions arrive.
  const cssWidth = canvas.clientWidth || window.innerWidth || 960;
  const cssHeight = canvas.clientHeight || window.innerHeight || 540;
  const width = Math.max(320, Math.round(cssWidth * dpr));
  const height = Math.max(240, Math.round(cssHeight * dpr));
  if (canvas.width === width && canvas.height === height) return;

  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingEnabled = false;
  camera.resize(width, height, VIEW_WORLD_WIDTH, VIEW_WORLD_HEIGHT);
}
window.addEventListener('resize', resize);
// Layout can settle after the module runs, so track the element itself.
new ResizeObserver(resize).observe(canvas);
resize();

const player0 = world.players[0];
if (player0) camera.jumpTo(player0.x, player0.y);

function restart(): void {
  world = new World({ room, seed: Date.now() & 0xffff, playerCount: 1 });
  renderer = new GameRenderer(world, pack, room.floorStyle ?? 'concrete');
  hud = new Hud(world);
  const player = world.players[0];
  if (player) camera.jumpTo(player.x, player.y);
  paused = false;
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyR') restart();
  if (event.code === 'F3') {
    event.preventDefault();
    showStats = !showStats;
  }
  if (event.code === 'KeyH') help.classList.toggle('hidden');
  if (event.code === 'KeyM') audio.toggleMute();
});

const loop = new Loop(
  {
    step: () => {
      if (input.consumePause()) paused = !paused;
      if (paused || world.gameOver) return;

      // The pointer aims in world space, so it must be unprojected first.
      const aim = camera.screenToWorld(input.pointerX, input.pointerY);
      const player = world.players[0];
      const command = player ? input.buildCommand(aim.x, aim.y) : emptyCommand();
      world.step([command]);

      const target = world.players[0];
      if (target) camera.follow(target.x, target.y);

      // The simulation raises sound requests; playback happens here so the
      // simulation itself stays headless.
      const listener = { x: camera.x, y: camera.y, halfWidth: camera.viewWidth / 2 };
      for (const event of world.sounds) {
        audio.play(event.name, event.x, event.y, event.rate, listener);
      }
      world.sounds.length = 0;
      audio.updateAmbience(world.enemies.length, listener, ambienceRandom);
      stepAverage = stepAverage * 0.9 + loop.stepMs * 0.1;
    },
    draw: (alpha) => {
      camera.interpolate(alpha);
      renderer.draw(ctx, camera, alpha);
      hud.draw(ctx, camera);

      if (paused) {
        ctx.fillStyle = 'rgba(8,9,12,0.6)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = '700 30px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillStyle = '#e8ecf1';
        ctx.textAlign = 'center';
        ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2);
        ctx.textAlign = 'left';
      }

      if (showStats) drawStats();
    },
  },
  TICK_MS,
);

function drawStats(): void {
  const lines = [
    `tick        ${world.tick}`,
    `steps/frame ${loop.lastSteps}`,
    `sim         ${stepAverage.toFixed(2)} ms`,
    `draw        ${loop.drawMs.toFixed(2)} ms`,
    `enemies     ${world.enemies.length}`,
    `shots       ${world.shots.length}`,
    `effects     ${world.effects.length}`,
    `decals      ${world.decals.length}`,
    `objects     ${world.placeables.length}`,
  ];
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(10, canvas.height - 20 - lines.length * 14, 190, lines.length * 14 + 10);
  ctx.fillStyle = '#9fe6b0';
  lines.forEach((line, i) => {
    ctx.fillText(line, 18, canvas.height - 22 - (lines.length - 1 - i) * 14);
  });
}

// Development-only hooks. Vite drops this branch from production builds, so
// the game never ships an object that reaches into its own internals.
if (import.meta.env.DEV) {
(window as unknown as Record<string, unknown>).__game = {
    get world() { return world; },
    camera,
    loop,
    get paused() { return paused; },
    get renderer() { return renderer; },
    /**
     * Drive the game without requestAnimationFrame, for automated checks in
     * environments that report the document as hidden and throttle rAF.
     */
    debugRun(steps: number, opts: { moveX?: number; moveY?: number; fire?: boolean; aim?: [number, number]; slot?: number | null } = {}) {
      for (let i = 0; i < steps; i++) {
        const command = emptyCommand();
        command.moveX = opts.moveX ?? 0;
        command.moveY = opts.moveY ?? 0;
        command.fire = opts.fire ?? false;
        command.weaponSlot = i === 0 ? (opts.slot ?? null) : null;
        const aim = opts.aim;
        const target = world.players[0];
        command.aimX = aim ? aim[0] : (target ? target.x + 100 : 0);
        command.aimY = aim ? aim[1] : (target ? target.y : 0);
        world.step([command]);
        world.sounds.length = 0;
        const follow = world.players[0];
        if (follow) camera.follow(follow.x, follow.y);
      }
      camera.interpolate(0);
      renderer.draw(ctx, camera, 0);
      hud.draw(ctx, camera);
      return { tick: world.tick, enemies: world.enemies.length, kills: world.kills, score: world.score, level: world.level };
    },
  };
}

loop.start();
