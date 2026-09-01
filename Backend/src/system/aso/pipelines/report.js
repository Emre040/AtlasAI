'use strict';

// Builds final ASO report artifacts.

const path = require('path');
const fs = require('fs/promises');

function renderReport({ goal, workspaceUuid, artifacts, charts = [], conclusion = null }) {
  const lines = [];
  lines.push(`# ASO Report`);
  lines.push('');
  lines.push(`**Workspace:** ${workspaceUuid}`);
  lines.push('');
  lines.push(`**Objective:** ${goal || 'N/A'}`);
  lines.push('');

  const grouped = {
    dataset: [],
    measurement: [],
    tool_result: [],
    cleaned: [],
    analysis: [],
    figure: [],
    inspection: [],
    summary: []
  };
  for (const a of artifacts) {
    if (grouped[a.kind]) grouped[a.kind].push(a);
  }

  if (grouped.dataset.length) {
    lines.push('## Datasets');
    grouped.dataset.forEach((a, i) => {
      const label = a.summary?.label ? ` (${a.summary.label})` : '';
      const rows = a.summary?.row_count !== undefined ? ` rows=${a.summary.row_count}` : '';
      lines.push(`- Dataset ${i + 1}${label}:${rows} ${a.storage_uri}`);
    });
    lines.push('');
  }

  if (grouped.measurement.length) {
    lines.push('## Measurements');
    grouped.measurement.forEach((a, i) => {
      const label = a.summary?.label ? ` (${a.summary.label})` : '';
      const rows = a.summary?.row_count !== undefined ? ` rows=${a.summary.row_count}` : '';
      lines.push(`- Measurement ${i + 1}${label}:${rows} ${a.storage_uri}`);
    });
    lines.push('');
  }

  if (grouped.tool_result.length) {
    lines.push('## Tool Results');
    grouped.tool_result.forEach((a, i) => {
      lines.push(`- Tool result ${i + 1}: ${a.storage_uri}`);
    });
    lines.push('');
  }

  if (grouped.cleaned.length) {
    lines.push('## Cleaned Outputs');
    grouped.cleaned.forEach((a, i) => {
      lines.push(`- Cleaned ${i + 1}: ${a.storage_uri}`);
    });
    lines.push('');
  }

  if (grouped.analysis.length) {
    lines.push('## Analysis');
    grouped.analysis.forEach((a, i) => {
      lines.push(`- Analysis ${i + 1}: ${a.storage_uri}`);
    });
    lines.push('');
  }

  if (grouped.figure.length || charts.length) {
    lines.push('## Figures');
    charts.forEach((imgPath, i) => {
      const rel = imgPath;
      lines.push(`![Figure ${i + 1}](${rel})`);
      lines.push('');
    });
    grouped.figure.forEach((a, i) => {
      lines.push(`- Figure spec ${i + 1}: ${a.storage_uri}`);
    });
    lines.push('');
  }

  if (grouped.inspection.length) {
    lines.push('## Inspections');
    grouped.inspection.forEach((a, i) => {
      lines.push(`- Inspection ${i + 1}: ${a.storage_uri}`);
    });
    lines.push('');
  }

  if (conclusion) {
    lines.push('## Conclusion');
    if (Array.isArray(conclusion)) {
      conclusion.forEach(line => lines.push(`- ${line}`));
    } else {
      lines.push(conclusion);
    }
    lines.push('');
  }

  if (grouped.summary.length) {
    lines.push('## Summaries');
    grouped.summary.forEach((a, i) => {
      lines.push(`- Summary ${i + 1}: ${a.storage_uri}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

async function writeReport({ workspaceDir, goal, workspaceUuid, artifacts, charts, conclusion }) {
  const reportPath = path.join(workspaceDir, 'report.md');
  const content = renderReport({ goal, workspaceUuid, artifacts, charts, conclusion });
  await fs.writeFile(reportPath, content);
  return reportPath;
}

module.exports = { writeReport };
