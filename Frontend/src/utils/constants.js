
export const THUMB_SECTIONS = [
    { key: 'tissue', label: 'Tissue', color: '#0083C4' },
    { key: 'brain', label: 'Brain', color: '#ffdd00' },
    { key: 'single_cell', label: 'Single cell', color: '#6aa692' },
    { key: 'subcellular', label: 'Subcell', color: '#97cf16' },
    { key: 'cancer', label: 'Cancer', color: '#ffaabf' },
    { key: 'blood', label: 'Blood', color: '#cf161a' },
    { key: 'cell_line', label: 'Cell line', color: '#ffa500' },
    { key: 'structure', label: 'Structure', color: '#69008c' },
    { key: 'interaction', label: 'Interaction', color: '#c89c79' },
];

export const TOOL_STAGE_META = {
    start: { label: 'Start', css: 'start', description: 'Agent activated.' },
    planning_step: { label: 'Plan', css: 'planning', description: 'Reading the schema.' },
    reasoning_step: { label: 'Think', css: 'reasoning', description: 'Weighing the options.' },
    selection_step: { label: 'Select', css: 'selection', description: 'Choice made.' },
    execution_step: { label: 'Run', css: 'execution', description: 'Executing.' },
    fallback: { label: 'Fallback', css: 'fallback', description: 'Trying backup.' },
    error: { label: 'Error', css: 'error', description: 'Issue detected.' },
    complete: { label: 'Done', css: 'complete', description: 'Complete.' },
    not_found: { label: 'Not found', css: 'fallback', description: 'No answer in the data.' },
    info: { label: 'Info', css: 'info', description: 'Status update.' }
};
