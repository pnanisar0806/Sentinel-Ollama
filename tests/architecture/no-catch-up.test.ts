import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, relative, resolve } from 'node:path';

/**
 * Architecture test: the `funded_status` firewall.
 *
 * PRD hard constraint (CLAUDE.md): `funded_status` is unreadable by any sizing or
 * risk function. No catch-up behaviour — being behind the FI target must never make
 * the agent take more risk to catch up.
 *
 * The version of this file that shipped on the branch enforced NOTHING. It had no
 * filesystem access, no module-graph walk and no allowlist evaluation: `sizeRisk`,
 * `riskScore`, `FundedRatio` and `resolveSpec` were all declared inside the test file,
 * and four tests asserted that an identity function returns its argument. Its own
 * stated mutation check was false — deleting a key from KNOWN_SPEC_KEYS left 10/10
 * green, because both sides of the comparison were hard-coded copies of one list.
 *
 * This version walks the real `src/` tree, builds the real import graph, and asserts
 * that the set of modules which can reach `funded-status.ts` — transitively, so a
 * two-hop path counts — is exactly the reporting surface. The type brand cannot do
 * this job: `number & {__brand}` is a subtype of `number`, so it is assignable to any
 * bare `number` parameter. The import graph is the mechanism.
 */

const SRC = resolve(fileURLToPath(new URL('../../src/', import.meta.url)));
const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const rel = (abs: string) => relative(REPO, abs).split(/[\\/]/).join('/');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Every relative specifier a module pulls in: static, side-effect and dynamic. */
function dependencies(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);

  return specs
    .filter((s) => s.startsWith('.'))
    .map((s) => {
      const base = normalize(join(dirname(file), s.replace(/\.js$/, '.ts')));
      if (existsSync(base)) return base;
      const asIndex = join(base.replace(/\.ts$/, ''), 'index.ts');
      return existsSync(asIndex) ? asIndex : base;
    });
}

const graph = new Map<string, string[]>(
  sourceFiles(SRC).map((f) => [rel(f), dependencies(f).map(rel)]),
);

const FUNDED_STATUS = 'src/domain/funded-status.ts';

/** Modules that can reach a target through any number of hops. */
function reachersOf(g: Map<string, string[]>, target = FUNDED_STATUS): Set<string> {
  const found = new Set<string>();
  for (;;) {
    const before = found.size;
    for (const [file, deps] of g) {
      if (found.has(file) || file === target) continue;
      if (deps.includes(target) || deps.some((d) => found.has(d))) found.add(file);
    }
    if (found.size === before) return found;
  }
}

const reachers = () => reachersOf(graph);

/**
 * The reporting surface, and nothing else. Adding a module here is a deliberate act
 * that must be justified against the no-catch-up rule — and the guard below refuses
 * to let anything that looks like sizing, risk or order flow onto this list.
 */
const ALLOWED = new Set([
  'src/domain/buckets.ts',   // bucket reporting; re-exports the FI band, never sizes
  'src/notify/digest.ts',    // renders funded status to the owner
  'src/jobs/digest.ts',      // the digest CLI entrypoint
]);

/** A module whose name says it decides how much to buy, or how much risk to take. */
const SIZING_OR_RISK = /(sizing|size|risk|recommend|rebalanc|allocat|order|trade|position)/i;

/** Identifiers that carry funded status out of a module by value. */
const FUNDED_IDENTIFIERS = /\b(fundedRatio|fundedStatus|reportFundedStatus|funded_status)\b/;

describe('the funded_status firewall has a mechanism', () => {
  it('actually walked the source tree', () => {
    // Without this every assertion below could pass vacuously on an empty graph —
    // which is precisely how the previous version of this file passed.
    expect(graph.size).toBeGreaterThan(20);
    expect(graph.has(FUNDED_STATUS)).toBe(true);
    expect(graph.get('src/notify/digest.ts')).toContain(FUNDED_STATUS);
  });

  it('resolves transitive reach, not just direct imports', () => {
    // jobs/digest.ts never imports funded-status directly; it reaches it via notify/digest.
    expect(graph.get('src/jobs/digest.ts')).not.toContain(FUNDED_STATUS);
    expect([...reachers()]).toContain('src/jobs/digest.ts');
  });
});

describe('funded_status is unreadable outside the reporting surface', () => {
  it('no module outside the allowlist can reach funded-status.ts', () => {
    const offenders = [...reachers()].filter((f) => !ALLOWED.has(f)).sort();
    expect(offenders).toEqual([]);
  });

  it('the allowlist is exactly the modules that do reach it — no stale entries', () => {
    // A stale entry is a licence granted to a module that no longer needs it, and it
    // is how an allowlist quietly stops meaning anything.
    expect([...ALLOWED].sort()).toEqual([...reachers()].sort());
  });

  it('no sizing, risk or order module is on the allowlist', () => {
    expect([...ALLOWED].filter((f) => SIZING_OR_RISK.test(f))).toEqual([]);
  });

  it('no module outside the allowlist even names a funded-status identifier', () => {
    // Catches the injection path the type brand cannot: passing `fundedRatio: number`
    // as a bare parameter, and any `select funded_status` in a non-reporting module.
    const leaks = [...graph.keys()]
      .filter((f) => f !== FUNDED_STATUS && !ALLOWED.has(f))
      .filter((f) => FUNDED_IDENTIFIERS.test(readFileSync(join(REPO, f), 'utf8')))
      .sort();
    expect(leaks).toEqual([]);
  });
});

describe('no catch-up: the firewall would catch a real breach', () => {
  /**
   * The previous file claimed a mutation check that did not hold. These run the real
   * checker against a synthetic graph, so the mechanism is proved here rather than
   * merely asserted about itself.
   */
  it('flags a sizing module that imports funded status directly', () => {
    const g = new Map(graph);
    g.set('src/domain/sizing.ts', [FUNDED_STATUS]);
    expect([...reachersOf(g)]).toContain('src/domain/sizing.ts');
    expect(ALLOWED.has('src/domain/sizing.ts')).toBe(false);
  });

  it('flags a sizing module that reaches it through an allowed module', () => {
    // The two-hop path a grep-for-an-import-string checker misses entirely.
    const g = new Map(graph);
    g.set('src/domain/sizing.ts', ['src/domain/buckets.ts']);
    expect([...reachersOf(g)]).toContain('src/domain/sizing.ts');
  });

  it('would refuse a sizing module even if someone allowlisted it', () => {
    const wouldBeAllowed = new Set([...ALLOWED, 'src/domain/risk-sizing.ts']);
    expect([...wouldBeAllowed].filter((f) => SIZING_OR_RISK.test(f)))
      .toEqual(['src/domain/risk-sizing.ts']);
  });
});
