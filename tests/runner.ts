// Test runner — discovers configured providers, runs all test suites, prints summary.
//
// Usage:
//   npx tsx tests/runner.ts [baseUrl] [provider] [test]
//   npx tsx tests/runner.ts --config path/to/config.json [baseUrl] [provider] [test]
//
// The --config flag tells the runner which config to read for provider/model
// discovery. It does NOT change the server's config — the server must already
// be running with the matching config.
//
// SDK tests iterate ALL models in each provider's models[] array,
// so you get coverage across e.g. all 5 OpenRouter models.

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

const DEFAULT_CONFIG_DIR = join(homedir(), '.ccasr');
const DEFAULT_LOGS_DIR = join(DEFAULT_CONFIG_DIR, 'logs');

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
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  configPath: string;
  baseUrl: string;
  filterProvider?: string;
  filterTest?: string;
} {
  const args = argv.slice(2); // skip node + script
  let configPath = join(DEFAULT_CONFIG_DIR, 'config.json');
  let positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && i + 1 < args.length) {
      configPath = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  return {
    configPath,
    baseUrl: positional[0] || 'http://127.0.0.1:3456',
    filterProvider: positional[1],
    filterTest: positional[2],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { configPath, baseUrl, filterProvider, filterTest } = parseArgs(process.argv);

  // Load config to discover configured providers
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
  console.log(`  Config:     ${configPath}`);
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

  // Run provider suites (use first model only — these are basic provider sanity tests)
  for (const suite of ALL_SUITES) {
    if (filterProvider && suite.providerName !== filterProvider) continue;
    if (!configuredProviders.has(suite.providerName)) {
      console.log(`SKIP  ${suite.providerName} (not configured)`);
      continue;
    }

    const providerConfig = configuredProviders.get(suite.providerName);
    const model = getFirstModel(suite.providerName, providerConfig, config.Router);

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

  // Run Agent SDK suite — iterate ALL models per provider
  if (!filterProvider || filterProvider === 'agent-sdk' || filterProvider.startsWith('agent-sdk:')) {
    const sdkProviderFilter = filterProvider?.startsWith('agent-sdk:')
      ? filterProvider.split(':')[1]
      : undefined;

    // Build list of (provider, model) targets — one entry per model
    const sdkTargets: Array<{ provider: string; model: string; label: string }> = [];

    for (const suite of ALL_SUITES) {
      if (sdkProviderFilter && suite.providerName !== sdkProviderFilter) continue;
      if (!configuredProviders.has(suite.providerName)) continue;

      const providerConfig = configuredProviders.get(suite.providerName);
      const models = getAllModels(suite.providerName, providerConfig, config.Router);

      for (const model of models) {
        sdkTargets.push({
          provider: suite.providerName,
          model,
          label: `agent-sdk:${suite.providerName}`,
        });
      }
    }

    // Fallback if filterProvider === 'agent-sdk' matched nothing
    if (sdkTargets.length === 0 && filterProvider === 'agent-sdk') {
      const defaultRoute = parseRoute(config.Router.sonnet || config.Router.default);
      sdkTargets.push({
        provider: defaultRoute.provider,
        model: defaultRoute.model,
        label: 'agent-sdk',
      });
    }

    for (const target of sdkTargets) {
      const sdkCtx: TestContext = {
        baseUrl,
        provider: target.provider,
        model: target.model,
        apiKey: 'test-key',
      };

      let sdkTests = agentSdkTests.tests;
      if (filterTest) {
        sdkTests = sdkTests.filter(t => t.name === filterTest);
      }

      if (sdkTests.length > 0) {
        console.log(`\n--- ${target.label} (${target.provider}/${target.model}) ---`);
        const sdkResults = await runTests(target.label, sdkTests, sdkCtx);
        printResults(sdkResults);
        allResults.push(...sdkResults);
      }
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
  mkdirSync(DEFAULT_LOGS_DIR, { recursive: true });
  const logPath = join(DEFAULT_LOGS_DIR, 'test-results.json');
  const logContent = JSON.stringify({
    timestamp: new Date().toISOString(),
    baseUrl,
    configPath,
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

/** Return the first model for a provider (for basic provider tests) */
function getFirstModel(provider: string, providerConfig: any, router: any): string {
  if (providerConfig.models && providerConfig.models.length > 0) {
    return providerConfig.models[0];
  }
  for (const [, entry] of Object.entries(router) as [string, string][]) {
    if (entry.startsWith(provider + ',')) {
      return entry.split(',').slice(1).join(',');
    }
  }
  return 'default';
}

/** Return ALL models for a provider (for SDK multi-model tests) */
function getAllModels(provider: string, providerConfig: any, router: any): string[] {
  if (providerConfig.models && providerConfig.models.length > 0) {
    return providerConfig.models;
  }
  // Fall back to models referenced in Router entries
  const models: string[] = [];
  for (const [, entry] of Object.entries(router) as [string, string][]) {
    if (entry.startsWith(provider + ',')) {
      models.push(entry.split(',').slice(1).join(','));
    }
  }
  return models.length > 0 ? models : ['default'];
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
