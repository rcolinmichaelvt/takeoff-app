import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

process.umask(0o077);
const destination = process.argv[2];
if (!destination) {
  console.error('Usage: npm run backup -- /absolute/path/to/new-backup.sqlite');
  process.exitCode = 1;
} else {
  let db, reserved = false;
  try {
    const source = path.join(path.resolve(process.env.DATA_DIR || './data'), 'takeoff.sqlite');
    if (!fs.existsSync(source)) throw new Error('No existing database to back up.');
    if (!path.isAbsolute(destination) || fs.existsSync(destination)) throw new Error('Choose a new absolute destination path; existing files are never overwritten.');
    fs.closeSync(fs.openSync(destination, 'wx', 0o600));
    reserved = true;
    db = new DatabaseSync(source, { readOnly: true });
    await backup(db, destination);
    fs.chmodSync(destination, 0o600);
    console.log('Consistent SQLite backup created. Keep an off-service copy.');
  } catch (error) {
    if (reserved) fs.rmSync(destination, { force: true });
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  } finally { db?.close(); }
}
