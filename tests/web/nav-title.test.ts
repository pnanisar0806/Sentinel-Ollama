import { describe, expect, it } from 'vitest';
import { GROUPS, pageTitle } from '../../web/lib/nav.js';

describe('phone top-bar title', () => {
  it('is the nav label for every nav entry', () => {
    for (const it of GROUPS.flatMap((g) => g.items)) expect(pageTitle(it.href)).toBe(it.label);
  });

  it('uses the section label for nested routes and ignores a trailing slash', () => {
    expect(pageTitle('/approvals/42')).toBe('Approvals');
    expect(pageTitle('/holdings/')).toBe('Holdings');
  });

  it('does not let Overview (/) or a shared prefix swallow other paths', () => {
    expect(pageTitle('/login')).toBe('Sentinel');
    expect(pageTitle('/rsux')).toBe('Sentinel');
  });
});
