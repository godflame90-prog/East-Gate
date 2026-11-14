/**
 * Builds `www/` — the web bundle the Capacitor app ships inside the APK.
 *
 * Why a copy step instead of pointing Capacitor at the project root: the root
 * also holds `server/`, `node_modules/`, `prisma/` and `uploads/`, and
 * `cap sync` copies the whole web directory into the native project. Pointing
 * it at the root would push tens of thousands of dependency files into the APK
 * and still not publish anything the app actually needs.
 *
 * `uploads/` is deliberately left out: dealer galleries are written to disk by
 * the running server and are fetched from it over HTTP, so a snapshot inside
 * the APK would be stale the moment a dealer uploads a new photo.
 *
 * Run through `npm run app:sync`, which also hands the result to Capacitor.
 */
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(projectRoot, 'www');

const DIRECTORIES = ['css', 'js', 'images'];

/** Static files at the project root that belong to the site, not the server. */
const FILES = ['robots.txt'];

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const entries = await readdir(projectRoot);
  const pages = entries.filter((entry) => entry.endsWith('.html')).sort();

  for (const page of pages) {
    await cp(path.join(projectRoot, page), path.join(outDir, page));
  }

  for (const file of FILES) {
    if (await isFile(path.join(projectRoot, file))) {
      await cp(path.join(projectRoot, file), path.join(outDir, file));
    }
  }

  for (const dir of DIRECTORIES) {
    await cp(path.join(projectRoot, dir), path.join(outDir, dir), { recursive: true });
  }

  console.log(`Built www/ — ${pages.length} page(s) plus ${DIRECTORIES.join(', ')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? err.message : error);
  process.exitCode = 1;
});
