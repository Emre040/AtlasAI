'use strict';

// Produces ranked ASO result subsets.

function rankTopX(normalizedRows = [], topX = 0) {
  // 0 = keep all
  const sliced = topX > 0 ? normalizedRows.slice(0, topX) : normalizedRows;
  const top = sliced.map((row, idx) => ({
    rank: idx + 1,
    gene: row.gene,
    ensembl: row.ensembl
  }));
  return top;
}

module.exports = { rankTopX };
