import { describe, it, expect, beforeEach } from 'vitest';
import { rupees, type Paise } from '../../src/money/paise.js';
import { BUCKETS, type Bucket, bucketStatus } from '../../src/domain/buckets.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';

describe('Buckets', () => {
  beforeEach(() => {
    // Reset any state if needed
  });

  describe('BUCKETS constants', () => {
    it('B1 has no target Paise (NULL)', () => {
      expect(BUCKETS.B1.targetPaise).toBeNull();
      expect(BUCKETS.B1.name).toBe('FI corpus');
      expect(BUCKETS.B1.mandate).toContain('risk-adjusted');
    });

    it('B2 has target ₹65L', () => {
      expect(BUCKETS.B2.targetPaise).toBe(rupees(6_500_000));
      expect(BUCKETS.B2.name).toBe('House fund');
    });

    it('B3 has target ₹6L', () => {
      expect(BUCKETS.B3.targetPaise).toBe(rupees(600_000));
      expect(BUCKETS.B3.name).toBe('Emergency fund');
    });

    it('B4 has target ₹1Cr', () => {
      expect(BUCKETS.B4.targetPaise).toBe(rupees(10_000_000));
      expect(BUCKETS.B4.name).toBe('Education corpus');
    });
  });

  describe('bucketStatus', () => {
    it('B1 derives target from assumptions floor band', () => {
      const result = bucketStatus(BUCKETS.B1, rupees(10_000_000));
      expect(result.met).toBe(false);
      // B1 target is now the floor band from assumptions (300_000 * 12 / 0.035)
      expect(result.targetPaise).toBe(10_285_714_285n);
    });

    it('B2 with current < target returns met=false', () => {
      const result = bucketStatus(BUCKETS.B2, rupees(3_000_000));
      expect(result.met).toBe(false);
      expect(result.progressPaise).toBe(rupees(3_000_000));
      expect(result.targetPaise).toBe(rupees(6_500_000));
    });

    it('B2 with current >= target returns met=true', () => {
      const result = bucketStatus(BUCKETS.B2, rupees(6_500_001));
      expect(result.met).toBe(true);
    });

    it('B3 with exact target returns met=true', () => {
      const result = bucketStatus(BUCKETS.B3, rupees(600_000));
      expect(result.met).toBe(true);
    });

    it('B4 with current < target returns progress', () => {
      const result = bucketStatus(BUCKETS.B4, rupees(5_000_000));
      expect(result.met).toBe(false);
      expect(result.progressPaise).toBe(rupees(5_000_000));
      expect(result.targetPaise).toBe(rupees(10_000_000));
    });
  });
});