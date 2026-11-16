import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export function localIngestionKey() {
  if (process.env.INCIDENTLAB_INGESTION_KEY) {
    if (process.env.INCIDENTLAB_INGESTION_KEY.length < 24) throw new Error('INCIDENTLAB_INGESTION_KEY must contain at least 24 characters');
    return process.env.INCIDENTLAB_INGESTION_KEY;
  }
  const directory = join(projectRoot, 'data');
  const file = join(directory, 'ingestion-key');
  mkdirSync(directory, { recursive: true });
  try { writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = readFileSync(file, 'utf8').trim();
  if (key.length < 24) throw new Error('Local ingestion key is invalid');
  return key;
}
