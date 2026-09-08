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
const FLAGS = new Set(['--url', '--out', '--width', '--height', '--fairness']);
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
        `(async () => { ${HELPERS} ${script}; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return g.debugStats ? g.debugStats() : null; })()`,
      );
      // Let the layout and any menu transition settle.
      await new Promise((r) => setTimeout(r, 400));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(out, `${name}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const line = { scenario: name, file, ms: Date.now() - started, ...(stats ?? {}) };
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
      const stats = await evaluate(cdp, `(async () => { ${HELPERS} return fairness('${preset}', 0, 9000); })()`);
      runs.push(stats);
    }
    const ticks = runs.map((r) => r.tick).sort((a, b) => a - b);
    const median = ticks[Math.floor(ticks.length / 2)];
    const row = {
      preset,
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
    const lobbyShot = await host.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(out, 'coop-lobby.png'), Buffer.from(lobbyShot.data, 'base64'));

    await evaluate(guest, `__game.run.session.setReady(true); 'ok'`);
    await new Promise((r) => setTimeout(r, 300));
    await evaluate(host, `__game.run.session.setReady(true); 'ok'`);
    await new Promise((r) => setTimeout(r, 300));
    await evaluate(host, `__game.run.session.start(); 'ok'`);
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
          return __game.debugStats();
        })()`,
      );
    const [hostStats, guestStats] = await Promise.all([
      drive(host, [{ keys: ['KeyD', 'Space'], ms: 1500 }, { keys: ['KeyW', 'Space'], ms: 1200 }, { keys: ['Space'], ms: 1500 }]),
      drive(guest, [{ keys: ['KeyA', 'Space'], ms: 1500 }, { keys: ['KeyS', 'Space'], ms: 1200 }, { keys: ['Space'], ms: 1500 }]),
    ]);
    const hostNet = await evaluate(host, `__game.run.session.stats()`);
    const guestNet = await evaluate(guest, `__game.run.session.stats()`);
    for (const [cdp, name] of [[host, 'coop-host'], [guest, 'coop-guest']]) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(out, `${name}.png`), Buffer.from(shot.data, 'base64'));
    }
    const report = { hostScreen, guestScreen, host: { ...hostStats, net: hostNet }, guest: { ...guestStats, net: guestNet } };
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
