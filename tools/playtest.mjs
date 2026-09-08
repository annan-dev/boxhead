#!/usr/bin/env node
/**
 * Headless playtest and screenshot harness.
 *
 * Drives the dev build in headless Chrome over the DevTools protocol, walks a
 * list of scenarios (title screen, each menu, an early wave, a late wave, the
 * pause overlay, the debrief) and writes one PNG per scenario, so a reviewer
 * can look at the real game without a hand on the mouse.
 *
 *   node tools/playtest.mjs --url http://localhost:5180 --out shots [scenario ...]
 *
 * Scenarios come from the SCENARIOS table below; with none named, all run.
 * Needs the dev server (the `__game` hooks exist only there).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = opt('url', 'http://localhost:5180/');
const out = opt('out', 'shots');
const width = Number(opt('width', 1280));
const height = Number(opt('height', 720));
/** `--fairness N`: instead of screenshots, play N bot runs per difficulty and report how long each lasted. */
const fairnessRuns = Number(opt('fairness', 0));
/** `--coop`: start a game server, join it from two pages, and screenshot the lobby and a shared wave. */
const coop = args.includes('--coop');
/** `--room N`: the room the fairness runs play (zero-based; the first room by default). */
const fairnessRoom = Number(opt('room', 0));
const FLAGS = new Set(['--url', '--out', '--width', '--height', '--fairness', '--room']);
const wanted = args.filter((a, i) => !a.startsWith('--') && !FLAGS.has(args[i - 1]));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));
if (!CHROME) throw new Error('no Chrome or Edge found');

/**
 * Each scenario is a script run inside the page. `bot(ticks)` plays the game
 * for that many simulation ticks with a simple kiting AI; `menu(screen)` opens
 * a menu screen; `run(roomIndex, difficulty)` starts a run.
 */
const SCENARIOS = {
  title: `menu('title')`,
  rooms: `menu('rooms')`,
  character: `menu('character')`,
  options: `menu('options')`,
  howto: `menu('instructions')`,
  multiplayer: `menu('multiplayer')`,
  'game-start': `run(0, 'beginner'); bot(150)`,
  'game-early': `run(0, 'beginner'); bot(1500)`,
  'game-mid': `run(2, 'intermediate'); bot(2500)`,
  'game-late': `run(5, 'expert'); bot(3000)`,
  'game-nightmare': `run(8, 'nightmare'); bot(2500)`,
  pause: `run(0, 'beginner'); bot(600); menu('pause')`,
  'quick-pause': `run(0, 'beginner'); bot(600); quickPause()`,
  debrief: `run(0, 'nightmare'); bot(6000, { suicide: true }); await debrief()`,
  latency: `run(0, 'beginner'); return latency()`,
  // The widest room, so the camera has room to lean and the arena's edge does not clamp it.
  lead: `run(4, 'beginner'); return lead()`,
  'shared-tips': `shared('coop'); run(0, 'beginner'); bot(200); return { tip: g.debugTip(1) }`,
  'low-health': `run(0, 'beginner'); bot(300); lowHealth(40)`,
  'low-health-shared': `shared('coop'); run(0, 'beginner'); bot(300); lowHealth(40, 1)`,
  'shared-coop': `shared('coop'); run(0, 'beginner'); await drive(['ArrowRight'], 60); bot(900); await drive(['ArrowLeft'], 40)`,
  'shared-deathmatch': `shared('deathmatch'); run(0, 'beginner'); await drive(['ArrowUp'], 60); bot(300)`,
};

