'use strict';

const FIGURES_SCHEMA = { type: 'array', items: { type: 'string' }, description: 'Ordered saved figure artifact IDs to include in the final report and chart export. Choose corrected final figures; every workspace artifact remains accessible. Omit to include all figures; [] includes none.' };

function selectFigures(artifacts, ids, identify = artifact => artifact.id) {
  if (ids === undefined) return artifacts.filter(artifact => artifact.kind === 'figure');
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('finish.figures must be an array of saved figure artifact IDs');
  if (new Set(ids).size !== ids.length) throw new Error('finish.figures must not repeat artifact IDs');
  const byId = new Map(artifacts.map(artifact => [identify(artifact), artifact]));
  return ids.map(id => {
    const artifact = byId.get(id);
    if (!artifact || artifact.kind !== 'figure') throw new Error(`finish.figures ${id} must name a saved figure artifact`);
    return artifact;
  });
}

// Both HTTP image export paths use the same final selection. The complete artifact
// list remains available for workspace inspection and independent reproducibility.
function reportFigureArtifacts(result) {
  return selectFigures(result.artifacts, result.report_figures, artifact => artifact.summary?.id);
}

module.exports = { FIGURES_SCHEMA, selectFigures, reportFigureArtifacts };
