'use strict';

// Merges normalized ASO datasets.

function makeKey(item) {
  const gene = (item.gene || '').toUpperCase();
  const ensg = (item.ensembl || '').toUpperCase();
  return `${gene}::${ensg}`;
}

function diffSets(setA = [], setB = [], topX = 20) {
  const mapA = new Map();
  const mapB = new Map();

  setA.forEach(item => mapA.set(makeKey(item), item));
  setB.forEach(item => mapB.set(makeKey(item), item));

  const onlyA = [];
  const onlyB = [];
  const both = [];

  for (const [key, item] of mapA.entries()) {
    if (mapB.has(key)) both.push(item);
    else onlyA.push(item);
  }
  for (const [key, item] of mapB.entries()) {
    if (!mapA.has(key)) onlyB.push(item);
  }

  const limit = Math.max(1, Math.min(topX || 20, 500));

  return {
    counts: { onlyA: onlyA.length, onlyB: onlyB.length, overlap: both.length },
    top: {
      onlyA: onlyA.slice(0, limit),
      onlyB: onlyB.slice(0, limit),
      overlap: both.slice(0, limit)
    }
  };
}

module.exports = { diffSets };
