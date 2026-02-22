// Test runner — derives test targets from the active route set.
//
// Usage:
//   npx tsx tests/runner.ts [baseUrl] [filter]
//   npx tsx tests/runner.ts --config path/to/config.json [baseUrl] [filter]
//   npx tsx tests/runner.ts --route mixed [baseUrl] [filter]
//
// The --route flag selects which named route set to test (overrides ActiveRoute).
// Provider tests: 5 basic tests per unique provider in the active route set.
// SDK tests: 8 tests per tier entry in the active route set.

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

const PROVIDER_SUITES: Record<string, ProviderSuite> = {
  anthropic: anthropicTests,
  openrouter: openrouterTests,
  gemini: geminiTests,
  openai: openaiTests,
  groq: groqTests,
  mistral: mistralTests,
  ollama: ollamaTests,
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  configPath: string;
  activeRoute?: string;
  baseUrl: string;
  filterTest?: string;
} {
  const args = argv.slice(2); // skip node + script
  let configPath = join(DEFAULT_CONFIG_DIR, 'config.json');
  let activeRoute: string | undefined;
  let positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && i + 1 < args.length) {
      configPath = args[++i];
    } else if (args[i] === '--route' && i + 1 < args.length) {
      activeRoute = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  return {
    configPath,
    activeRoute,
    baseUrl: positional[0] || 'http://127.0.0.1:3456',
    filterTest: positional[1],
  };
}

// ---------------------------------------------------------------------------
// Route target resolution
// ---------------------------------------------------------------------------

interface RouteTarget {
  tier: string;
  provider: string;
  model: string;
}

function parseRoute(entry: string): { provider: string; model: string } {
  const i = entry.indexOf(',');
  return { provider: entry.substring(0, i), model: entry.substring(i + 1) };
}

function getRouteTargets(routeSet: Record<string, string>): RouteTarget[] {
  const targets: RouteTarget[] = [];
  for (const tier of ['sonnet', 'opus', 'haiku']) {
    const entry = routeSet[tier];
    if (!entry) continue;
    const { provider, model } = parseRoute(entry);
    targets.push({ tier, provider, model });
  }
  return targets;
}

function getUniqueProviders(targets: RouteTarget[]): string[] {
  return [...new Set(targets.map((t) => t.provider))];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { configPath, activeRoute: activeRouteFlag, baseUrl, filterTest } = parseArgs(process.argv);

  // Load config to discover routes
  let config: any;
  try {
    config = JSON5.parse(readFileSync(configPath, 'utf-8'));
  } catch (err: any) {
    console.error(`ERROR: Cannot read config at ${configPath}: ${err.message}`);
    process.exit(1);
  }

  // Resolve the active route set
  let activeRouteName: string;
  let activeRouteSet: Record<string, string>;

  if (config.Routes && typeof config.Routes === 'object') {
    // New format
    activeRouteName = activeRouteFlag || config.ActiveRoute || Object.keys(config.Routes)[0];
    if (!config.Routes[activeRouteName]) {
      const available = Object.keys(config.Routes).join(', ');
      console.error(`ERROR: Route "${activeRouteName}" not found. Available: ${available}`);
      process.exit(1);
    }
    activeRouteSet = config.Routes[activeRouteName];
  } else if (config.Router) {
    // Old format (backward compat)
    activeRouteName = 'default';
    activeRouteSet = config.Router;
    // Normalize: Router.default → Router.sonnet
    if (activeRouteSet.default && !activeRouteSet.sonnet) {
      activeRouteSet.sonnet = activeRouteSet.default;
    }
  } else {
    console.error('ERROR: Config has no Routes or Router section');
    process.exit(1);
  }

  const targets = getRouteTargets(activeRouteSet);
  const uniqueProviders = getUniqueProviders(targets);

  console.log('\n========================================');
  console.log('  ccasr test runner');
  console.log('========================================');
  console.log(`  Target:     ${baseUrl}`);
  console.log(`  Config:     ${configPath}`);
  console.log(`  Route:      ${activeRouteName}`);
  for (const t of targets) {
    console.log(`    ${t.tier}: ${t.provider} / ${t.model}`);
  }
  console.log(`  Providers:  ${uniqueProviders.join(', ')}`);
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

  // --- Provider tests: one run per unique provider in the route set ---
  for (const providerName of uniqueProviders) {
    const suite = PROVIDER_SUITES[providerName];
    if (!suite) {
      console.log(`SKIP  ${providerName} (no test suite)`);
      continue;
    }

    // Find the first model for this provider from the route targets
    const target = targets.find((t) => t.provider === providerName);
    if (!target) continue;

    const ctx: TestContext = {
      baseUrl,
      provider: providerName,
      model: target.model,
      apiKey: 'test-key',
    };

    let testsToRun = suite.tests;
    if (filterTest) {
      testsToRun = testsToRun.filter(t => t.name === filterTest);
    }
    if (testsToRun.length === 0) continue;

    console.log(`\n--- ${providerName} (${target.model}) ---`);
    const results = await runTests(providerName, testsToRun, ctx);
    printResults(results);
    allResults.push(...results);
  }

  // --- SDK tests: one run per tier in the route set ---
  if (!filterTest || filterTest === 'agent-sdk') {
    for (const target of targets) {
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
        const label = `agent-sdk:${target.tier}`;
        console.log(`\n--- ${label} (${target.provider}/${target.model}) ---`);
        const sdkResults = await runTests(label, sdkTests, sdkCtx);
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
    route: activeRouteName,
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

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
