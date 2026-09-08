import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, mkdir, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const environmentURL = new URL('../../../scripts/e2e/web/environment.mjs', import.meta.url);

test('browser acceptance defaults and overrides share one safe origin', async () => {
  assert.ok(existsSync(environmentURL), 'browser acceptance needs one shared endpoint resolver');
  const { resolveWebE2EEnvironment } = await import(environmentURL.href);
  const defaults = resolveWebE2EEnvironment({});
  assert.equal(defaults.webURL, 'http://127.0.0.1:1422');
  assert.equal(defaults.webHeaders.origin, defaults.webURL);
  assert.equal(defaults.apiURL, 'http://127.0.0.1:13300');
  const override = resolveWebE2EEnvironment({ THECHAT_WEB_E2E_URL: 'https://localhost:18443', THECHAT_WEB_E2E_API_URL: 'https://localhost:18443' });
  assert.equal(override.webURL, 'https://localhost:18443');
  assert.equal(override.webHeaders.origin, override.webURL);
  assert.equal(override.apiURL, override.webURL);
  assert.throws(() => resolveWebE2EEnvironment({ THECHAT_WEB_E2E_URL: 'https://example.com' }), /loopback/);
  for (const name of ['playwright.config.ts', 'fixtures.ts', 'session.spec.ts']) {
    const text = await readFile(path.join(root, 'scripts/e2e/web', name), 'utf8');
    assert.match(text, /from ['"]\.\/environment\.mjs['"]/, name);
    assert.doesNotMatch(text, /THECHAT_WEB_E2E_URL|http:\/\/127\.0\.0\.1:142[02]/, name);
  }
});

for (const app of ['client', 'desktop']) test(`${app} test defines honor dotenv and explicit process endpoint precedence`, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'thechat-vitest-env-'));
  const target = path.join(scratch, 'packages', app);
  const keys = ['THECHAT_BACKEND_URL', 'THECHAT_BACKEND_PORT'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const key of keys) delete process.env[key];
    await mkdir(target, {recursive:true});
    await writeFile(path.join(scratch, 'package.json'), '{"type":"module"}');
    await copyFile(path.join(root, 'packages', app, 'vitest.config.ts'), path.join(target, 'vitest.config.ts'));
    await symlink(path.join(root, 'packages', app, 'node_modules'), path.join(target, 'node_modules'), 'dir');
    const load = async () => (await loadConfigFromFile({command:'serve', mode:'test'}, path.join(target, 'vitest.config.ts'))).config;
    await writeFile(path.join(scratch, '.env.test'), 'THECHAT_BACKEND_URL=http://127.0.0.1:17001\n');
    let config = await load();
    assert.equal(JSON.parse(config.define.__BACKEND_URL__), config.test.env.THECHAT_BACKEND_URL, 'production API singleton define must match dotenv-backed fixture endpoint');
    assert.equal(JSON.parse(config.define.__BACKEND_URL__), 'http://127.0.0.1:17001');
    await writeFile(path.join(scratch, '.env.test'), 'THECHAT_BACKEND_PORT=17002\n');
    config = await load();
    assert.equal(JSON.parse(config.define.__BACKEND_URL__), `http://localhost:${config.test.env.THECHAT_BACKEND_PORT}`);
    process.env.THECHAT_BACKEND_URL = 'http://127.0.0.1:17003';
    config = await load();
    assert.equal(JSON.parse(config.define.__BACKEND_URL__), 'http://127.0.0.1:17003');
    assert.equal(config.test.env.THECHAT_BACKEND_URL, 'http://127.0.0.1:17003');
  } finally {
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    await rm(scratch, {recursive:true,force:true});
  }
});

test('current web validation docs select both relocated browser suites', async () => {
  const readme = await readFile(path.join(root, 'deploy/web/README.md'), 'utf8');
  for (const app of ['client', 'web']) assert.ok(readme.includes(`pnpm --filter @thechat/${app} exec vitest run browser --maxWorkers=2`));
  assert.ok(!readme.includes('pnpm --filter @thechat/desktop exec vitest run browser'));
});
