import { promises as fs } from 'node:fs';
import path from 'node:path';

// Writes Phosphor glyphs over the font sources listed in `dev/icons-phosphor-map.json`.
// Usage: tsx ./dev/syncPhosphorIcons.ts <path to @phosphor-icons/core/assets>
// Map value: `<phosphor name>[:fill][@<scale>]`; Bold weight by default, `@scale` fits the optical size.
const PROJECT_ROOT = process.cwd();
const SOURCE_DIR = path.join(PROJECT_ROOT, 'src', 'assets', 'font-icons');
const MAP_PATH = path.join(PROJECT_ROOT, 'dev', 'icons-phosphor-map.json');
const GRID_SIZE = 256;
const MAP_VALUE_PATTERN = /^([a-z0-9-]+)(:fill)?(?:@(\d+(?:\.\d+)?))?$/;
const SVG_BODY_PATTERN = /<svg[^>]*>([\s\S]*)<\/svg>/;

async function collectSourcePaths(directoryPath: string): Promise<Map<string, string>> {
  const sourcePaths = new Map<string, string>();
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedPaths = await collectSourcePaths(fullPath);
      nestedPaths.forEach((nestedPath, name) => sourcePaths.set(name, nestedPath));
    } else if (entry.name.endsWith('.svg')) {
      sourcePaths.set(entry.name.replace(/\.svg$/, ''), fullPath);
    }
  }

  return sourcePaths;
}

function buildSvg(body: string, scale: number) {
  const size = GRID_SIZE / scale;
  const offset = (GRID_SIZE - size) / 2;
  const viewBox = scale === 1
    ? `0 0 ${GRID_SIZE} ${GRID_SIZE}`
    : `${offset.toFixed(3)} ${offset.toFixed(3)} ${size.toFixed(3)} ${size.toFixed(3)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
}

async function run() {
  const phosphorDir = process.argv[2];
  if (!phosphorDir) {
    throw new Error('Pass the path to @phosphor-icons/core/assets as the first argument.');
  }

  const iconMap = JSON.parse(await fs.readFile(MAP_PATH, 'utf8')) as Record<string, string>;
  const sourcePaths = await collectSourcePaths(SOURCE_DIR);

  for (const [relayName, value] of Object.entries(iconMap)) {
    const match = value.match(MAP_VALUE_PATTERN);
    const sourcePath = sourcePaths.get(relayName);
    if (!match || !sourcePath) {
      throw new Error(`Bad map entry "${relayName}": "${value}".`);
    }

    const [, phosphorName, fillFlag, scaleValue] = match;
    const weight = fillFlag ? 'fill' : 'bold';
    const phosphorPath = path.join(phosphorDir, weight, `${phosphorName}-${weight}.svg`);
    const phosphorSvg = await fs.readFile(phosphorPath, 'utf8');
    const body = phosphorSvg.match(SVG_BODY_PATTERN)?.[1];
    if (!body) {
      throw new Error(`Cannot read glyph body from "${phosphorPath}".`);
    }

    await fs.writeFile(sourcePath, buildSvg(body, scaleValue ? Number(scaleValue) : 1));
  }

  process.stdout.write(`Phosphor glyphs written: ${Object.keys(iconMap).length}\n`);
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
