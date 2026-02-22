// Test runner — discovers configured providers, runs all test suites, prints summary.
// Usage: npx tsx tests/runner.ts [baseUrl]

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import JSON5 from 'json5';
import type { TestResult, TestContext, TestFn } from './harness';
import { runTests } from './harness';

// Import all provider test suites
import * as anthropicTests from './providers/anthropic';
import * as openrouterTests from './providers/openrouter';
import * as geminiTests from './providers/gemini';
import * as openaiTests from './providers/openai';
import * as groqTests from './providers/groq';
import * as mistralTests from './providers/mistral';
import * as ollamaTests from './providers/ollama';
import * as agentSdkTests from './agent-sdk';

const CONFIG_DIR = join(homedir(), '.ccasr');
const LOGS_DIR = join(CONFIG_DIR, 'logs');

interface ProviderSuite {
  providerName: string;
  tests: TestFn[];
}

const ALL_SUITES: ProviderSuite[] = [
  anthropicTests,
  openrouterTests,
  geminiTests,
  openaiTests,
  groqTests,
  mistralTests,
  ollamaTests,
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const baseUrl = process.argv[2] || 'http://127.0.0.1:3456';
  const filterProvider = process.argv[3]; // optional: run only one provider
  const filterTest = process.argv[4];     // optional: run only one test name

  // Load config to discover configured providers
  const configPath = join(CONFIG_DIR, 'config.json');
  let config: any;
  try {
    config = JSON5.parse(readFileSync(configPath, 'utf-8'));
  } catch (err: any) {
    console.error(`ERROR: Cannot read config at ${configPath}: ${err.message}`);
    process.exit(1);
  }

  const configuredProviders = new Map<string, any>();
  for (const p of config.Providers || []) {
    configuredProviders.set(p.name, p);
  }

  console.log('\n========================================');
  console.log('  ccasr test runner');
  console.log('========================================');
  console.log(`  Target:     ${baseUrl}`);
  console.log(`  Providers:  ${[...configuredProviders.keys()].join(', ')}`);
  if (filterProvider) console.log(`  Filter:     provider=${filterProvider}`);
  if (filterTest) console.log(`  Filter:     test=${filterTest}`);
  console.log('');

  // Check server is reachable
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`health check returned ${health.status}`);
    const healthData = await health.json();
    console.log(`  Server:     v${healthData.version} (${healthData.providers.join(', ')})`);
    console.log('');
  } catch (err: any) {
    console.error(`ERROR: Cannot reach server at ${baseUrl}. Is ccasr running?`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  const allResults: TestResult[] = [];
  const startTime = Date.now();

  // Run provider suites
  for (const suite of ALL_SUITES) {
    if (filterProvider && suite.providerName !== filterProvider) continue;
    if (!configuredProviders.has(suite.providerName)) {
      console.log(`SKIP  ${suite.providerName} (not configured)`);
      continue;
    }

    const providerConfig = configuredProviders.get(suite.providerName);
    const model = getModel(suite.providerName, providerConfig, config.Router);

    const ctx: TestContext = {
      baseUrl,
      provider: suite.providerName,
      model,
      apiKey: 'test-key',
    };

    // Filter tests if specified
    let testsToRun = suite.tests;
    if (filterTest) {
      testsToRun = testsToRun.filter(t => t.name === filterTest);
    }

    if (testsToRun.length === 0) continue;

    console.log(`\n--- ${suite.providerName} (${model}) ---`);
    const results = await runTests(suite.providerName, testsToRun, ctx);
    printResults(results);
    allResults.push(...results);
  }

  // Run Agent SDK suite against the default route
  if (!filterProvider || filterProvider === 'agent-sdk') {
    const defaultRoute = parseRoute(config.Router.sonnet || config.Router.default);
    const sdkCtx: TestContext = {
      baseUrl,
      provider: defaultRoute.provider,
      model: defaultRoute.model,
      apiKey: 'test-key',
    };

    let sdkTests = agentSdkTests.tests;
    if (filterTest) {
      sdkTests = sdkTests.filter(t => t.name === filterTest);
    }

    if (sdkTests.length > 0) {
      console.log(`\n--- agent-sdk (${defaultRoute.provider}/${defaultRoute.model}) ---`);
      const sdkResults = await runTests('agent-sdk', sdkTests, sdkCtx);
      printResults(sdkResults);
      allResults.push(...sdkResults);
    }
  }

  // Summary
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed && !r.expectedFail).length;
  const expectedFail = allResults.filter(r => !r.passed && r.expectedFail).length;
  const total = allResults.length;

  console.log('\n========================================');
  console.log('  SUMMARY');
  console.log('========================================');
  console.log(`  ${passed} passed, ${failed} failed, ${expectedFail} expected-fail, ${total} total`);
  console.log(`  Time: ${totalTime}s`);

  // Show failures
  const realFailures = allResults.filter(r => !r.passed && !r.expectedFail);
  if (realFailures.length > 0) {
    console.log('\n  FAILURES:');
    for (const r of realFailures) {
      console.log(`    ${r.provider}/${r.test}: ${r.error?.slice(0, 100)}`);
    }
  }

  console.log('========================================\n');

  // Write results to log file
  mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = join(LOGS_DIR, 'test-results.json');
  const logContent = JSON.stringify({
    timestamp: new Date().toISOString(),
    baseUrl,
    durationSeconds: parseFloat(totalTime),
    summary: { passed, failed, expectedFail, total },
    results: allResults,
  }, null, 2);
  writeFileSync(logPath, logContent, 'utf-8');
  console.log(`Results written to ${logPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printResults(results: TestResult[]): void {
  for (const r of results) {
    if (r.passed) {
      console.log(`  PASS  ${r.test} (${r.durationMs}ms)`);
    } else if (r.expectedFail) {
      console.log(`  XFAIL ${r.test} (${r.durationMs}ms) -- ${r.error?.slice(0, 80)}`);
    } else {
      console.log(`  FAIL  ${r.test} (${r.durationMs}ms) -- ${r.error?.slice(0, 80)}`);
    }
  }
}

function parseRoute(entry: string): { provider: string; model: string } {
  const i = entry.indexOf(',');
  return { provider: entry.substring(0, i), model: entry.substring(i + 1) };
}

function getModel(provider: string, providerConfig: any, router: any): string {
  // Use first model from provider config
  if (providerConfig.models && providerConfig.models.length > 0) {
    return providerConfig.models[0];
  }
  // Fall back to Router entries
  for (const [, entry] of Object.entries(router) as [string, string][]) {
    if (entry.startsWith(provider + ',')) {
      return entry.split(',').slice(1).join(',');
    }
  }
  return 'default';
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
