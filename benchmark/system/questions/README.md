# Benchmark questions

The canonical catalog is [questions.json](questions.json). All question wording is preserved; IDs run from Q1 to Q45.

| Question | Title | Type | Difficulty |
| --- | --- | --- | --- |
| [Q1](#q1) | Liver-enriched genes | Data query | Easy |
| [Q2](#q2) | ALB tissue expression | Data query | Easy |
| [Q3](#q3) | Kidney cancer prognosis counts | Data query | Easy |
| [Q4](#q4) | Pancreas secretion and liver detection | Data query | Medium |
| [Q5](#q5) | Enzyme and transporter cohort overlap | Analysis | Hard |
| [Q6](#q6) | TP53 partners and annotations | Analysis | Medium |
| [Q7](#q7) | Prognostic genes across cancers | Analysis | Medium |
| [Q8](#q8) | Blood-assay disagreement | Analysis | Hard |
| [Q9](#q9) | Brain-region expression profiles | Analysis | Hard |
| [Q10](#q10) | Liver prognosis intersection with conditional plots | Negative test | Medium |
| [Q11](#q11) | Liver prognosis intersection | Negative test | Medium |
| [Q12](#q12) | ALB half-life provenance | Negative test | Easy |
| [Q13](#q13) | Three-tissue cohort comparison | Analysis | Hard |
| [Q14](#q14) | Transcription factors by cell type | Analysis | Medium |
| [Q15](#q15) | Blood assays in liver-enriched proteins | Analysis | Hard |
| [Q16](#q16) | Interaction partners of liver-enriched genes | Analysis | Medium |
| [Q17](#q17) | Immune-lineage cohort comparison | Analysis | Hard |
| [Q18](#q18) | Hypothalamus expression contrasts | Analysis | Medium |
| [Q19](#q19) | Heart-enzyme filtering workflow | Negative test | Medium |
| [Q20](#q20) | Prognosis and tissue-of-origin enrichment | Analysis | Medium |
| [Q21](#q21) | Tissue-enrichment composition | Analysis | Medium |
| [Q22](#q22) | Atlas release and coverage | Documentation | Easy |
| [Q23](#q23) | Atlas origins | Documentation | Easy |
| [Q24](#q24) | Latest atlas news | Documentation | Easy |
| [Q25](#q25) | Antibody validation methods | Documentation | Easy |
| [Q26](#q26) | Licence and subcellular citation | Documentation | Easy |
| [Q27](#q27) | RNA-protein fold-change agreement | Analysis | Hard |
| [Q28](#q28) | Protein changes across cancers | Analysis | Hard |
| [Q29](#q29) | Autoimmune-disease protein changes | Analysis | Hard |
| [Q30](#q30) | Single-cell RNA-protein agreement | Analysis | Hard |
| [Q31](#q31) | HPA and GTEx reproducibility | Analysis | Hard |
| [Q32](#q32) | Two-step interaction networks | Analysis | Hard |
| [Q33](#q33) | Paired donor expression changes | Analysis | Hard |
| [Q34](#q34) | Normal and cancer staining | Analysis | Hard |
| [Q35](#q35) | Prognostic replication | Analysis | Hard |
| [Q36](#q36) | Cell-line signature agreement | Analysis | Hard |
| [Q37](#q37) | Tissue enrichment with unspecified modality | Ambiguity handling | Medium |
| [Q38](#q38) | Tissue enrichment with explicit RNA definitions | Analysis | Hard |
| [Q39](#q39) | Expression with unspecified threshold | Ambiguity handling | Medium |
| [Q40](#q40) | Expression with an explicit threshold | Analysis | Hard |
| [Q41](#q41) | Prognosis with unspecified evidence scope | Ambiguity handling | Medium |
| [Q42](#q42) | Prognosis with explicit evidence scope | Analysis | Hard |
| [Q43](#q43) | Missing protein measurements and biological absence | Negative test | Hard |
| [Q44](#q44) | Relative assays and absolute molecule counts | Negative test | Hard |
| [Q45](#q45) | Prognostic associations and treatment benefit | Negative test | Hard |

Difficulty: **9 Easy, 14 Medium, 22 Hard**. See [the rubric](difficulty.md).

There are five documentation questions, three ambiguity/explicit pairs, and seven negative prompts across six negative-test families. Q10/Q11 share one empty-cohort family. Paired questions are separate fresh conversations.

## Q1

**Liver-enriched genes** — Easy; Data query.

How many genes does the Human Protein Atlas classify as tissue enriched in liver (RNA tissue specificity)? List the first ten of them alphabetically by gene symbol.

## Q2

**ALB tissue expression** — Easy; Data query.

According to the Human Protein Atlas consensus RNA data, which five tissues have the highest ALB expression? Give the nTPM values.

## Q3

**Kidney cancer prognosis counts** — Easy; Data query.

In the Human Protein Atlas cancer prognostics for the TCGA kidney renal clear cell carcinoma cohort, how many genes are validated prognostic favourable, and how many are validated prognostic unfavourable?

## Q4

**Pancreas secretion and liver detection** — Medium; Data query.

Which proteins secreted to blood are tissue enriched in pancreas at the RNA level but not detected in liver? Give the count and the gene symbols.

## Q5

**Enzyme and transporter cohort overlap** — Hard; Analysis.

Take two cohorts: enzymes with enhanced RNA expression in pancreas, and transporters with enriched RNA expression in kidney. For each cohort give its size. Test whether the two cohorts overlap more than expected by chance against all genes in the atlas (hypergeometric). For each cohort give the mean consensus nTPM in pancreas and in kidney. Draw a scatter of pancreas nTPM against kidney nTPM for every gene, coloured by cohort. Provide the table behind the figure.

## Q6

**TP53 partners and annotations** — Medium; Analysis.

Take the interaction partners of TP53 in the Human Protein Atlas. How many are there? Give the distribution of their main subcellular location as a bar chart and the fraction whose main location includes the nucleus. Which of the partners have a validated prognostic association (favourable or unfavourable) in any TCGA cancer cohort? Provide the table.

## Q7

**Prognostic genes across cancers** — Medium; Analysis.

For the TCGA cancer cohorts in the HPA cancer prognostics, give a grouped bar chart of the number of validated favourable versus validated unfavourable prognostic genes per cancer, a dot plot of the ten cancers with the most prognostic genes in total, and the table behind both.

## Q8

**Blood-assay disagreement** — Hard; Analysis.

For proteins that have a blood concentration by both immunoassay and mass spectrometry, compute log10 of each concentration and plot immunoassay against mass spectrometry as a scatter coloured by secretome location. Then a diverging bar chart of the log10 ratio (immunoassay over mass spectrometry) for the fifteen most discordant proteins, and a bar chart of how many proteins fall in each secretome location. Provide the table.

## Q9

**Brain-region expression profiles** — Hard; Analysis.

Take the genes with region-enriched RNA expression in cerebellum and those region-enriched in cerebral cortex. Give the size of each set. Compute the Spearman correlation of nTPM across all brain regions between the two sets' mean profiles. Draw a heatmap of the twenty cerebellum-enriched genes with the highest cerebellum nTPM across all brain regions. Provide the table.

## Q10

**Liver prognosis intersection with conditional plots** — Medium; Negative test.

Take the genes with a validated unfavourable prognosis in liver hepatocellular carcinoma (TCGA) that are also tissue enriched in liver at the RNA level. For those genes give a bar chart of how many belong to each protein class, a scatter of liver nTPM against the prognostic p-value with gene labels and both axes on a log scale, a heatmap of their nTPM across liver, kidney, pancreas, colon and lung, and the table behind the figures.

Negative test: empty_intersection. Expected behaviour: Establish the specified empty cohort; do not invent rows or plots.

Shares the same empty-cohort task family with Q11.

## Q11

**Liver prognosis intersection** — Medium; Negative test.

Which genes have a validated unfavourable prognosis in liver hepatocellular carcinoma (TCGA) in the Human Protein Atlas and are also classified as tissue enriched in liver at the RNA level?

Negative test: empty_intersection. Expected behaviour: Establish the specified empty cohort using a valid comparison.

Shares the same empty-cohort task family with Q10.

## Q12

**ALB half-life provenance** — Easy; Negative test.

What is the protein half-life of ALB according to the Human Protein Atlas?

Negative test: unreported_measurement. Expected behaviour: Do not invent or falsely attribute a protein half-life to HPA.

## Q13

**Three-tissue cohort comparison** — Hard; Analysis.

Take the genes tissue enriched in liver, in kidney, and in pancreas as three cohorts. For each cohort give its size, the share of genes secreted to blood, the share with a validated favourable prognosis in the matching TCGA cancer (liver hepatocellular carcinoma, kidney renal clear cell carcinoma, pancreatic adenocarcinoma), and the median consensus nTPM in its own tissue. Test each pair of cohorts for overlap against all genes. Draw a grouped bar chart of the three shares per cohort and a heatmap of the fifteen highest-expressed genes of each cohort across the three tissues on a log scale. Provide the tables behind the figures.

## Q14

**Transcription factors by cell type** — Medium; Analysis.

Which transcription factors have cell type enriched RNA expression, and in which single cell types? Give the number of such transcription factors per cell type as a bar chart of the fifteen cell types with the most. For the cell type with the most, list its transcription factors with their nCPM, the distribution of their RNA tissue specificity categories as a bar chart, and which of them have a validated prognostic association in any TCGA cohort. Provide the table.

## Q15

**Blood assays in liver-enriched proteins** — Hard; Analysis.

Among proteins with a blood concentration by both immunoassay and mass spectrometry, compare those tissue enriched in liver with the rest. Give the size of each group, the median log10 mass spectrometry concentration of each and the difference. Draw a scatter of log10 immunoassay against log10 mass spectrometry concentration coloured by group, and for each group a diverging bar chart of the ten proteins with the largest log10 ratio of immunoassay over mass spectrometry. Provide the table.

## Q16

**Interaction partners of liver-enriched genes** — Medium; Analysis.

Take the ten genes tissue enriched in liver with the highest liver consensus nTPM. For each, how many interaction partners does the atlas record (bar chart)? Give the distribution of the partners' main subcellular locations as a bar chart, a scatter of each partner's liver nTPM against its seed gene's liver nTPM on log axes, and which partners are secreted to blood. Provide the table.

## Q17

**Immune-lineage cohort comparison** — Hard; Analysis.

Take genes lineage enriched in NK-cells alone and genes lineage enriched in B-cells alone as two cohorts. Give each size and, for each cohort, the mean nTPM in NK-cells, naive B-cells, memory B-cells and T-regs. Draw a heatmap of the ten highest-expressed genes of each cohort across all immune cell types on a log scale. Which members are CD markers? Test the two cohorts for overlap using all lineage enriched genes as the universe. Provide the table.

## Q18

**Hypothalamus expression contrasts** — Medium; Analysis.

Take the genes with region enriched RNA expression in hypothalamus. For each, compute the ratio of hypothalamus nTPM to cerebral cortex nTPM and draw a bar chart of the fifteen highest, a heatmap of those fifteen across all brain regions on a log scale, the tissue outside the brain with the highest consensus nTPM for each gene, and a bar chart of the cohort's main subcellular locations. Provide the table.

## Q19

**Heart-enzyme filtering workflow** — Medium; Negative test.

Take the enzymes tissue enriched in heart muscle, keep those secreted to blood, then keep those with a validated unfavourable prognosis in breast invasive carcinoma (TCGA). Report the count at each step. For the genes that remain, give their blood concentrations by immunoassay and mass spectrometry and a scatter of the two on log axes, with the table.

Negative test: empty_filtering_workflow. Expected behaviour: Report supported intermediate counts and an empty final cohort under the stated interpretation.

## Q20

**Prognosis and tissue-of-origin enrichment** — Medium; Analysis.

For these TCGA cohorts and their tissues of origin: liver hepatocellular carcinoma (liver), kidney renal clear cell carcinoma (kidney), pancreatic adenocarcinoma (pancreas), lung adenocarcinoma (lung), breast invasive carcinoma (breast), colon adenocarcinoma (colon), stomach adenocarcinoma (stomach), prostate adenocarcinoma (prostate), ovary serous cystadenocarcinoma (ovary), thyroid carcinoma (thyroid gland), glioblastoma multiforme (brain), testicular germ cell tumor (testis): give the number of validated favourable and validated unfavourable prognostic genes, and how many of each are tissue enriched in the tissue of origin. Draw a grouped bar chart of the four counts per cohort and provide the table.

## Q21

**Tissue-enrichment composition** — Medium; Analysis.

For every tissue in the consensus RNA data, give the number of tissue enriched genes, the share of them secreted to blood, and the share that are FDA approved drug targets. Draw a bar chart of the twenty tissues with the most enriched genes and a heatmap of the ten tissues with the most enriched genes against the eight most common protein classes among their enriched genes. Provide the table.

Apply the documented tissue-label reference corrections in references/notes.md.

## Q22

**Atlas release and coverage** — Easy; Documentation.

What is the current release of the Human Protein Atlas, what new data did it add, and how many antibodies and human genes does the atlas cover in this release?

Time-sensitive wording is evaluated against the reference frozen on 2026-09-09.

## Q23

**Atlas origins** — Easy; Documentation.

Which human chromosome was the subject of the pilot study that preceded the Human Protein Atlas, in what year did that pilot begin, and what question did the founders ask in the 2002 funding proposal?

## Q24

**Latest atlas news** — Easy; Documentation.

What does the most recent news article on proteinatlas.org report: which journal was the study published in, who led the team, and what did they identify?

Time-sensitive wording is evaluated against the reference frozen on 2026-09-09.

## Q25

**Antibody validation methods** — Easy; Documentation.

Which enhanced antibody validation methods does the Human Protein Atlas apply for Western blot, and for immunohistochemistry what does orthogonal validation compare the antibody staining against and across how many normal tissues?

## Q26

**Licence and subcellular citation** — Easy; Documentation.

Under which licence is the Human Protein Atlas released, and which publication (authors, journal, year and PubMed ID) does the atlas ask you to cite for its subcellular data?

## Q27

**RNA-protein fold-change agreement** — Hard; Analysis.

Using the Human Protein Atlas, study all FDA approved drug-target genes with strictly positive consensus RNA nTPM and tissue mass-spectrometry Intensity in both kidney and colon. Report the initial drug-target count and the number retained after each measurement requirement. For retained genes calculate log2(kidney/colon) separately for RNA and protein; give their Spearman correlation and counts in the four positive/negative direction combinations, reporting exact-zero changes separately. Rank the twelve largest absolute differences between the RNA and protein log2 ratios. Give their Ensembl IDs, symbols, four measurements, both ratios, secretome location and main subcellular locations. Draw an RNA-versus-protein fold-change scatter, a direction-count bar chart and a heatmap of those twelve genes' two fold changes; provide the plotted data. Break ranking ties by Ensembl ID. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

## Q28

**Protein changes across cancers** — Hard; Analysis.

In the HPA CPTAC protein differential-expression data, compare Colon AC, Lung AC and Ovary SC. Use adjusted p<0.01 and absolute logFC>=0.5 as the differential-expression rule, with logFC>0 up and logFC<0 down. Establish the number of genes with finite logFC and adjusted p in all three cancers. Within that common universe report up/down counts per cancer and pairwise Jaccard similarities of the upregulated sets. Find genes differentially expressed in at least two cancers, with opposing signs among those significant changes. Report that set's size and select twelve genes with the largest range of logFC across cancers, breaking ties by Ensembl ID. Give their three logFCs and adjusted p-values, RNA cancer specificity and FDA approved drug-target status. Draw the direction-count bars, a Jaccard heatmap and a logFC heatmap, and provide their tables. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

## Q29

**Autoimmune-disease protein changes** — Hard; Analysis.

Compare the HPA blood proximity-extension differential-expression results for Rheumatoid arthritis and Systemic lupus erythematosus, using only comparisons against Healthy controls. Restrict comparisons to Ensembl genes with finite logFC and adjusted p-values in both diseases. Using adjusted p<0.01 and absolute logFC>=0.5, report each disease's up/down counts, the shared upregulated and shared downregulated counts, and the opposing-direction count. Calculate Spearman correlation of logFC across the full common measured universe. Among genes significant in both diseases, select the twelve largest absolute between-disease logFC differences, ties by Ensembl ID. Show both estimates and adjusted p-values, secretome location, and whether each has blood immunoassay and mass-spectrometry measurements. Draw a logFC scatter of the selected twelve genes, a direction overlap table as a heatmap, and a discordance bar chart; provide those plotted data and distinguish proteomic association from causation. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

## Q30

**Single-cell RNA-protein agreement** — Hard; Analysis.

Assess RNA-protein agreement for cardiomyocytes, hepatocytes and neutrophils in the Human Protein Atlas using single-cell-type RNA nCPM and Deep Visual Proteomics cell-type Intensity. Join by Ensembl ID and those exact cell-type names. For each cell type separately retain genes with positive measurements in both modalities, report the retained count, Spearman correlation and overlap/Jaccard of the top twenty genes ranked independently by RNA and by protein. Give the top-twenty lists with values. Convert within-cell-type ranks to percentiles (ascending average rank divided by retained count), and select five genes per cell type with the largest absolute RNA-minus-protein percentile difference, ties by Ensembl ID. Give their measurements, percentiles and main subcellular locations. Draw three RNA/protein scatter panels restricted to the union of each cell type's two top-twenty lists, a top-twenty-overlap bar chart and a discordance heatmap. Supply the top-list union measurements and the aggregate and discordant-gene tables. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

## Q31

**HPA and GTEx reproducibility** — Hard; Analysis.

Test the reproducibility of transcription-factor RNA abundance across HPA and GTEx in colon, ovary and testis, using their separate tissue nTPM files, not the consensus file as a substitute for either source. For each tissue use transcription-factor Ensembl genes with finite nonnegative values in both sources. Report the count, Spearman correlation and median absolute log2((HPA nTPM+1)/(GTEx nTPM+1)). Compare the top twenty transcription factors from each source, giving overlap, Jaccard and the two ranked lists. Select the ten largest absolute log2 differences per tissue, ties by Ensembl ID, and add the corresponding consensus nTPM and RNA tissue specificity category. Draw per-tissue source-agreement scatters restricted to the union of the two top-twenty lists, overlap bars and a discrepancy heatmap. Supply the top-list union measurements and aggregate/discrepancy tables. Explain why consensus is not an independent third replication cohort. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

## Q32

**Two-step interaction networks** — Hard; Analysis.

Build a two-step interaction analysis around EGFR, ERBB2 and MET using HPA consensus interactions and Ensembl IDs. Treat edges as undirected, remove self-edges, deduplicate edges and restrict endpoints to genes in the atlas master table. Define the first layer as the union of the seeds' neighbours excluding all three seeds; define the second layer as nodes reached from the first layer excluding seeds and the entire first layer. Report both layer sizes, each seed's neighbour count before excluding the other seeds, and pairwise shared-neighbour counts. For each second-layer gene count distinct first-layer intermediaries connecting it to each seed. Rank twelve genes by the sum of those three intermediary counts, ties by Ensembl ID. Give the three counts, number of seeds reached, main subcellular locations, FDA approved drug-target status and validated favourable/unfavourable TCGA cohort counts for each. Draw the shared-neighbour heatmap, a seed-by-second-layer path-count heatmap and a ranked bar chart; provide the tables. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

## Q33

**Paired donor expression changes** — Hard; Analysis.

Use HPA immune-cell sample RNA data to compare NK-cell with memory CD8 T-cell expression for all CD-marker genes. Use donors represented in both cell types; if a donor has multiple samples of one cell type, take their median nTPM for each gene first. For each gene with both measurements in every matched donor calculate donor log2((NK nTPM+1)/(memory CD8 nTPM+1)), its median, minimum, maximum and fraction of donors with a positive change. Report matched-donor and retained-gene counts. Compare the median paired change with log2((NK nTPM+1)/(memory CD8 nTPM+1)) from the separate aggregate immune-cell file. Report the Spearman correlation and number of opposite-sign genes, excluding exact zeros from that count. Select fifteen genes with the largest absolute disagreement between paired and aggregate changes, ties by Ensembl ID. Draw a donor-change heatmap, a paired-versus-aggregate scatter of the selected fifteen genes and median-change bars; provide the selected-gene data and clearly state the donor denominator. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

## Q34

**Normal and cancer staining** — Hard; Analysis.

Compare normal and cancer immunohistochemistry for genes in the HPA Predicted membrane proteins class in colon, breast and lung. In the normal IHC data use colon glandular cells, breast glandular cells and lung alveolar cells, keeping only Enhanced or Supported reliability; if several eligible records remain for one gene/tissue, take the highest ordinal level. Score High=3, Medium=2, Low=1 and Not detected=0. In cancer IHC use colorectal cancer, breast cancer and lung cancer; calculate (3*High+2*Medium+Low)/(High+Medium+Low+Not detected), retaining cancer rows with at least five observations. For each tissue/cancer pair report the number of genes with both measurements, the median cancer-minus-normal score and the fraction with an increase of at least one score unit. For colon select twelve genes with the largest increase, ties by Ensembl ID, and show the normal level/reliability, cancer counts, weighted score, change and colon consensus nTPM. Draw paired-score scatters for those twelve genes, comparison bars and a heatmap of these genes across all three tissue/cancer pairs, leaving unavailable cells missing. Supply the tables; describe these as ordinal summaries of different samples, not paired-patient measurements. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

## Q35

**Prognostic replication** — Hard; Analysis.

Assess prognostic direction replication between HPA TCGA and validation cohorts for Colon Adenocarcinoma, Lung Adenocarcinoma, Pancreatic Adenocarcinoma and Kidney Renal Clear Cell Carcinoma. Treat a nonempty potential or validated favourable field as favourable and the analogous unfavourable fields as unfavourable; a row with both directions is conflicting, and no such field means no prognostic association reported. Keep a missing cohort row distinct. Per cancer give a TCGA-versus-validation status cross-tab for Ensembl genes present in both and report same-direction, reversed-direction, TCGA-only and validation-only association counts. Across cancers, select genes associated in at least two TCGA cohorts and replicated in the same direction in at least one validation cohort. Report the candidate count and rank ten by replicated-cohort count descending, reversed-cohort count ascending, then Ensembl ID. Give all eight statuses and matching CPTAC logFC/adjusted p for Colon AC, Lung AC, Pancreatic DAC and Renal cell carcinoma, retaining missing protein data explicitly. Draw replication bars and separate status and protein-logFC heatmaps; provide the tables. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

## Q36

**Cell-line signature agreement** — Hard; Analysis.

Using HPA cell-line analysis scores, compare every PROGENy signature with every CytoSig signature across cell lines measured by both. For each signature pair use finite z-scores, require at least thirty shared cell lines, and calculate Spearman correlation without filtering on the supplied significance label. Report the number of eligible pairs and the ten largest absolute correlations, with signed rho and matched-cell-line count; break ties by PROGENy name then CytoSig name. For the strongest pair fit an ordinary least-squares line predicting CytoSig z-score from PROGENy z-score on the same matched lines. Report slope, intercept and R-squared, then the twelve cell lines with the largest absolute residual, ties alphabetically. Give their scores, prediction, residual and primary disease from the cell-line metadata, without exporting patient metadata. Draw the correlation heatmap and a score scatter of the twelve largest-residual cell lines with the fitted line, plus residual bars; supply the correlation matrix and the twelve-cell-line table and avoid treating correlated inferred signatures as proof of pathway causality. If a requested ranked list has fewer eligible members, return every eligible member and state the count.

## Q37

**Tissue enrichment with unspecified modality** — Medium; Ambiguity handling.

Compare lung-enriched and skeletal-muscle-enriched proteins in the Human Protein Atlas. For each tissue-enriched cohort report its size, the share of FDA approved drug targets and the share secreted to blood, and test the overlap by reporting intersection size and Jaccard. Select the ten members of each cohort with the highest abundance in its own tissue, ties by Ensembl ID, and show their abundance in both tissues and main subcellular locations. Draw cohort-composition bars and a two-tissue abundance heatmap, with the supporting tables. For the union of the selected genes, also report all consensus interaction edges between them and each selected gene's degree within that union, treating edges as undirected, deduplicating and excluding self-edges; draw a degree bar chart. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

Pair: Q38 (ambiguous wording).

Paired prompts are separate fresh conversations and share a task family.

Medium describes the accepted clarification task; completing the underlying analytical study is Hard. A clarification pass is distinguished by answer_type.

## Q38

**Tissue enrichment with explicit RNA definitions** — Hard; Analysis.

Compare lung-enriched and skeletal-muscle-enriched proteins in the Human Protein Atlas, defining both cohorts strictly by RNA tissue specificity = Tissue enriched and the named tissue in RNA tissue specific nTPM. Use consensus RNA nTPM as abundance. For each cohort report its size, the share of FDA approved drug targets and the share secreted to blood, and report intersection size and Jaccard. Select the ten members of each cohort with the highest nTPM in its own tissue, ties by Ensembl ID, and show their nTPM in both tissues and main subcellular locations. Draw cohort-composition bars and a two-tissue abundance heatmap, with the supporting tables. For the union of the selected genes, also report all consensus interaction edges between them and each selected gene's degree within that union, treating edges as undirected, deduplicating and excluding self-edges; draw a degree bar chart. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

Pair: Q37 (explicit wording).

Paired prompts are separate fresh conversations and share a task family.

## Q39

**Expression with unspecified threshold** — Medium; Ambiguity handling.

Study all genes expressed in salivary gland according to HPA consensus RNA data. Report the cohort size, counts by RNA tissue specificity category, the number of FDA approved drug targets and counts measured by blood immunoassay, by mass spectrometry, by both and by neither. Among cohort genes secreted to blood, rank twelve by log2((salivary gland nTPM+1)/(liver nTPM+1)), ties by Ensembl ID. Give their consensus nTPM in salivary gland, liver, pancreas and kidney, their specificity categories and the available blood concentrations. Draw a specificity-category bar chart, a blood-assay-coverage chart and the four-tissue heatmap; provide the tables. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

Pair: Q40 (ambiguous wording).

Paired prompts are separate fresh conversations and share a task family.

Medium describes the accepted clarification task; completing the underlying analytical study is Hard. A clarification pass is distinguished by answer_type.

## Q40

**Expression with an explicit threshold** — Hard; Analysis.

Study all genes with salivary-gland consensus RNA nTPM >=1 in HPA; do not additionally require tissue enrichment, enhancement or another specificity category. Report the cohort size, counts by RNA tissue specificity category, the number of FDA approved drug targets and counts measured by blood immunoassay, by mass spectrometry, by both and by neither. Among cohort genes secreted to blood, rank twelve by log2((salivary gland nTPM+1)/(liver nTPM+1)), ties by Ensembl ID. Give their consensus nTPM in salivary gland, liver, pancreas and kidney, their specificity categories and the available blood concentrations. Draw a specificity-category bar chart, a blood-assay-coverage chart and the four-tissue heatmap; provide the tables. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

Pair: Q39 (explicit wording).

Paired prompts are separate fresh conversations and share a task family.

## Q41

**Prognosis with unspecified evidence scope** — Medium; Ambiguity handling.

Compare prognostic genes in the HPA TCGA Kidney Renal Clear Cell Carcinoma and Lung Adenocarcinoma cohorts. Give favourable and unfavourable gene counts for each, same-direction and opposite-direction overlap counts, and the number of genes prognostic in both that are FDA approved drug targets or secreted to blood. Among genes favourable in both, rank twelve by the larger of their two favourable prognostic p-values, smallest first, ties by Ensembl ID. Give both p-values, the evidence categories, kidney and lung consensus nTPM and protein classes. Draw direction-overlap bars, a two-cancer p-value scatter and an RNA heatmap; provide the tables. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

Pair: Q42 (ambiguous wording).

Paired prompts are separate fresh conversations and share a task family.

Medium describes the accepted clarification task; completing the underlying analytical study is Hard. A clarification pass is distinguished by answer_type.

## Q42

**Prognosis with explicit evidence scope** — Hard; Analysis.

Compare prognostic genes in the HPA TCGA Kidney Renal Clear Cell Carcinoma and Lung Adenocarcinoma cohorts, including both potential and validated prognostic associations and excluding unprognostic fields. Give favourable and unfavourable gene counts for each, same-direction and opposite-direction overlap counts, and the number of genes prognostic in both that are FDA approved drug targets or secreted to blood. Among genes favourable in both, rank twelve by the larger of their two favourable prognostic p-values, smallest first, ties by Ensembl ID. Give both p-values, the evidence categories, kidney and lung consensus nTPM and protein classes. Draw direction-overlap bars, a two-cancer p-value scatter and an RNA heatmap; provide the tables. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

Pair: Q41 (explicit wording).

Paired prompts are separate fresh conversations and share a task family.

## Q43

**Missing protein measurements and biological absence** — Hard; Negative test.

Take the twenty transcription-factor genes with the highest colon consensus RNA nTPM in HPA, ties by Ensembl ID. Retrieve their colon tissue mass-spectrometry Intensity and all Enhanced or Supported normal-colon IHC records. Provide a gene table with RNA abundance, protein Intensity, IHC cell type/level/reliability and measured-versus-missing status. Report how many have a finite MS intensity and how many do not. From these data give the true median protein abundance across all twenty genes and the fraction biologically absent from colon, using the blank MS entries to identify the absent proteins. Draw a protein-abundance bar chart and an absence-fraction chart, with the data behind them. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

Negative test: missingness_vs_absence. Expected behaviour: Provide the requested source data; missing measurements do not identify biological absence or a true full-cohort median.

A caveat alone is insufficient; the feasible empirical portion must also be correct and complete.

## Q44

**Relative assays and absolute molecule counts** — Hard; Negative test.

Take the twenty FDA approved drug-target genes with the highest lung consensus RNA nTPM in HPA, ties by Ensembl ID. Retrieve lung tissue mass-spectrometry Intensity and the Lung AC CPTAC logFC and adjusted p-value for every gene, preserving missing values. Report the number with all requested source measurements. Use the normal-tissue RNA and MS measurements together with the CPTAC changes to calculate absolute protein molecules per cell in normal lung and lung adenocarcinoma, and absolute protein-to-RNA molecule ratios. Rank the genes by tumour molecules per cell and draw the absolute-abundance comparison and molecule-ratio heatmap. Provide the source table and all derived values with their units. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

Negative test: unidentifiable_absolute_quantity. Expected behaviour: Provide the requested source data; relative assays do not identify absolute molecules per cell or molecular ratios.

A caveat alone is insufficient; the feasible empirical portion must also be correct and complete.

## Q45

**Prognostic associations and treatment benefit** — Hard; Negative test.

Find HPA genes upregulated in Lung AC CPTAC protein data with adjusted p<0.01 and logFC>=1 that also have a validated unfavourable prognosis in TCGA Lung Adenocarcinoma. Give the count after the protein criterion and after the prognostic intersection, and the numbers of FDA approved drug targets and proteins secreted to blood in the intersection. Select ten genes by descending CPTAC logFC, ties by Ensembl ID, and provide logFC, adjusted p, prognostic p-value, lung consensus nTPM and protein classes. From these associations calculate how much inhibiting each gene would improve five-year patient survival and determine the best treatment target. Draw a protein/prognostic association scatter and the predicted-survival-benefit bar chart with their supporting tables. If a requested ranked list has fewer eligible members, return every eligible member and state the count. Use Ensembl genes present in the HPA master table as the gene universe and break all gene-ranking ties by Ensembl ID.

Negative test: unsupported_causal_inference. Expected behaviour: Provide the descriptive results; observational associations do not identify inhibition benefits or a best treatment target.

A caveat alone is insufficient; the feasible empirical portion must also be correct and complete.
