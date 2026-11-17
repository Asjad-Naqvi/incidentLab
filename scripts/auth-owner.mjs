import { createInterface,emitKeypressEvents } from 'node:readline';
import { stdin,stdout } from 'node:process';
import { openStore } from '../lib/open-store.mjs';
import { hashPassword,normalizeUsername } from '../lib/auth.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '../lib/config.mjs';

function question(prompt) {
  const rl = createInterface({ input: stdin,output: stdout });
  return new Promise(resolve => rl.question(prompt,answer => { rl.close(); resolve(answer); }));
}
function secret(prompt) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Run this command in an interactive terminal; passwords are never accepted as command-line arguments');
  stdout.write(prompt); emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume();
  return new Promise((resolve,reject) => {
    let value = '';
    const finish = () => { stdin.off('keypress',onKey); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
    const onKey = (text,key = {}) => {
      if (key.ctrl && key.name === 'c') { finish(); reject(new Error('Cancelled')); }
      else if (key.name === 'return' || key.name === 'enter') { finish(); resolve(value); }
      else if (key.name === 'backspace') value = [...value].slice(0,-1).join('');
      else if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f]/.test(text)) value += text;
    };
    stdin.on('keypress',onKey);
  });
}

let store;
try {
  if (!stdin.isTTY) throw new Error('Run owner setup in an interactive terminal');
  let configuration = process.env;
  if (process.argv.includes('--local-postgres')) {
    let localConfig;
    try { localConfig = JSON.parse(await readFile(join(projectRoot,'data','postgres-local.json'),'utf8')); }
    catch { throw new Error('Local PostgreSQL configuration unavailable. Start dev:postgres first.'); }
    const { password } = localConfig;
    if (typeof password !== 'string' || !/^[a-f0-9]{48}$/.test(password)) throw new Error('Invalid local PostgreSQL configuration');
    configuration = { ...process.env,DATABASE_URL: `postgresql://incidentlab:${password}@127.0.0.1:${process.env.PG_DEV_PORT || 54329}/incidentlab` };
  }
  store = await openStore(configuration);
  const reset = process.argv.includes('--reset');
  if (!reset && await store.ownerCount()) throw new Error('Owner already exists. Use npm.cmd run auth:password for local account recovery.');
  const username = normalizeUsername(await question('Workspace owner username: '));
  const password = await secret(reset ? 'New password (12–128 characters, hidden): ' : 'Password (12–128 characters, hidden): ');
  if (password !== await secret('Confirm password (hidden): ')) throw new Error('Passwords do not match');
  const passwordHash = await hashPassword(password);
  if (reset) await store.replaceOwnerPassword(username,passwordHash);
  else await store.createOwner(username,passwordHash);
  console.log(reset ? 'Owner password changed. All existing sessions were revoked.' : 'Workspace owner created. You can now sign in through /login.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await store?.close(); }
