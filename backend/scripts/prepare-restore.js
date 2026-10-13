import { prepareRestore } from '../src/recovery.js';

process.umask(0o077);
const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  console.error('Usage: npm run prepare-restore -- /absolute/backup.sqlite /absolute/new-restore.sqlite');
  process.exitCode = 1;
} else {
  try {
    await prepareRestore(source, destination);
    console.log('Offline restore copy prepared. All old sessions are invalidated; device transfers are held for at least six hours.');
    console.log('The live database has NOT changed. Follow SETUP.md before replacing it.');
  } catch (error) {
    console.error(`Restore preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
