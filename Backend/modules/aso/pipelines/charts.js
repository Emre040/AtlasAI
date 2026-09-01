'use strict';

function buildBasicComparisonCharts(analysis = {}) {
  const counts = analysis.counts || {};
  return {
    charts: [
      {
        type: 'bar',
        title: 'Top List Size Comparison',
        data: [
          { label: 'List A', value: counts.listA || 0 },
          { label: 'List B', value: counts.listB || 0 },
          { label: 'Overlap', value: counts.overlap || 0 }
        ]
      },
      {
        type: 'bar',
        title: 'Jaccard Similarity (Overlap / Union)',
        data: [
          { label: 'Jaccard', value: counts.jaccard || 0 }
        ]
      }
    ]
  };
}

module.exports = { buildBasicComparisonCharts };
