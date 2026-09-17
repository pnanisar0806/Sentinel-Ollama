import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, type Purpose } from '../../src/config/env.js';
import { ENV_PURPOSES as SYNC_PURPOSES } from '../../src/jobs/sync.js';
import { ENV_PURPOSES as DIGEST_PURPOSES } from '../../src/jobs/digest.js';
import { ENV_PURPOSES as KEEPALIVE_PURPOSES } from '../../src/jobs/keepalive.js';
import { ENV_PURPOSES as REPORT_PURPOSES } from '../../src/jobs/report.js';

/**
 * Every scheduled job crashed on startup because it demanded credentials its own
 * workflow never supplies (`loadEnv()` defaulted to ['all']). Neither job reads
 * them. This derives the environment from the real workflow file rather than
 * restating it, so adding a job or dropping a secret fails here.
 */
const workflowsDir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

/** Collects the `env:` keys of the single `run:` step that invokes the job. */
function workflowEnv(file: string): Record<string, string> {
  // Normalize CRLF: a Windows checkout materializes these files with \r\n, and the
  // regex below is LF-only — without this the whole suite fails off a fresh clone.
  const text = readFileSync(workflowsDir + file, 'utf8').replace(/\r\n/g, '\n');
  // Tolerates comment and blank lines inside the block - real workflows have
  // them, and a parser that stops at the first `#` silently reports a short
  // environment, which would make this whole test lie.
  const block = /\n\s*env:\n((?:[ \t]*(?:#.*)?\n|[ \t]+[A-Z_][A-Z0-9_]*:.*\n?)+)/.exec(text)?.[1];
  if (!block) throw new Error(`no env: block in ${file}`);
  const env: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const key = /^\s+([A-Z_][A-Z0-9_]*):\s*\S/.exec(line)?.[1];
    if (key) env[key] = 'workflow-supplied-value';
  }
  return env;
}

const JOBS: Array<{ workflow: string; purposes: Purpose[] }> = [
  { workflow: 'sync.yml', purposes: SYNC_PURPOSES },
  { workflow: 'digest.yml', purposes: DIGEST_PURPOSES },
  { workflow: 'keepalive.yml', purposes: KEEPALIVE_PURPOSES },
  { workflow: 'weekly.yml', purposes: REPORT_PURPOSES },
];

describe('scheduled jobs start under their own workflow environment', () => {
  it.each(JOBS)('$workflow keeps all steps at the same sequence indentation', ({ workflow }) => {
    const text = readFileSync(workflowsDir + workflow, 'utf8');
    const steps = [...text.matchAll(/^( +)- (?:uses|run):/gm)];
    expect(steps.length).toBeGreaterThan(0);
    expect(new Set(steps.map((step) => step[1]?.length))).toEqual(new Set([6]));
  });

  it('scheduled package scripts do not require a local env file', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const script of ['sync', 'digest', 'report', 'screener:remind']) {
      expect(scripts[script]).toContain('--env-file-if-exists=.env');
      expect(scripts[script]).not.toContain('--env-file=.env');
    }
  });
  it('scheduled tsx startup tolerates absent .env and preserves supplied environment values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-workflow-env-'));
    const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const cli = createRequire(import.meta.url).resolve('tsx/cli');
    try {
      for (const script of ['sync', 'digest', 'report', 'screener:remind']) {
        const command = scripts[script];
        if (!command) throw new Error(`Missing script: ${script}`);
        const flags = command.split(' ').slice(1, -1);
        const result = spawnSync(process.execPath, [cli, ...flags, '-e', 'process.stdout.write(process.env.SENTINEL_ENV_PROBE ?? "missing")'], {
          cwd: dir,
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SENTINEL_ENV_PROBE: 'runner' },
          encoding: 'utf8',
          timeout: 10000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('runner');
      }
      writeFileSync(join(dir, '.env'), 'SENTINEL_ENV_PROBE=local\n');
      const flags = scripts.sync!.split(' ').slice(1, -1);
      for (const supplied of [false, true]) {
        const result = spawnSync(process.execPath, [cli, ...flags, '-e', 'process.stdout.write(process.env.SENTINEL_ENV_PROBE ?? "missing")'], {
          cwd: dir,
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...(supplied ? { SENTINEL_ENV_PROBE: 'runner' } : {}) },
          encoding: 'utf8',
          timeout: 10000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(supplied ? 'runner' : 'local');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it.each(JOBS)('$workflow supplies everything its job demands', ({ workflow, purposes }) => {
    const env = workflowEnv(workflow);
    expect(Object.keys(env).length).toBeGreaterThan(0);
    expect(() => loadEnv(env, purposes)).not.toThrow();
  });

  it('sync.yml does not ship the Telegram bot token to a job that never messages', () => {
    // Least privilege on the one credential that can reach the owner.
    expect(Object.keys(workflowEnv('sync.yml'))).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  // ENV_PURPOSES is [] for sync (it must still start without a key and fall back to the
  // file snapshot), so loadEnv cannot catch a missing TOKEN_ENCRYPTION_KEY here. The job
  // does read it, and without it the live OAuth path is silently skipped — which is how
  // three tasks' worth of code became unreachable in the first place.
  it('sync.yml supplies the key its live INDmoney path decrypts with', () => {
    expect(Object.keys(workflowEnv('sync.yml'))).toContain('TOKEN_ENCRYPTION_KEY');
  });

  it('every workflow supplies DATABASE_URL', () => {
    for (const { workflow } of JOBS) {
      expect(Object.keys(workflowEnv(workflow))).toContain('DATABASE_URL');
    }
  });
});