const HELPERS = `
  const g = window.__game;
  function menu(screen) { g.menus.show(screen); }
  function run(roomIndex, difficulty) {
    g.save.setDifficulty(difficulty);
    const room = g.rooms[Math.min(roomIndex, g.rooms.length - 1)];
    g.startRun(room.id, g.save.characterId);
  }
  function quickPause() {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', bubbles: true }));
    g.loop.callbacks.step();
  }
  function bot(ticks, opts) { g.debugBot(ticks, opts || {}); }
  /**
   * Input latency in simulation ticks: a key down to the first step the
   * player moves, and a click to the first shot fired. Steps the loop by
   * hand so the count is exact, then hands the numbers back as stats.
   */
  function latency() {
    const p = g.world.players[0];
    const step = () => g.loop.callbacks.step();
    for (let i = 0; i < 5; i++) step();
    const x0 = p.x;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true }));
    let moveTicks = -1;
    for (let i = 1; i <= 10; i++) { step(); if (p.x !== x0) { moveTicks = i; break; } }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', bubbles: true }));
    let fired = false;
    const orig = g.audio.play.bind(g.audio);
    g.audio.play = (name, ...rest) => { if (String(name).startsWith('Weapon.')) fired = true; return orig(name, ...rest); };
    const canvas = document.getElementById('view');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 400, clientY: 200, bubbles: true }));
    let fireTicks = -1;
    for (let i = 1; i <= 10; i++) { step(); if (fired) { fireTicks = i; break; } }
    window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
    g.audio.play = orig;
    // Draw the frame the numbers were measured on, then hold it.
    g.debugBot(0);
    g.loop.stop();
    return { moveTicks, fireTicks };
  }
  /**
   * How far the camera leans toward the aim at a setting: the pointer goes
   * to the right edge, the player stands still, and after the camera has
   * settled the offset between camera and player is the lead.
   */
  function leadAt(amount) {
    g.save.setCameraLead(amount);
    const p = g.world.players[0];
    p.invincible = 100000;
    // Stand in the middle of the arena, well clear of the edges the camera clamps to.
    const map = g.world.map;
    p.x = p.prevX = map.width / 2;
    p.y = p.prevY = map.height / 2;
    g.world.hash.move(p.id, p.x, p.y);
    g.camera.jumpTo(p.x, p.y);
    const canvas = document.getElementById('view');
    const rect = canvas.getBoundingClientRect();
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.right - 4, clientY: rect.top + rect.height / 2, bubbles: true }));
    for (let i = 0; i < 30; i++) {
      // The pointer unprojects through the drawn camera; with no frames drawn here, settle it by hand.
      g.camera.interpolate(1);
      g.loop.callbacks.step();
      // Hold the player where they stand: a bite would shove them and spoil the reading.
      p.x = p.prevX = map.width / 2;
      p.y = p.prevY = map.height / 2;
    }
    return g.debugStats().lead.x;
  }
  function lead() {
    const lead100 = leadAt(1);
    const lead50 = leadAt(0.5);
    const lead0 = leadAt(0);
    g.save.setCameraLead(1);
    g.debugBot(0);
    g.loop.stop();
    return { lead0, lead50, lead100 };
  }
  /** Drain a seat to a few points, and hold it there through the frame, so the heartbeat shows. */
  function lowHealth(life, seat) {
    const p = g.world.players[seat || 0];
    p.life = life;
    p.invincible = 100000;
    // Land on a tick where the beat is up.
    for (let i = 0; i < 60; i++) {
      p.life = life;
      if (g.run.hud.heartbeat(life / p.maxLife) > 0.9) break;
      g.debugBot(1);
    }
    p.life = life;
    // Draw this very tick, at the top of the beat, and hold the frame: the
    // live loop would step on and draw the trough before the capture.
    g.debugBot(0);
    g.loop.stop();
  }
  /** Two players on this screen, survive together or head to head. */
  function shared(mode) { g.save.setSharedScreen(true); g.save.setSharedMode(mode); }
  /** Hold keys for the second seat while the loop steps, so it walks. */
  async function drive(codes, ticks) {
    const ev = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
    for (const c of codes) ev('keydown', c);
    for (let i = 0; i < ticks; i++) g.loop.callbacks.step();
    for (const c of codes) ev('keyup', c);
  }
  /** Play a difficulty with the bot until it dies or the tick limit, and say how it went. */
  function fairness(difficulty, roomIndex, maxTicks) {
    run(roomIndex, difficulty);
    let stats = g.debugStats();
    while (!stats.gameOver && stats.tick < maxTicks) stats = g.debugBot(100, {});
    return stats;
  }
  async function debrief() {
    for (let i = 0; i < 400 && g.menus.screen !== 'debrief'; i++) {
      g.loop.callbacks.step();
      await new Promise((r) => setTimeout(r, 0));
    }
  }
`;

/** A headless Chrome of its own, attached over the DevTools protocol. */
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'boxhead-playtest-'));
  const port = 9222 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const target = await waitForTarget(port);
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    cdp,
    close() {
      cdp.close();
      chrome.kill();
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
    },
  };
}

