/**
 * Parse-checks every browser script in js/.
 *
 * Why this exists: `tsc --project tsconfig.check.json` only covers server/ and
 * prisma/. The front-end scripts in js/ were completely unchecked, so a single
 * missing comma between two adjacent string literals shipped to production and
 * took the entire home page offline — a SyntaxError stops the whole file from
 * parsing, which killed the scroll-reveal setup and left every .reveal element
 * stuck at opacity:0. A green typecheck said nothing was wrong.
 *
 * `node --check` is a pure parse with no type inference, so it reports exactly
 * the class of failure that blanked the site while producing no false positives
 * on untyped ES5-style browser code.
 */
import { execFile } from 'child_process';
import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = path.join(projectRoot, 'js');

async function collectScripts(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectScripts(full)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }

  return files.sort();
}

const files = await collectScripts(jsDir);

if (files.length === 0) {
  console.error('No .js files found in js/ — refusing to report success.');
  process.exit(1);
}

const failures = [];

for (const file of files) {
  try {
    await run(process.execPath, ['--check', file]);
  } catch (error) {
    // node --check prints the offending line and a caret to stderr.
    const detail = [error.stderr, error.stdout].filter(Boolean).join('\n').trim();
    failures.push({ file: path.relative(projectRoot, file), detail });
  }
}

if (failures.length > 0) {
  console.error(`\nFront-end syntax check FAILED — ${failures.length} of ${files.length} file(s):\n`);
  for (const { file, detail } of failures) {
    console.error(`  ${file}`);
    console.error(
      detail
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
    );
    console.error('');
  }
  console.error('A parse error here takes whole pages offline. Fix before deploying.\n');
  process.exit(1);
}

console.log(`Front-end syntax OK — ${files.length} file(s) parsed: ${files.map((f) => path.relative(projectRoot, f)).join(', ')}`);
