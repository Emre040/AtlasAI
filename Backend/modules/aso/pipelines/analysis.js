'use strict';

function compareTopLists(listA = [], listB = []) {
  const key = (row) => `${(row.gene || '').toUpperCase()}::${(row.ensembl || '').toUpperCase()}`;
  const setA = new Set(listA.map(key));
  const setB = new Set(listB.map(key));

  let overlap = 0;
  for (const k of setA) if (setB.has(k)) overlap++;
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union ? overlap / union : 0;

  return {
    counts: {
      listA: listA.length,
      listB: listB.length,
      overlap,
      union,
      jaccard
    }
  };
}

module.exports = { compareTopLists };