async function main() {
  mkdirSync(out, { recursive: true });
  const browser = await launchChrome();
  const cdp = browser.cdp;
  try {

    if (fairnessRuns > 0) {
      await runFairness(cdp);
      return;
    }
    if (coop) {
      await runCoop(cdp);
      return;
    }
    const names = wanted.length > 0 ? wanted : Object.keys(SCENARIOS);
    const results = [];
    for (const name of names) {
      const script = SCENARIOS[name];
      if (!script) {
        console.error(`unknown scenario ${name}`);
        continue;
      }
      const loaded = cdp.waitFor('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
      await evaluate(
        cdp,
        `(async () => { for (let i = 0; i < 400 && !window.__game; i++) await new Promise((r) => setTimeout(r, 50)); if (!window.__game) throw new Error('no __game hooks: is this the dev server?'); await document.fonts.ready; })()`,
      );
      const started = Date.now();
      const stats = await evaluate(
        cdp,
        `(async () => { ${HELPERS} const extra = await (async () => { ${script}; })(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return { ...(g.debugStats ? g.debugStats() : {}), ...(extra ?? {}) }; })()`,
      );
      // Let the layout and any menu transition settle.
      await new Promise((r) => setTimeout(r, 400));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(out, `${name}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      // How far a menu runs past the window: zero is the only good number.
      const overflow = await evaluate(cdp, `Math.max(0, (document.querySelector('.menu.on')?.scrollHeight ?? 0) - window.innerHeight)`);
      const line = { scenario: name, file, ms: Date.now() - started, overflow, ...(stats ?? {}) };
      if (overflow > 0 && name !== 'rooms') {
        console.error(`${name}: the menu runs ${overflow}px past the window`);
        process.exitCode = 1;
      }
      results.push(line);
      console.log(JSON.stringify(line));
    }
    writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    browser.close();
  }
}

/**
 * The difficulty curve, measured: the bot plays each preset a few times on
 * the first room and the median survival says whether a change made the
 * opening harsher or kinder. Print a table and keep the numbers.
 */
async function runFairness(cdp) {
  const presets = ['beginner', 'intermediate', 'expert', 'nightmare'];
  const rows = [];
  for (const preset of presets) {
    const runs = [];
    for (let i = 0; i < fairnessRuns; i++) {
      const loaded = cdp.waitFor('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
      await evaluate(
        cdp,
        `(async () => { for (let i = 0; i < 400 && !window.__game; i++) await new Promise((r) => setTimeout(r, 50)); })()`,
      );
      const stats = await evaluate(cdp, `(async () => { ${HELPERS} return fairness('${preset}', ${fairnessRoom}, 9000); })()`);
      runs.push(stats);
    }
    const ticks = runs.map((r) => r.tick).sort((a, b) => a - b);
    const median = ticks[Math.floor(ticks.length / 2)];
    const row = {
      preset,
      room: fairnessRoom + 1,
      runs: runs.length,
      medianSeconds: Math.round(median / 50),
      minSeconds: Math.round(ticks[0] / 50),
      maxSeconds: Math.round(ticks[ticks.length - 1] / 50),
      survived: runs.filter((r) => !r.gameOver).length,
      medianKills: runs.map((r) => r.kills).sort((a, b) => a - b)[Math.floor(runs.length / 2)],
      levels: runs.map((r) => r.level),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  writeFileSync(join(out, 'fairness.json'), JSON.stringify(rows, null, 2));
}

/**
 * Online play, end to end: a real server on a spare port, two headless pages
 * that join it, the host readying and starting the match, and both clients
 * driven by keys for a few seconds of a shared wave. Screenshots the lobby
 * from the host and the wave from both seats, and reports each client's own
 * netcode counters (round trip, corrections) so the feel has a number.
 */
async function runCoop(host) {
  const serverPort = 9500 + Math.floor(Math.random() * 400);
  const server = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], {
    env: { ...process.env, PORT: String(serverPort) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const ok = await fetch(`http://127.0.0.1:${serverPort}/health`).then((r) => r.ok);
        if (ok) break;
      } catch {
        // Still starting.
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // The guest gets a browser of its own: a second tab in the same one would
    // sit in the background, where Chrome throttles its frames to nothing.
    const guestBrowser = await launchChrome();
    const guest = guestBrowser.cdp;

    const open = async (cdp) => {
      const loaded = cdp.waitFor('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
      await evaluate(cdp, `(async () => { for (let i = 0; i < 400 && !window.__game; i++) await new Promise((r) => setTimeout(r, 50)); await document.fonts.ready; })()`);
    };
    await open(host);
    await open(guest);
    const joinServer = (cdp, name, character) =>
      evaluate(
        cdp,
        `(async () => { __game.connect('127.0.0.1:${serverPort}', '${name}', '${character}');
          for (let i = 0; i < 100 && __game.menus.screen !== 'lobby'; i++) await new Promise((r) => setTimeout(r, 50));
          return __game.menus.screen; })()`,
      );
    const hostScreen = await joinServer(host, 'Ann', 'swat');
    const guestScreen = await joinServer(guest, 'Ben', 'bond');
    await new Promise((r) => setTimeout(r, 600));

    // The host opens the match on a practice level, so the option is proven online.
    await evaluate(host, `__game.run.session.configure({ startLevel: 5 }); 'ok'`);
    await new Promise((r) => setTimeout(r, 300));
    const lobbyOverflow = await evaluate(host, `Math.max(0, (document.querySelector('.menu.on')?.scrollHeight ?? 0) - window.innerHeight)`);
    const lobbyShot = await host.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(out, 'coop-lobby.png'), Buffer.from(lobbyShot.data, 'base64'));
    await evaluate(guest, `__game.run.session.setReady(true); 'ok'`);
    await new Promise((r) => setTimeout(r, 300));
    await evaluate(host, `__game.run.session.setReady(true); 'ok'`);
    await new Promise((r) => setTimeout(r, 300));
    await evaluate(host, `__game.run.session.start(); 'ok'`);
    // The opening banner lives four seconds; look for it as the wave opens, not after the drive.
    const bannerOf = (cdp) =>
      evaluate(cdp, `(async () => { for (let i = 0; i < 60; i++) { if (__game.world?.messages.some((m) => m.kind === 'level')) return true; await new Promise((r) => setTimeout(r, 50)); } return false; })()`);
    const [hostBanner, guestBanner] = await Promise.all([bannerOf(host), bannerOf(guest)]);
    // Pull the guest's plug while the opening banner is alive: it must come
    // back to the same seat with the room's strip, banner included.
    const earlyReconnect = await evaluate(
      guest,
      `(async () => {
        const session = __game.run?.session;
        if (!session) return { state: 'run ended before the reconnect' };
        const seat = session.localPlayerIndex;
        const net = session['net'];
        net['socket']?.close();
        let state = '';
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 100));
          state = net.state;
          if (state === 'joined') break;
        }
        await new Promise((r) => setTimeout(r, 200));
        return { seatBefore: seat, seatAfter: session.localPlayerIndex, state };
      })()`,
    );
    const stripsAfterRejoin = {
      host: await evaluate(host, `(__game.world?.messages.map((m) => m.text) ?? null)`),
      guest: await evaluate(guest, `(__game.world?.messages.map((m) => m.text) ?? null)`),
    };
    const stripCarried =
      Array.isArray(stripsAfterRejoin.guest) && stripsAfterRejoin.guest.length > 0 &&
      JSON.stringify(stripsAfterRejoin.guest) === JSON.stringify(stripsAfterRejoin.host);
    // Both seats walk and shoot for a few seconds of real time.
    const drive = (cdp, keys) =>
      evaluate(
        cdp,
        `(async () => {
          for (let i = 0; i < 100 && __game.menus.screen !== 'none'; i++) await new Promise((r) => setTimeout(r, 50));
          const down = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
          const up = (code) => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
          for (const step of ${JSON.stringify(keys)}) {
            for (const k of step.keys) down(k);
            await new Promise((r) => setTimeout(r, step.ms));
            for (const k of step.keys) up(k);
          }
          return { ...(__game.debugStats() ?? {}), screen: __game.menus.screen, seat: __game.run?.session.localPlayerIndex ?? -1 };
        })()`,
      );
    // The guest walks off first, alone, so the host's screen has to point at a partner it cannot see.
    const [hostStats, guestStats] = await Promise.all([
      drive(host, [{ keys: ['KeyD'], ms: 2600 }, { keys: ['KeyW', 'Space'], ms: 1200 }, { keys: ['Space'], ms: 1500 }]),
      drive(guest, [{ keys: ['KeyA', 'Space'], ms: 1400 }, { keys: ['KeyA', 'KeyS', 'Space'], ms: 1200 }, { keys: ['KeyS', 'Space'], ms: 1200 }, { keys: ['Space'], ms: 1500 }]),
    ]);
    const partnerMarkerSeen = hostStats.partnerMarkers > 0 || guestStats.partnerMarkers > 0;
    // Pull the guest's plug: the client must come back to the same seat on
    // its own, with the server having held it, and keep playing.
    const reconnect = await evaluate(
      guest,
      `(async () => {
        const session = __game.run?.session;
        if (!session) return { seatBefore: -1, seatAfter: -1, state: 'run ended before the reconnect', tickBefore: 0, tickAfter: 0 };
        const seat = session.localPlayerIndex;
        const tickBefore = session.world.tick;
        const net = session['net'];
        net['socket']?.close();
        let state = '';
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 100));
          state = net.state;
          if (state === 'joined' && session.world.tick > tickBefore + 20) break;
        }
        return { seatBefore: seat, seatAfter: session.localPlayerIndex, state, tickBefore, tickAfter: session.world.tick };
      })()`,
    );
    const hostNet = await evaluate(host, `__game.run?.session.stats() ?? ['run ended']`);
    const guestNet = await evaluate(guest, `__game.run?.session.stats() ?? ['run ended']`);
    for (const [cdp, name] of [[host, 'coop-host'], [guest, 'coop-guest']]) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(out, `${name}.png`), Buffer.from(shot.data, 'base64'));
    }
    const bothInWave = hostStats.screen === 'none' && guestStats.screen === 'none' && hostStats.tick > 0 && guestStats.tick > 0;
    const match = await evaluate(host, `(() => { const c = __game.run?.session.config; return c ? { difficulty: c.difficulty, mode: c.mode, startLevel: c.startLevel ?? 0 } : null; })()`);
    // Cosmetic events each client was sent during the drive: a re-forward shows here as a large number.
    const events = {
      host: await evaluate(host, `(__game.run?.session.eventsSeen ?? null)`),
      guest: await evaluate(guest, `(__game.run?.session.eventsSeen ?? null)`),
    };
    // After the guest's reconnect, the strips should say the same things.
    const strips = {
      host: await evaluate(host, `(__game.world?.messages.map((m) => m.text) ?? null)`),
      guest: await evaluate(guest, `(__game.world?.messages.map((m) => m.text) ?? null)`),
    };
    const levels = {
      host: hostStats.level,
      guest: guestStats.level,
      hostBanner,
      guestBanner,
    };
    const closes = {
      host: await evaluate(host, `__game.debugStats()?.lastNetClose ?? (window.__game ? '' : null)`),
      guest: await evaluate(guest, `__game.debugStats()?.lastNetClose ?? ''`),
    };
    const report = {
      closes,
      joinedAs: { host: hostScreen, guest: guestScreen },
      match,
      levels,
      events,
      partnerMarkerSeen,
      earlyReconnect,
      stripsAfterRejoin,
      stripCarried,
      strips,
      lobbyOverflow,
      bothInWave,
      reconnect,
      host: { ...hostStats, net: hostNet },
      guest: { ...guestStats, net: guestNet },
    };
    if (!bothInWave) console.error('co-op: a client never reached the wave');
    console.log(JSON.stringify(report, null, 2));
    writeFileSync(join(out, 'coop.json'), JSON.stringify(report, null, 2));
    guestBrowser.close();
  } finally {
    server.kill();
  }
}

async function waitForTarget(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      // Chrome is still coming up.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome never exposed a page target');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    let nextId = 1;
    const pending = new Map();
    const waiters = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method && waiters.has(msg.method)) {
        const list = waiters.get(msg.method);
        waiters.delete(msg.method);
        for (const w of list) w(msg.params);
      }
    });
    ws.on('open', () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        waitFor: (method) =>
          new Promise((resolve) => {
            waiters.set(method, [...(waiters.get(method) ?? []), resolve]);
          }),
        close: () => ws.close(),
      }),
    );
    ws.on('error', reject);
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
