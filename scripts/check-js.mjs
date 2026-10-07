/**
 * Parse-checks every browser script: the files in js/ plus every inline
 * <script> block in the site's HTML pages.
 *
 * Why this exists: `tsc --project tsconfig.check.json` only covers server/ and
 * prisma/. The front-end scripts in js/ were completely unchecked, so a single
 * missing comma between two adjacent string literals shipped to production and
 * took the entire home page offline — a SyntaxError stops the whole file from
 * parsing, which killed the scroll-reveal setup and left every .reveal element
 * stuck at opacity:0. A green typecheck said nothing was wrong.
 *
 * Inline blocks earned their own pass for the same reason, in worse shape: the
 * dealer portal's sidebar handlers live inside an inline script, and a
 * half-deleted fallback branch left an unbalanced `});` there. The whole block
 * failed to parse, so every tab button silently did nothing — "the sidebar is
 * frozen" — while js/*.js stayed green because nothing looked at the HTML.
 *
 * `node --check` is a pure parse with no type inference, so it reports exactly
 * the class of failure that takes pages offline while producing no false
 * positives on untyped ES5-style browser code.
 */
import { execFile } from 'child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = path.join(projectRoot, 'js');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

async function collectFiles(dir, extension) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await collectFiles(path.join(dir, entry.name), extension)));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(path.join(dir, entry.name));
    }
  }

  return files.sort();
}

/**
 * Returns [{ code, line, isModule }] for each executable inline <script> block.
 * Blocks with a src= attribute belong to js/ (or a CDN) and are skipped, as are
 * non-script payloads such as JSON-LD.
 */
function inlineScripts(html) {
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const attrs = match[1] || '';
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : '';

    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (type && type !== 'text/javascript' && type !== 'module') continue;
    if (!match[2].trim()) continue;

    scripts.push({
      code: match[2],
      line: html.slice(0, match.index).split('\n').length,
      isModule: type === 'module'
    });
  }

  return scripts;
}

const failures = [];
const jsFiles = await collectFiles(jsDir, '.js');

if (jsFiles.length === 0) {
  console.error('No .js files found in js/ — refusing to report success.');
  process.exit(1);
}

for (const file of jsFiles) {
  try {
    await run(process.execPath, ['--check', file]);
  } catch (error) {
    // node --check prints the offending line and a caret to stderr.
    const detail = [error.stderr, error.stdout].filter(Boolean).join('\n').trim();
    failures.push({ file: path.relative(projectRoot, file), detail });
  }
}

const htmlFiles = await collectFiles(projectRoot, '.html');
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'eastgate-check-'));
let inlineCount = 0;

try {
  for (const file of htmlFiles) {
    const html = await readFile(file, 'utf8');

    for (const [index, script] of inlineScripts(html).entries()) {
      inlineCount += 1;
      // --check infers module vs script from the extension.
      const tempFile = path.join(tempDir, `inline-${index}${script.isModule ? '.mjs' : '.js'}`);
      await writeFile(tempFile, script.code);

      try {
        await run(process.execPath, ['--check', tempFile]);
      } catch (error) {
        const detail = [error.stderr, error.stdout].filter(Boolean).join('\n').trim();
        failures.push({
          file: `${path.relative(projectRoot, file)} (inline script at line ${script.line})`,
          detail
        });
      }
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

if (htmlFiles.length === 0) {
  console.error('No .html files found — refusing to report success.');
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\nFront-end syntax check FAILED — ${failures.length} problem(s):\n`);
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

console.log(
  `Front-end syntax OK — ${jsFiles.length} file(s) in js/ plus ${inlineCount} inline script(s) across ${htmlFiles.length} page(s) parsed`
);
