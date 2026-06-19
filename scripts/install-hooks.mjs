/**
 * Install the repo's git hooks by pointing `core.hooksPath` at scripts/hooks.
 *
 * Run: `npm run hooks:install`
 *
 * This is intentionally opt-in instead of auto-running on `npm install` so
 * that a contributor cloning the repo doesn't get git config mutated without
 * noticing. The only hook installed today is the claude/*→main push guard
 * (see scripts/hooks/pre-push).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const hooksDir = join(repoRoot, 'scripts', 'hooks');

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
}

function ensureGitRepo() {
  try {
    run('git', ['rev-parse', '--git-dir']);
  } catch {
    console.error('[hooks:install] not inside a git working tree — aborting.');
    process.exit(1);
  }
}

function ensureHooksDir() {
  if (!existsSync(hooksDir) || !statSync(hooksDir).isDirectory()) {
    console.error(`[hooks:install] expected hooks dir at ${hooksDir}`);
    process.exit(1);
  }
}

function setHooksPath() {
  const rel = 'scripts/hooks';
  run('git', ['config', 'core.hooksPath', rel]);
  const confirmed = run('git', ['config', '--get', 'core.hooksPath']);
  console.log(`[hooks:install] core.hooksPath = ${confirmed}`);
}

function chmodHooks() {
  // POSIX needs the +x bit. On Windows, git honours POSIX execute bits for
  // scripts under core.hooksPath regardless, so this is a no-op in effect —
  // but chmod itself is safe to call (we ignore EPERM / unsupported errors).
  for (const name of readdirSync(hooksDir)) {
    const full = join(hooksDir, name);
    if (!statSync(full).isFile()) continue;
    try {
      chmodSync(full, 0o755);
    } catch (err) {
      if (err?.code !== 'EPERM' && err?.code !== 'ENOTSUP') {
        console.warn(`[hooks:install] could not chmod ${name}: ${err.message}`);
      }
    }
  }
}

ensureGitRepo();
ensureHooksDir();
chmodHooks();
setHooksPath();
console.log('[hooks:install] installed pre-push guard against claude/* → main pushes.');
