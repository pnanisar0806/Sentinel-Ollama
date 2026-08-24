import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../../src/util/main-module.js';

/**
 * The shipped guard was `import.meta.url === "file://" + process.argv[1]`.
 * On Windows argv[1] is `D:\...\migrate.ts` while import.meta.url is
 * `file:///D:/.../migrate.ts`, so it never matched: `pnpm migrate` printed
 * nothing, exited 0, and left the database empty.
 */
describe('isMainModule', () => {
  const WIN_ARGV1 = String.raw`D:\Sentinel-Ollama\src\db\migrate.ts`;

  it('matches a Windows-style argv[1] against its own file URL', () => {
    const metaUrl = pathToFileURL(WIN_ARGV1).href;

    // The shipped defect, pinned: the naive comparison cannot match on Windows.
    expect(metaUrl).not.toBe(`file://${WIN_ARGV1}`);

    expect(isMainModule(metaUrl, WIN_ARGV1)).toBe(true);
  });

  it('matches a POSIX-style argv[1] against its own file URL', () => {
    const argv1 = '/home/anirban/sentinel/src/db/migrate.ts';
    expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
  });

  it('does not match a different module', () => {
    const other = pathToFileURL(String.raw`D:\Sentinel-Ollama\src\seed\seed.ts`).href;
    expect(isMainModule(other, WIN_ARGV1)).toBe(false);
  });

  it('is false when the process has no argv[1] (REPL / eval)', () => {
    expect(isMainModule(pathToFileURL(WIN_ARGV1).href, undefined)).toBe(false);
  });
});
