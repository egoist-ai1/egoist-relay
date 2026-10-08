import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(ROOT_DIR, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

if (!fs.existsSync(CLI_PATH)) {
  throw new Error('The local Tauri CLI is missing. Use the installed Egoist Relay app or install the project dependencies.');
}

// The native launcher owns WebView profiles, app proxy configuration and helper lifecycle
process.chdir(ROOT_DIR);
process.argv = [process.execPath, CLI_PATH, 'dev', ...process.argv.slice(2)];
await import(pathToFileURL(CLI_PATH).href);
