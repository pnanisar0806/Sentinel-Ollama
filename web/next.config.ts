import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Initialise process.env from the repo-root .env (this config runs inside the
// Next server process, and Next only auto-loads the .env next to this config).
try {
  const envPath = resolve(process.cwd(), '..', '.env');
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      const v = m[2];
      // Strip surrounding single/double quotes (dotenv convention)
      process.env[m[1]] = v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))
        ? v.slice(1, -1) : v;
    }
  }
} catch {
  // No root .env — renders then fail per-module on the DB connection.
}

const config: NextConfig = {
  webpack(cfg, { webpack }) {
    // The repo's src/ uses typescript ESM style imports with .js specifiers
    // (resolveable by tsc, not by webpack's default extensions).
    cfg.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js', '.jsx'] };
    // src/domain/ips.ts reads its markdown via import.meta.url, which webpack
    // rewrites into an asset URL that cannot be readFileSync'd. Swap that one
    // module for a bundle-safe shim that reads the file from disk instead.
    cfg.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/\/domain\/ips\.js$/, (res: { request: string }) => {
        res.request = resolve(process.cwd(), 'lib', 'domain-ips-shim.ts');
      }),
    );
    return cfg;
  },
};

export default config;