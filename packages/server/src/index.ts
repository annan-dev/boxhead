/**
 * Command-line entry: start one game server and print where to find it.
 *
 *   npm run server            # listens on 8787
 *   PORT=9000 npm run server
 *
 * The built single-file client is served from `/` when it exists, so a host
 * only has to share one address with friends.
 */
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, PROTOCOL_VERSION } from '@boxhead/shared';
import { createGameServer } from './server.js';
import { loadRooms } from './rooms.js';

const port = Number(process.env.PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT must be a whole number between 0 and 65535, not ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}
const rooms = loadRooms();

const clientPath = join(import.meta.dirname, '..', '..', 'client', 'dist', 'boxhead.html');
const options: Parameters<typeof createGameServer>[0] = { port, rooms };
if (existsSync(clientPath)) {
  options.clientHtml = readFileSync(clientPath, 'utf8');
  console.log(`client: ${clientPath}`);
} else {
  console.log('client: not built (run `npm run build`); serving a status page only');
}

const server = await createGameServer(options);
console.log(`boxhead server listening on :${server.port} (protocol v${PROTOCOL_VERSION})`);
for (const list of Object.values(networkInterfaces())) {
  for (const iface of list ?? []) {
    if (iface.family !== 'IPv4' || iface.internal) continue;
    console.log(`  http://${iface.address}:${server.port}`);
  }
}
console.log(
  'Share one of these addresses with players on your network; port-forward or use a VPN like Tailscale for the internet.',
);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
