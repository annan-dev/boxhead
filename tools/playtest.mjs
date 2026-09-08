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
const FLAGS = new Set(['--url', '--out', '--width', '--height']);
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
  async function debrief() {
    for (let i = 0; i < 400 && g.menus.screen !== 'debrief'; i++) {
      g.loop.callbacks.step();
      await new Promise((r) => setTimeout(r, 0));
    }
  }
`;

async function main() {
  mkdirSync(out, { recursive: true });
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

  try {
    const target = await waitForTarget(port);
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

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
    cdp.close();
  } finally {
    chrome.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
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
