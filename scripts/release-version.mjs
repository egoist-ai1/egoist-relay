import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(packageJson.version)) throw new Error('Invalid release version');
for (const [directory, crate] of [['tauri', 'egoist_relay'], ['installer', 'beresta-setup']]) {
  const cargoPath = path.join(root, directory, 'Cargo.toml');
  const cargoLockPath = path.join(root, directory, 'Cargo.lock');
  const cargo = await readFile(cargoPath, 'utf8');
  const cargoLock = await readFile(cargoLockPath, 'utf8');
  const manifestVersion = /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/;
  const lockVersion = new RegExp(`(^name = "${crate}"\\r?\\nversion = )"[^"]+"`, 'm');
  if (!manifestVersion.test(cargo) || !lockVersion.test(cargoLock)) throw new Error(`Missing Cargo version for ${crate}`);
  const version = `$1"${packageJson.version}"`;
  await writeFile(cargoPath, cargo.replace(manifestVersion, version));
  await writeFile(cargoLockPath, cargoLock.replace(lockVersion, version));
}
await writeFile(path.join(root, 'public/version.txt'), `${packageJson.version}\n`);
const lockPath = path.join(root, 'package-lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
lock.version = packageJson.version;
lock.packages[''].version = packageJson.version;
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
process.stdout.write(`Application and installer versions synchronized: ${packageJson.version}\n`);
