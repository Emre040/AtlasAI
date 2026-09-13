# Benchmark questions

The canonical catalog is [questions.json](questions.json): 236 questions, IDs D1 to D236, 51 Easy, 147 Medium and 38 Hard by the rubric in [difficulty.md](difficulty.md). The reference query of each question is in `../references/queries.json`.

| Question | Title | Difficulty | Filters | Fields |
| --- | --- | --- | --- | --- |
| [D1](#d1) | Transcription factors | Easy | 1 | Protein class |
| [D2](#d2) | Protein kinases | Easy | 1 | Protein class |
| [D3](#d3) | CD markers | Easy | 1 | Protein class |
| [D4](#d4) | Liver-specific genes | Easy | 1 | Tissue category (RNA) |
| [D5](#d5) | Pancreas above average | Easy | 1 | Tissue category (RNA) |
| [D6](#d6) | Absent from kidney | Easy | 1 | Tissue category (RNA) |
| [D7](#d7) | Ubiquitous genes | Medium | 1 | Tissue category (RNA) |
| [D8](#d8) | Cerebellum-specific | Easy | 1 | Brain region category (RNA) |
| [D9](#d9) | Silent in hypothalamus | Easy | 1 | Brain region category (RNA) |
| [D10](#d10) | Hepatocyte-specific | Easy | 1 | Cell type category (scRNA) |
| [D11](#d11) | Cardiomyocytes above average | Easy | 1 | Cell type category (scRNA) |
| [D12](#d12) | Neutrophil-specific | Easy | 1 | Immune cell category (RNA) |
| [D13](#d13) | Bloodstream secretome | Easy | 1 | Secretome annotation |
| [D14](#d14) | Digestive secretome | Easy | 1 | Secretome annotation |
| [D15](#d15) | Nucleoplasm | Easy | 1 | Subcellular location (ICC) |
| [D16](#d16) | Mitochondria | Easy | 1 | Subcellular location (ICC) |
| [D17](#d17) | Chromosome 17 | Easy | 1 | Chromosome |
| [D18](#d18) | Y chromosome | Easy | 1 | Chromosome |
| [D19](#d19) | Protein-level evidence | Easy | 1 | Evidence summary |
| [D20](#d20) | Better survival in renal cancer | Easy | 1 | Prognostic cancer |
| [D21](#d21) | Glioblastoma-specific | Easy | 1 | Cancer category (RNA) |
| [D22](#d22) | Neuropeptide cluster | Easy | 1 | Brain expression cluster (RNA) |
| [D23](#d23) | With antibodies | Easy | 1 | With antibodies |
| [D24](#d24) | T-cell lineage | Easy | 1 | Immune cell lineage category (RNA) |
| [D25](#d25) | Liver-specific enzymes | Medium | 2 | Protein class, Tissue category (RNA) |
| [D26](#d26) | Testis-specific transcription factors | Medium | 2 | Protein class, Tissue category (RNA) |
| [D27](#d27) | Plasma proteins in blood | Easy | 2 | Protein class, Secretome annotation |
| [D28](#d28) | Kidney-specific transporters | Medium | 2 | Protein class, Tissue category (RNA) |
| [D29](#d29) | Cortex channels above average | Easy | 2 | Protein class, Brain region category (RNA) |
| [D30](#d30) | Drug targets on X | Easy | 2 | Protein class, Chromosome |
| [D31](#d31) | Nuclear receptors in liver | Medium | 2 | Protein class, Tissue category (RNA) |
| [D32](#d32) | CD markers at the membrane | Easy | 2 | Protein class, Subcellular location (ICC) |
| [D33](#d33) | Pancreatic digestive secretion | Medium | 2 | Tissue category (RNA), Secretome annotation |
| [D34](#d34) | Liver-specific, kidney-silent | Medium | 2 | Tissue category (RNA) |
| [D35](#d35) | Hepatocyte secretion to blood | Medium | 2 | Cell type category (scRNA), Secretome annotation |
| [D36](#d36) | Basophil genes on chromosome 1 | Medium | 2 | Immune cell category (RNA), Chromosome |
| [D37](#d37) | Muscle-specific, protein evidence | Medium | 2 | Tissue category (RNA), Evidence summary |
| [D38](#d38) | Cytosolic enzymes | Easy | 2 | Protein class, Subcellular location (ICC) |
| [D39](#d39) | Retina-specific GPCRs | Medium | 2 | Protein class, Tissue category (RNA) |
| [D40](#d40) | Poor survival in liver cancer | Medium | 2 | Prognostic cancer, Secretome annotation |
| [D41](#d41) | Placenta-specific | Easy | 1 | Tissue category (RNA) |
| [D42](#d42) | Thyroid group | Medium | 1 | Tissue category (RNA) |
| [D43](#d43) | No tissue preference | Medium | 1 | Tissue category (RNA) |
| [D44](#d44) | Prostate-specific cancer genes | Medium | 2 | Protein class, Tissue category (RNA) |
| [D45](#d45) | Golgi apparatus | Easy | 1 | Subcellular location (ICC) |
| [D46](#d46) | Proteases | Easy | 1 | Protein class |
| [D47](#d47) | Pituitary-specific | Easy | 1 | Tissue category (RNA) |
| [D48](#d48) | Astrocyte-specific | Easy | 1 | Cell type category (scRNA) |
| [D49](#d49) | Choroid plexus-specific | Easy | 1 | Brain region category (RNA) |
| [D50](#d50) | Secreted in brain | Easy | 1 | Secretome annotation |
| [D51](#d51) | Tyrosine kinases | Easy | 1 | Protein class |
| [D52](#d52) | Serine proteases at the membrane | Medium | 2 | Protein class, Subcellular location (ICC) |
| [D53](#d53) | Liver-specific, not blood-secreted | Medium | 2 | Tissue category (RNA), Secretome annotation |
| [D54](#d54) | Kidney-specific enzymes, no CD markers | Medium | 3 | Protein class, Tissue category (RNA) |
| [D55](#d55) | Liver or kidney specific | Medium | 1 | Tissue category (RNA) |
| [D56](#d56) | Cerebellum or hypothalamus | Medium | 2 | Protein class, Brain region category (RNA) |
| [D57](#d57) | Pancreas alone or in a group | Medium | 1 | Tissue category (RNA) |
| [D58](#d58) | Strong hepatocyte staining | Medium | 1 | Tissue expression (IHC) |
| [D59](#d59) | Glomerular staining, kidney-specific | Medium | 2 | Tissue category (RNA), Tissue expression (IHC) |
| [D60](#d60) | Cortex-specific, not in cerebellum | Medium | 2 | Brain region category (RNA) |
| [D61](#d61) | Nucleoplasm as main site | Easy | 2 | Protein class, Subcellular location (ICC) |
| [D62](#d62) | Not in the nucleus | Medium | 2 | Protein class, Subcellular location (ICC) |
| [D63](#d63) | Small-molecule targets in liver | Medium | 2 | Protein class, Tissue category (RNA) |
| [D64](#d64) | Biologic targets secreted | Medium | 2 | Protein class, Secretome annotation |
| [D65](#d65) | Cancer drivers on chromosome 3 | Easy | 2 | Protein class, Chromosome |
| [D66](#d66) | Zinc-finger factors in testis | Medium | 2 | Protein class, Tissue category (RNA) |
| [D67](#d67) | Channels above average in cortex | Easy | 2 | Protein class, Brain region category (RNA) |
| [D68](#d68) | Serotonin receptors | Medium | 2 | Protein class, Tissue category (RNA) |
| [D69](#d69) | Olfactory receptors detected somewhere | Medium | 2 | Protein class, Tissue category (RNA) |
| [D70](#d70) | Monocyte-specific membrane | Medium | 2 | Immune cell category (RNA), Subcellular location (ICC) |
| [D71](#d71) | Silent in all immune cells | Medium | 2 | Protein class, Immune cell category (RNA) |
| [D72](#d72) | B-cell lineage secreted | Medium | 2 | Immune cell lineage category (RNA), Secretome annotation |
| [D73](#d73) | Better survival in lung adenocarcinoma | Medium | 2 | Protein class, Prognostic cancer |
| [D74](#d74) | Shorter survival, membrane | Medium | 2 | Prognostic cancer, Subcellular location (ICC) |
| [D75](#d75) | Liver cancer specific enzymes | Medium | 2 | Protein class, Cancer category (RNA) |
| [D76](#d76) | Testicular cancer above average | Medium | 2 | Cancer category (RNA), Tissue category (RNA) |
| [D77](#d77) | Neuropeptide cluster, hypothalamus-specific | Medium | 2 | Brain expression cluster (RNA), Brain region category (RNA) |
| [D78](#d78) | Myelination cluster | Easy | 1 | Brain expression cluster (RNA) |
| [D79](#d79) | Degranulation cluster, membrane | Easy | 2 | Immune cell expression cluster (RNA), Subcellular location (ICC) |
| [D80](#d80) | Basophil proteolysis cluster | Easy | 1 | Immune cell expression cluster (RNA) |
| [D81](#d81) | Cortex-specific, absent in liver and kidney | Medium | 3 | Brain region category (RNA), Tissue category (RNA) |
| [D82](#d82) | Heart-specific channels, protein evidence | Medium | 3 | Protein class, Tissue category (RNA), Evidence summary |
| [D83](#d83) | Transcript-level only | Easy | 2 | Chromosome, Evidence summary |
| [D84](#d84) | Mitochondrial genome | Easy | 1 | Chromosome |
| [D85](#d85) | Secreted in testis area | Medium | 2 | Secretome annotation, Tissue category (RNA) |
| [D86](#d86) | Extracellular matrix, not blood | Medium | 2 | Secretome annotation |
| [D87](#d87) | Vesicles as main site | Easy | 1 | Subcellular location (ICC) |
| [D88](#d88) | Nucleoli, top reliability | Easy | 1 | Subcellular location (ICC) |
| [D89](#d89) | Multiple compartments incl. mitochondria | Easy | 1 | Subcellular location (ICC) |
| [D90](#d90) | Kupffer cells | Medium | 2 | Cell type category (scRNA), Subcellular location (ICC) |
| [D91](#d91) | Oligodendrocytes not in liver | Medium | 2 | Cell type category (scRNA), Tissue category (RNA) |
| [D92](#d92) | Sertoli or Leydig | Medium | 1 | Cell type category (scRNA) |
| [D93](#d93) | Detected in a third of tissues | Medium | 2 | Protein class, Tissue category (RNA) |
| [D94](#d94) | Detected in few tissues | Medium | 2 | Protein class, Tissue category (RNA) |
| [D95](#d95) | Brain-region ubiquitous | Medium | 2 | Protein class, Brain region category (RNA) |
| [D96](#d96) | NK-cell specific, not T-cell | Medium | 2 | Immune cell category (RNA), Immune cell lineage category (RNA) |
| [D97](#d97) | Excluding cancer genes | Medium | 2 | Tissue category (RNA), Protein class |
| [D98](#d98) | Not kidney-specific | Medium | 3 | Protein class, Tissue category (RNA) |
| [D99](#d99) | Purkinje staining | Medium | 1 | Tissue expression (IHC) |
| [D100](#d100) | No staining in cardiomyocytes | Medium | 2 | Tissue category (RNA), Tissue expression (IHC) |
| [D101](#d101) | Liver-specific secreted enzymes, silent elsewhere | Medium | 5 | Protein class, Tissue category (RNA), Secretome annotation |
| [D102](#d102) | Testis-specific factors, not in brain regions | Medium | 5 | Protein class, Tissue category (RNA), Brain region category (RNA), Evidence summary |
| [D103](#d103) | Kidney transporters, membrane, not liver | Hard | 5 | Protein class, Tissue category (RNA), Subcellular location (ICC) |
| [D104](#d104) | Pancreatic proteases to the gut | Medium | 5 | Protein class, Tissue category (RNA), Secretome annotation |
| [D105](#d105) | Brain-wide channels, not liver | Hard | 5 | Protein class, Brain region category (RNA), Tissue category (RNA), Subcellular location (ICC), Chromosome |
| [D106](#d106) | Hepatocyte plasma proteins | Medium | 5 | Protein class, Cell type category (scRNA), Secretome annotation, Evidence summary, Tissue category (RNA) |
| [D107](#d107) | Neutrophil-specific membrane, not T-cells | Medium | 4 | Immune cell category (RNA), Subcellular location (ICC), Immune cell lineage category (RNA), With antibodies |
| [D108](#d108) | Vasculature cluster, lymphatic endothelium | Medium | 3 | Brain expression cluster (RNA), Cell type category (scRNA), Subcellular location (ICC) |
| [D109](#d109) | Renal cancer survival, kidney-specific | Medium | 3 | Prognostic cancer, Tissue category (RNA), Secretome annotation |
| [D110](#d110) | Liver cancer, poor survival | Medium | 2 | Cancer category (RNA), Prognostic cancer |
| [D111](#d111) | Tyrosine kinases, broadly expressed, membrane | Hard | 4 | Protein class, Tissue category (RNA), Subcellular location (ICC) |
| [D112](#d112) | Zinc-finger factors, nucleoplasm, chromosome 19 | Hard | 4 | Protein class, Chromosome, Subcellular location (ICC), Tissue category (RNA) |
| [D113](#d113) | Sertoli or Leydig, testis, not ovary | Medium | 3 | Cell type category (scRNA), Tissue category (RNA) |
| [D114](#d114) | Liver or kidney, secreted, no CD markers | Medium | 3 | Tissue category (RNA), Secretome annotation, Protein class |
| [D115](#d115) | Astrocytes, brain-wide, not liver | Medium | 3 | Cell type category (scRNA), Brain region category (RNA), Tissue category (RNA) |
| [D116](#d116) | Pancreas alone or grouped, digestive, not blood | Hard | 3 | Tissue category (RNA), Secretome annotation |
| [D117](#d117) | Thyroid-specific, glandular staining, not cancer | Medium | 3 | Tissue category (RNA), Tissue expression (IHC), Protein class |
| [D118](#d118) | Placenta-specific, trophoblast staining, secreted | Medium | 3 | Tissue category (RNA), Tissue expression (IHC), Secretome annotation |
| [D119](#d119) | Cerebellum-specific, no glomerular staining | Medium | 3 | Brain region category (RNA), Tissue expression (IHC), Tissue category (RNA) |
| [D120](#d120) | Basophils or eosinophils, not blood, chromosome 1 | Medium | 3 | Immune cell category (RNA), Secretome annotation, Chromosome |
| [D121](#d121) | Prostate, glandular staining, not blood | Medium | 3 | Tissue category (RNA), Tissue expression (IHC), Secretome annotation |
| [D122](#d122) | Oligodendrocytes, myelination, not kinases | Medium | 3 | Cell type category (scRNA), Brain expression cluster (RNA), Protein class |
| [D123](#d123) | Monoamine cluster enzymes, not liver | Medium | 3 | Protein class, Brain expression cluster (RNA), Tissue category (RNA) |
| [D124](#d124) | Ovary above average, silent in testis | Medium | 3 | Tissue category (RNA) |
| [D125](#d125) | Salivary secretome | Medium | 4 | Tissue category (RNA), Secretome annotation |
| [D126](#d126) | Retina-specific GPCRs, not liver, protein evidence | Medium | 4 | Protein class, Tissue category (RNA), Evidence summary |
| [D127](#d127) | Lung above average, alveolar staining, not cancer | Medium | 3 | Tissue category (RNA), Tissue expression (IHC), Protein class |
| [D128](#d128) | Skeletal muscle, myocyte staining, no nucleoplasm | Medium | 3 | Tissue category (RNA), Tissue expression (IHC), Subcellular location (ICC) |
| [D129](#d129) | Bone marrow specific, no antibodies | Medium | 2 | Tissue category (RNA), With antibodies |
| [D130](#d130) | Hematopoietic staining, monocytes | Medium | 2 | Immune cell category (RNA), Tissue expression (IHC) |
| [D131](#d131) | Cortex-specific, not cerebellum or hypothalamus | Medium | 3 | Brain region category (RNA) |
| [D132](#d132) | Liver-specific drug targets, not blood | Medium | 4 | Protein class, Tissue category (RNA), Secretome annotation, Subcellular location (ICC) |
| [D133](#d133) | Kidney tubule staining, kidney-specific transporters | Medium | 4 | Protein class, Tissue category (RNA), Tissue expression (IHC) |
| [D134](#d134) | Adipose, not liver, secreted | Medium | 3 | Tissue category (RNA), Secretome annotation |
| [D135](#d135) | Cancer biomarkers, secreted, chromosome 1 or 2 | Medium | 3 | Protein class, Secretome annotation, Chromosome |
| [D136](#d136) | Chromosome 21 factors, nucleoplasm, protein evidence | Medium | 4 | Protein class, Chromosome, Subcellular location (ICC), Evidence summary |
| [D137](#d137) | Cardiomyocyte-specific, not kidney, not membrane | Medium | 3 | Cell type category (scRNA), Tissue category (RNA), Subcellular location (ICC) |
| [D138](#d138) | Group with heart muscle, not blood | Medium | 2 | Tissue category (RNA), Secretome annotation |
| [D139](#d139) | Choroid plexus region, mitochondria cluster | Medium | 2 | Brain expression cluster (RNA), Brain region category (RNA) |
| [D140](#d140) | T-cell lineage, not detected in liver, membrane | Medium | 3 | Immune cell lineage category (RNA), Tissue category (RNA), Subcellular location (ICC) |
| [D141](#d141) | Kupffer cells, monocytes, not blood | Medium | 3 | Cell type category (scRNA), Immune cell category (RNA), Secretome annotation |
| [D142](#d142) | Basic-domain factors, testis, not ovary | Medium | 3 | Protein class, Tissue category (RNA) |
| [D143](#d143) | Helix-turn-helix, brain-region ubiquitous | Medium | 3 | Protein class, Brain region category (RNA), Subcellular location (ICC) |
| [D144](#d144) | Metalloproteases secreted, not liver | Medium | 3 | Protein class, Secretome annotation, Tissue category (RNA) |
| [D145](#d145) | Oxidoreductases, liver, mitochondria | Easy | 3 | Protein class, Tissue category (RNA), Subcellular location (ICC) |
| [D146](#d146) | Primary active transporters, membrane, chromosome X | Easy | 3 | Protein class, Subcellular location (ICC), Chromosome |
| [D147](#d147) | Electrochemical transporters, kidney, not liver | Medium | 3 | Protein class, Tissue category (RNA) |
| [D148](#d148) | Colon glandular staining, digestive | Medium | 2 | Tissue expression (IHC), Secretome annotation |
| [D149](#d149) | Spleen white pulp, B-cell lineage | Medium | 2 | Tissue expression (IHC), Immune cell lineage category (RNA) |
| [D150](#d150) | Epidermal staining, skin silent in liver | Medium | 3 | Tissue expression (IHC), Tissue category (RNA) |
| [D151](#d151) | Cortex channels, not liver | Medium | 3 | Protein class, Brain region category (RNA), Tissue category (RNA) |
| [D152](#d152) | Hepatocyte enzymes, strong staining, not blood | Hard | 4 | Protein class, Cell type category (scRNA), Tissue expression (IHC), Secretome annotation |
| [D153](#d153) | Plasma cells, secreted, not gut | Medium | 3 | Cell type category (scRNA), Secretome annotation |
| [D154](#d154) | Salivary duct cells, not liver | Medium | 3 | Cell type category (scRNA), Tissue category (RNA) |
| [D155](#d155) | Spermatid-specific, no somatic expression | Medium | 5 | Cell type category (scRNA), Tissue category (RNA) |
| [D156](#d156) | Bone marrow specific, not membrane | Medium | 3 | Tissue category (RNA), Evidence summary, Subcellular location (ICC) |
| [D157](#d157) | Plasma cells, immunoglobulin-free | Medium | 3 | Cell type category (scRNA), Secretome annotation, Protein class |
| [D158](#d158) | Rod photoreceptors, retina | Medium | 2 | Cell type category (scRNA), Tissue category (RNA) |
| [D159](#d159) | Melanocytes, skin silent in liver | Medium | 3 | Cell type category (scRNA), Tissue category (RNA) |
| [D160](#d160) | Adipocytes, secreted, not liver | Medium | 3 | Cell type category (scRNA), Secretome annotation, Tissue category (RNA) |
| [D161](#d161) | Alveolar type 2, lung-specific, secreted | Medium | 3 | Cell type category (scRNA), Tissue category (RNA), Secretome annotation |
| [D162](#d162) | Kidney transporters, membrane | Easy | 3 | Protein class, Tissue category (RNA), Subcellular location (ICC) |
| [D163](#d163) | Paneth cells, digestive, not liver | Medium | 3 | Cell type category (scRNA), Secretome annotation, Tissue category (RNA) |
| [D164](#d164) | Synaptic cluster, brain-wide, not astrocytes | Hard | 3 | Brain expression cluster (RNA), Brain region category (RNA), Cell type category (scRNA) |
| [D165](#d165) | Monoamine cluster, not liver, protein evidence | Medium | 3 | Brain expression cluster (RNA), Tissue category (RNA), Evidence summary |
| [D166](#d166) | Microglia cluster, monocytes, not blood | Medium | 3 | Brain expression cluster (RNA), Immune cell category (RNA), Secretome annotation |
| [D167](#d167) | Schwann cells, not brain regions | Medium | 3 | Cell type category (scRNA), Brain region category (RNA) |
| [D168](#d168) | Cholangiocytes vs hepatocytes | Medium | 3 | Cell type category (scRNA), Tissue expression (IHC) |
| [D169](#d169) | Kidney above average, not liver | Medium | 3 | Tissue category (RNA) |
| [D170](#d170) | Lymphatic endothelium, membrane, ubiquitous | Medium | 3 | Cell type category (scRNA), Subcellular location (ICC), Tissue category (RNA) |
| [D171](#d171) | Smooth muscle, actin, not heart-specific | Medium | 3 | Cell type category (scRNA), Subcellular location (ICC), Tissue category (RNA) |
| [D172](#d172) | Fibroblasts, extracellular matrix | Medium | 2 | Cell type category (scRNA), Secretome annotation |
| [D173](#d173) | Skeletal muscle, myocyte staining, protein evidence | Medium | 3 | Tissue category (RNA), Tissue expression (IHC), Evidence summary |
| [D174](#d174) | Salivary duct cells, digestive | Medium | 2 | Cell type category (scRNA), Secretome annotation |
| [D175](#d175) | Paneth cells, digestive | Medium | 2 | Cell type category (scRNA), Secretome annotation |
| [D176](#d176) | Syncytiotrophoblasts, placenta, secreted | Medium | 3 | Cell type category (scRNA), Tissue category (RNA), Secretome annotation |
| [D177](#d177) | Rod photoreceptors, retina, not liver | Medium | 3 | Cell type category (scRNA), Tissue category (RNA) |
| [D178](#d178) | Plasmacytoid cluster, dendritic lineage | Medium | 2 | Immune cell expression cluster (RNA), Immune cell lineage category (RNA) |
| [D179](#d179) | Granulosa cells, ovary above average | Medium | 2 | Cell type category (scRNA), Tissue category (RNA) |
| [D180](#d180) | Oocytes, not testis | Medium | 2 | Cell type category (scRNA), Tissue category (RNA) |
| [D181](#d181) | Breast, myoepithelial cells | Medium | 2 | Tissue category (RNA), Cell type category (scRNA) |
| [D182](#d182) | Kidney above average, membrane, not liver | Medium | 3 | Tissue category (RNA), Subcellular location (ICC) |
| [D183](#d183) | Salivary duct transporters | Medium | 2 | Cell type category (scRNA), Protein class |
| [D184](#d184) | Alveolar type 2, lung, secreted | Medium | 3 | Cell type category (scRNA), Tissue category (RNA), Secretome annotation |
| [D185](#d185) | Late spermatids, testis, chromosome X | Medium | 3 | Cell type category (scRNA), Tissue category (RNA), Chromosome |
| [D186](#d186) | Hofbauer cells, placenta, not blood | Medium | 3 | Cell type category (scRNA), Tissue category (RNA), Secretome annotation |
| [D187](#d187) | Basal keratinocytes, not liver | Medium | 2 | Cell type category (scRNA), Tissue category (RNA) |
| [D188](#d188) | Monocyte membrane cluster, no antibodies | Easy | 2 | Immune cell expression cluster (RNA), With antibodies |
| [D189](#d189) | Mesothelial cells, extracellular matrix | Medium | 2 | Cell type category (scRNA), Secretome annotation |
| [D190](#d190) | Lymphatic endothelium, membrane, not blood | Medium | 3 | Cell type category (scRNA), Subcellular location (ICC), Secretome annotation |
| [D191](#d191) | T-cells and T-lineage, membrane | Medium | 3 | Cell type category (scRNA), Immune cell lineage category (RNA), Subcellular location (ICC) |
| [D192](#d192) | B-cells, memory B, secreted | Medium | 3 | Cell type category (scRNA), Immune cell category (RNA), Secretome annotation |
| [D193](#d193) | NK-cells both datasets, not blood | Medium | 3 | Cell type category (scRNA), Immune cell category (RNA), Secretome annotation |
| [D194](#d194) | Macrophages, lung alveolar staining | Medium | 2 | Cell type category (scRNA), Tissue expression (IHC) |
| [D195](#d195) | Neutrophils, granulocyte lineage, not liver | Medium | 3 | Immune cell category (RNA), Immune cell lineage category (RNA), Tissue category (RNA) |
| [D196](#d196) | Dendritic cluster, dendritic cells | Medium | 2 | Immune cell expression cluster (RNA), Immune cell category (RNA) |
| [D197](#d197) | Monocytes, single-cell and lineage | Medium | 3 | Cell type category (scRNA), Immune cell lineage category (RNA), Subcellular location (ICC) |
| [D198](#d198) | Cytotrophoblasts, placenta, not blood | Medium | 3 | Cell type category (scRNA), Tissue category (RNA), Secretome annotation |
| [D199](#d199) | Leydig cells, steroid enzymes | Medium | 3 | Protein class, Cell type category (scRNA), Tissue category (RNA) |
| [D200](#d200) | Suprabasal keratinocytes, esophagus | Medium | 2 | Cell type category (scRNA), Tissue category (RNA) |
| [D201](#d201) | Liver-specific secreted enzymes, five constraints | Hard | 6 | Protein class, Tissue category (RNA), Secretome annotation, Evidence summary |
| [D202](#d202) | Brain-wide channels, six constraints | Hard | 6 | Protein class, Brain region category (RNA), Tissue category (RNA), Subcellular location (ICC) |
| [D203](#d203) | Kidney transporters, six constraints | Hard | 6 | Protein class, Tissue category (RNA), Subcellular location (ICC), Secretome annotation |
| [D204](#d204) | Pancreatic proteases, six constraints | Hard | 6 | Protein class, Tissue category (RNA), Secretome annotation, Evidence summary |
| [D205](#d205) | Testis factors, six constraints | Hard | 6 | Protein class, Tissue category (RNA), Cell type category (scRNA), Subcellular location (ICC) |
| [D206](#d206) | Neutrophil membrane, six constraints | Hard | 5 | Immune cell category (RNA), Immune cell lineage category (RNA), Subcellular location (ICC), Tissue category (RNA), Secretome annotation |
| [D207](#d207) | Heart contraction, six constraints | Hard | 5 | Tissue category (RNA), Cell type category (scRNA), Tissue expression (IHC), Subcellular location (ICC) |
| [D208](#d208) | Placental secretion, five constraints | Medium | 5 | Tissue category (RNA), Cell type category (scRNA), Secretome annotation, Evidence summary |
| [D209](#d209) | Retinal GPCRs, six constraints | Hard | 7 | Protein class, Tissue category (RNA), Cell type category (scRNA) |
| [D210](#d210) | Liver cancer prognosis, six constraints | Hard | 5 | Cancer category (RNA), Prognostic cancer, Tissue category (RNA), Cell type category (scRNA), Secretome annotation |
| [D211](#d211) | Renal cancer favorable, five constraints | Hard | 4 | Prognostic cancer, Tissue category (RNA), Subcellular location (ICC), Protein class |
| [D212](#d212) | Cerebellum nucleic acid cluster | Hard | 4 | Brain expression cluster (RNA), Tissue category (RNA), Subcellular location (ICC) |
| [D213](#d213) | Skin barrier, six constraints | Hard | 6 | Cell type category (scRNA), Tissue expression (IHC), Tissue category (RNA), Protein class |
| [D214](#d214) | Thyroid, glandular staining, not enzymes | Hard | 4 | Tissue category (RNA), Tissue expression (IHC), Protein class |
| [D215](#d215) | Adrenal steroid enzymes, six constraints | Hard | 6 | Protein class, Tissue category (RNA), Subcellular location (ICC), Brain region category (RNA), Secretome annotation |
| [D216](#d216) | Prostate secretome, six constraints | Hard | 6 | Tissue category (RNA), Cell type category (scRNA), Secretome annotation, Tissue expression (IHC), Protein class |
| [D217](#d217) | Bone marrow, six constraints | Hard | 6 | Tissue category (RNA), Immune cell lineage category (RNA), Tissue expression (IHC), Subcellular location (ICC), Protein class |
| [D218](#d218) | Salivary or pancreas digestive | Hard | 5 | Tissue category (RNA), Secretome annotation |
| [D219](#d219) | Lung alveolar, six constraints | Hard | 5 | Tissue category (RNA), Cell type category (scRNA), Tissue expression (IHC), Evidence summary, Protein class |
| [D220](#d220) | Sperm tail, seven constraints | Hard | 7 | Tissue category (RNA), Cell type category (scRNA), Protein class |
| [D221](#d221) | Choroid plexus transporters | Medium | 5 | Protein class, Brain region category (RNA), Tissue category (RNA), Subcellular location (ICC), Evidence summary |
| [D222](#d222) | Hypothalamic peptides | Hard | 5 | Brain region category (RNA), Secretome annotation, Tissue category (RNA), Protein class |
| [D223](#d223) | Pituitary hormones | Hard | 7 | Tissue category (RNA), Secretome annotation, Evidence summary, Protein class |
| [D224](#d224) | Parathyroid and thyroid | Hard | 4 | Tissue category (RNA), Secretome annotation, Protein class |
| [D225](#d225) | Digestive proteases, six constraints | Hard | 6 | Protein class, Secretome annotation, Tissue category (RNA) |
| [D226](#d226) | Ovarian stroma | Hard | 4 | Tissue category (RNA), Cell type category (scRNA), Secretome annotation |
| [D227](#d227) | Epididymis secretome | Hard | 5 | Tissue category (RNA), Secretome annotation, Protein class |
| [D228](#d228) | Fallopian tube, not liver, not nuclear | Hard | 4 | Tissue category (RNA), Evidence summary, Subcellular location (ICC) |
| [D229](#d229) | Tongue and esophagus, keratinocytes | Hard | 4 | Tissue category (RNA), Cell type category (scRNA), Protein class |
| [D230](#d230) | Urinary bladder urothelium | Medium | 4 | Tissue category (RNA), Tissue expression (IHC), Subcellular location (ICC) |
| [D231](#d231) | Breast myoepithelium | Hard | 4 | Tissue category (RNA), Tissue expression (IHC), Secretome annotation |
| [D232](#d232) | Seminal vesicle secretome | Hard | 6 | Tissue category (RNA), Secretome annotation, Protein class |
| [D233](#d233) | Gallbladder, cholangiocytes | Medium | 3 | Tissue category (RNA), Cell type category (scRNA) |
| [D234](#d234) | Smooth muscle, not heart-specific | Medium | 4 | Tissue category (RNA), Cell type category (scRNA), Evidence summary |
| [D235](#d235) | Cervix and vagina, keratinocytes | Hard | 4 | Tissue category (RNA), Cell type category (scRNA), Secretome annotation |
| [D236](#d236) | Adipose secretome, seven constraints | Hard | 7 | Tissue category (RNA), Cell type category (scRNA), Secretome annotation, Evidence summary, Protein class |

## Questions

### D1

**Transcription factors** (Easy: scope 0, schema depth 0, logic 0, wording 0; 1 filter on 1 field; single-level options; inclusions only; the atlas's own words.)

Which genes encode transcription factors?

### D2

**Protein kinases** (Easy: scope 0, schema depth 1, logic 0, wording 0; 1 filter on 1 field; a two-level path; inclusions only; the atlas's own words.)

List all protein kinases.

### D3

**CD markers** (Easy: scope 0, schema depth 0, logic 0, wording 0; 1 filter on 1 field; single-level options; inclusions only; the atlas's own words.)

Which genes are CD markers?

### D4

**Liver-specific genes** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are liver-specific?

### D5

**Pancreas above average** (Easy: scope 0, schema depth 1, logic 0, wording 0; 1 filter on 1 field; a two-level path; inclusions only; the atlas's own words.)

Genes with enhanced expression in pancreas.

### D6

**Absent from kidney** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes have no detectable mRNA in kidney?

### D7

**Ubiquitous genes** (Medium: scope 0, schema depth 2, logic 0, wording 2; 1 filter on 1 field; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

List the ubiquitously expressed genes, those found in every tissue.

### D8

**Cerebellum-specific** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are specific to the cerebellum among brain regions?

### D9

**Silent in hypothalamus** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Genes with no detectable mRNA in the hypothalamus.

### D10

**Hepatocyte-specific** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are hepatocyte-specific in the single-cell data?

### D11

**Cardiomyocytes above average** (Easy: scope 0, schema depth 1, logic 0, wording 0; 1 filter on 1 field; a two-level path; inclusions only; the atlas's own words.)

Genes with enhanced expression in cardiomyocytes across single cell types.

### D12

**Neutrophil-specific** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are neutrophil-specific among blood immune cells?

### D13

**Bloodstream secretome** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which genes encode proteins secreted into the blood?

### D14

**Digestive secretome** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

List the genes whose proteins are secreted in the digestive tract.

### D15

**Nucleoplasm** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which proteins are nucleoplasmic?

### D16

**Mitochondria** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Mitochondrial proteins by immunofluorescence.

### D17

**Chromosome 17** (Easy: scope 0, schema depth 0, logic 0, wording 0; 1 filter on 1 field; single-level options; inclusions only; the atlas's own words.)

Which genes are on chromosome 17?

### D18

**Y chromosome** (Easy: scope 0, schema depth 0, logic 0, wording 0; 1 filter on 1 field; single-level options; inclusions only; the atlas's own words.)

List the genes encoded on the Y chromosome.

### D19

**Protein-level evidence** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which genes have protein-level evidence?

### D20

**Better survival in renal cancer** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are validated markers of longer survival in kidney renal clear cell carcinoma?

### D21

**Glioblastoma-specific** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Genes specific to glioblastoma among the TCGA cancers.

### D22

**Neuropeptide cluster** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which genes are in the hypothalamus neuropeptide signaling brain co-expression cluster?

### D23

**With antibodies** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which genes have an atlas antibody?

### D24

**T-cell lineage** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are enriched in the T-cell lineage?

### D25

**Liver-specific enzymes** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which enzymes are liver-specific?

### D26

**Testis-specific transcription factors** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which transcription factors are testis-specific?

### D27

**Plasma proteins in blood** (Easy: scope 1, schema depth 0, logic 0, wording 1; 2 filters on 2 fields; single-level options; inclusions only; a derived form of an option.)

Which plasma proteins are secreted into the blood?

### D28

**Kidney-specific transporters** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

List the kidney-specific transporters.

### D29

**Cortex channels above average** (Easy: scope 1, schema depth 1, logic 0, wording 0; 2 filters on 2 fields; a two-level path; inclusions only; the atlas's own words.)

Which voltage-gated ion channels have enhanced expression in the cerebral cortex among brain regions?

### D30

**Drug targets on X** (Easy: scope 1, schema depth 0, logic 0, wording 1; 2 filters on 2 fields; single-level options; inclusions only; a derived form of an option.)

Which targets of FDA-approved drugs lie on the X chromosome?

### D31

**Nuclear receptors in liver** (Medium: scope 1, schema depth 1, logic 0, wording 2; 2 filters on 2 fields; a two-level path; inclusions only; a category given by its definition.)

Which nuclear receptors are expressed above the tissue average in liver?

### D32

**CD markers at the membrane** (Easy: scope 1, schema depth 0, logic 0, wording 0; 2 filters on 2 fields; single-level options; inclusions only; the atlas's own words.)

Which CD markers sit at the plasma membrane?

### D33

**Pancreatic digestive secretion** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which pancreas-specific genes encode proteins secreted in the digestive tract?

### D34

**Liver-specific, kidney-silent** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are enriched in liver and have no detectable mRNA in kidney?

### D35

**Hepatocyte secretion to blood** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which hepatocyte-specific genes (single-cell) encode blood-secreted proteins?

### D36

**Basophil genes on chromosome 1** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes on chromosome 1 are basophil-specific among blood immune cells?

### D37

**Muscle-specific, protein evidence** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which skeletal-muscle-specific genes have protein-level evidence?

### D38

**Cytosolic enzymes** (Easy: scope 1, schema depth 0, logic 0, wording 1; 2 filters on 2 fields; single-level options; inclusions only; a derived form of an option.)

Which enzymes are cytosolic?

### D39

**Retina-specific GPCRs** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which GPCRs are retina-specific?

### D40

**Poor survival in liver cancer** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which blood-secreted proteins are validated markers of shorter survival in liver hepatocellular carcinoma?

### D41

**Placenta-specific** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are placenta-specific?

### D42

**Thyroid group** (Medium: scope 0, schema depth 1, logic 0, wording 2; 1 filter on 1 field; a two-level path; inclusions only; a category given by its definition.)

List the genes enriched in a small group of tissues that includes the thyroid gland.

### D43

**No tissue preference** (Medium: scope 0, schema depth 2, logic 0, wording 2; 1 filter on 1 field; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which genes are expressed with no tissue preference at all, detected somewhere but elevated nowhere?

### D44

**Prostate-specific cancer genes** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which cancer-related genes are prostate-specific?

### D45

**Golgi apparatus** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which proteins localize to the Golgi apparatus?

### D46

**Proteases** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

List the proteases.

### D47

**Pituitary-specific** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are pituitary-gland-specific?

### D48

**Astrocyte-specific** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are astrocyte-specific in the single-cell data?

### D49

**Choroid plexus-specific** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Genes specific to the choroid plexus among brain regions.

### D50

**Secreted in brain** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which genes encode proteins secreted locally in the brain?

### D51

**Tyrosine kinases** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes encode tyrosine kinases?

### D52

**Serine proteases at the membrane** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which serine proteases sit at the plasma membrane?

### D53

**Liver-specific, not blood-secreted** (Medium: scope 1, schema depth 1, logic 1, wording 1; 2 filters on 2 fields; a two-level path; one exclusion; a derived form of an option.)

Liver-specific genes whose proteins are not secreted into the blood.

### D54

**Kidney-specific enzymes, no CD markers** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 2 fields; a two-level path; one exclusion; a derived form of an option.)

Which kidney-specific enzymes are there, leaving out CD markers?

### D55

**Liver or kidney specific** (Medium: scope 0, schema depth 2, logic 0, wording 1; 1 filter on 1 field; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes are specific to either liver or kidney?

### D56

**Cerebellum or hypothalamus** (Medium: scope 1, schema depth 2, logic 0, wording 0; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; the atlas's own words.)

Which transcription factors are enriched in the cerebellum or in the hypothalamus among brain regions?

### D57

**Pancreas alone or in a group** (Medium: scope 0, schema depth 2, logic 0, wording 0; 1 filter on 1 field; a three-level path, several values on one level or a category with no entity; inclusions only; the atlas's own words.)

Which genes are enriched in pancreas, either on its own or together with a few other tissues?

### D58

**Strong hepatocyte staining** (Medium: scope 0, schema depth 2, logic 0, wording 1; 1 filter on 1 field; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes stain strongly in liver hepatocytes by immunohistochemistry?

### D59

**Glomerular staining, kidney-specific** (Medium: scope 1, schema depth 2, logic 0, wording 1; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which kidney-specific genes show moderate or strong staining in the glomeruli?

### D60

**Cortex-specific, not in cerebellum** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes are enriched in the cerebral cortex among brain regions yet have no detectable mRNA in the cerebellum?

### D61

**Nucleoplasm as main site** (Easy: scope 1, schema depth 1, logic 0, wording 0; 2 filters on 2 fields; a two-level path; inclusions only; the atlas's own words.)

Which transcription factors have the nucleoplasm as their main location?

### D62

**Not in the nucleus** (Medium: scope 1, schema depth 1, logic 1, wording 1; 2 filters on 2 fields; a two-level path; one exclusion; a derived form of an option.)

Which protein kinases are never seen in the nucleoplasm?

### D63

**Small-molecule targets in liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which targets of approved small-molecule drugs have enhanced expression in liver?

### D64

**Biologic targets secreted** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which targets of approved biologic drugs are secreted into the blood?

### D65

**Cancer drivers on chromosome 3** (Easy: scope 1, schema depth 1, logic 0, wording 0; 2 filters on 2 fields; a two-level path; inclusions only; the atlas's own words.)

Which cancer driver genes are on chromosome 3?

### D66

**Zinc-finger factors in testis** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which zinc-coordinating transcription factors are testis-specific?

### D67

**Channels above average in cortex** (Easy: scope 1, schema depth 1, logic 0, wording 0; 2 filters on 2 fields; a two-level path; inclusions only; the atlas's own words.)

Which channel and pore transporters have enhanced expression in the cerebral cortex among brain regions?

### D68

**Serotonin receptors** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which serotonin receptors have no detectable mRNA in liver?

### D69

**Olfactory receptors detected somewhere** (Medium: scope 1, schema depth 2, logic 0, wording 2; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which olfactory or gustatory receptors are expressed in one tissue only?

### D70

**Monocyte-specific membrane** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which plasma membrane proteins are specific to classical monocytes among blood immune cells?

### D71

**Silent in all immune cells** (Medium: scope 1, schema depth 2, logic 0, wording 1; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which transcription factors have no detectable mRNA in any blood immune cell type?

### D72

**B-cell lineage secreted** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which B-cell-lineage-enriched genes encode blood-secreted proteins?

### D73

**Better survival in lung adenocarcinoma** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which transcription factors are potential (not yet validated) markers of longer survival in lung adenocarcinoma?

### D74

**Shorter survival, membrane** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which plasma membrane proteins are validated markers of shorter survival in pancreatic adenocarcinoma?

### D75

**Liver cancer specific enzymes** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which enzymes are specific to liver hepatocellular carcinoma among the TCGA cancers?

### D76

**Testicular cancer above average** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which testis-specific genes have enhanced expression in testicular germ cell tumor among cancers?

### D77

**Neuropeptide cluster, hypothalamus-specific** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes of the hypothalamus neuropeptide signaling brain cluster are hypothalamus-specific among brain regions?

### D78

**Myelination cluster** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which genes make up the white matter myelination brain co-expression cluster?

### D79

**Degranulation cluster, membrane** (Easy: scope 1, schema depth 0, logic 0, wording 1; 2 filters on 2 fields; single-level options; inclusions only; a derived form of an option.)

Which genes of the neutrophil degranulation blood co-expression cluster sit at the plasma membrane?

### D80

**Basophil proteolysis cluster** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which genes form the basophil proteolysis co-expression cluster?

### D81

**Cortex-specific, absent in liver and kidney** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes specific to the cerebral cortex among brain regions have no detectable mRNA in liver and none in kidney?

### D82

**Heart-specific channels, protein evidence** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which voltage-gated ion channels are heart-muscle-specific and have protein-level evidence?

### D83

**Transcript-level only** (Easy: scope 1, schema depth 0, logic 0, wording 1; 2 filters on 2 fields; single-level options; inclusions only; a derived form of an option.)

Which genes on chromosome 19 are known at transcript level only?

### D84

**Mitochondrial genome** (Easy: scope 0, schema depth 0, logic 0, wording 1; 1 filter on 1 field; single-level options; inclusions only; a derived form of an option.)

Which genes are encoded by the mitochondrial genome?

### D85

**Secreted in testis area** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which testis-specific genes encode proteins secreted in the male reproductive tract?

### D86

**Extracellular matrix, not blood** (Medium: scope 1, schema depth 0, logic 1, wording 1; 2 filters on 1 field; single-level options; one exclusion; a derived form of an option.)

Which genes encode proteins secreted to the extracellular matrix but not into the blood?

### D87

**Vesicles as main site** (Easy: scope 0, schema depth 1, logic 0, wording 0; 1 filter on 1 field; a two-level path; inclusions only; the atlas's own words.)

Which proteins have vesicles as their main location?

### D88

**Nucleoli, top reliability** (Easy: scope 0, schema depth 1, logic 0, wording 1; 1 filter on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which proteins are located in nucleoli with the highest antibody reliability score?

### D89

**Multiple compartments incl. mitochondria** (Easy: scope 0, schema depth 1, logic 0, wording 0; 1 filter on 1 field; a two-level path; inclusions only; the atlas's own words.)

Which proteins are found in several compartments, one of them mitochondria?

### D90

**Kupffer cells** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which plasma membrane proteins are enhanced in Kupffer cells (single-cell)?

### D91

**Oligodendrocytes not in liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which oligodendrocyte-specific genes (single-cell) have no detectable mRNA in liver?

### D92

**Sertoli or Leydig** (Medium: scope 0, schema depth 2, logic 0, wording 1; 1 filter on 1 field; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes are specific to Sertoli cells or Leydig cells in the single-cell data?

### D93

**Detected in a third of tissues** (Medium: scope 1, schema depth 2, logic 0, wording 2; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which CD markers are expressed in most tissues but not all?

### D94

**Detected in few tissues** (Medium: scope 1, schema depth 2, logic 0, wording 2; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which transcription factors are expressed in only a handful of tissues, more than one but well under a third?

### D95

**Brain-region ubiquitous** (Medium: scope 1, schema depth 2, logic 0, wording 2; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which protein kinases are expressed in every brain region?

### D96

**NK-cell specific, not T-cell** (Medium: scope 1, schema depth 1, logic 1, wording 1; 2 filters on 2 fields; a two-level path; one exclusion; a derived form of an option.)

Which NK-cell-specific genes (blood immune cells) are not enriched in the T-cell lineage?

### D97

**Excluding cancer genes** (Medium: scope 1, schema depth 1, logic 1, wording 1; 2 filters on 2 fields; a two-level path; one exclusion; a derived form of an option.)

Which thyroid-gland-specific genes are there once cancer-related genes are excluded?

### D98

**Not kidney-specific** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 2 fields; a two-level path; one exclusion; a derived form of an option.)

Which transporters are liver-specific but not kidney-specific?

### D99

**Purkinje staining** (Medium: scope 0, schema depth 2, logic 0, wording 1; 1 filter on 1 field; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes stain strongly in Purkinje cells of the cerebellum?

### D100

**No staining in cardiomyocytes** (Medium: scope 1, schema depth 2, logic 0, wording 1; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes with enhanced heart muscle expression show no antibody staining in cardiomyocytes?

### D101

**Liver-specific secreted enzymes, silent elsewhere** (Medium: scope 2, schema depth 1, logic 0, wording 1; 5 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which liver-specific enzymes have no detectable mRNA in kidney and none in testis, and are secreted into the blood?

### D102

**Testis-specific factors, not in brain regions** (Medium: scope 2, schema depth 1, logic 0, wording 1; 5 filters on 4 fields; a two-level path; inclusions only; a derived form of an option.)

Which testis-specific transcription factors have no detectable mRNA in the cerebral cortex and none in cerebellum, and have protein-level evidence?

### D103

**Kidney transporters, membrane, not liver** (Hard: scope 2, schema depth 1, logic 2, wording 1; 5 filters on 3 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Kidney-specific transporters at the plasma membrane that have no detectable mRNA in liver, leaving out targets of FDA-approved drugs.

### D104

**Pancreatic proteases to the gut** (Medium: scope 2, schema depth 1, logic 0, wording 1; 5 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which pancreas-specific proteases are secreted in the digestive tract and have no detectable mRNA in liver and none in lung?

### D105

**Brain-wide channels, not liver** (Hard: scope 2, schema depth 2, logic 0, wording 2; 5 filters on 5 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which voltage-gated ion channels on chromosome 1 or 2 are expressed in every brain region, have no detectable mRNA in liver, and are located at the plasma membrane?

### D106

**Hepatocyte plasma proteins** (Medium: scope 2, schema depth 1, logic 0, wording 1; 5 filters on 5 fields; a two-level path; inclusions only; a derived form of an option.)

Which plasma proteins are hepatocyte-specific (single-cell), secreted into the blood, backed by protein-level evidence, and have no detectable mRNA in kidney?

### D107

**Neutrophil-specific membrane, not T-cells** (Medium: scope 2, schema depth 1, logic 1, wording 1; 4 filters on 4 fields; a two-level path; one exclusion; a derived form of an option.)

Which neutrophil-specific plasma membrane proteins (blood immune cells) are not enriched in the T-cell lineage and have an atlas antibody?

### D108

**Vasculature cluster, lymphatic endothelium** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes of the endothelial vasculature brain cluster are enhanced in lymphatic endothelial cells (single-cell) and seen at the plasma membrane?

### D109

**Renal cancer survival, kidney-specific** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which validated markers of longer survival in kidney renal clear cell carcinoma are kidney-specific and not secreted into the blood?

### D110

**Liver cancer, poor survival** (Medium: scope 1, schema depth 2, logic 0, wording 1; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes with enhanced expression in liver hepatocellular carcinoma among cancers are markers of shorter survival in it, potential or validated?

### D111

**Tyrosine kinases, broadly expressed, membrane** (Hard: scope 2, schema depth 2, logic 0, wording 2; 4 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which tyrosine kinases are expressed in every tissue, sit at the plasma membrane, and are targets of approved small-molecule drugs?

### D112

**Zinc-finger factors, nucleoplasm, chromosome 19** (Hard: scope 2, schema depth 2, logic 0, wording 2; 4 filters on 4 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which zinc-coordinating transcription factors on chromosome 19 have the nucleoplasm as their main location and are expressed in every tissue?

### D113

**Sertoli or Leydig, testis, not ovary** (Medium: scope 1, schema depth 2, logic 0, wording 1; 3 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which testis-specific genes are specific to Sertoli or Leydig cells in the single-cell data and have no detectable mRNA in ovary?

### D114

**Liver or kidney, secreted, no CD markers** (Medium: scope 1, schema depth 2, logic 1, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which blood-secreted proteins are specific to liver or kidney, CD markers excluded?

### D115

**Astrocytes, brain-wide, not liver** (Medium: scope 1, schema depth 2, logic 0, wording 2; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which genes enhanced in astrocytes (single-cell) are expressed in every brain region and have no detectable mRNA in liver?

### D116

**Pancreas alone or grouped, digestive, not blood** (Hard: scope 1, schema depth 2, logic 1, wording 2; 3 filters on 2 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a category given by its definition.)

Which genes enriched in pancreas, alone or with a few other tissues, are secreted in the digestive tract but not into the blood?

### D117

**Thyroid-specific, glandular staining, not cancer** (Medium: scope 1, schema depth 2, logic 1, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which thyroid-gland-specific genes stain moderately or strongly in thyroid glandular cells and are not cancer-related genes?

### D118

**Placenta-specific, trophoblast staining, secreted** (Medium: scope 1, schema depth 2, logic 0, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which placenta-specific genes stain strongly in trophoblastic cells and encode blood-secreted proteins?

### D119

**Cerebellum-specific, no glomerular staining** (Medium: scope 1, schema depth 2, logic 0, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes specific to the cerebellum among brain regions are unstained in the kidney glomeruli and have no detectable mRNA in liver?

### D120

**Basophils or eosinophils, not blood, chromosome 1** (Medium: scope 1, schema depth 2, logic 1, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which genes on chromosome 1 are specific to basophils or eosinophils among blood immune cells and not secreted into the blood?

### D121

**Prostate, glandular staining, not blood** (Medium: scope 1, schema depth 2, logic 1, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which genes enriched or enhanced in prostate stain moderately or strongly in prostate glandular cells and are not secreted into the blood?

### D122

**Oligodendrocytes, myelination, not kinases** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which genes enhanced in oligodendrocytes (single-cell) belong to the white matter myelination brain cluster and are not protein kinases?

### D123

**Monoamine cluster enzymes, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which enzymes of the monoamine neurotransmitter signalling brain cluster have no detectable mRNA in liver?

### D124

**Ovary above average, silent in testis** (Medium: scope 1, schema depth 2, logic 0, wording 2; 3 filters on 1 field; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which genes with enhanced ovary expression have no detectable mRNA in testis, and are expressed in only a handful of tissues?

### D125

**Salivary secretome** (Medium: scope 2, schema depth 1, logic 0, wording 1; 4 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which salivary-gland-specific genes encode proteins secreted in the digestive tract and have no detectable mRNA in pancreas and none in liver?

### D126

**Retina-specific GPCRs, not liver, protein evidence** (Medium: scope 2, schema depth 1, logic 0, wording 1; 4 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which retina-specific GPCRs have no detectable mRNA in liver, and have protein-level evidence?

### D127

**Lung above average, alveolar staining, not cancer** (Medium: scope 1, schema depth 2, logic 1, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which genes with enhanced lung expression stain moderately or strongly in alveolar cells and are not cancer-related genes?

### D128

**Skeletal muscle, myocyte staining, no nucleoplasm** (Medium: scope 1, schema depth 2, logic 1, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which skeletal-muscle-specific genes stain strongly in myocytes and are never seen in the nucleoplasm?

### D129

**Bone marrow specific, no antibodies** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which bone-marrow-specific genes have no atlas antibody?

### D130

**Hematopoietic staining, monocytes** (Medium: scope 1, schema depth 2, logic 0, wording 1; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes enhanced in classical monocytes among blood immune cells stain moderately or strongly in hematopoietic cells of the bone marrow?

### D131

**Cortex-specific, not cerebellum or hypothalamus** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 1 field; a two-level path; inclusions only; a derived form of an option.)

Which genes specific to the cerebral cortex among brain regions have no detectable mRNA in the cerebellum and none in the hypothalamus?

### D132

**Liver-specific drug targets, not blood** (Medium: scope 2, schema depth 1, logic 1, wording 1; 4 filters on 4 fields; a two-level path; one exclusion; a derived form of an option.)

Which liver-specific targets of FDA-approved drugs are cytosolic and not secreted into the blood?

### D133

**Kidney tubule staining, kidney-specific transporters** (Medium: scope 2, schema depth 2, logic 0, wording 1; 4 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which kidney-specific transporters stain strongly in the kidney tubules and have no detectable mRNA in liver?

### D134

**Adipose, not liver, secreted** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes with enhanced adipose tissue expression have no detectable mRNA in liver, and are secreted into the blood?

### D135

**Cancer biomarkers, secreted, chromosome 1 or 2** (Medium: scope 1, schema depth 2, logic 0, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which candidate cancer biomarkers are secreted into the blood and located on chromosome 1 or 2?

### D136

**Chromosome 21 factors, nucleoplasm, protein evidence** (Medium: scope 2, schema depth 0, logic 0, wording 1; 4 filters on 4 fields; single-level options; inclusions only; a derived form of an option.)

Which transcription factors on chromosome 21 are nucleoplasmic and have protein-level evidence?

### D137

**Cardiomyocyte-specific, not kidney, not membrane** (Medium: scope 1, schema depth 1, logic 2, wording 1; 3 filters on 3 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which cardiomyocyte-specific genes (single-cell) have no detectable mRNA in kidney, and are not at the plasma membrane?

### D138

**Group with heart muscle, not blood** (Medium: scope 1, schema depth 1, logic 1, wording 2; 2 filters on 2 fields; a two-level path; one exclusion; a category given by its definition.)

Which genes enriched in a small group of tissues that includes heart muscle are not secreted into the blood?

### D139

**Choroid plexus region, mitochondria cluster** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes of the choroid plexus mitochondria co-expression cluster (brain) are choroid-plexus-specific among brain regions?

### D140

**T-cell lineage, not detected in liver, membrane** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which T-cell-lineage-enriched genes have no detectable mRNA in liver, and sit at the plasma membrane?

### D141

**Kupffer cells, monocytes, not blood** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which genes enhanced in Kupffer cells (single-cell) and in classical monocytes (blood immune cells) are not secreted into the blood?

### D142

**Basic-domain factors, testis, not ovary** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which basic-domain transcription factors are testis-specific and have no detectable mRNA in ovary?

### D143

**Helix-turn-helix, brain-region ubiquitous** (Medium: scope 1, schema depth 2, logic 0, wording 2; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which helix-turn-helix transcription factors are expressed in every brain region and have the nucleoplasm as their main location?

### D144

**Metalloproteases secreted, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which metalloproteases are secreted to the extracellular matrix and have no detectable mRNA in liver?

### D145

**Oxidoreductases, liver, mitochondria** (Easy: scope 1, schema depth 1, logic 0, wording 0; 3 filters on 3 fields; a two-level path; inclusions only; the atlas's own words.)

Which mitochondrial oxidoreductases have enhanced liver expression?

### D146

**Primary active transporters, membrane, chromosome X** (Easy: scope 1, schema depth 1, logic 0, wording 0; 3 filters on 3 fields; a two-level path; inclusions only; the atlas's own words.)

Which primary active transporters at the plasma membrane are on the X chromosome?

### D147

**Electrochemical transporters, kidney, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which electrochemical potential-driven transporters are kidney-specific and have no detectable mRNA in liver?

### D148

**Colon glandular staining, digestive** (Medium: scope 1, schema depth 2, logic 0, wording 1; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes stain strongly in colon glandular cells and encode proteins secreted in the digestive tract?

### D149

**Spleen white pulp, B-cell lineage** (Medium: scope 1, schema depth 2, logic 0, wording 1; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which B-cell-lineage-enriched genes stain moderately or strongly in the white pulp of the spleen?

### D150

**Epidermal staining, skin silent in liver** (Medium: scope 1, schema depth 2, logic 0, wording 1; 3 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes stain strongly in skin keratinocytes and have no detectable mRNA in liver and none in kidney?

### D151

**Cortex channels, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which voltage-gated ion channels with enhanced expression in the cerebral cortex among brain regions have no detectable mRNA in liver?

### D152

**Hepatocyte enzymes, strong staining, not blood** (Hard: scope 2, schema depth 2, logic 1, wording 1; 4 filters on 4 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which hepatocyte-specific enzymes (single-cell) stain strongly in liver hepatocytes and are not secreted into the blood?

### D153

**Plasma cells, secreted, not gut** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 2 fields; a two-level path; one exclusion; a derived form of an option.)

Which genes enhanced in plasma cells (single-cell) encode blood-secreted proteins that are not secreted in the digestive tract?

### D154

**Salivary duct cells, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes with enhanced salivary gland expression are enhanced in salivary duct cells (single-cell) and have no detectable mRNA in liver?

### D155

**Spermatid-specific, no somatic expression** (Medium: scope 2, schema depth 1, logic 0, wording 1; 5 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which testis-specific genes are specific to late spermatids (single-cell) and have no detectable mRNA in liver, none in kidney and none in lung?

### D156

**Bone marrow specific, not membrane** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which bone-marrow-specific genes with protein-level evidence are not at the plasma membrane?

### D157

**Plasma cells, immunoglobulin-free** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which plasma-cell-specific genes (single-cell) encode blood-secreted proteins, T-cell receptor genes excluded?

### D158

**Rod photoreceptors, retina** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which retina-specific genes are enhanced in rod photoreceptor cells (single-cell)?

### D159

**Melanocytes, skin silent in liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which melanocyte-specific genes (single-cell) have no detectable mRNA in liver and none in kidney?

### D160

**Adipocytes, secreted, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which adipocyte-specific genes (single-cell) encode blood-secreted proteins and have no detectable mRNA in liver?

### D161

**Alveolar type 2, lung-specific, secreted** (Medium: scope 1, schema depth 2, logic 0, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which lung-specific genes are specific to alveolar type 2 cells (single-cell) and encode secreted proteins of unknown destination or secreted locally in other tissues?

### D162

**Kidney transporters, membrane** (Easy: scope 1, schema depth 1, logic 0, wording 0; 3 filters on 3 fields; a two-level path; inclusions only; the atlas's own words.)

Which plasma membrane transporters have enhanced kidney expression?

### D163

**Paneth cells, digestive, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes enhanced in Paneth cells (single-cell) are secreted in the digestive tract and have no detectable mRNA in liver?

### D164

**Synaptic cluster, brain-wide, not astrocytes** (Hard: scope 1, schema depth 2, logic 1, wording 2; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a category given by its definition.)

Which genes of the neuron synaptic function brain cluster are expressed in every brain region and not enhanced in astrocytes (single-cell)?

### D165

**Monoamine cluster, not liver, protein evidence** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes of the monoamine neurotransmitter signalling brain cluster have no detectable mRNA in liver, and have protein-level evidence?

### D166

**Microglia cluster, monocytes, not blood** (Medium: scope 1, schema depth 2, logic 1, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which genes of the macrophage and microglia immune response brain cluster are enhanced in classical or non-classical monocytes among blood immune cells and not secreted into the blood?

### D167

**Schwann cells, not brain regions** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which Schwann-cell-specific genes (single-cell) have no detectable mRNA in the cerebral cortex and none in the cerebellum?

### D168

**Cholangiocytes vs hepatocytes** (Medium: scope 1, schema depth 2, logic 1, wording 1; 3 filters on 2 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which genes enhanced in cholangiocytes (single-cell) stain moderately or strongly in liver cholangiocytes and are not hepatocyte-specific?

### D169

**Kidney above average, not liver** (Medium: scope 1, schema depth 2, logic 0, wording 2; 3 filters on 1 field; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which genes with enhanced kidney expression have no detectable mRNA in liver, and are expressed in only a handful of tissues?

### D170

**Lymphatic endothelium, membrane, ubiquitous** (Medium: scope 1, schema depth 2, logic 0, wording 2; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a category given by its definition.)

Which plasma membrane proteins enhanced in lymphatic endothelial cells (single-cell) are expressed in every tissue?

### D171

**Smooth muscle, actin, not heart-specific** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which smooth-muscle-cell-specific genes (single-cell) are seen on actin filaments and are not heart-muscle-specific?

### D172

**Fibroblasts, extracellular matrix** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which fibroblast-specific genes (single-cell) encode proteins secreted to the extracellular matrix?

### D173

**Skeletal muscle, myocyte staining, protein evidence** (Medium: scope 1, schema depth 2, logic 0, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which skeletal-muscle-specific genes stain moderately or strongly in myocytes and have protein-level evidence?

### D174

**Salivary duct cells, digestive** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes enhanced in salivary duct cells (single-cell) encode proteins secreted in the digestive tract?

### D175

**Paneth cells, digestive** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which Paneth-cell-specific genes (single-cell) are secreted in the digestive tract?

### D176

**Syncytiotrophoblasts, placenta, secreted** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which placenta-specific genes are specific to syncytiotrophoblasts (single-cell) and encode blood-secreted proteins?

### D177

**Rod photoreceptors, retina, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which retina-specific genes are specific to rod photoreceptor cells (single-cell) and have no detectable mRNA in liver?

### D178

**Plasmacytoid cluster, dendritic lineage** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes of the plasmacytoid dendritic cell plasma membrane blood cluster are enriched in the dendritic cell lineage?

### D179

**Granulosa cells, ovary above average** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes with enhanced ovary expression are enhanced in granulosa cells (single-cell)?

### D180

**Oocytes, not testis** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which oocyte-specific genes (single-cell) have no detectable mRNA in testis?

### D181

**Breast, myoepithelial cells** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes with enhanced breast expression are enhanced in breast myoepithelial cells (single-cell)?

### D182

**Kidney above average, membrane, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which plasma membrane proteins with enhanced kidney expression have no detectable mRNA in liver?

### D183

**Salivary duct transporters** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which transporters are enhanced in salivary duct cells (single-cell)?

### D184

**Alveolar type 2, lung, secreted** (Medium: scope 1, schema depth 2, logic 0, wording 1; 3 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes with enhanced lung expression are enhanced in alveolar type 2 cells (single-cell) and encode secreted proteins of unknown destination or secreted locally in other tissues?

### D185

**Late spermatids, testis, chromosome X** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which testis-specific genes on the X chromosome are late-spermatid-specific in the single-cell data?

### D186

**Hofbauer cells, placenta, not blood** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which genes enhanced in Hofbauer cells (single-cell) have enhanced placenta expression and are not secreted into the blood?

### D187

**Basal keratinocytes, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes enhanced in basal keratinocytes (single-cell) have no detectable mRNA in liver?

### D188

**Monocyte membrane cluster, no antibodies** (Easy: scope 1, schema depth 0, logic 0, wording 1; 2 filters on 2 fields; single-level options; inclusions only; a derived form of an option.)

Which genes of the monocyte plasma membrane protein blood cluster have no atlas antibody?

### D189

**Mesothelial cells, extracellular matrix** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes enhanced in mesothelial cells (single-cell) are secreted to the extracellular matrix?

### D190

**Lymphatic endothelium, membrane, not blood** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which plasma membrane proteins enhanced in lymphatic endothelial cells (single-cell) are not secreted into the blood?

### D191

**T-cells and T-lineage, membrane** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which plasma membrane proteins are T-cell-specific in the single-cell data and enriched in the T-cell lineage?

### D192

**B-cells, memory B, secreted** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes enhanced in B-cells (single-cell) and in memory B-cells (blood immune cells) encode blood-secreted proteins?

### D193

**NK-cells both datasets, not blood** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which NK-cell-specific genes in both the single-cell and the blood immune cell data are not secreted into the blood?

### D194

**Macrophages, lung alveolar staining** (Medium: scope 1, schema depth 2, logic 0, wording 1; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes enhanced in macrophages (single-cell) stain moderately or strongly in lung macrophages?

### D195

**Neutrophils, granulocyte lineage, not liver** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes enhanced in neutrophils among blood immune cells are enriched in the granulocyte lineage and have no detectable mRNA in liver?

### D196

**Dendritic cluster, dendritic cells** (Medium: scope 1, schema depth 2, logic 0, wording 1; 2 filters on 2 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes of the dendritic cell blood co-expression cluster are enhanced in myeloid or plasmacytoid dendritic cells among blood immune cells?

### D197

**Monocytes, single-cell and lineage** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which plasma membrane proteins enhanced in monocytes (single-cell) are enriched in the monocyte lineage?

### D198

**Cytotrophoblasts, placenta, not blood** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which genes enhanced in cytotrophoblasts (single-cell) have enhanced placenta expression and are not secreted into the blood?

### D199

**Leydig cells, steroid enzymes** (Medium: scope 1, schema depth 1, logic 0, wording 1; 3 filters on 3 fields; a two-level path; inclusions only; a derived form of an option.)

Which enzymes enhanced in Leydig cells (single-cell) have enhanced testis expression?

### D200

**Suprabasal keratinocytes, esophagus** (Medium: scope 1, schema depth 1, logic 0, wording 1; 2 filters on 2 fields; a two-level path; inclusions only; a derived form of an option.)

Which genes with enhanced esophagus expression are enhanced in suprabasal keratinocytes (single-cell)?

### D201

**Liver-specific secreted enzymes, five constraints** (Hard: scope 2, schema depth 1, logic 2, wording 1; 6 filters on 4 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which liver-specific enzymes are secreted into the blood, have protein-level evidence, have no detectable mRNA in kidney, and are not targets of FDA-approved drugs?

### D202

**Brain-wide channels, six constraints** (Hard: scope 2, schema depth 2, logic 2, wording 2; 6 filters on 4 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a category given by its definition.)

Which voltage-gated ion channels expressed in every brain region have no detectable mRNA in liver and none in kidney, are at the plasma membrane, and are not targets of approved small-molecule drugs?

### D203

**Kidney transporters, six constraints** (Hard: scope 2, schema depth 1, logic 2, wording 1; 6 filters on 4 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which kidney-specific transporters sit at the plasma membrane, have no detectable mRNA in liver and none in testis, and are not secreted into the blood?

### D204

**Pancreatic proteases, six constraints** (Hard: scope 2, schema depth 1, logic 2, wording 1; 6 filters on 4 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which pancreas-specific proteases are secreted in the digestive tract, have protein-level evidence, have no detectable mRNA in liver, and are not secreted into the blood?

### D205

**Testis factors, six constraints** (Hard: scope 2, schema depth 2, logic 2, wording 1; 6 filters on 4 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which testis-specific transcription factors are enhanced in early or late spermatids (single-cell), have no detectable mRNA in liver, are nucleoplasmic, and are not cancer-related genes?

### D206

**Neutrophil membrane, six constraints** (Hard: scope 2, schema depth 1, logic 2, wording 1; 5 filters on 5 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes enhanced in neutrophils among blood immune cells are enriched in the granulocyte lineage, are at the plasma membrane, have no detectable mRNA in liver, and are not secreted into the blood?

### D207

**Heart contraction, six constraints** (Hard: scope 2, schema depth 2, logic 2, wording 1; 5 filters on 4 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which heart-muscle-specific genes enhanced in cardiomyocytes (single-cell) stain moderately or strongly in cardiomyocytes, have no detectable mRNA in liver, and are never seen in the nucleoplasm?

### D208

**Placental secretion, five constraints** (Medium: scope 2, schema depth 1, logic 0, wording 1; 5 filters on 4 fields; a two-level path; inclusions only; a derived form of an option.)

Which placenta-specific genes enhanced in syncytiotrophoblasts (single-cell) encode blood-secreted proteins, have no detectable mRNA in liver, and have protein-level evidence?

### D209

**Retinal GPCRs, six constraints** (Hard: scope 2, schema depth 2, logic 2, wording 1; 7 filters on 3 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which retina-specific GPCRs are specific to rod or cone photoreceptor cells (single-cell), have no detectable mRNA in liver, none in kidney and none in lung, and are not targets of FDA-approved drugs?

### D210

**Liver cancer prognosis, six constraints** (Hard: scope 2, schema depth 2, logic 1, wording 1; 5 filters on 5 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which genes specific to liver hepatocellular carcinoma among cancers are markers of shorter survival in it, potential or validated, liver-specific, hepatocyte-specific in the single-cell data, and are not secreted into the blood?

### D211

**Renal cancer favorable, five constraints** (Hard: scope 2, schema depth 2, logic 1, wording 1; 4 filters on 4 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which validated markers of longer survival in kidney renal clear cell carcinoma are enriched or enhanced in kidney, are at the plasma membrane, and are not transporters?

### D212

**Cerebellum nucleic acid cluster** (Hard: scope 2, schema depth 1, logic 2, wording 1; 4 filters on 3 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes of the cerebellum nucleic acid binding brain cluster have no detectable mRNA in liver and none in kidney, and are not at the plasma membrane?

### D213

**Skin barrier, six constraints** (Hard: scope 2, schema depth 2, logic 2, wording 1; 6 filters on 4 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes enhanced in suprabasal keratinocytes (single-cell) stain moderately or strongly in skin keratinocytes, have no detectable mRNA in liver, none in kidney and none in lung, and are not cancer-related genes?

### D214

**Thyroid, glandular staining, not enzymes** (Hard: scope 2, schema depth 2, logic 2, wording 1; 4 filters on 3 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes enriched or enhanced in thyroid gland stain moderately or strongly in thyroid glandular cells, have no detectable mRNA in liver, and are not enzymes?

### D215

**Adrenal steroid enzymes, six constraints** (Hard: scope 2, schema depth 2, logic 2, wording 1; 6 filters on 5 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which adrenal-gland-specific enzymes localize to mitochondria or the endoplasmic reticulum, have no detectable mRNA in the cerebral cortex, none in liver, and are not secreted into the blood?

### D216

**Prostate secretome, six constraints** (Hard: scope 2, schema depth 2, logic 2, wording 1; 6 filters on 5 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which prostate-specific genes are specific to prostatic glandular cells (single-cell), secreted in the male reproductive tract, stain moderately or strongly in prostate glandular cells, have no detectable mRNA in liver, and are not CD markers?

### D217

**Bone marrow, six constraints** (Hard: scope 2, schema depth 2, logic 2, wording 1; 6 filters on 5 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which bone-marrow-specific genes are enriched in the granulocyte or monocyte lineage, stain moderately or strongly in hematopoietic cells, have no detectable mRNA in liver, are not at the plasma membrane, and are not transcription factors?

### D218

**Salivary or pancreas digestive** (Hard: scope 2, schema depth 2, logic 2, wording 1; 5 filters on 2 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes specific to either salivary gland or pancreas are secreted in the digestive tract, have no detectable mRNA in liver and none in kidney, and are not secreted into the blood?

### D219

**Lung alveolar, six constraints** (Hard: scope 2, schema depth 2, logic 1, wording 1; 5 filters on 5 fields; a three-level path, several values on one level or a category with no entity; one exclusion; a derived form of an option.)

Which genes with enhanced lung expression are enhanced in alveolar type 2 cells (single-cell), stain moderately or strongly in alveolar cells, have protein-level evidence, and are not cancer-related genes?

### D220

**Sperm tail, seven constraints** (Hard: scope 2, schema depth 1, logic 2, wording 1; 7 filters on 3 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which testis-specific genes are specific to late spermatids (single-cell), have no detectable mRNA in liver, none in kidney, none in lung and none in ovary, and are not transcription factors?

### D221

**Choroid plexus transporters** (Medium: scope 2, schema depth 1, logic 0, wording 1; 5 filters on 5 fields; a two-level path; inclusions only; a derived form of an option.)

Which choroid-plexus-specific transporters (brain regions) have no detectable mRNA in liver, sit at the plasma membrane, and have protein-level evidence?

### D222

**Hypothalamic peptides** (Hard: scope 2, schema depth 2, logic 2, wording 1; 5 filters on 4 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes specific to the hypothalamus among brain regions encode proteins secreted locally in the brain or into the blood, have no detectable mRNA in liver and none in kidney, and are not enzymes?

### D223

**Pituitary hormones** (Hard: scope 2, schema depth 1, logic 2, wording 1; 7 filters on 4 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which pituitary-specific genes encode blood-secreted proteins, have no detectable mRNA in liver, none in kidney and none in lung, have protein-level evidence, and are not enzymes?

### D224

**Parathyroid and thyroid** (Hard: scope 2, schema depth 2, logic 2, wording 1; 4 filters on 3 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes specific to either the parathyroid or the thyroid gland encode blood-secreted proteins, have no detectable mRNA in liver, and are not enzymes?

### D225

**Digestive proteases, six constraints** (Hard: scope 2, schema depth 1, logic 2, wording 1; 6 filters on 3 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which proteases secreted in the digestive tract have no detectable mRNA in liver, none in kidney and none in lung, and are not secreted into the blood?

### D226

**Ovarian stroma** (Hard: scope 2, schema depth 2, logic 2, wording 1; 4 filters on 3 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes with enhanced ovary expression are enhanced in ovarian stromal or granulosa cells (single-cell), have no detectable mRNA in testis, and are not secreted into the blood?

### D227

**Epididymis secretome** (Hard: scope 2, schema depth 1, logic 2, wording 1; 5 filters on 3 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which epididymis-specific genes encode proteins secreted in the male reproductive tract, have no detectable mRNA in liver and none in kidney, and are not enzymes?

### D228

**Fallopian tube, not liver, not nuclear** (Hard: scope 2, schema depth 1, logic 2, wording 1; 4 filters on 3 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes with enhanced fallopian tube expression have no detectable mRNA in liver, have protein-level evidence, and are never seen in the nucleoplasm?

### D229

**Tongue and esophagus, keratinocytes** (Hard: scope 2, schema depth 2, logic 2, wording 1; 4 filters on 3 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes specific to either tongue or esophagus are enhanced in suprabasal keratinocytes (single-cell), have no detectable mRNA in liver, and are not cancer-related genes?

### D230

**Urinary bladder urothelium** (Medium: scope 2, schema depth 2, logic 0, wording 1; 4 filters on 3 fields; a three-level path, several values on one level or a category with no entity; inclusions only; a derived form of an option.)

Which genes with enhanced urinary bladder expression stain moderately or strongly in urothelial cells, have no detectable mRNA in liver, and sit at the plasma membrane?

### D231

**Breast myoepithelium** (Hard: scope 2, schema depth 2, logic 2, wording 1; 4 filters on 3 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes with enhanced breast expression stain moderately or strongly in breast myoepithelial cells, have no detectable mRNA in liver, and are not secreted into the blood?

### D232

**Seminal vesicle secretome** (Hard: scope 2, schema depth 1, logic 2, wording 1; 6 filters on 3 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which seminal-vesicle-specific genes encode proteins secreted in the male reproductive tract, have no detectable mRNA in liver, none in kidney and none in lung, and are not enzymes?

### D233

**Gallbladder, cholangiocytes** (Medium: scope 1, schema depth 1, logic 1, wording 1; 3 filters on 2 fields; a two-level path; one exclusion; a derived form of an option.)

Which genes with enhanced gallbladder expression are enhanced in cholangiocytes (single-cell) but not hepatocyte-specific?

### D234

**Smooth muscle, not heart-specific** (Medium: scope 2, schema depth 1, logic 1, wording 1; 4 filters on 3 fields; a two-level path; one exclusion; a derived form of an option.)

Which genes with enhanced smooth muscle expression are enhanced in smooth muscle cells (single-cell), have protein-level evidence, and are not heart-muscle-specific?

### D235

**Cervix and vagina, keratinocytes** (Hard: scope 2, schema depth 2, logic 2, wording 1; 4 filters on 3 fields; a three-level path, several values on one level or a category with no entity; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes enriched or enhanced in cervix or vagina are enhanced in suprabasal keratinocytes (single-cell), have no detectable mRNA in liver, and are not secreted into the blood?

### D236

**Adipose secretome, seven constraints** (Hard: scope 2, schema depth 1, logic 2, wording 1; 7 filters on 5 fields; a two-level path; an exclusion beside an absence category or several exclusions; a derived form of an option.)

Which genes with enhanced adipose tissue expression are enhanced in adipocytes (single-cell), encode blood-secreted proteins, have no detectable mRNA in liver and none in kidney, have protein-level evidence, and are not enzymes?
