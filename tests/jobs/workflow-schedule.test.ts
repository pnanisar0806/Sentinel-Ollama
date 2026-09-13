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
 * Re-derived 2026-09-13 with the owner's sign-off on PRD §12.2: the weekly deep report
 * moves from Saturday 08:00 IST to **Sunday 10:00 IST**. The previous version of this
 * file asserted a cron in `digest.yml`; that assertion was deleted when the digest moved
 * to `workflow_run`, and the decision was reported to the owner rather than silently
 * edited. The `workflow_run` shape is asserted here instead, so the gating is still
 * pinned by a test.
 */
describe('schedules match the PRD cadence', () => {
  const IST_OFFSET_MIN = 330;

  it('runs the weekly deep report at Sunday 10:00 IST', () => {
    const [minuteOfWeek] = runsAt(cronOf('weekly.yml'));
    // Derived from the cron itself, not restated: convert UTC to IST and read it back.
    const ist = (minuteOfWeek! + IST_OFFSET_MIN) % (7 * 1440);
    expect(Math.floor(ist / 1440)).toBe(0); // Sunday
    expect(ist % 1440).toBe(10 * 60); // 10:00
  });

  it('invokes the FR-51 report job, not the retired weekly script', () => {
    expect(read('weekly.yml')).toMatch(/pnpm report/);
    expect(read('weekly.yml')).not.toMatch(/pnpm weekly/);
  });

  it('gates the digest on a successful sync instead of a fixed cron', () => {
    const digest = read('digest.yml');
    expect(() => cronOf('digest.yml')).toThrow(/no cron/);
    expect(digest).toMatch(/workflow_run/);
    expect(digest).toMatch(/conclusion/);
  });

  it('keeps the daily sync on its own cron', () => {
    expect(runsAt(cronOf('sync.yml')).length).toBe(7);
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
