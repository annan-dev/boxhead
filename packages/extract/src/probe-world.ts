/** Scratch probe: what form is the world art (walls, pieces, objects) in? */
import { readFileSync } from 'node:fs';
import { readSwf, spriteTags, parseExportAssets, TagCode, type SwfTag } from './swf/Reader.js';
import { indexDefinitions } from './TextureBuilder.js';
import { decodeShape } from './swf/ShapeDecoder.js';

const swf = readSwf(readFileSync('D:/Projects/boxhead/boxhead2play.swf'));
const defs = indexDefinitions(swf.tags);

const exports = new Map<number, string>();
const walk = (tags: SwfTag[]): void => {
  for (const tag of tags) {
    if (tag.code === TagCode.ExportAssets) {
      for (const [id, name] of parseExportAssets(tag.body)) exports.set(id, name);
    }
    if (tag.code === TagCode.DefineSprite) walk(spriteTags(tag.body));
  }
};
walk(swf.tags);

const NAMES: Record<number, string> = {
  2: 'Shape', 22: 'Shape2', 32: 'Shape3', 83: 'Shape4', 39: 'Sprite', 46: 'MorphShape',
};

const wanted = /^(Piece\.|Object\.|Effect\.|Shot\.|.*MuzzleFlash|Hud|HUD)/;
const rows: string[] = [];
for (const [id, name] of [...exports].sort((a, b) => a[1].localeCompare(b[1]))) {
  if (!wanted.test(name)) continue;
  const def = defs.get(id);
  if (!def) { rows.push(`${name.padEnd(30)} id=${id} MISSING`); continue; }

  let detail = '';
  if (def.code === TagCode.DefineSprite) {
    const inner = spriteTags(def.body);
    const places = inner.filter((t) => t.code === 26 || t.code === 70).length;
    const frames = def.body.readUInt16LE(2);
    detail = `frames=${frames} places=${places}`;
  } else {
    const shape = decodeShape(def.code, def.body);
    const cmds = shape?.paths.reduce((n, p) => n + p.commands.length, 0) ?? 0;
    const colors = [...new Set(shape?.paths.map((p) => p.color.toString(16).padStart(6, '0')) ?? [])];
    detail = `paths=${shape?.paths.length ?? 0} cmds=${cmds} ${colors.slice(0, 6).join(',')}`;
  }
  rows.push(`${name.padEnd(30)} id=${String(id).padEnd(5)} ${(NAMES[def.code] ?? def.code).toString().padEnd(10)} ${detail}`);
}
console.log(rows.join('\n'));
console.log(`\n${rows.length} world-art symbols`);
