'use strict';

/**
 * Investigation agent manual test runner.
 *
 * Run: node scripts/manual/test_investigation.js
 * Or:  node scripts/manual/test_investigation.js "GENE" "question here"
 */

const { initializeManualRuntime } = require('./runtime');
const agent = require('../../src/system/agents/investigation.js');

const TEST_CASES = [
  // Brain disambiguation (the hard ones)
  { gene: 'TP53', q: 'What is the nTPM expression value in the Amygdala from the Mouse brain RNA-Seq dataset?' },
  { gene: 'TP53', q: 'What is the nTPM expression value in the Amygdala from the Human brain (HPA) dataset?' },

  // Tissue expression
  { gene: 'EGFR', q: 'What tissues express EGFR? List the top 5 with nTPM values.' },
  { gene: 'INS', q: 'What is the nTPM expression of insulin (INS) in pancreas?' },
  { gene: 'ALB', q: 'What tissue has the highest expression of albumin?' },

  // Subcellular
  { gene: 'TP53', q: 'What is the main subcellular location of TP53?' },
  { gene: 'ACTB', q: 'Where is beta-actin located in the cell?' },

  // Cancer/Prognostic
  { gene: 'MYC', q: 'Is MYC prognostic in any cancer type?' },
  { gene: 'TP53', q: 'Is TP53 a prognostic marker in any cancer?' },
  { gene: 'EGFR', q: 'What cancers show high EGFR expression?' },

  // Cell lines
  { gene: 'TP53', q: 'What is the nTPM expression of TP53 in HeLa cells?' },
  { gene: 'GAPDH', q: 'What cell lines express GAPDH highly?' },

  // Interactions
  { gene: 'TP53', q: 'How many protein interactions does TP53 have?' },
  { gene: 'BRCA1', q: 'What proteins interact with BRCA1?' },

  // General info
  { gene: 'EGFR', q: 'What is the protein class of EGFR?' },
  { gene: 'TP53', q: 'What is TP53 also known as? Give me aliases.' },
];

async function runTest(gene, question) {
  const start = Date.now();
  const steps = [];

  console.log('\n' + '█'.repeat(100));
  console.log(`GENE: ${gene}`);
  console.log(`QUESTION: ${question}`);
  console.log('█'.repeat(100));

  try {
    const result = await agent({ gene, question }, {
      onStep: (s) => {
        const ts = ((Date.now() - start) / 1000).toFixed(2);
        const line = `[${ts}s] ${s.stage.toUpperCase().padEnd(18)} [${(s.label || '').padEnd(15)}] ${s.message || ''}`;
        console.log(line);
        steps.push({ ts, ...s });
      }
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);

    console.log('\n' + '-'.repeat(100));
    console.log('RESULT:');
    console.log('-'.repeat(100));
    console.log(`Found: ${result.found}`);
    console.log(`Answer: ${result.answer}`);
    console.log(`Source: ${result.source_section || 'N/A'}`);
    console.log(`Confidence: ${result.confidence || 'N/A'}`);
    console.log(`Reasoning: ${result.reasoning || 'N/A'}`);
    console.log(`Pages fetched: ${result.pages_fetched?.join(', ') || 'N/A'}`);

    // Citations
    if (result.citations?.length) {
      console.log('\nCITATIONS:');
      for (const c of result.citations) {
        console.log(`  [${c.page}] ${c.url}`);
        console.log(`          ${c.charts} charts, ${c.tables} tables extracted`);
      }
    }

    // Tokens
    if (result.tokens) {
      console.log('\nTOKENS:');
      console.log(`  Page selection: ${result.tokens.pageSelection?.total || 0}`);
      console.log(`  Reasoning:      ${result.tokens.reasoning?.total || 0}`);
      console.log(`  TOTAL:          ${result.tokens.total?.total || 0} (${result.tokens.total?.prompt || 0} in + ${result.tokens.total?.completion || 0} out)`);
    }

    console.log('-'.repeat(100));
    console.log(`ELAPSED: ${elapsed}s`);
    console.log('-'.repeat(100));

    return { gene, question, result, elapsed: parseFloat(elapsed), steps };

  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log('\n' + '-'.repeat(100));
    console.log(`ERROR: ${err.message}`);
    console.log(`ELAPSED: ${elapsed}s`);
    console.log('-'.repeat(100));
    return { gene, question, error: err.message, elapsed: parseFloat(elapsed), steps };
  }
}

async function runAll() {
  console.log('\n');
  console.log('████████████████████████████████████████████████████████████████████████████████████████████████████');
  console.log('█                            INVESTIGATION AGENT - MANUAL TEST SUITE                              █');
  console.log('████████████████████████████████████████████████████████████████████████████████████████████████████');
  console.log(`\nRunning ${TEST_CASES.length} test cases...\n`);

  const results = [];
  const startTotal = Date.now();

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    console.log(`\n[${'#'.repeat(20)} TEST ${i + 1}/${TEST_CASES.length} ${'#'.repeat(20)}]`);
    const r = await runTest(tc.gene, tc.q);
    results.push(r);
  }

  const totalElapsed = ((Date.now() - startTotal) / 1000).toFixed(1);

  // Summary
  console.log('\n\n');
  console.log('████████████████████████████████████████████████████████████████████████████████████████████████████');
  console.log('█                                         SUMMARY                                                  █');
  console.log('████████████████████████████████████████████████████████████████████████████████████████████████████');

  const found = results.filter(r => r.result?.found).length;
  const notFound = results.filter(r => r.result && !r.result.found).length;
  const errors = results.filter(r => r.error).length;

  console.log(`\nTotal tests: ${results.length}`);
  console.log(`✅ Found answer: ${found}`);
  console.log(`❓ Not found: ${notFound}`);
  console.log(`❌ Errors: ${errors}`);
  console.log(`⏱️  Total time: ${totalElapsed}s`);
  console.log(`⏱️  Avg per test: ${(parseFloat(totalElapsed) / results.length).toFixed(1)}s`);

  console.log('\n--- Per-test summary ---');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.error ? '❌' : (r.result?.found ? '✅' : '❓');
    const answer = r.result?.answer?.slice(0, 80) || r.error || 'N/A';
    console.log(`${status} [${r.elapsed}s] ${r.gene}: ${r.question.slice(0, 50)}...`);
    console.log(`   → ${answer}${answer.length >= 80 ? '...' : ''}`);
  }

  console.log('\n████████████████████████████████████████████████████████████████████████████████████████████████████\n');
}

async function runSingle(gene, question) {
  await runTest(gene, question);
}

async function main() {
  const { db, withActiveModel } = await initializeManualRuntime();
  const args = process.argv.slice(2);
  try {
    if (args.length >= 2) {
      await withActiveModel(() => runSingle(args[0], args.slice(1).join(' ')));
    } else if (args[0] === '--all' || args.length === 0) {
      await withActiveModel(() => runAll());
    } else {
      console.log(`
Usage:
  node scripts/manual/test_investigation.js                    # Run all tests
  node scripts/manual/test_investigation.js --all              # Run all tests
  node scripts/manual/test_investigation.js GENE "question"    # Run single test

Examples:
  node scripts/manual/test_investigation.js TP53 "What is the subcellular location?"
  node scripts/manual/test_investigation.js MYC "Is MYC prognostic in any cancer?"
  node scripts/manual/test_investigation.js EGFR "What tissues express EGFR?"
`);
    }
  } finally {
    await db.end();
  }
}

main().catch(console.error);
