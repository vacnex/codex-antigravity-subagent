import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { blob, type Change } from './git.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

type Format = { bom: boolean; eol: 'crlf' | 'lf' | 'mixed' | 'none' };

function formatOf(buf: Buffer): Format {
  const text = buf.toString('latin1');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const eol = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
  return { bom: buf.subarray(0, 3).equals(BOM), eol };
}

/**
 * Put back each modified file's own BOM and line-ending style when agy changed them.
 * There is no project-wide rule to follow (TSDC mixes BOM and no-BOM .cs files), so the
 * file's previous state is the reference. Compares the checkpoint blob with the post
 * blob, both normalized by git the same way, so `core.autocrlf` cannot cause a false
 * repair. Files whose old line endings were mixed, binary files and new files are left
 * alone. Returns "file: what" descriptions of the repairs.
 */
export function restoreFileFormats(root: string, checkpoint: string, post: string, changed: Change[]): string[] {
  const repaired: string[] = [];
  for (const c of changed) {
    if (c.status !== 'M') continue;
    const before = blob(root, checkpoint, c.file);
    const after = blob(root, post, c.file);
    if (before.includes(0) || after.includes(0)) continue;
    const was = formatOf(before);
    const now = formatOf(after);
    const fixes: string[] = [];
    const abs = path.join(root, c.file);
    const raw = readFileSync(abs);
    let text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) continue; // not UTF-8: rewriting would corrupt it
    if (was.bom !== now.bom) {
      text = was.bom ? `﻿${text.replace(/^﻿/, '')}` : text.replace(/^﻿/, '');
      fixes.push(was.bom ? 'BOM restored' : 'BOM removed');
    }
    if ((was.eol === 'crlf' || was.eol === 'lf') && now.eol !== 'none' && now.eol !== was.eol) {
      text = text.replace(/\r\n/g, '\n');
      if (was.eol === 'crlf') text = text.replace(/\n/g, '\r\n');
      fixes.push(`line endings back to ${was.eol.toUpperCase()}`);
    }
    if (fixes.length === 0) continue;
    writeFileSync(abs, text, 'utf8');
    repaired.push(`${c.file} (${fixes.join(', ')})`);
  }
  return repaired;
}
