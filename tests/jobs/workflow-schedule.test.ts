import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FRESHNESS_HOURS } from '../../src/sources/staleness.js';

const dir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const read = (f: string) => readFileSync(dir + f, 'utf8');

/** `m h * * dow` -> every UTC minute-of-week the job runs. */
function runsAt(cron: string): number[] {
  const [min, hour, , , dow] = cron.trim().split(/\s+/);
  const days = dow === '*'
    ? [0, 1, 2, 3, 4, 5, 6]
    : dow!.split(',').flatMap((part) => {
        const m = /^(\d)-(\d)$/.exec(part);
        if (!m) return [Number(part)];
        const out: number[] = [];
        for (let d = Number(m[1]); d <= Number(m[2]); d++) out.push(d);
        return out;
      });
  return days.map((d) => d * 1440 + Number(hour) * 60 + Number(min));
}

const cronOf = (file: string): string => {
  const m = /cron:\s*'([^']+)'/.exec(read(file));
  if (!m) throw new Error(`no cron in ${file}`);
  return m[1]!;
};

/**
 * Review item 13: sync ran Fri 12:00 UTC and the next digest was Mon 03:15 UTC —
 * 63.25h against a 36h portfolio freshness limit. One digest in five was a guaranteed
 * false alarm, which is the fastest way to teach the owner to ignore the staleness
 * banner. The band is right; the schedule was wrong.
 */
describe('every digest reads data inside the freshness limit', () => {
  it('never waits longer than the portfolio limit after a sync', () => {
    const syncs = runsAt(cronOf('sync.yml')).sort((a, b) => a - b);
    const digests = runsAt(cronOf('digest.yml')).sort((a, b) => a - b);
    expect(syncs.length).toBeGreaterThan(0);
    expect(digests.length).toBeGreaterThan(0);

    const WEEK = 7 * 1440;
    const worst = Math.max(...digests.map((d) => {
      // Most recent sync at or before this digest, wrapping around the week.
      const gaps = syncs.map((s) => ((d - s) % WEEK + WEEK) % WEEK);
      return Math.min(...gaps);
    })) / 60;

    // Derived from the engine's own limit, not restated — moving the band moves this.
    expect(worst).toBeLessThanOrEqual(FRESHNESS_HOURS.portfolio!);
  });

  it('the Monday digest specifically is fresh', () => {
    const syncs = runsAt(cronOf('sync.yml'));
    const monday = 1 * 1440 + 3 * 60 + 15;
    const WEEK = 7 * 1440;
    const gap = Math.min(...syncs.map((s) => ((monday - s) % WEEK + WEEK) % WEEK)) / 60;
    expect(gap).toBeLessThanOrEqual(FRESHNESS_HOURS.portfolio!);
  });
});

/**
 * Review item 14: `pnpm/action-setup@v4 with: { version: 10 }` alongside
 * `"packageManager": "pnpm@10.14.0"` makes the action error with "Multiple versions of
 * pnpm specified". If it holds, all three workflows fail at setup — before a single
 * test runs.
 */
describe('workflows install pnpm without conflicting version specs', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));

  it.each(files)('%s does not pin a pnpm version beside packageManager', (file) => {
    const text = read(file);
    if (!text.includes('pnpm/action-setup')) return;
    // Only the action's OWN `version:` counts - `node-version:` on the setup-node step
    // that follows is legitimate and must not trip this.
    expect(text).not.toMatch(/pnpm\/action-setup[\s\S]{0,120}?(?<!node-)version:\s*\d/);
  });

  it('package.json still declares the version, so there is one source of truth', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
    expect(pkg.packageManager).toMatch(/^pnpm@\d/);
  });
});

/** Review item 32: nothing enforced the suite a whole safety argument rests on. */
describe('CI enforces the suite on push', () => {
  const ci = () => read('ci.yml');

  it('runs the tests and the typechecker', () => {
    expect(ci()).toMatch(/pnpm test/);
    expect(ci()).toMatch(/tsc --noEmit/);
  });

  it('triggers on push and on pull request', () => {
    expect(ci()).toMatch(/\bpush\b/);
    expect(ci()).toMatch(/pull_request/);
  });
});
