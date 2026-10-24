import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** pnpm installs the overridden Reown wallet package with its own zod under .pnpm. */
async function reownWalletRoot() {
  const store = path.join(repoRoot, 'node_modules', '.pnpm');
  const entries = (await readdir(store)).filter((name) => name.startsWith('@reown+appkit-wallet@'));
  assert.equal(entries.length, 1, 'expected exactly one locked @reown/appkit-wallet');
  return path.join(store, entries[0], 'node_modules');
}

test('WalletConnect Reown frame protocol works on the zod 4 override', async () => {
  const root = await reownWalletRoot();
  const zod = await import(pathToFileURL(path.join(root, 'zod', 'package.json')).href, {
    with: { type: 'json' },
  });
  assert.match(zod.default.version, /^4\./, 'Reown must resolve the patched zod 4 override');
  const src = path.join(root, '@reown', 'appkit-wallet', 'dist', 'esm', 'src');
  const schema = await import(pathToFileURL(path.join(src, 'W3mFrameSchema.js')).href);
  const { W3mFrameConstants: C } = await import(
    pathToFileURL(path.join(src, 'W3mFrameConstants.js')).href
  );
  // W3mFrame.js parses every iframe message through these two unions.
  const { appEvent, frameEvent } = schema.W3mFrameSchema;
  assert.equal(
    appEvent.parse({ id: '1', type: C.APP_SWITCH_NETWORK, payload: { chainId: 8453 } }).type,
    C.APP_SWITCH_NETWORK,
  );
  assert.equal(
    appEvent.parse({ type: C.APP_CONNECT_EMAIL, payload: { email: 'agent@example.com' } }).payload
      .email,
    'agent@example.com',
  );
  assert.equal(appEvent.safeParse({ type: C.APP_CONNECT_EMAIL, payload: {} }).success, false);
  assert.equal(appEvent.safeParse({ type: 'NOT_A_FRAME_EVENT' }).success, false);
  assert.equal(
    frameEvent.parse({ type: C.FRAME_SWITCH_NETWORK_SUCCESS, payload: { chainId: 8453 } }).type,
    C.FRAME_SWITCH_NETWORK_SUCCESS,
  );
});
