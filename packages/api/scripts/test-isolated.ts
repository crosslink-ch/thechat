import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Bun's module isolation does not isolate process-wide transports, timers,
// spies, native handles or environment. Each owning file gets a fresh process.
// Preserve the original deadlines, service environment and guarded auth files.
const common = ['test', '--isolate', '--env-file', '../../.env', '--timeout=30000'];
const excluded = new Set(['src/auth/rate-limit.test.ts', 'src/auth/password-reset.test.ts']);
const requested = process.argv.slice(2).filter(argument => argument !== '--');
let active: ReturnType<typeof Bun.spawn> | undefined;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  interrupted = true;
  active?.kill(signal);
});
async function discover(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes:true});
  const results: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await discover(path));
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && !excluded.has(path)) results.push(path);
  }
  return results.sort();
}
const commands = requested.length
  ? [[...common, ...requested]]
  : (await discover('src')).map(path => [...common, path]);
let failed = 0, executed = 0;
for (const command of commands) {
  if (interrupted) break;
  active = Bun.spawn([process.execPath, ...command], {env:process.env, stdout:'inherit', stderr:'inherit'});
  const status = await active.exited;
  executed++;
  if (status !== 0) failed++;
  active = undefined;
}
console.log(`API process-isolated gate: ${executed}/${commands.length} file commands executed; ${failed} failed.`);
process.exitCode = interrupted ? 130 : failed ? 1 : 0;
