// Interactive setup wizard — creates ~/.ccasr/config.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { CONFIG_DIR, CONFIG_FILE } from '../core/services/config';
import { SUPPORTED_PROVIDERS, type SupportedProvider } from '../core/types';
import { PROVIDER_DEFAULTS } from './constants';
import { selectOne, selectMany, promptInput } from './menu';

interface KnownModels {
  [provider: string]: string[];
}

function loadKnownModels(): KnownModels {
  // Resolve known_models.json relative to this file's compiled location
  // In dev (tsx): src/cli/setup.ts -> ../../known_models.json
  // In dist: dist/cli/setup.js -> ../../known_models.json
  const candidates = [
    join(__dirname, '..', '..', 'known_models.json'),
    join(process.cwd(), 'known_models.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf-8'));
    }
  }
  console.warn('  Warning: known_models.json not found, using empty model list');
  return {};
}

function buildModelOptions(providers: SupportedProvider[], models: KnownModels): string[] {
  const options: string[] = [];
  for (const p of providers) {
    const providerModels = models[p] || [];
    for (const m of providerModels) {
      options.push(`${p} / ${m}`);
    }
  }
  return options;
}

function parseModelOption(option: string): { provider: string; model: string } {
  const slashIdx = option.indexOf(' / ');
  return {
    provider: option.substring(0, slashIdx),
    model: option.substring(slashIdx + 3),
  };
}

export async function runSetup(): Promise<void> {
  console.log('\n  ccasr setup — configure your proxy\n');

  // 1. Check existing config
  if (existsSync(CONFIG_FILE)) {
    const overwriteOptions = ['No — keep existing config', 'Yes — overwrite'];
    const idx = await selectOne(overwriteOptions, 'Config already exists. Overwrite?');
    if (idx === 0) {
      console.log('  Setup cancelled.\n');
      return;
    }
  }

  const knownModels = loadKnownModels();

  // 2. Select providers
  const providerLabels = SUPPORTED_PROVIDERS.map(
    (p) => PROVIDER_DEFAULTS[p].label
  );
  console.log('');
  const providerSelected = await selectMany(
    providerLabels,
    'Select providers (space to toggle, enter to confirm):'
  );

  const selectedProviders = SUPPORTED_PROVIDERS.filter((_, i) => providerSelected[i]);

  if (selectedProviders.length === 0) {
    console.log('  No providers selected. At least one is required.\n');
    process.exit(1);
  }

  // 3. API keys per provider
  const providerConfigs: Array<{
    name: SupportedProvider;
    api_base_url: string;
    api_key: string;
    models?: string[];
  }> = [];

  for (const name of selectedProviders) {
    const defaults = PROVIDER_DEFAULTS[name];
    const models = knownModels[name];

    if (!defaults.envVar) {
      // Ollama — no key needed
      providerConfigs.push({
        name,
        api_base_url: defaults.baseUrl,
        api_key: 'ollama',
        ...(models?.length ? { models } : {}),
      });
      continue;
    }

    console.log('');
    const keyOptions = [
      `Use env var $${defaults.envVar} (Recommended)`,
      'Paste API key directly',
    ];
    const keyChoice = await selectOne(keyOptions, `${defaults.label} — API key:`);

    let apiKey: string;
    if (keyChoice === 0) {
      apiKey = `$${defaults.envVar}`;
    } else {
      console.log('  Warning: key will be stored in plaintext in config file.');
      apiKey = await promptInput('API key');
      if (!apiKey) {
        console.log('  Skipping — no key provided.');
        continue;
      }
    }

    providerConfigs.push({
      name,
      api_base_url: defaults.baseUrl,
      api_key: apiKey,
      ...(models?.length ? { models } : {}),
    });
  }

  if (providerConfigs.length === 0) {
    console.log('  No providers configured. Aborting.\n');
    process.exit(1);
  }

  const configuredNames = providerConfigs.map((p) => p.name);

  // 4-6. Router tiers
  const modelOptions = buildModelOptions(configuredNames, knownModels);
  const customEntry = '[custom entry]';

  // Sonnet tier (required)
  console.log('');
  const sonnetIdx = await selectOne(
    [...modelOptions, customEntry],
    'Router — sonnet tier (main model, required):'
  );
  let sonnetEntry: string;
  if (sonnetIdx === modelOptions.length) {
    const custom = await promptInput('Custom entry (provider,model)');
    sonnetEntry = custom;
  } else {
    const parsed = parseModelOption(modelOptions[sonnetIdx]);
    sonnetEntry = `${parsed.provider},${parsed.model}`;
  }

  // Opus tier (optional)
  console.log('');
  const opusOptions = ['[skip]', ...modelOptions, customEntry];
  const opusIdx = await selectOne(opusOptions, 'Router — opus tier (optional):');
  let opusEntry: string | undefined;
  if (opusIdx === 0) {
    opusEntry = undefined;
  } else if (opusIdx === opusOptions.length - 1) {
    const custom = await promptInput('Custom entry (provider,model)');
    opusEntry = custom || undefined;
  } else {
    const parsed = parseModelOption(opusOptions[opusIdx]);
    opusEntry = `${parsed.provider},${parsed.model}`;
  }

  // Haiku tier (optional)
  console.log('');
  const haikuOptions = ['[skip]', ...modelOptions, customEntry];
  const haikuIdx = await selectOne(haikuOptions, 'Router — haiku tier (optional):');
  let haikuEntry: string | undefined;
  if (haikuIdx === 0) {
    haikuEntry = undefined;
  } else if (haikuIdx === haikuOptions.length - 1) {
    const custom = await promptInput('Custom entry (provider,model)');
    haikuEntry = custom || undefined;
  } else {
    const parsed = parseModelOption(haikuOptions[haikuIdx]);
    haikuEntry = `${parsed.provider},${parsed.model}`;
  }

  // 7. Port
  console.log('');
  const portStr = await promptInput('Port', '3456');
  const port = parseInt(portStr, 10) || 3456;

  // 8. Write config
  const config: Record<string, any> = {
    LOG: false,
    API_TIMEOUT_MS: 300000,
    PORT: port,
    Providers: providerConfigs,
    Router: {
      sonnet: sonnetEntry,
      ...(opusEntry ? { opus: opusEntry } : {}),
      ...(haikuEntry ? { haiku: haikuEntry } : {}),
    },
  };

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  console.log(`\n  Config written to ${CONFIG_FILE}`);

  // Validate by loading it (catches bad env var references etc.)
  try {
    // Lazy import to avoid circular deps
    const { ConfigService } = await import('../core/services/config');
    new ConfigService();
    console.log('  Config validated successfully.');
  } catch (err: any) {
    console.log(`  Warning: config validation failed — ${err.message}`);
    console.log('  The config file was written but may need manual fixes.');
  }

  // 9. Print next steps
  console.log(`
  Next steps:

    ccasr start          Start the proxy server
    ccasr run claude     Start proxy + launch Claude Code

  Or set env vars manually:

    export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}
    export ANTHROPIC_API_KEY=ccasr-proxy
`);
}
