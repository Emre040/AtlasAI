'use strict';

/**
 * What the Human Protein Atlas says its own search categories mean. Quoted or condensed from
 * the atlas's documentation pages (sources below), so an agent reading the schema can reason
 * from the database's definitions rather than from the option names alone.
 */

const SOURCES = [
  'https://www.proteinatlas.org/humanproteome/tissue/tissue+specific',
  'https://www.proteinatlas.org/humanproteome/tissue/housekeeping',
  'https://www.proteinatlas.org/humanproteome/brain',
  'https://www.proteinatlas.org/humanproteome/single+cell',
  'https://www.proteinatlas.org/about/antibodies'
];

// Definitions keyed by option name; the same specificity and distribution wording is applied by
// the atlas to tissues, brain regions, single cell types, immune cells, cancers and cell lines.
const OPTIONS = {
  'Tissue enriched': 'At least four-fold higher mRNA level in a particular tissue compared to any other tissue.',
  'Region enriched': 'At least four-fold higher mRNA level in a particular brain region compared to any other region.',
  'Cell type enriched': 'At least four-fold higher mRNA level in a particular cell type compared to any other cell type.',
  'Immune cell enriched': 'At least four-fold higher mRNA level in a particular immune cell type compared to any other immune cell type.',
  'Lineage enriched': 'At least four-fold higher mRNA level in a particular immune cell lineage compared to any other lineage.',
  'Cancer enriched': 'At least four-fold higher mRNA level in a particular cancer type compared to any other cancer type.',
  'Cell line enriched': 'At least four-fold higher mRNA level in a particular cell line compared to any other cell line.',
  'Group enriched': 'At least four-fold higher average mRNA level in a group of 2-5 tissues, regions or cell types compared to all others. A gene group enriched in a set carries this category for every member of the set.',
  'Tissue enhanced': 'At least four-fold higher mRNA level in a particular tissue compared to the average level in all other tissues.',
  'Region enhanced': 'At least four-fold higher mRNA level in a particular brain region compared to the average of all other regions.',
  'Cell type enhanced': 'At least four-fold higher mRNA level in a particular cell type compared to the average of all other cell types.',
  'Immune cell enhanced': 'At least four-fold higher mRNA level in a particular immune cell type compared to the average of all others.',
  'Lineage enhanced': 'At least four-fold higher mRNA level in a particular lineage compared to the average of all other lineages.',
  'Cancer enhanced': 'At least four-fold higher mRNA level in a particular cancer compared to the average of all other cancers.',
  'Low tissue specificity': 'Detected (at least 1 nTPM) in at least one tissue and not elevated anywhere: none of the enriched, group enriched or enhanced categories apply.',
  'Low region specificity': 'Detected in at least one region and not elevated in any.',
  'Low cell type specificity': 'Detected in at least one cell type and not elevated in any.',
  'Low immune cell specificity': 'Detected in at least one immune cell type and not elevated in any.',
  'Low lineage specificity': 'Detected in at least one lineage and not elevated in any.',
  'Low cancer specificity': 'Detected in at least one cancer type and not elevated in any.',
  'Not detected': 'mRNA below the detection cut-off of 1 nTPM. With a specific tissue, region or cell type selected: below 1 nTPM in that one; with none selected: below 1 nTPM in all of them.',
  'Detected in all': 'Detected (at least 1 nTPM) in every tissue, region or cell type of the dataset.',
  'Detected in many': 'Detected in at least a third of the tissues, regions or cell types, but not in all.',
  'Detected in some': 'Detected in more than one but fewer than a third of the tissues, regions or cell types.',
  'Detected in single': 'Detected in a single tissue, region or cell type only.',
  'Is highest expressed': 'The selected tissue, region or cell type is where this gene has its highest mRNA level. Not a specificity category: the gene may be broadly expressed.',
  'Tau score': 'A specificity measure between 0 and 1 that does not depend on expression cut-offs: 0 means broadly expressed, 1 means expression confined to one tissue, region or cell type. Bins of 0.1.',
  'Favorable - validated prognostic': 'Higher expression is associated with longer patient survival in this cancer, and the association held in a validation analysis.',
  'Favorable - potential prognostic': 'Higher expression is associated with longer patient survival in this cancer (Kaplan-Meier, log-rank p below 0.001), not validated.',
  'Unfavorable - validated prognostic': 'Higher expression is associated with shorter patient survival in this cancer, and the association held in a validation analysis.',
  'Unfavorable - potential prognostic': 'Higher expression is associated with shorter patient survival in this cancer (log-rank p below 0.001), not validated.',
  Enhanced: 'Antibody reliability: the highest score, given when the staining pattern is supported by orthogonal or independent-antibody validation.',
  Supported: 'Antibody reliability: staining consistent with experimental data or literature, without the validation needed for Enhanced.',
  Approved: 'Antibody reliability: staining partly consistent with available data; interpret with some caution.',
  Uncertain: 'Antibody reliability: staining could not be corroborated; may be unspecific.',
  High: 'Immunohistochemistry: strong staining intensity in more than a quarter of the cells.',
  Medium: 'Immunohistochemistry: moderate staining, or strong staining in fewer cells.',
  Low: 'Immunohistochemistry: weak staining, or moderate staining in fewer cells.',
  'Main location': 'The compartment is the main annotated location of the protein by immunofluorescence.',
  'Additional location': 'The compartment is an additional, not main, annotated location.',
  Multilocalizing: 'The protein is annotated in more than one compartment.',
  'Single cell variation': 'Staining intensity or spatial pattern varies between individual cells of the same cell line.',
  'Cell cycle dependent protein': 'Protein level in the compartment varies with the cell cycle.',
  'Secreted to blood': 'Secretome annotation: the protein is secreted and its main destination is the bloodstream.',
  'Secreted to extracellular matrix': 'Secretome annotation: secreted and incorporated into the extracellular matrix.',
  'Secreted to digestive system': 'Secretome annotation: secreted into the digestive tract.',
  'Secreted in brain': 'Secretome annotation: secreted locally within the brain.',
  'Secreted in male reproductive system': 'Secretome annotation: secreted locally within the male reproductive system.',
  'Secreted in female reproductive system': 'Secretome annotation: secreted locally within the female reproductive system.',
  'Secreted in other tissues': 'Secretome annotation: secreted locally in other tissues.',
  'Secreted - unknown location': 'Secretome annotation: predicted secreted, destination unknown.',
  'Intracellular and membrane': 'Secretome annotation: predicted secreted, but the protein is intracellular or membrane-bound.',
  'Immunoglobulin genes': 'Secretome annotation: immunoglobulin genes.',
  'Evidence at protein level': 'The protein has been detected experimentally (mass spectrometry, antibody or literature).',
  'Evidence at transcript level': 'Only the transcript has been detected.',
  'No human protein/transcript evidence': 'Neither protein nor transcript evidence.'
};

