import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { transaction } from './database.js';
import { latestSchemaVersion } from './migrations.js';

// Prepare a NEW offline copy. Never modify the source backup or a live database.
export async function prepareRestore(source, destination, now = Date.now()) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination) || !fs.existsSync(source)) {
    throw new Error('Use an existing absolute source path and a new absolute destination path.');
  }
  if (fs.existsSync(destination)) throw new Error('The restore destination must not already exist.');
  let input, output, reserved = false;
  try {
    input = new DatabaseSync(source, { readOnly: true });
    if (![1, 2, 3, 4, latestSchemaVersion].includes(input.prepare('PRAGMA user_version').get().user_version) ||
        input.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        input.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Backup integrity or schema validation failed.');
    }
    // Reserve exclusively with private permissions before copying sensitive data.
    fs.closeSync(fs.openSync(destination, 'wx', 0o600));
    reserved = true;
    await backup(input, destination);
    output = new DatabaseSync(destination);
    output.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;');
    transaction(output, () => {
      output.exec('DELETE FROM access_tokens; DELETE FROM refresh_tokens; DELETE FROM sessions;');
      output.exec('DELETE FROM oauth_flows; DELETE FROM login_codes; DELETE FROM request_nonces;');
      // Reauthentication is mandatory. Also protect against rolled-back transfer times.
      output.prepare('UPDATE users SET next_transfer_at = MAX(next_transfer_at, ?)')
        .run(now + 6 * 60 * 60_000);
      output.prepare('INSERT INTO audit_events (discord_id, kind, created_at) VALUES (?, ?, ?)')
        .run('system', 'backup_prepared_sessions_invalidated', now);
    });
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    output?.close();
    output = undefined;
    if (reserved) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(destination + suffix, { force: true });
    }
    throw error;
  } finally {
    input?.close();
    output?.close();
  }
}
