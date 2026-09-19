import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { installIps } from '../domain/ips.js';
import { isMainModule } from '../util/main-module.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createCipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

/** This job does weekly backup; it needs DATABASE_URL and backup secrets. */
export const ENV_PURPOSES: Purpose[] = ['crypto'];

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ['crypto']);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = `sentinel-backup-${timestamp}.sql.gz.enc`;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const backupDir = join(repoRoot, 'backups');
  
  // Get backup configuration from secrets
  const backupRepo = process.env.BACKUP_REPO; // e.g., "owner/sentinel-backups"
  const backupBranch = process.env.BACKUP_BRANCH ?? 'main';
  const ghToken = process.env.GH_TOKEN;
  const encryptionKey = env.tokenEncryptionKey; // 32-byte base64

  if (!backupRepo || !ghToken || !encryptionKey) {
    console.error('Missing backup configuration: BACKUP_REPO, GH_TOKEN, TOKEN_ENCRYPTION_KEY required');
    await db.close();
    process.exit(1);
  }

  console.log(`Starting weekly encrypted backup at ${now.toISOString()}...`);
  console.log(`Backup destination: ${backupRepo}:${backupBranch}/${backupFile}`);

  try {
    // 1. Get database URL for pg_dump
    const databaseUrl = env.databaseUrl;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL not available');
    }

    // 2. Run pg_dump to stdout, pipe through gzip, then encrypt
    const pgDump = execFile('pg_dump', [
      '--no-owner',
      '--no-privileges',
      '--no-comments',
      '--format=plain',
      '--inserts',
      databaseUrl,
    ]);

    // 3. Encryption setup (AES-256-GCM)
    const key = Buffer.from(encryptionKey, 'base64');
    if (key.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (base64 encoded)');
    }
    const iv = randomBytes(12); // 96-bit IV for GCM
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    // 4. Pipeline: pg_dump -> gzip -> encrypt -> file
    const outputFile = join(backupDir, backupFile);
    const writeStream = createWriteStream(outputFile);
    
    // Write IV prefix (12 bytes) so decrypt knows it
    writeStream.write(iv);
    
    await pipeline(
      pgDump.stdout!,
      createGzip(),
      cipher,
      writeStream
    );

    // Get auth tag and append it
    const authTag = cipher.getAuthTag();
    writeStream.write(authTag);
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const { stat } = await import('node:fs/promises');
    const stats = await stat(outputFile);
    console.log(`Backup created: ${backupFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    // 5. Push to private GitHub repo
    const tmpDir = join(repoRoot, '.backup-tmp');
    await import('node:fs/promises').then(m => m.mkdir(tmpDir, { recursive: true }));
    await import('node:fs/promises').then(m => m.copyFile(outputFile, join(tmpDir, backupFile)));

    await execFileAsync('git', ['init'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Sentinel Backup Bot'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'sentinel@backup.local'], { cwd: tmpDir });
    await execFileAsync('git', ['remote', 'add', 'origin', `https://x-access-token:${ghToken}@github.com/${backupRepo}.git`], { cwd: tmpDir });
    await execFileAsync('git', ['fetch', 'origin', backupBranch, '--depth=1'], { cwd: tmpDir });
    await execFileAsync('git', ['checkout', backupBranch], { cwd: tmpDir });
    await execFileAsync('git', ['add', backupFile], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', `chore: weekly backup ${timestamp}`], { cwd: tmpDir });
    await execFileAsync('git', ['push', 'origin', `HEAD:${backupBranch}`], { cwd: tmpDir });

    console.log(`Backup pushed to ${backupRepo}:${backupBranch}`);

    // 6. Cleanup local backup files (keep only last 4)
    const files = await import('node:fs/promises').then(m => m.readdir(backupDir));
    const backupFiles = files
      .filter(f => f.startsWith('sentinel-backup-') && f.endsWith('.sql.gz.enc'))
      .sort()
      .reverse();
    for (const f of backupFiles.slice(4)) {
      await import('node:fs/promises').then(m => m.unlink(join(backupDir, f)));
      console.log(`Removed old backup: ${f}`);
    }

    // 7. Verify backup by restoring to isolated DB (optional, can be separate step)
    // For now, just log that restore verification should be done manually per runbook
    console.log('\n=== Backup complete ===');
    console.log(`File: ${backupFile}`);
    console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Destination: ${backupRepo}:${backupBranch}`);
    console.log('\nRestore verification: run `pnpm backup:restore <file>` on isolated DB per SETUP.md runbook');

  } catch (error) {
    console.error('Backup failed:', error);
    process.exit(1);
  }

  await db.close();
}