// Definitions keyed by field name, for what the field as a whole measures.
const FIELDS = {
  'Tissue category (RNA)': 'RNA specificity and distribution across 36 human tissue types (consensus of HPA and GTEx RNA-seq), classified per gene.',
  'Tissue Tau score (RNA)': 'Tau specificity score across tissues, binned.',
  'Tissue expression cluster (RNA)': 'Co-expression clusters of genes across tissues, named after the dominant tissue and function.',
  'Tissue expression (IHC)': 'Antibody staining (immunohistochemistry) per tissue and cell type, at levels Not detected, Low, Medium, High.',
  'Reliability score tissue (IHC)': 'Reliability score of the tissue antibody staining.',
  'Secretome annotation': 'Predicted secreted proteins classified by their destination.',
  'Brain region category (RNA)': 'RNA specificity and distribution across 13 human brain regions.',
  'Brain Tau score (RNA)': 'Tau specificity score across human brain regions, binned.',
  'Mouse brain category (RNA)': 'RNA specificity and distribution across mouse brain regions.',
  'Pig brain category (RNA)': 'RNA specificity and distribution across pig brain regions.',
  'Brain expression cluster (RNA)': 'Co-expression clusters of genes across brain regions.',
  'Cell type category (scRNA)': 'RNA specificity and distribution across 81 single cell types (single-cell RNA-seq).',
  'Cell type enrichment (RNA)': 'Cell types within a given tissue in which the gene is enriched.',
  'Brain region cell type (scRNA)': 'RNA specificity across cell clusters of the brain from single-nuclei sequencing.',
  'Immune cell category (RNA)': 'RNA specificity and distribution across 18 flow-sorted immune cell types from blood.',
  'Immune cell lineage category (RNA)': 'RNA specificity across the 6 immune cell lineages (B, T, NK, monocytes, granulocytes, dendritic cells).',
  'Subcellular location (ICC)': 'Compartment where the protein is seen by immunofluorescence in cell lines, with reliability and annotation classes.',
  'Predicted location': 'Prediction from sequence: intracellular, membrane or secreted.',
  'Subcellular Cell Cycle Peak Phase': 'Cell-cycle phase in which the protein or transcript level peaks.',
  'Cancer category (RNA)': 'RNA specificity and distribution across TCGA cancer cohorts.',
  'Prognostic cancer': 'Association between expression and patient survival per TCGA cancer cohort.',
  'Cell line category (RNA)': 'RNA specificity and distribution across cell lines grouped by origin.',
  'Protein class': 'Gene classes: enzymes, transporters, transcription factors, disease genes, drug targets, predicted location classes. A subclass narrows a class (kinases within enzymes; a disease group within human disease related genes).',
  Chromosome: 'Chromosome carrying the gene.',
  'Evidence summary': 'Best available evidence that the gene product exists.',
  'Protein interaction count': 'Number of known protein interactions, binned.'
};

module.exports = { SOURCES, OPTIONS, FIELDS };
