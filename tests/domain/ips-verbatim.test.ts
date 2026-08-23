import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IPS_V1_TEXT } from '../../src/domain/ips.js';

const repo = (f: string) => readFileSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)), 'utf8');
const prd = repo('PRD_investment_agent.md');

/** The text of PRD section 3 from its heading to the start of section 4. */
const prdSection3 = (): string => {
  const start = prd.indexOf('# 3. THE INVESTMENT POLICY STATEMENT (IPS)');
  expect(start, 'PRD section 3 heading').toBeGreaterThan(-1);
  const after = prd.indexOf('\n# 4.', start);
  return prd.slice(start, after === -1 ? undefined : after);
};

/**
 * Review item 31. The IPS is the document shown to the owner at a -20% drawdown, so a
 * paraphrase is a product failure, not a wording preference. The preamble had been
 * rewritten and dropped four things: "This is the binding document", "The IPS is
 * versioned in the database", the "(Section 11)" cross-reference, and "Annual review is
 * a scheduled agent task."
 *
 * The clause bodies 3.1-3.10 were already verified byte-identical by the branch review;
 * these tests derive their expectations from the PRD file so they stay that way.
 */
describe('the stored IPS reproduces the PRD verbatim', () => {
  it('carries the section 3 preamble word for word', () => {
    const preamble = prdSection3()
      .split('\n')
      .find((l) => l.startsWith('This is the binding document'));
    expect(preamble, 'PRD preamble paragraph').toBeDefined();
    expect(IPS_V1_TEXT).toContain(preamble!.trim());
  });

  it.each([
    'The IPS is versioned in the database',
    'Annual review is a scheduled agent task',
    '(Section 11)',
    'This is the binding document',
    'cite the IPS clause(s) it serves',
  ])('does not drop %s', (fragment) => {
    expect(prd).toContain(fragment);       // the PRD really says it
    expect(IPS_V1_TEXT).toContain(fragment); // and so does the stored IPS
  });

  it('reproduces every clause heading 3.1 through 3.10', () => {
    const headings = [...prdSection3().matchAll(/^## (3\.\d+ .+)$/gm)].map((m) => m[1]!);
    expect(headings.length).toBe(10);
    for (const h of headings) expect(IPS_V1_TEXT).toContain(h);
  });

  it('reproduces every clause BODY line, not just the headings', () => {
    // Derived from the PRD rather than restated: any silent rewording fails.
    const body = prdSection3()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 40 && !l.startsWith('#'));
    expect(body.length).toBeGreaterThan(15);

    const missing = body.filter((l) => !IPS_V1_TEXT.includes(l));
    expect(missing).toEqual([]);
  });
});
