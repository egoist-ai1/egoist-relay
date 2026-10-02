import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(packageJson.version)) throw new Error('Invalid release version');
const cargoPath = path.join(root, 'tauri/Cargo.toml');
const cargo = await readFile(cargoPath, 'utf8');
const updated = cargo.replace(/(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/, `$1"${packageJson.version}"`);
if (updated === cargo && !cargo.includes(`version = "${packageJson.version}"`)) throw new Error('Missing Cargo package version');
await writeFile(cargoPath, updated);
await writeFile(path.join(root, 'public/version.txt'), `${packageJson.version}\n`);
const lockPath = path.join(root, 'package-lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
lock.version = packageJson.version;
lock.packages[''].version = packageJson.version;
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
process.stdout.write(`Version synchronized: ${packageJson.version}. Update Cargo.lock with cargo check before release.\n`);
