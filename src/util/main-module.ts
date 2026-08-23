import { pathToFileURL } from 'node:url';

/**
 * True when `metaUrl` (an `import.meta.url`) is the entrypoint the process was
 * started with.
 *
 * Comparing `import.meta.url` to `"file://" + process.argv[1]` is wrong on
 * Windows: argv[1] is a drive path (`D:\a\b.ts`), the URL is `file:///D:/a/b.ts`.
 * Route argv[1] through pathToFileURL so both sides are URLs.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  return metaUrl === pathToFileURL(argv1).href;
}
