'use strict';

const fs = require('node:fs');
const { load } = require('cheerio');

const ENTRY = Buffer.from('<entry');
const CLASSES_END = Buffer.from('</proteinClasses>');
const ENTRY_END = Buffer.from('</entry>');

// HPA places identifiers and proteinClasses before the large expression/image sections.
// Stream the raw XML, parse those metadata subtrees, and discard the remaining entry body.
// This reads the imported file directly; no rewritten source or prepared gene list is needed.
async function readProteinClasses(filePath) {
  const classes = new Map();
  const genes = new Map();
  let state = 'entry';
  let pending = Buffer.alloc(0);

  function record(header) {
    const $ = load(`${header.toString('utf8')}</entry>`, { xmlMode: true });
    const entry = $('entry');
    const ensembl = entry.children('identifier[db="Ensembl"]').attr('id');
    if (entry.length !== 1 || !ensembl || entry.children('proteinClasses').length !== 1) {
      throw new Error('The imported HPA XML has an entry without an Ensembl identifier or proteinClasses');
    }
    if (genes.has(ensembl)) throw new Error(`The imported HPA XML repeats entry ${ensembl}`);
    const membership = new Set();
    entry.children('proteinClasses').children('proteinClass').each((_, node) => {
      const { id, parent_id: parent, name, source } = node.attribs;
      if (!id || !name || parent === undefined) throw new Error(`Incomplete proteinClass metadata for ${ensembl}`);
      const previous = classes.get(id);
      if (previous && (previous.name !== name || previous.parent !== parent)) throw new Error(`Conflicting HPA proteinClass definition for ${id}`);
      classes.set(id, { id, parent, name, source });
      membership.add(id);
    });
    genes.set(ensembl, membership);
  }

  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 1 << 20 })) {
    let buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    pending = Buffer.alloc(0);
    for (;;) {
      if (state === 'entry') {
        const start = buffer.indexOf(ENTRY);
        if (start === -1) { pending = buffer.subarray(Math.max(0, buffer.length - ENTRY.length)); break; }
        buffer = buffer.subarray(start);
        state = 'classes';
      }
      if (state === 'classes') {
        const end = buffer.indexOf(CLASSES_END);
        const entryEnd = buffer.indexOf(ENTRY_END);
        if (entryEnd !== -1 && (end === -1 || entryEnd < end)) throw new Error('An imported HPA XML entry is missing proteinClasses');
        if (end === -1) { pending = buffer; break; }
        const after = end + CLASSES_END.length;
        record(buffer.subarray(0, after));
        buffer = buffer.subarray(after);
        state = 'body';
      }
      if (state === 'body') {
        const end = buffer.indexOf(ENTRY_END);
        if (end === -1) { pending = buffer.subarray(Math.max(0, buffer.length - ENTRY_END.length)); break; }
        buffer = buffer.subarray(end + ENTRY_END.length);
        state = 'entry';
      }
    }
  }
  if (state !== 'entry' || !genes.size) throw new Error('The imported HPA XML is incomplete or contains no gene entries');
  return { classes, genes };
}

module.exports = { readProteinClasses };
