import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { validateSection, writeCommentary, type Fact } from '../../src/advisor/commentary.js';

/**
 * Phase 2.5 Task 8. Commentary is prose the model writes about facts the system computed.
 * Every number in it must be bound to a specific fact, quoted exactly, in a sentence that
 * names that fact's subject. A section that fails is dropped and the deterministic bullets
 * stand. A regex that finds the number somewhere would pass the wrong company's number;
 * the tests below include exactly those false positives.
 */
const facts: Fact[] = [
  { id: 'f1', subject: 'Equity', field: 'allocation', value: '60.7%', period: '2026-09-27' },
  { id: 'f2', subject: 'Gold', field: 'allocation', value: '1.2%', period: '2026-09-27' },
  { id: 'f3', subject: 'Bajaj Auto', field: 'valuation score', value: '9.07 of 30', period: '2026-09-20' },
];

describe('validating a section', () => {
  it('accepts numbers bound to the right fact in a sentence naming its subject', () => {
    expect(() => validateSection({
      title: 'Allocation', text: 'Equity sits at 60.7%, a little over its ceiling. Gold is only 1.2%.',
      claims: [{ factId: 'f1', quoted: '60.7%' }, { factId: 'f2', quoted: '1.2%' }], evidenceIds: ['f1', 'f2'],
    }, facts)).not.toThrow();
  });

  it('accepts a claim quoted as a phrase when its numbers are the fact\'s own', () => {
    expect(() => validateSection({ title: 't', text: 'Equity allocation is 60.7%.', claims: [{ factId: 'f1', quoted: 'Equity allocation is 60.7%.' }], evidenceIds: [] }, facts)).not.toThrow();
    expect(() => validateSection({ title: 't', text: 'Equity allocation is 61.7%.', claims: [{ factId: 'f1', quoted: 'Equity allocation is 61.7%.' }], evidenceIds: [] }, facts)).toThrow(/does not match/);
  });

  it('rejects an unbound number', () => {
    expect(() => validateSection({ title: 't', text: 'Equity sits at 61%.', claims: [], evidenceIds: [] }, facts)).toThrow(/unbound/);
  });

  it('rejects the right number attributed to the wrong subject', () => {
    // 1.2% is Gold's number; the sentence gives it to Equity.
    expect(() => validateSection({ title: 't', text: 'Equity is only 1.2%.', claims: [{ factId: 'f2', quoted: '1.2%' }], evidenceIds: ['f2'] }, facts))
      .toThrow(/subject/);
  });

  it('rejects a quote that does not match its fact, a fact that does not exist, and an over-long section', () => {
    expect(() => validateSection({ title: 't', text: 'Equity sits at 67.0%.', claims: [{ factId: 'f1', quoted: '67.0%' }], evidenceIds: [] }, facts)).toThrow(/does not match/);
    expect(() => validateSection({ title: 't', text: 'Equity sits at 60.7%.', claims: [{ factId: 'f9', quoted: '60.7%' }], evidenceIds: [] }, facts)).toThrow(/unknown fact/);
    expect(() => validateSection({ title: 't', text: Array(301).fill('word').join(' '), claims: [], evidenceIds: [] }, facts)).toThrow(/300 words/);
  });
});

describe('writing commentary', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(); await runMigrations(db); });
  const reply = (content: unknown) => (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) })) as unknown as typeof fetch;

  it('keeps valid sections, drops invalid ones, and stores what it kept', async () => {
    const r = await writeCommentary(db, { facts, apiKey: 'k', fetchImpl: reply({ sections: [
      { title: 'Allocation', text: 'Equity sits at 60.7%.', claims: [{ factId: 'f1', quoted: '60.7%' }], evidenceIds: ['f1'] },
      { title: 'Bad', text: 'Gold is 9.07 of 30.', claims: [{ factId: 'f3', quoted: '9.07 of 30' }], evidenceIds: ['f3'] },
    ] }), asOf: '2026-09-27' });
    expect(r.sections.map((s) => s.title)).toEqual(['Allocation']);
    expect(r.dropped).toHaveLength(1);
    const [p] = await db.query<{ kind: string }>(`select kind from advisor_proposals`);
    expect(p!.kind).toBe('COMMENTARY');
    await db.close();
  });

  it('with no key there is no commentary — the deterministic bullets stand', async () => {
    expect(await writeCommentary(db, { facts, apiKey: undefined, asOf: '2026-09-27' })).toMatchObject({ sections: [], unavailable: true });
    expect(await db.query(`select 1 from advisor_proposals`)).toHaveLength(0);
    await db.close();
  });
});
