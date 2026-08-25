#!/usr/bin/env node
/**
 * Find a denied phrase that a line break has hidden.
 *
 *   node scripts/wrapped-scan.mjs <deny-file> <exclude-dir>...
 *
 * `git grep` matches within a line, which is fine for a word and useless for a phrase: the
 * moment an editor reflows a paragraph, a two-word place name ends up with its first word
 * closing one line and its second opening the next behind a comment leader. The deny audit
 * then reports clean, every time, while the phrase sits in the published tree — which is
 * exactly what had happened, undetected, for as long as the check had existed.
 *
 * So this joins every line before searching, dropping the comment leaders that sit between
 * the halves of a wrapped sentence.
 *
 * Only multi-word terms are worth this. A single word cannot be split by wrapping, and
 * git grep already reports it with a line number, which is more useful.
 *
 * Reads the working tree rather than the git object store, which is exact because publish.sh
 * refuses to run on a dirty tree — the thing being committed and the thing on disk are the
 * same bytes. Doing it in one process rather than three per file matters more than it
 * sounds: the shell version took over ten minutes on Windows and was abandoned.
 *
 * Exit 1 and print the matches if anything is found; exit 0 in silence otherwise.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [denyFile, ...excluded] = process.argv.slice(2);
if (!denyFile) {
  console.error('usage: wrapped-scan.mjs <deny-file> [exclude-dir...]');
  process.exit(2);
}

/** Terms with whitespace in them. The rest are already covered by the line-based scan. */
let terms = [];
try {
  terms = readFileSync(denyFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /\s/.test(line));
} catch {
  process.exit(0); // No deny list is not a failure; it is an install without one.
}
if (!terms.length) process.exit(0);

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((path) => !excluded.some((dir) => path === dir || path.startsWith(`${dir}/`)))
  // Binary files cannot hold a wrapped sentence and read as noise.
  .filter((path) => !/\.(png|jpe?g|ico|gif|webp|woff2?|ttf|eot|pdf|zip|gz|tgz|mp4|wasm)$/i.test(path));

const hits = [];
for (const path of files) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue;
  /*
    Newlines to spaces, then comment leaders, then runs of whitespace to one. A phrase whose
    two halves sit on either side of a line break becomes one phrase again; an ordinary
    sentence is unchanged apart from its spacing.

    No worked example here, deliberately. Writing one means writing a denied phrase into the
    tree this very script is meant to keep clean — which it duly caught when this file was
    first published, and which is a better demonstration than the comment would have been.
  */
  const flat = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(^|\s)(\*|\/\/|#|--)\s/g, '$1')
    .replace(/\s{2,}/g, ' ');
  const haystack = flat.toLowerCase();
  for (const term of terms) {
    const at = haystack.indexOf(term.toLowerCase());
    if (at < 0) continue;
    // Only report what the line-based scan would have missed, so a plain occurrence is not
    // announced twice under two different headings.
    if (text.toLowerCase().includes(term.toLowerCase())) continue;
    hits.push({ term, path, context: flat.slice(Math.max(0, at - 45), at + term.length + 45).trim() });
  }
}

if (!hits.length) process.exit(0);

for (const hit of hits) {
  console.error(`\n!! denied string across a line break: ${hit.term}`);
  console.error(`   ${hit.path}: …${hit.context}…`);
}
process.exit(1);
