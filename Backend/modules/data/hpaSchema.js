// Auto-generated HPA Schema
// Format: category → field → { urlKey, levels: [{ label, options }] }
// URL format: urlKey:level0Value;level1Value;level2Value,...

const hpaSchema = {
  "GENE INFO": {
    "Gene name": {
      "urlKey": "gene_name",
      "levels": []
    },
    "Protein class": {
      "urlKey": "protein_class",
      "levels": [
        {
          "index": 0,
          "label": "Class",
          "selectId": "main_class",
          "multiSelect": false,
          "options": [
            "Blood group antigen proteins",
            "Cancer-related genes",
            "Candidate cardiovascular disease genes",
            "CD markers",
            "Citric acid cycle related proteins",
            "Disease related genes",
            "Enzymes",
            "Essential proteins",
            "FDA approved drug targets",
            "G-protein coupled receptors",
            "Human disease related genes",
            "Immunoglobulin genes",
            "Mapped to neXtProt",
            "Mapped to UniProt SWISS-PROT",
            "Metabolic proteins",
            "Nuclear receptors",
            "Plasma proteins",
            "Potential drug targets",
            "Predicted intracellular proteins",
            "Predicted membrane proteins",
            "Predicted secreted proteins",
            "Protein evidence (Ezkurdia et al 2014)",
            "Protein evidence (Kim et al 2014)",
            "RAS pathway related proteins",
            "Ribosomal proteins",
            "RNA polymerase related proteins",
            "T-cell receptor genes",
            "Transcription factors",
            "Transporters",
            "Voltage-gated ion channels"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Subclass",
          "selectId": "sub_class",
          "multiSelect": false,
          "options": [],
          "groups": null
        }
      ]
    },
    "Uniprot keyword": {
      "urlKey": "uniprot_keyword",
      "levels": [
        {
          "index": 0,
          "label": "Category",
          "selectId": "kw_cat",
          "multiSelect": false,
          "options": [
            "Biological process",
            "Molecular function",
            "Disease"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Keyword",
          "selectId": "keyword",
          "multiSelect": true,
          "options": [],
          "groups": null
        }
      ]
    },
    "Chromosome": {
      "urlKey": "chromosome",
      "levels": [
        {
          "index": 0,
          "label": "Chromosome",
          "selectId": "chr",
          "multiSelect": true,
          "options": [
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "10",
            "11",
            "12",
            "13",
            "14",
            "15",
            "16",
            "17",
            "18",
            "19",
            "20",
            "21",
            "22",
            "MT",
            "Unmapped",
            "X",
            "Y"
          ],
          "groups": null
        }
      ]
    },
    "External id": {
      "urlKey": "external_id",
      "levels": []
    }
  },
  "TISSUE": {
    "Tissue expression (IHC)": {
      "urlKey": "normal_expression",
      "levels": [
        {
          "index": 0,
          "label": "Tissue",
          "selectId": "normal_tissue",
          "multiSelect": false,
          "options": [
            "Any",
            "Adipose tissue",
            "Adrenal gland",
            "Appendix",
            "Bone marrow",
            "Breast",
            "Bronchus",
            "Brown adipose tissue",
            "Cartilage",
            "Caudate",
            "Cerebellum",
            "Cerebral cortex",
            "Cervix",
            "Choroid plexus",
            "Colon",
            "Dorsal raphe",
            "Duodenum",
            "Efferent ducts",
            "Endometrium",
            "Epididymis",
            "Esophagus",
            "Eye",
            "Fallopian tube",
            "Gallbladder",
            "Hair",
            "Heart muscle",
            "Hippocampus",
            "Hypothalamus",
            "Kidney",
            "Lactating breast",
            "Liver",
            "Lung",
            "Lymph node",
            "Nasopharynx",
            "Oral mucosa",
            "Ovary",
            "Pancreas",
            "Parathyroid gland",
            "Pituitary gland",
            "Placenta",
            "Prostate",
            "Rectum",
            "Retina",
            "Salivary gland",
            "Seminal vesicle",
            "Skeletal muscle",
            "Skin",
            "Small intestine",
            "Smooth muscle",
            "Soft tissue",
            "Sole of foot",
            "Spleen",
            "Stomach",
            "Substantia nigra",
            "Testis",
            "Thymus",
            "Thyroid gland",
            "Tonsil",
            "Urinary bladder",
            "Vagina"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Cell type",
          "selectId": "normal_cell",
          "multiSelect": false,
          "options": [],
          "groups": null
        },
        {
          "index": 2,
          "label": "Expression",
          "selectId": "expression_normal",
          "multiSelect": true,
          "options": [],
          "groups": null
        }
      ]
    },
    "Multiplex tissue (IHC)": {
      "urlKey": "multiplex_tissue",
      "levels": [
        {
          "index": 0,
          "label": "Antibody panel",
          "selectId": "multiplex_panel",
          "multiSelect": false,
          "options": [
            "Any",
            "Ciliated cells",
            "Kidney",
            "Pancreas",
            "Salivary gland",
            "Sertoli cells",
            "Spermatids",
            "Spermatocytes",
            "Spermatogonia"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Tissue",
          "selectId": "multiplex_tissue_select",
          "multiSelect": false,
          "options": [],
          "groups": null
        },
        {
          "index": 2,
          "label": "Main location",
          "selectId": "multiplex_main_location",
          "multiSelect": true,
          "options": [],
          "groups": null
        }
      ]
    },
    "Patient ID (IHC)": {
      "urlKey": "ihc_patient_id",
      "levels": []
    },
    "Secretome annotation": {
      "urlKey": "sa_location",
      "levels": [
        {
          "index": 0,
          "label": "Annotation",
          "selectId": "sa_location",
          "multiSelect": true,
          "options": [
            "Immunoglobulin genes",
            "Intracellular and membrane",
            "Secreted - unknown location",
            "Secreted in brain",
            "Secreted in female reproductive system",
            "Secreted in male reproductive system",
            "Secreted in other tissues",
            "Secreted to blood",
            "Secreted to digestive system",
            "Secreted to extracellular matrix"
          ],
          "groups": null
        }
      ]
    },
    "Tissue category (RNA)": {
      "urlKey": "tissue_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Tissue",
          "selectId": "tissue_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Adipose tissue",
            "Adrenal gland",
            "Blood vessel",
            "Bone marrow",
            "Brain",
            "Breast",
            "Cervix",
            "Choroid plexus",
            "Endometrium",
            "Epididymis",
            "Esophagus",
            "Fallopian tube",
            "Gallbladder",
            "Heart muscle",
            "Intestine",
            "Kidney",
            "Liver",
            "Lung",
            "Lymphoid tissue",
            "Ovary",
            "Pancreas",
            "Parathyroid gland",
            "Pituitary gland",
            "Placenta",
            "Prostate",
            "Retina",
            "Salivary gland",
            "Seminal vesicle",
            "Skeletal muscle",
            "Skin",
            "Smooth muscle",
            "Stomach",
            "Testis",
            "Thyroid gland",
            "Tongue",
            "Urinary bladder",
            "Vagina"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "tissue_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Tissue enriched",
            "Group enriched",
            "Tissue enhanced",
            "Low tissue specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Tissue enriched",
              "Group enriched",
              "Tissue enhanced",
              "Low tissue specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Tissue Tau score (RNA)": {
      "urlKey": "tissue_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "tissue_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Tissue expression cluster (RNA)": {
      "urlKey": "expressionclustertissue",
      "levels": [
        {
          "index": 0,
          "label": "Cluster",
          "selectId": "cluster_tissue",
          "multiSelect": true,
          "options": [
            "14:Adipose tissue - Angiogenesis",
            "4:Adrenal gland - Steroid metabolism",
            "15:Bone marrow - Innate immune response",
            "44:Bone marrow - Nuclear processes",
            "73:Brain - Neuronal signaling",
            "78:Brain - Neuronal signaling",
            "10:Brain - Synaptic signal transduction",
            "65:Brain - Transcription",
            "36:Brain & Liver - Signaling",
            "46:Brain & retina - Neuronal signaling",
            "55:Breast - Lactation",
            "71:Cerebellum - Nervous system development",
            "27:Cerebellum - Synaptic function",
            "1:Choroid plexus - Transmembrane transport",
            "48:Ciliated tissues - Cilium organization",
            "56:Ciliated tissues - Cilium organization",
            "50:Epididymis - Male reproductive secretion",
            "22:Epididymis - Mixed function",
            "11:Esophagus - Basic cellular processes",
            "17:Intestine - Digestion",
            "77:Intestine - Digestion",
            "72:Kidney - Transmembrane transport",
            "26:Kidney & Intestine - Metabolism",
            "31:Liver - Metabolism & Coagulation",
            "45:Liver - Metabolism & Coagulation",
            "53:Liver - Plasma proteins",
            "28:Liver & Adrenal gland - Secretion",
            "16:Liver & Kidney - Metabolism",
            "13:Lung - Secretion",
            "34:Lymphoid tissue - Adaptive immune response",
            "51:Lymphoid tissue - Adaptive immune response",
            "18:Lymphoid tissue - Immune response",
            "66:Lymphoid tissue - Immune response",
            "59:Lymphoid tissue & Bone marrow - Cell proliferation",
            "29:Lymphoid tissue & Bone marrow - Innate immune response",
            "25:Non-specific - Basic cellular processes",
            "38:Non-specific - Basic cellular processes",
            "63:Non-specific - Basic cellular processes",
            "68:Non-specific - Basic cellular processes",
            "52:Non-specific - Cellular respiration",
            "76:Non-specific - Metabolism",
            "2:Non-specific - Mixed function",
            "35:Non-specific - Mixed function",
            "40:Non-specific - Mixed function",
            "70:Non-specific - Protein processing",
            "54:Non-specific - Ribosome",
            "74:Non-specific - Signal transduction",
            "24:Non-specific - Transcription",
            "49:Non-specific - Transcription",
            "61:Non-specific - Transcription",
            "64:Non-specific - Transcription",
            "3:Oligodendrocytes - Myelination",
            "75:Ovary - Mixed function",
            "8:Pancreas - Proteolysis",
            "69:Parathyroid gland - Mixed function",
            "20:Pituitary gland - Hormone signaling",
            "43:Placenta - Pregnancy hormone signaling",
            "42:Retina - Visual perception",
            "32:Retina & Lymphoid tissues - Signaling",
            "82:Salivary gland - Secretion",
            "62:Skeletal muscle - Muscle contraction",
            "19:Skeletal muscle - Striated muscle contraction",
            "30:Skeletal muscle - Striated muscle contraction",
            "9:Skin - Hair follicle development",
            "37:Skin - Keratinization",
            "58:Skin - Keratinization",
            "7:Small intestine - Absorption and Digestion",
            "12:Smooth muscle tissue - ECM organization",
            "5:Spleen - Immune response",
            "81:Squamous epithelium - Keratinization",
            "60:Stomach - Digestion",
            "41:Striated muscle - Muscle contraction",
            "21:Testis - Mixed function",
            "47:Testis - Mixed function",
            "67:Testis - Mixed function",
            "39:Testis - Nuclear processes",
            "6:Testis - Spermatogenesis",
            "23:Testis - Spermatogenesis",
            "57:Testis - Spermatogenesis",
            "79:Testis - Spermatogenesis",
            "80:Thymus - Adaptive immune response",
            "33:Thyroid gland - Tissue development"
          ],
          "groups": null
        }
      ]
    },
    "Reliability score tissue (IHC)": {
      "urlKey": "ih_tissue_reliability",
      "levels": [
        {
          "index": 0,
          "label": "Reliability",
          "selectId": "search_reliability_ih",
          "multiSelect": true,
          "options": [
            "Enhanced",
            "Supported",
            "Approved",
            "Uncertain"
          ],
          "groups": null
        }
      ]
    }
  },
  "BRAIN": {
    "Brain region category (RNA)": {
      "urlKey": "brain_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Brain region",
          "selectId": "brain_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Amygdala",
            "Basal ganglia",
            "Cerebellum",
            "Cerebral cortex",
            "Choroid plexus",
            "Hippocampal formation",
            "Hypothalamus",
            "Medulla oblongata",
            "Midbrain",
            "Pons",
            "Spinal cord",
            "Thalamus",
            "White matter"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "brain_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Region enriched",
            "Group enriched",
            "Region enhanced",
            "Low region specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Region enriched",
              "Group enriched",
              "Region enhanced",
              "Low region specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Brain Tau score (RNA)": {
      "urlKey": "brain_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "brain_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Mouse brain category (RNA)": {
      "urlKey": "mouse_brain_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Brain region",
          "selectId": "mouse_brain_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Amygdala",
            "Basal ganglia",
            "Cerebellum",
            "Cerebral cortex",
            "Hippocampal formation",
            "Hypothalamus",
            "Midbrain",
            "Olfactory bulb",
            "Pons and medulla",
            "Thalamus",
            "White matter"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "mouse_brain_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Region enriched",
            "Group enriched",
            "Region enhanced",
            "Low region specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Region enriched",
              "Group enriched",
              "Region enhanced",
              "Low region specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Mouse brain Tau score (RNA)": {
      "urlKey": "mouse_brain_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "mouse_brain_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Pig brain category (RNA)": {
      "urlKey": "pig_brain_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Brain region",
          "selectId": "pig_brain_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Amygdala",
            "Basal ganglia",
            "Cerebellum",
            "Cerebral cortex",
            "Hippocampal formation",
            "Hypothalamus",
            "Medulla oblongata",
            "Midbrain",
            "Olfactory bulb",
            "Pons",
            "Spinal cord",
            "Thalamus",
            "White matter"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "pig_brain_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Region enriched",
            "Group enriched",
            "Region enhanced",
            "Low region specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Region enriched",
              "Group enriched",
              "Region enhanced",
              "Low region specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Pig brain Tau score (RNA)": {
      "urlKey": "pig_brain_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "pig_brain_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Brain expression cluster (RNA)": {
      "urlKey": "expressionclusterbrain",
      "levels": [
        {
          "index": 0,
          "label": "Cluster",
          "selectId": "cluster_brain",
          "multiSelect": true,
          "options": [
            "40:Astrocytes - Astrocyte-neuron interactions",
            "19:Astrocytes - Mixed function",
            "39:Astrocytes - Mixed function",
            "46:Brainstem - Mixed function",
            "10:Cerebellum - Nucleic acid binding",
            "32:Cerebral cortex - Mixed function",
            "3:Choroid plexus - Cilium",
            "17:Choroid plexus - Cilium",
            "42:Choroid plexus - Mitochondria",
            "23:Choroid plexus - Mixed function",
            "36:Choroid plexus - Mixed function",
            "47:Endothelial cells - Vasculature",
            "29:Forebrain - Mixed function",
            "43:Hindbrain - Mixed function",
            "49:Hindbrain - Mixed function",
            "56:Hypothalamus - Neuropeptide signaling",
            "8:Immune cells - Immune response",
            "54:Immune cells - T cell receptor",
            "20:Macrophages & Microglia - Immune response",
            "41:Monoamines - Neurotransmitter signalling",
            "1:Neurons - Mixed function",
            "24:Neurons - Mixed function",
            "33:Neurons - Mixed function",
            "37:Neurons - Mixed function",
            "51:Neurons - Mixed function",
            "53:Neurons - Mixed function",
            "2:Neurons - Nucleosome",
            "14:Neurons - Synaptic function",
            "52:Neurons & Synapses - Synaptic function",
            "35:Non-specific - DNA binding",
            "6:Non-specific - Immune response",
            "21:Non-specific - Metabolism",
            "5:Non-specific - Mixed function",
            "18:Non-specific - Mixed function",
            "22:Non-specific - Mixed function",
            "27:Non-specific - Mixed function",
            "34:Non-specific - Mixed function",
            "44:Non-specific - Mixed function",
            "45:Non-specific - Mixed function",
            "48:Non-specific - Mixed function",
            "4:Non-specific - mRNA splicing & Cell cycle",
            "50:Non-specific - Nucleic acid binding",
            "9:Non-specific - Receptor signaling",
            "7:Non-specific - Ribosome",
            "15:Non-specific - Transcription",
            "16:Non-specific - Transcription",
            "25:Non-specific - Transcription",
            "31:Non-specific - Transcription",
            "55:Non-specific - Transcription",
            "12:Non-specific - Vasculature",
            "13:Oligodendrocytes - Mixed function",
            "26:Oligodendrocytes - Mixed function",
            "28:Oligodendrocytes - Mixed function",
            "38:Sub-cortical - Mixed function",
            "30:White matter - Myelination",
            "11:White matter - Signal transduction"
          ],
          "groups": null
        }
      ]
    },
    "Reliability score mouse brain": {
      "urlKey": "mb_tissue_reliability",
      "levels": [
        {
          "index": 0,
          "label": "Reliability",
          "selectId": "search_reliability_mb",
          "multiSelect": true,
          "options": [
            "Supported",
            "Approved"
          ],
          "groups": null
        }
      ]
    }
  },
  "SINGLE CELL": {
    "Cell type enrichment (RNA)": {
      "urlKey": "ce_enriched",
      "levels": [
        {
          "index": 0,
          "label": "Tissue",
          "selectId": "ce_tissue",
          "multiSelect": false,
          "options": [
            "Adipose subcutaneous",
            "Adipose visceral",
            "Adrenal gland",
            "Breast",
            "Colon",
            "Heart muscle",
            "Kidney",
            "Liver",
            "Lung",
            "Minor Salivary Gland",
            "Pancreas",
            "Pituitary gland",
            "Prostate",
            "Skeletal muscle",
            "Skin",
            "Spleen",
            "Stomach",
            "Testis",
            "Thyroid gland"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Cell type",
          "selectId": "ce_cell",
          "multiSelect": true,
          "options": [],
          "groups": null
        },
        {
          "index": 2,
          "label": "Enrichment",
          "selectId": "ce_score",
          "multiSelect": true,
          "options": [],
          "groups": null
        }
      ]
    },
    "Cell type category (scRNA)": {
      "urlKey": "cell_type_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Cell type",
          "selectId": "cell_type_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Adipocytes",
            "Adrenal cortex cells",
            "Adrenal medulla cells",
            "Alveolar cells type 1",
            "Alveolar cells type 2",
            "Astrocytes",
            "B-cells",
            "Basal keratinocytes",
            "Basal prostatic cells",
            "Bergmann glia",
            "Brain excitatory neurons",
            "Brain inhibitory neurons",
            "Breast hormone-responsive cells",
            "Breast lactating cells",
            "Breast myoepithelial cells",
            "Breast secretory cells",
            "Cardiomyocytes",
            "CDC",
            "Cholangiocytes",
            "Choroid plexus epithelial cells",
            "Colonocytes",
            "Cone photoreceptor cells",
            "Conjunctival goblet cells",
            "Corticotrophs",
            "Cytotrophoblasts",
            "Decidual stromal cells",
            "Differentiating spermatogonia",
            "Distal convoluted tubule cells",
            "Early primary spermatocytes",
            "Early spermatids",
            "Endometrial ciliated cells",
            "Endometrial glandular cells",
            "Endometrial luminal cells",
            "Endometrial secretory cells",
            "Endometrial stromal cells",
            "Enteric stem cells",
            "Enteric transient amplifying cells",
            "Enterocytes",
            "Ependymal cells",
            "Epicardial cells",
            "Epididymal basal cells",
            "Epididymal clear cells",
            "Epididymal efferent duct absorptive cells",
            "Epididymal efferent duct ciliated cells",
            "Epididymal principal cells",
            "Erythrocyte progenitors",
            "Erythrocytes",
            "Esophageal apical cells",
            "Esophageal basal cells",
            "Esophageal suprabasal cells",
            "Extravillous trophoblasts",
            "Fallopian secretory cells",
            "Fallopian tube ciliated cells",
            "Fibro-adipogenic progenitors",
            "Fibroblasts",
            "Foveolar cells",
            "Gastric chief cells",
            "Gastric progenitor cells",
            "Goblet cells",
            "Gonadotrophs",
            "Granulosa cells",
            "Hematopoietic stem cells",
            "Hepatic stellate cells",
            "Hepatocytes",
            "Hofbauer cells",
            "Innate lymphoid cells",
            "Kupffer cells",
            "Lacrimal acinar cells",
            "Lactotrophs",
            "Late primary spermatocytes",
            "Late spermatids",
            "Leydig cells",
            "Loop of henle epithelial cells",
            "Lymphatic endothelial cells",
            "Macrophages",
            "Mast cells",
            "Medullary thymic epithelial cells",
            "Megakaryocyte progenitors",
            "Megakaryocyte-Erythroid progenitors",
            "Megakaryocytes",
            "Melanocytes",
            "Mesothelial cells",
            "Microglia",
            "Migrating cytotrophoblasts",
            "Monocyte progenitors",
            "Monocytes",
            "Mucous neck cells",
            "Müller glia",
            "Myonuclei",
            "Myosatellite cells",
            "Neuroendocrine cells",
            "Neutrophil progenitors",
            "Neutrophils",
            "NK-cells",
            "Ocular epithelial cells",
            "Oligodendrocyte progenitor cells",
            "Oligodendrocytes",
            "Oocytes",
            "Other brain neurons",
            "Ovarian stromal cells",
            "Pancreatic acinar cells",
            "Pancreatic duct cells",
            "Pancreatic islet cells",
            "Paneth cells",
            "Papillary tip epithelial cells",
            "Parietal cells",
            "PDCs",
            "Pericytes",
            "Peritubular myoid cells",
            "Pituicytes/FSCs",
            "Pituitary stem cells",
            "Plasma cells",
            "Platelets",
            "Podocytes",
            "Prostatic club cells",
            "Prostatic glandular cells",
            "Prostatic hillock cells",
            "Proximal tubule cells",
            "Renal collecting duct intercalated cells",
            "Renal collecting duct principal cells",
            "Renal connecting tubule cells",
            "Respiratory basal cells",
            "Respiratory ciliated cells",
            "Respiratory deuterosomal cells",
            "Respiratory ionocytes",
            "Respiratory secretory cells",
            "Retinal amacrine cells",
            "Retinal bipolar cells",
            "Retinal ganglion cells",
            "Retinal horizontal cells",
            "Retinal pigment epithelial cells",
            "Rod photoreceptor cells",
            "Salivary acinar cells",
            "Salivary basal cells",
            "Salivary duct cells",
            "Salivary ionocytes",
            "Salivary myoepithelial cells",
            "Schwann cells",
            "Sertoli cells",
            "Smooth muscle cells",
            "Somatotrophs",
            "Submucosal glandular cells",
            "Suprabasal keratinocytes",
            "Syncytiotrophoblasts",
            "T-cells",
            "Thymic myoid cells",
            "Thymocytes",
            "Thyrotrophs",
            "Transitional alveolar cells",
            "Tuft cells",
            "Undifferentiated spermatogonia",
            "Urothelial cells",
            "Vascular endothelial cells",
            "Vascular smooth muscle cells"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "cell_type_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Cell type enriched",
            "Group enriched",
            "Cell type enhanced",
            "Low cell type specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Cell type enriched",
              "Group enriched",
              "Cell type enhanced",
              "Low cell type specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Cell type Tau score (RNA)": {
      "urlKey": "cell_type_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "cell_type_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Cell type group category (scRNA)": {
      "urlKey": "cell_type_group_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Cell type group",
          "selectId": "cell_type_group_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Acinar cells",
            "Adipocytes",
            "Adrenal endocrine cells",
            "Alveolar cells",
            "Apical squamous epithelial cells",
            "B-cells",
            "Barrier epithelial cells",
            "Basal cells",
            "Ciliated cells",
            "Dendritic cells",
            "Ductal cells",
            "Endothelial cells",
            "Enterocytes",
            "Enteroendocrine cells",
            "Erythrocytes",
            "Fibro-adipogenic progenitors",
            "Fibroblasts",
            "Gastric glandular cells",
            "Glandular cells",
            "Glial cells",
            "Goblet cells",
            "Hepatocytes",
            "Innate lymphoid cells",
            "Ionocytes",
            "Leydig cells",
            "Luminal cells",
            "Mast cells",
            "Megakaryocytes",
            "Mononuclear phagocytes",
            "Mural cells",
            "Myocytes",
            "Neuronal cells",
            "Neutrophils",
            "NK-cells",
            "Oocytes",
            "Pancreatic islet cells",
            "Pigment cells",
            "Pituitary endocrine cells",
            "Plasma cells",
            "Platelets",
            "Proliferating cells",
            "Renal nephron cells",
            "Reproductive supporting cells",
            "Secretory cells",
            "Secretory gland support",
            "Smooth muscle cells",
            "Spermatogenic cell types",
            "Stellate cells",
            "Stem cells",
            "Stromal cells",
            "Suprabasal cells",
            "T-cells",
            "Trophoblast cells"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "cell_type_group_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Cell type enriched",
            "Group enriched",
            "Cell type enhanced",
            "Low cell type specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Cell type enriched",
              "Group enriched",
              "Cell type enhanced",
              "Low cell type specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Cell type group Tau score (RNA)": {
      "urlKey": "cell_type_group_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "cell_type_group_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Brain region cell type (scRNA)": {
      "urlKey": "sc_brain_region_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Cell type",
          "selectId": "sc_brain_region_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Amygdala excitatory",
            "Astrocyte",
            "Bergmann glia",
            "Central nervous system macrophage",
            "Cerebellar inhibitory",
            "CGE interneuron",
            "Choroid plexus epithelial cell",
            "Committed oligodendrocyte precursor",
            "Deep-layer corticothalamic and 6b",
            "Deep-layer intratelencephalic",
            "Deep-layer near-projecting",
            "Eccentric medium spiny neuron",
            "Endothelial cell",
            "Ependymal cell",
            "Fibroblast",
            "Hippocampal CA1-3",
            "Hippocampal CA4",
            "Hippocampal dentate gyrus",
            "LAMP5-LHX6 and Chandelier",
            "Leukocyte",
            "Lower rhombic lip",
            "Mammillary body",
            "Medium spiny neuron",
            "MGE interneuron",
            "Midbrain-derived inhibitory",
            "Miscellaneous",
            "Oligodendrocyte",
            "Oligodendrocyte precursor cell",
            "Pericyte",
            "Splatter",
            "Thalamic excitatory",
            "Upper rhombic lip",
            "Upper-layer intratelencephalic",
            "Vascular associated smooth muscle cell"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "sc_brain_region_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Cell type enriched",
            "Group enriched",
            "Cell type enhanced",
            "Low cell type specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Cell type enriched",
              "Group enriched",
              "Cell type enhanced",
              "Low cell type specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Brain region Tau score (scRNA)": {
      "urlKey": "sc_brain_region_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "sc_brain_region_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Immune cell category (RNA)": {
      "urlKey": "immune_cell_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Cell type",
          "selectId": "immune_cell_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Basophil",
            "Classical monocyte",
            "Eosinophil",
            "GdT-cell",
            "Intermediate monocyte",
            "MAIT T-cell",
            "Memory B-cell",
            "Memory CD4 T-cell",
            "Memory CD8 T-cell",
            "Myeloid DC",
            "Naive B-cell",
            "Naive CD4 T-cell",
            "Naive CD8 T-cell",
            "Neutrophil",
            "NK-cell",
            "Non-classical monocyte",
            "Plasmacytoid DC",
            "T-reg",
            "Total PBMC"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "immune_cell_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Immune cell enriched",
            "Group enriched",
            "Immune cell enhanced",
            "Low immune cell specificity",
            "Not detected in immune cells",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Immune cell enriched",
              "Group enriched",
              "Immune cell enhanced",
              "Low immune cell specificity",
              "Not detected in immune cells"
            ],
            "DISTRIBUTION": [
              "Not detected",
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Immune cell Tau score (RNA)": {
      "urlKey": "immune_cell_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "immune_cell_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Immune cell lineage category (RNA)": {
      "urlKey": "immune_cell_lineage_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Cell lineage",
          "selectId": "immune_cell_lineage_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "B-cells",
            "Dendritic cells",
            "Granulocytes",
            "Monocytes",
            "NK-cells",
            "T-cells"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "immune_cell_lineage_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Lineage enriched",
            "Group enriched",
            "Lineage enhanced",
            "Low lineage specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Lineage enriched",
              "Group enriched",
              "Lineage enhanced",
              "Low lineage specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Immune cell lineage Tau score (RNA)": {
      "urlKey": "immune_cell_lineage_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "immune_cell_lineage_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Immune cell expression cluster (RNA)": {
      "urlKey": "expressionclusterblood",
      "levels": [
        {
          "index": 0,
          "label": "Cluster",
          "selectId": "cluster_blood",
          "multiSelect": true,
          "options": [
            "17:B-cells - Immunoglobulins",
            "23:B-cells - Immunoglobulins",
            "34:B-cells - Unknown function",
            "46:Basophils - Proteolysis",
            "32:Basophils - Transcription",
            "41:Basophils - Unknown function",
            "2:Dendritic cells - Unknown function",
            "36:Eosinophils - Protein ubiquitination",
            "22:Eosinophils - Transcription",
            "19:Eosinophils - Unknown function",
            "45:Eosinophils - Unknown function",
            "40:Monocytes - Innate immune response",
            "26:Monocytes - Plasma membrane proteins",
            "38:Monocytes & Neutrophils - Degranulation",
            "37:Monocytes & Neutrophils - Innate immune response",
            "4:Neutrophils - Degranulation",
            "35:Neutrophils - Protein binding",
            "21:Neutrophils - Unknown function",
            "28:Neutrophils - Unknown function",
            "15:NK-cells - Unknown function",
            "33:Non-specific - ATP binding",
            "5:Non-specific - Cell proliferation",
            "16:Non-specific - Cell proliferation",
            "20:Non-specific - DNA binding",
            "30:Non-specific - DNA binding",
            "7:Non-specific - Innate immune response",
            "10:Non-specific - Membrane trafficking",
            "13:Non-specific - Mitochondria",
            "12:Non-specific - Mitochondrial translation",
            "3:Non-specific - Nuclear processes",
            "24:Non-specific - Transcription",
            "43:Non-specific - Transcription & Translation",
            "18:Non-specific - Translation",
            "14:Non-specific - Unknown function",
            "25:Non-specific - Unknown function",
            "29:Non-specific - Unknown function",
            "42:Non-specific - Vesicular transport",
            "44:Plasmacytoid DCs - Plasma membrane proteins",
            "8:Plasmacytoid DCs - Unknown function",
            "6:T-cells - T-cell receptor",
            "31:T-cells - T-cell receptor",
            "39:T-cells - T-cell receptor",
            "1:T-cells - Unknown function",
            "11:T-cells - Unknown function",
            "27:T-cells - Unknown function",
            "9:T-regs - Cell cycle regulation"
          ],
          "groups": null
        }
      ]
    },
    "Single cell type expression cluster (RNA)": {
      "urlKey": "expressionclustersinglecell",
      "levels": [
        {
          "index": 0,
          "label": "Cluster",
          "selectId": "cluster_singlecell",
          "multiSelect": true,
          "options": [
            "89:Adipocytes - Lipid metabolism",
            "18:Adrenal cortex cells - Steroidogensis",
            "81:Alveolar cells - Lung function",
            "84:Apical squamous epithelium - Cornification",
            "49:Apical squamous epithelium - Epithelial barrier & keratinization",
            "28:Astrocytes - Homeostasis & neuron support",
            "87:B-cells - Adaptive immunity: Humoral response",
            "104:Brain endothelial cells - Blood brain barrier",
            "4:Breast lactating luminal cells - Lactation",
            "60:Cardiomyocytes - Cardiac muscle contraction & structure",
            "2:Cerebellar granular cells - Neuronal signaling",
            "19:Cerebellar purkinje cells - Neurotransmission & signaling",
            "101:Choroid plexus epithelial cells - Ion transport",
            "34:Ciliated cells - Cilia assembly & function",
            "107:Ciliated cells - Cilia assembly & function",
            "45:Colonocytes & Enterocytes - Gastrointestinal absorption & barrier",
            "63:Cytotrophoblasts - Basic cellular functions",
            "82:Dendritic cells - Antigen presentation",
            "3:Early primary spermatocytes - Early meiosis",
            "42:Early spermatids - Spermiogenesis: Acrosomal phase",
            "33:Early spermatids - Spermiogenesis: Cap phase",
            "23:Elongating spermatids - Sperm cell metabolism & fertilization",
            "90:Elongating spermatids - Spermiogenesis: Elongation",
            "12:Endothelial cells - Angiogenesis & vascular homeostasis",
            "32:Endothelial cells - Angiogenesis & vascular immunity",
            "1:Enterocytes - Absorption and Digestion",
            "96:Enteroendocrine cells - Neuropeptide signaling",
            "83:Epicardial mesothelial cells - Basic cellular functions",
            "10:Epididymal principal cells - Sperm maturation microenvironment",
            "30:Epididymal principal cells - Sperm storage microenvironment",
            "66:Erythroid cells - Erythroid differentiation and maturation",
            "21:Extravillous trophoblasts - Placental invasion & endocrine regulatio",
            "108:Fibroblasts - ECM organization",
            "68:Foveolar cells - Mucosal defense",
            "52:Glandular & Luminal cells - Estrogen-regulated epithelial secretion",
            "94:Gonadal somatic cells - Mixed function",
            "93:Hepatocytes - Bile production & excretion",
            "25:Hepatocytes - Plasma protein synthesis & secretion",
            "54:Intestinal epithelial cells - Intestinal epi homeostasis & respiration",
            "70:Intestinal goblet cells - Mucin production",
            "26:Keratinocytes - Keratinization",
            "53:Late primary spermatocytes - Meiotic division & transition",
            "77:Late primary spermatocytes - Spermiogenesis: Golgi Phase",
            "56:Late spermatids - Spermiogenesis: Maturation",
            "73:Late spermatids - Spermiogenesis: Maturation",
            "72:Macrophages - Phagocytosis & lysosomal degradation",
            "58:Mast cells - Allergic inflammatory responses",
            "74:Microglia - Neuroimmunity & neuroinflammation",
            "40:Monocytes & Neutrophils - Inflammatory signaling",
            "11:Muller glia cells - Retinal homeostasis",
            "110:Mural cells - ECM organization",
            "55:Myocytes - Oxidative muscle function",
            "109:Neurons - Neuronal signaling",
            "98:Neurons - Neurotransmission & signaling",
            "35:Neurons - Synaptic function & neurogenesis",
            "37:Neutrophil progenitors - Granulopoiesis",
            "31:Neutrophils - Chemotaxis & Apoptosis",
            "29:Neutrophils - Innate immune cellular maintenance",
            "24:Neutrophils - Innate immunity signal integration",
            "48:Neutrophils - Phagocytosis & degranulation",
            "92:NK-cells & T-cells - Adaptive immunity: Cytotoxicity",
            "22:Non-specific - Basic cellular functions",
            "103:Non-specific - Basic cellular processes",
            "71:Non-specific - Cardiac endocrine signaling & maintenanc",
            "65:Non-specific - Cell growth & division",
            "27:Non-specific - Cell proliferation",
            "97:Non-specific - Cellular respiration",
            "75:Non-specific - Chaperones and protein folding",
            "102:Non-specific - Mixed function",
            "105:Non-specific - Mixed function",
            "15:Non-specific - Protein processing",
            "17:Non-specific - RNA processing",
            "8:Non-specific - Secretory pathway",
            "7:Non-specific - Transcription",
            "20:Non-specific - Transcription regulation",
            "14:Oligodendrocyte progenitor cells - Development & myelination",
            "80:Oligodendrocytes - Myelination",
            "41:Oocytes - Oogenesis",
            "5:Pancreatic acinar cells - Pancreatic exocrine secretion",
            "76:Pancreatic endocrine cells - Endocrine signaling",
            "79:Photoreceptor cells - Phototransduction",
            "91:Pituicytes/FSC - Homeostasis & neuron support",
            "59:Pituitary endocrine cells - Neuroendocrine signaling",
            "78:Plasma cells - Antibody production & ER-stress response",
            "44:Plasma cells - Antibody production & secretion",
            "67:Plasma cells - Plasma cell differentiation",
            "6:Plasmacytoid dendritic cells - Viral sensing & interferon response",
            "47:Platelets - Hemostasis",
            "57:Podocytes - Glomerular filtration",
            "16:Prostatic glandular cells - Androgen response & seminal fluid",
            "88:Proximal tubular cells - Transmembrane transport",
            "64:Renal epithelial cells - Ion transport & homeostasis",
            "50:Renal epithelial cells - Ion transport and pH regulation",
            "86:Retinal bipolar cells - Synaptic signal transduction",
            "99:Retinal pigment epithelial cells - Retinol metabolism",
            "61:Schwann cells & Melanocytes - Mixed function",
            "38:Secretory epithelial cells - Exocrine secretion",
            "51:Secretory epithelial cells - Mixed function",
            "43:Sertoli cells - Spermatogenesis microenvironment",
            "36:Skeletal myocytes - Muscle excitation & contraction",
            "46:Skeletal myocytes - Muscle structure & formation",
            "62:Smooth muscle cells - Muscle contraction",
            "106:Spermatogonia - Spermatogonial differentiation",
            "85:Squamous epithelial cells - Keratinization",
            "100:Stratified epithelial cells - Barrier functions",
            "39:Syncytiotrophoblasts - Placental homeostasis & endocrine signal",
            "13:Syncytiotrophoblasts - Placental remodeling & endocrine func.",
            "9:T-cells - Adaptive immunity: Regulation",
            "95:Tuft cells - Chemosensory signaling",
            "69:Urothelial cells - Basic cellular functions"
          ],
          "groups": null
        }
      ]
    }
  },
  "SUBCELLULAR": {
    "Subcellular location (ICC)": {
      "urlKey": "subcell_location",
      "levels": [
        {
          "index": 0,
          "label": "Location",
          "selectId": "location",
          "multiSelect": true,
          "options": [
            "Acrosome",
            "Actin filaments",
            "Aggresome",
            "Annulus",
            "Basal body",
            "Calyx",
            "Cell Junctions",
            "Centriolar satellite",
            "Centrosome",
            "Cleavage furrow",
            "Connecting piece",
            "Cytokinetic bridge",
            "Cytoplasmic bodies",
            "Cytosol",
            "End piece",
            "Endoplasmic reticulum",
            "Endosomes",
            "Equatorial segment",
            "Flagellar centriole",
            "Focal adhesion sites",
            "Golgi apparatus",
            "Intermediate filaments",
            "Kinetochore",
            "Lipid droplets",
            "Lysosomes",
            "Microtubule ends",
            "Microtubules",
            "Mid piece",
            "Midbody",
            "Midbody ring",
            "Mitochondria",
            "Mitotic chromosome",
            "Mitotic spindle",
            "Nuclear bodies",
            "Nuclear membrane",
            "Nuclear speckles",
            "Nucleoli",
            "Nucleoli fibrillar center",
            "Nucleoli rim",
            "Nucleoplasm",
            "Perinuclear theca",
            "Peroxisomes",
            "Plasma membrane",
            "Primary cilium",
            "Primary cilium tip",
            "Primary cilium transition zone",
            "Principal piece",
            "Rods & Rings",
            "Vesicles"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Searches",
          "selectId": "reliability_if_location",
          "multiSelect": true,
          "options": [
            "Enhanced",
            "Supported",
            "Approved",
            "Uncertain",
            "Single cell variation",
            "CCD protein mitotic structure",
            "CCD protein interphase",
            "Cell cycle dependent protein",
            "Cell cycle independent protein",
            "Cell cycle dependent transcript",
            "Cell cycle independent transcript",
            "Multilocalizing",
            "Localizing 1",
            "Localizing 2",
            "Localizing 3",
            "Localizing 4",
            "Localizing 5",
            "Localizing 6",
            "Main location",
            "Additional location"
          ],
          "groups": {
            "RELIABILITY": [
              "Enhanced",
              "Supported",
              "Approved",
              "Uncertain"
            ],
            "SUBCELLULAR VARIATION": [
              "Single cell variation",
              "CCD protein mitotic structure",
              "CCD protein interphase",
              "Cell cycle dependent protein",
              "Cell cycle independent protein",
              "Cell cycle dependent transcript",
              "Cell cycle independent transcript"
            ],
            "MULTILOCALIZATION": [
              "Multilocalizing",
              "Localizing 1",
              "Localizing 2",
              "Localizing 3",
              "Localizing 4",
              "Localizing 5",
              "Localizing 6"
            ],
            "OTHER": [
              "Main location",
              "Additional location"
            ]
          }
        }
      ]
    },
    "Subcellular location - cell line (ICC)": {
      "urlKey": "subcell_location_celline",
      "levels": [
        {
          "index": 0,
          "label": "Location",
          "selectId": "location_celline",
          "multiSelect": true,
          "options": [
            "Any",
            "Acrosome",
            "Actin filaments",
            "Aggresome",
            "Annulus",
            "Basal body",
            "Calyx",
            "Cell Junctions",
            "Centriolar satellite",
            "Centrosome",
            "Cleavage furrow",
            "Connecting piece",
            "Cytokinetic bridge",
            "Cytoplasmic bodies",
            "Cytosol",
            "End piece",
            "Endoplasmic reticulum",
            "Endosomes",
            "Equatorial segment",
            "Flagellar centriole",
            "Focal adhesion sites",
            "Golgi apparatus",
            "Intermediate filaments",
            "Kinetochore",
            "Lipid droplets",
            "Lysosomes",
            "Microtubule ends",
            "Microtubules",
            "Mid piece",
            "Midbody",
            "Midbody ring",
            "Mitochondria",
            "Mitotic chromosome",
            "Mitotic spindle",
            "Nuclear bodies",
            "Nuclear membrane",
            "Nuclear speckles",
            "Nucleoli",
            "Nucleoli fibrillar center",
            "Nucleoli rim",
            "Nucleoplasm",
            "Perinuclear theca",
            "Peroxisomes",
            "Plasma membrane",
            "Primary cilium",
            "Primary cilium tip",
            "Primary cilium transition zone",
            "Principal piece",
            "Rods & Rings",
            "Vesicles"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Cell line",
          "selectId": "cellline",
          "multiSelect": true,
          "options": [
            "Any",
            "A-431",
            "A-549",
            "AF22",
            "ASC52telo",
            "BJ [Human fibroblast]",
            "CACO-2",
            "EFO-21",
            "GAMG",
            "HaCaT",
            "HAP1",
            "HBEC3-KT",
            "HDLM-2",
            "HEK293",
            "HEL",
            "HeLa",
            "Hep-G2",
            "HTCEpi",
            "HTERT-RPE1",
            "HTERT-RPE1 (serum starved)",
            "HUVEC/TERT2",
            "JURKAT",
            "K-562",
            "KOLF2.1J",
            "LHCN-M2",
            "MCF-7",
            "NB4",
            "OE19",
            "PC-3",
            "PODO/SVTERT152",
            "PODO/TERT256",
            "REH",
            "Rh30",
            "RPTEC/TERT1",
            "RT-4",
            "SH-SY5Y",
            "SiHa",
            "SK-MEL-30",
            "Sperm",
            "SuSa",
            "THP-1",
            "U-251MG",
            "U2OS"
          ],
          "groups": null
        }
      ]
    },
    "Predicted location": {
      "urlKey": "predicted_location",
      "levels": [
        {
          "index": 0,
          "label": "Class",
          "selectId": "predicted_class",
          "multiSelect": true,
          "options": [
            "Predicted intracellular proteins",
            "Predicted membrane proteins",
            "Predicted secreted proteins"
          ],
          "groups": null
        }
      ]
    },
    "Subcellular Cell Cycle Peak Phase": {
      "urlKey": "subcell_ccd_peak",
      "levels": [
        {
          "index": 0,
          "label": "Type",
          "selectId": "type",
          "multiSelect": true,
          "options": [
            "Protein",
            "Rna"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Phase",
          "selectId": "phase",
          "multiSelect": true,
          "options": [
            "G1",
            "S",
            "G2"
          ],
          "groups": null
        }
      ]
    },
    "Reliability score cells (ICC)": {
      "urlKey": "if_reliability",
      "levels": [
        {
          "index": 0,
          "label": "Reliability",
          "selectId": "search_reliability_if",
          "multiSelect": true,
          "options": [
            "Enhanced",
            "Supported",
            "Approved",
            "Uncertain"
          ],
          "groups": null
        }
      ]
    }
  },
  "CANCER": {
    "Prognostic cancer": {
      "urlKey": "prognostic",
      "levels": [
        {
          "index": 0,
          "label": "Cancer",
          "selectId": "cancer",
          "multiSelect": true,
          "options": [
            "Bladder Urothelial Carcinoma",
            "Breast Invasive Carcinoma",
            "Cervical Squamous Cell Carcinoma and Endocervical Adenocarcinoma",
            "Colon Adenocarcinoma",
            "Glioblastoma Multiforme",
            "Head and Neck Squamous Cell Carcinoma",
            "Kidney Chromophobe",
            "Kidney Renal Clear Cell Carcinoma",
            "Kidney Renal Papillary Cell Carcinoma",
            "Liver Hepatocellular Carcinoma",
            "Lung Adenocarcinoma",
            "Lung Squamous Cell Carcinoma",
            "Ovary Serous Cystadenocarcinoma",
            "Pancreatic Adenocarcinoma",
            "Prostate Adenocarcinoma",
            "Rectum Adenocarcinoma",
            "Skin Cutaneous Melanoma",
            "Stomach Adenocarcinoma",
            "Testicular Germ Cell Tumor",
            "Thyroid Carcinoma",
            "Uterine Corpus Endometrial Carcinoma"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Prognosis",
          "selectId": "prognosis",
          "multiSelect": true,
          "options": [
            "Favorable - potential prognostic",
            "Favorable - validated prognostic",
            "Unfavorable - potential prognostic",
            "Unfavorable - validated prognostic"
          ],
          "groups": null
        }
      ]
    },
    "Cancer category (RNA)": {
      "urlKey": "cancer_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Cancer",
          "selectId": "cancer_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Bladder Urothelial Carcinoma",
            "Breast Invasive Carcinoma",
            "Cervical Squamous Cell Carcinoma and Endocervical Adenocarcinoma",
            "Colon Adenocarcinoma",
            "Glioblastoma Multiforme",
            "Head and Neck Squamous Cell Carcinoma",
            "Kidney Chromophobe",
            "Kidney Renal Clear Cell Carcinoma",
            "Kidney Renal Papillary Cell Carcinoma",
            "Liver Hepatocellular Carcinoma",
            "Lung Adenocarcinoma",
            "Lung Squamous Cell Carcinoma",
            "Ovary Serous Cystadenocarcinoma",
            "Pancreatic Adenocarcinoma",
            "Prostate Adenocarcinoma",
            "Rectum Adenocarcinoma",
            "Skin Cutaneous Melanoma",
            "Stomach Adenocarcinoma",
            "Testicular Germ Cell Tumor",
            "Thyroid Carcinoma",
            "Uterine Corpus Endometrial Carcinoma"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "cancer_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Cancer enriched",
            "Group enriched",
            "Cancer enhanced",
            "Low cancer specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Cancer enriched",
              "Group enriched",
              "Cancer enhanced",
              "Low cancer specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    }
  },
  "BLOOD": {},
  "CELL LINE": {
    "Cell line category (RNA)": {
      "urlKey": "celline_category_rna",
      "levels": [
        {
          "index": 0,
          "label": "Cancer",
          "selectId": "celline_category_rnatissue",
          "multiSelect": true,
          "options": [
            "Any",
            "Adrenocortical cancer",
            "Bile duct cancer",
            "Bladder cancer",
            "Bone cancer",
            "Brain cancer",
            "Breast cancer",
            "Cervical cancer",
            "Colorectal cancer",
            "Esophageal cancer",
            "Gallbladder cancer",
            "Gastric cancer",
            "Head and neck cancer",
            "Kidney cancer",
            "Leukemia",
            "Liver cancer",
            "Lung cancer",
            "Lymphoma",
            "Myeloma",
            "Neuroblastoma",
            "Non-cancerous",
            "Ovarian cancer",
            "Pancreatic cancer",
            "Prostate cancer",
            "Rhabdoid",
            "Sarcoma",
            "Skin cancer",
            "Testis cancer",
            "Thyroid cancer",
            "Uncategorized",
            "Uterine cancer"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Category",
          "selectId": "celline_category_rnacategory",
          "multiSelect": true,
          "options": [
            "Cancer enriched",
            "Group enriched",
            "Cancer enhanced",
            "Low cancer specificity",
            "Not detected",
            "Detected in all",
            "Detected in many",
            "Detected in some",
            "Detected in single",
            "Is highest expressed"
          ],
          "groups": {
            "SPECIFICITY": [
              "Cancer enriched",
              "Group enriched",
              "Cancer enhanced",
              "Low cancer specificity",
              "Not detected"
            ],
            "DISTRIBUTION": [
              "Detected in all",
              "Detected in many",
              "Detected in some",
              "Detected in single"
            ],
            "EXPRESSION": [
              "Is highest expressed"
            ]
          }
        }
      ]
    },
    "Celline Tau score (RNA)": {
      "urlKey": "celline_tau_score",
      "levels": [
        {
          "index": 0,
          "label": "Tau score",
          "selectId": "celline_tau_scoretau",
          "multiSelect": true,
          "options": [
            "0.0-0.1",
            "0.1-0.2",
            "0.2-0.3",
            "0.3-0.4",
            "0.4-0.5",
            "0.5-0.6",
            "0.6-0.7",
            "0.7-0.8",
            "0.8-0.9",
            "0.9-1.0"
          ],
          "groups": null
        }
      ]
    },
    "Cell line expression cluster (RNA)": {
      "urlKey": "expressionclustercellline",
      "levels": [
        {
          "index": 0,
          "label": "Cluster",
          "selectId": "cluster_celline",
          "multiSelect": true,
          "options": [
            "48:Adipocytes & Endothelial cells - Angiogenesis",
            "61:BICR 18 - Protein kinases",
            "12:Bone cancer - Neuronal signaling",
            "27:Breast cancer - Unknown function",
            "10:Ciliated cells - Ion channel activity",
            "44:Connective tissue cells - ECM organization",
            "64:Connective tissue cells - ECM organization",
            "70:DU4475 - Unknown function",
            "49:HMC-1 - Innate immune response",
            "15:Kidney cancer - Membrane components",
            "47:Leukemia - Hemostasis",
            "6:Leukemia - Signal transduction",
            "59:Leukemia - T-cell receptor",
            "7:Liver cancer - Metabolism",
            "18:Liver cancer - Metabolism",
            "21:Lymphoma - Adaptive immune response",
            "46:Lymphoma - Humoral immune response",
            "55:Lymphoma - Immune response",
            "71:Lymphoma - Inflammatory response",
            "50:Lymphoma - Unknown function",
            "2:Mucus-secreting cells - Unknown function",
            "14:Myeloid leukemia - Innate immune response",
            "20:Myeloma - Immune response",
            "51:Myeloma - Immunoglobulins",
            "17:Neuroblastoma - Neuronal signaling",
            "11:Neuronal - Sensory perception",
            "72:Neuronal - Signal transduction",
            "1:Neuronal - Visual perception",
            "31:Non-specific - Antiviral immune response",
            "8:Non-specific - Basic cellular processes",
            "43:Non-specific - Basic cellular processes",
            "68:Non-specific - Cell cycle regulation",
            "32:Non-specific - Cell proliferation",
            "30:Non-specific - Gene expression regulation",
            "52:Non-specific - Mitochondria",
            "66:Non-specific - Mitochondria",
            "26:Non-specific - Mitochondria & RNA binding",
            "13:Non-specific - Mixed function",
            "36:Non-specific - mRNA processing",
            "37:Non-specific - mRNA processing",
            "22:Non-specific - mRNA splicing & Cell cycle",
            "28:Non-specific - Nuclear processes",
            "45:Non-specific - Nuclear processes",
            "58:Non-specific - Nuclear processes",
            "41:Non-specific - Nucleosome assembly",
            "62:Non-specific - Plasma proteins",
            "63:Non-specific - Protein processing",
            "25:Non-specific - Ribosome",
            "56:Non-specific - Sensory perception",
            "4:Non-specific - Transcription",
            "23:Non-specific - Transcription",
            "38:Non-specific - Transcription",
            "39:Non-specific - Transcription",
            "54:Non-specific - Transcription",
            "19:Non-specific - Unknown function",
            "24:Non-specific - Unknown function",
            "29:Non-specific - Unknown function",
            "40:Non-specific - Unknown function",
            "42:Non-specific - Unknown function",
            "65:Non-specific - Unknown function",
            "67:Non-specific - Unknown function",
            "60:Prostate cancer - Unknown function",
            "3:Rhabdoid - Membrane components",
            "5:Rhabdoid - Unknown function",
            "35:RS4;11 - Unknown function",
            "33:Sarcoma - Muscle contraction",
            "69:Skin cancer - ECM organization",
            "9:Skin cancer - Melanin biosynthesis",
            "53:Squamous epithelial cells - Keratinization",
            "57:Stomach & Colon cancer - Digestion",
            "34:Testis cancer - Unknown function",
            "16:Thyroid cancer - Neuronal signaling"
          ],
          "groups": null
        }
      ]
    }
  },
  "STRUCTURE": {
    "Protein sequence variants": {
      "urlKey": "sequence_variants",
      "levels": [
        {
          "index": 0,
          "label": "Variants",
          "selectId": "variants",
          "multiSelect": true,
          "options": [
            "Alphamissense population",
            "Alphamissense clinical",
            "Experimental Population",
            "Experimental clinical"
          ],
          "groups": null
        }
      ]
    }
  },
  "INTERACTION": {
    "Protein interaction": {
      "urlKey": "interaction",
      "levels": []
    },
    "Protein interaction count": {
      "urlKey": "num_interactions",
      "levels": [
        {
          "index": 0,
          "label": "Type",
          "selectId": "Type",
          "multiSelect": true,
          "options": [
            "Consensus",
            "IntAct",
            "BioGrid",
            "OpenCell",
            "BioPlex"
          ],
          "groups": null
        },
        {
          "index": 1,
          "label": "Number of interactions",
          "selectId": "num",
          "multiSelect": true,
          "options": [
            "1",
            "2",
            "3",
            "4",
            "5",
            "6-10",
            "11-20",
            "21-30",
            "31-40",
            "41-50",
            "51-75",
            "76-100",
            "101-200",
            ">200"
          ],
          "groups": null
        }
      ]
    },
    "Metabolic pathway": {
      "urlKey": "pathway",
      "levels": [
        {
          "index": 0,
          "label": "Pathway",
          "selectId": "pathway",
          "multiSelect": true,
          "options": [
            "Acyl-CoA hydrolysis",
            "Acylglycerides metabolism",
            "Alanine; aspartate and glutamate metabolism",
            "Amino sugar and nucleotide sugar metabolism",
            "Aminoacyl-tRNA biosynthesis",
            "Androgen metabolism",
            "Arachidonic acid metabolism",
            "Arginine and proline metabolism",
            "Ascorbate and aldarate metabolism",
            "Beta oxidation of branched-chain fatty acids (mitochondrial)",
            "Beta oxidation of di-unsaturated fatty acids (n-6) (mitochondrial)",
            "Beta oxidation of di-unsaturated fatty acids (n-6) (peroxisomal)",
            "Beta oxidation of even-chain fatty acids (mitochondrial)",
            "Beta oxidation of even-chain fatty acids (peroxisomal)",
            "Beta oxidation of odd-chain fatty acids (mitochondrial)",
            "Beta oxidation of phytanic acid (peroxisomal)",
            "Beta oxidation of poly-unsaturated fatty acids (mitochondrial)",
            "Beta oxidation of unsaturated fatty acids (n-7) (mitochondrial)",
            "Beta oxidation of unsaturated fatty acids (n-7) (peroxisomal)",
            "Beta oxidation of unsaturated fatty acids (n-9) (mitochondrial)",
            "Beta oxidation of unsaturated fatty acids (n-9) (peroxisomal)",
            "Beta-alanine metabolism",
            "Bile acid biosynthesis",
            "Bile acid recycling",
            "Biopterin metabolism",
            "Biotin metabolism",
            "Blood group biosynthesis",
            "Butanoate metabolism",
            "C5-branched dibasic acid metabolism",
            "Carnitine shuttle (cytosolic)",
            "Carnitine shuttle (endoplasmic reticular)",
            "Carnitine shuttle (mitochondrial)",
            "Carnitine shuttle (peroxisomal)",
            "Cholesterol biosynthesis 1 (Bloch pathway)",
            "Cholesterol biosynthesis 2",
            "Cholesterol biosynthesis 3 (Kandustch-Russell pathway)",
            "Cholesterol metabolism",
            "Chondroitin / heparan sulfate biosynthesis",
            "Chondroitin sulfate degradation",
            "Cysteine and methionine metabolism",
            "Drug metabolism",
            "Eicosanoid metabolism",
            "Estrogen metabolism",
            "Ether lipid metabolism",
            "Fatty acid activation (cytosolic)",
            "Fatty acid activation (endoplasmic reticular)",
            "Fatty acid biosynthesis",
            "Fatty acid biosynthesis (even-chain)",
            "Fatty acid biosynthesis (odd-chain)",
            "Fatty acid biosynthesis (unsaturated)",
            "Fatty acid degradation",
            "Fatty acid desaturation (even-chain)",
            "Fatty acid desaturation (odd-chain)",
            "Fatty acid elongation (even-chain)",
            "Fatty acid elongation (odd-chain)",
            "Fatty acid metabolism",
            "Fatty acid oxidation",
            "Folate metabolism",
            "Formation and hydrolysis of cholesterol esters",
            "Fructose and mannose metabolism",
            "Galactose metabolism",
            "Glucocorticoid biosynthesis",
            "Glutathione metabolism",
            "Glycerolipid metabolism",
            "Glycerophospholipid metabolism",
            "Glycine; serine and threonine metabolism",
            "Glycolysis / Gluconeogenesis",
            "Glycosphingolipid biosynthesis-ganglio series",
            "Glycosphingolipid biosynthesis-globo series",
            "Glycosphingolipid biosynthesis-lacto and neolacto series",
            "Glycosphingolipid metabolism",
            "Glycosylphosphatidylinositol (GPI)-anchor biosynthesis",
            "Glyoxylate and dicarboxylate metabolism",
            "Heme degradation",
            "Heparan sulfate degradation",
            "Histidine metabolism",
            "Inositol phosphate metabolism",
            "Insect hormone biosynthesis",
            "Isolated",
            "Keratan sulfate biosynthesis",
            "Keratan sulfate degradation",
            "Leukotriene metabolism",
            "Linoleate metabolism",
            "Lipoic acid metabolism",
            "Lysine metabolism",
            "Metabolism of other amino acids",
            "Miscellaneous",
            "N-glycan metabolism",
            "Nicotinate and nicotinamide metabolism",
            "Nucleotide metabolism",
            "O-glycan metabolism",
            "Octane oxidation",
            "Omega-3 fatty acid metabolism",
            "Omega-6 fatty acid metabolism",
            "Oxidative phosphorylation",
            "Pantothenate and CoA metabolism",
            "Pentose and glucuronate interconversions",
            "Pentose phosphate pathway",
            "Phenylalanine metabolism",
            "Phenylalanine; tyrosine and tryptophan biosynthesis",
            "Phosphatidylinositol phosphate metabolism",
            "Pool reactions",
            "Porphyrin metabolism",
            "Propanoate metabolism",
            "Prostaglandin biosynthesis",
            "Protein assembly",
            "Protein degradation",
            "Protein modification",
            "Purine metabolism",
            "Pyrimidine metabolism",
            "Pyruvate metabolism",
            "Retinol metabolism",
            "Riboflavin metabolism",
            "ROS detoxification",
            "Serotonin and melatonin biosynthesis",
            "Sphingolipid metabolism",
            "Starch and sucrose metabolism",
            "Steroid metabolism",
            "Sulfur metabolism",
            "Terpenoid backbone biosynthesis",
            "Thiamine metabolism",
            "Toluene degradation",
            "Transport reactions",
            "Tricarboxylic acid cycle and glyoxylate/dicarboxylate metabolism",
            "Tryptophan metabolism",
            "Tyrosine metabolism",
            "Ubiquinone and other terpenoid-quinone biosynthesis",
            "Ubiquinone synthesis",
            "Valine; leucine; and isoleucine metabolism",
            "Vitamin A metabolism",
            "Vitamin B12 metabolism",
            "Vitamin B2 metabolism",
            "Vitamin B6 metabolism",
            "Vitamin C metabolism",
            "Vitamin D metabolism",
            "Vitamin E metabolism",
            "Xenobiotics metabolism"
          ],
          "groups": null
        }
      ]
    },
    "Structure ipTM": {
      "urlKey": "intstruct_iptm",
      "levels": [
        {
          "index": 0,
          "label": "ipTM",
          "selectId": "iptm",
          "multiSelect": true,
          "options": [
            "0-0.2",
            "0.2-0.4",
            "0.4-0.6",
            "0.6-0.8",
            "0.8-1"
          ],
          "groups": null
        }
      ]
    }
  },
  "PRIMARY DATA": {},
  "PROTEIN EVIDENCE": {
    "Evidence summary": {
      "urlKey": "evidence_summary",
      "levels": [
        {
          "index": 0,
          "label": "Category",
          "selectId": "evidence_protein",
          "multiSelect": true,
          "options": [
            "Evidence at protein level",
            "Evidence at transcript level",
            "No human protein/transcript evidence"
          ],
          "groups": null
        }
      ]
    },
    "UniProt evidence": {
      "urlKey": "uniprot_evidence",
      "levels": [
        {
          "index": 0,
          "label": "Category",
          "selectId": "evidence_protein",
          "multiSelect": true,
          "options": [
            "Evidence at protein level",
            "Evidence at transcript level",
            "No human protein/transcript evidence"
          ],
          "groups": null
        }
      ]
    },
    "NeXtProt evidence": {
      "urlKey": "nextprot_evidence",
      "levels": [
        {
          "index": 0,
          "label": "Category",
          "selectId": "evidence_protein",
          "multiSelect": true,
          "options": [
            "Evidence at protein level",
            "Evidence at transcript level",
            "No human protein/transcript evidence"
          ],
          "groups": null
        }
      ]
    },
    "HPA evidence": {
      "urlKey": "hpa_evidence",
      "levels": [
        {
          "index": 0,
          "label": "Category",
          "selectId": "evidence_protein",
          "multiSelect": true,
          "options": [
            "Evidence at protein level",
            "Evidence at transcript level",
            "No human protein/transcript evidence"
          ],
          "groups": null
        }
      ]
    }
  },
  "ANTIBODY VALIDATION": {
    "Protein array (PA)": {
      "urlKey": "pa_ab_validation",
      "levels": [
        {
          "index": 0,
          "label": "Validation",
          "selectId": "pa_validation",
          "multiSelect": true,
          "options": [
            "Supported",
            "Approved",
            "Uncertain"
          ],
          "groups": null
        }
      ]
    },
    "Western blot (WB)": {
      "urlKey": "wb_ab_validation",
      "levels": [
        {
          "index": 0,
          "label": "Validation",
          "selectId": "wb_validation",
          "multiSelect": true,
          "options": [
            "Enhanced - Capture",
            "Enhanced - Genetic",
            "Enhanced - Independent",
            "Enhanced - Orthogonal",
            "Enhanced - Recombinant",
            "Supported",
            "Approved",
            "Uncertain"
          ],
          "groups": null
        }
      ]
    },
    "Immunohistochemistry (IHC)": {
      "urlKey": "ihc_ab_validation",
      "levels": [
        {
          "index": 0,
          "label": "Validation",
          "selectId": "ih_validation",
          "multiSelect": true,
          "options": [
            "Enhanced - Independent",
            "Enhanced - Orthogonal",
            "Supported",
            "Approved",
            "Uncertain"
          ],
          "groups": null
        }
      ]
    },
    "Immunocytochemistry (ICC)": {
      "urlKey": "icc_ab_validation",
      "levels": [
        {
          "index": 0,
          "label": "Validation",
          "selectId": "if_validation",
          "multiSelect": true,
          "options": [
            "Enhanced - Genetic",
            "Enhanced - Independent",
            "Enhanced - Recombinant",
            "Supported",
            "Approved",
            "Uncertain"
          ],
          "groups": null
        }
      ]
    }
  },
  "EXTRA": {
    "With antibodies": {
      "urlKey": "with_antibodies",
      "levels": [
        {
          "index": 0,
          "label": "Antibodies",
          "selectId": "antibodies_with",
          "multiSelect": false,
          "options": [
            "Yes",
            "No"
          ],
          "groups": null
        }
      ]
    },
    "Has data": {
      "urlKey": "has_data",
      "levels": [
        {
          "index": 0,
          "label": "Data type",
          "selectId": "has_data_type",
          "multiSelect": true,
          "options": [
            "Tissue - Immunohistochemistry",
            "Tissue - GTEx transcriptomics",
            "Tissue - FANTOM transcriptomics",
            "Tissue - Expression clustering",
            "Brain",
            "Brain - Expression clustering",
            "Single cell - Expression clustering",
            "Immune cell - Expression clustering",
            "Subcellular",
            "Cancer - Immunohistochemistry",
            "Cancer - Mass spectrometry",
            "Blood - conc. immunoassay",
            "Blood - conc. mass spectrometry",
            "Blood - Olink HT",
            "Blood - Olink 1536",
            "Blood - SomaScan",
            "Blood - ProteomEdge",
            "Blood - Targeted proteomics",
            "Cell line - Mass spectrometry",
            "Cell line - Expression clustering",
            "Structure",
            "Interaction",
            "Metabolic"
          ],
          "groups": null
        }
      ]
    },
    "Sort by": {
      "urlKey": "sort_by",
      "levels": [
        {
          "index": 0,
          "label": "Column",
          "selectId": "sort",
          "multiSelect": false,
          "options": [
            "Gene",
            "Position",
            "Tissue specific score",
            "Prognostic",
            "Reliability (IF)",
            "Reliability (IH)"
          ],
          "groups": null
        }
      ]
    }
  },
  "SPECIFICITY": {},
  "DISTRIBUTION": {},
  "EXPRESSION": {},
  "RELIABILITY": {},
  "SUBCELLULAR VARIATION": {},
  "MULTILOCALIZATION": {},
  "OTHER": {}
};

module.exports = { hpaSchema };
