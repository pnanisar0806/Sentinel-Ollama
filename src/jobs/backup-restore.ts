import { loadEnv } from '../config/env.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: pnpm backup:restore <backup-file.sql.gz.enc> [--target-db <url>]');
    console.error('Example: pnpm backup:restore sentinel-backup-2026-09-19T00-00-00.sql.gz.enc');
    console.error('Example: pnpm backup:restore sentinel-backup-2026-09-19T00-00-00.sql.gz.enc --target-db postgres://user:pass@localhost:5432/sentinel_restore');
    process.exit(1);
  }

  const backupFile = args[0] as string;
  const targetDbIndex = args.indexOf('--target-db');
  const targetDb = targetDbIndex >= 0 ? args[targetDbIndex + 1] : undefined;

  const env = loadEnv(process.env, ['crypto']);
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const backupDir = join(repoRoot, 'backups');
  const backupPath = join(backupDir, backupFile);
  const encryptionKey = env.tokenEncryptionKey;

  if (!encryptionKey) {
    console.error('TOKEN_ENCRYPTION_KEY not configured');
    process.exit(1);
  }

  const key = Buffer.from(encryptionKey, 'base64');
  if (key.length !== 32) {
    console.error('TOKEN_ENCRYPTION_KEY must be 32 bytes (base64 encoded)');
    process.exit(1);
  }

  console.log(`Restoring backup: ${backupFile}`);
  console.log(`Target DB: ${targetDb ?? 'uses DATABASE_URL from env'}`);

  try {
    // 1. Read encrypted file
    const encryptedData = await readFile(backupPath);
    
    // Extract IV (first 12 bytes) and auth tag (last 16 bytes)
    const fileIv = encryptedData.subarray(0, 12);
    const fileAuthTag = encryptedData.subarray(encryptedData.length - 16);
    const ciphertext = encryptedData.subarray(12, encryptedData.length - 16);
    
    const decipher = createDecipheriv('aes-256-gcm', key, fileIv);
    decipher.setAuthTag(fileAuthTag);
    
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    
    // 2. Decompress
    const sql = gunzipSync(decrypted).toString('utf-8');
    
    console.log(`Decrypted and decompressed: ${sql.length} chars`);
    
    // 3. Connect to target database and restore
    const databaseUrl = targetDb ?? env.databaseUrl ?? '';
    if (!databaseUrl) {
      console.error('No target database URL provided (set --target-db or DATABASE_URL)');
      process.exit(1);
    }
    
    console.log('Restoring to database...');
    const { execFile } = await import('node:child_process');
    const { execFile: execFileCb } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileProm = promisify(execFileCb);
    
    await execFileProm('psql', ['-q', '-d', databaseUrl], { 
      input: sql,
      maxBuffer: 100 * 1024 * 1024, // 100MB
    } as any);
    
    console.log('Restore completed');
    
    // 4. Verify key tables exist and have data
    console.log('\nVerifying restore...');
    const verifyTables = [
      'instruments', 'holdings', 'lots', 'order_intents', 'order_transitions',
      'order_simulations', 'recommendations', 'signal_scores', 'audit_log',
      'settings_rails', 'ips_versions', 'bucket_flows', 'rsu_vests', 'loans'
    ];
    
    for (const table of verifyTables) {
      const { stdout } = await execFileAsync('psql', ['-q', '-d', databaseUrl, '-t', '-c', `select count(*) from ${table}`]);
      const count = parseInt(stdout.trim());
      console.log(`  ${table}: ${count} rows`);
    }
    
    // 5. Verify immutability triggers
    console.log('\nVerifying immutability...');
    const { stdout: triggersOut } = await execFileAsync('psql', ['-q', '-d', databaseUrl, '-t', '-c', 
      "select trigger_name from information_schema.triggers where event_object_table in ('order_intents', 'order_transitions', 'recommendations', 'ips_versions', 'bucket_flows', 'lots') and trigger_name like '%immutable%'"]);
    console.log(`  Immutable triggers: ${triggersOut.trim().split('\n').filter(Boolean).length}`);
    
    // 6. Verify RLS enabled
    const { stdout: rlsOut } = await execFileAsync('psql', ['-q', '-d', databaseUrl, '-t', '-c',
      "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relrowsecurity and n.nspname = 'public'"]);
    console.log(`  RLS-enabled tables: ${rlsOut.trim()}`);
    
    console.log('\n✅ Restore verification complete');
    
  } catch (error) {
    console.error('Restore failed:', error);
    process.exit(1);
  }
}

main();