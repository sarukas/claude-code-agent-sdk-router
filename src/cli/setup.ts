// Interactive setup wizard — creates/edits ~/.ccasr/config.json
// Menu-driven editor: loads existing config, lets you edit any section,
// explicitly save or discard.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import JSON5 from 'json5';
import { CONFIG_DIR, CONFIG_FILE } from '../core/services/config';
import { SUPPORTED_PROVIDERS, type SupportedProvider } from '../core/types';
import { PROVIDER_DEFAULTS } from './constants';
import { selectOne, selectMany, promptInput } from './menu';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SetupState {
  providers: Array<{
    name: SupportedProvider;
    api_base_url: string;
    api_key: string;
    models?: string[];
  }>;
  router: { sonnet: string; opus?: string; haiku?: string };
  port: number;
  log: boolean;
}

interface KnownModels {
  [provider: string]: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKnownModels(): KnownModels {
  const candidates = [
    join(process.cwd(), 'known_models.json'),
    ...(typeof __dirname !== 'undefined'
      ? [join(__dirname, '..', '..', 'known_models.json')]
      : []),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf-8'));
    }
  }
  console.warn('  Warning: known_models.json not found, using empty model list');
  return {};
}

function maskApiKey(key: string): string {
  if (key.startsWith('$')) return key;
  if (key.length <= 8) return '****';
  return key.substring(0, 2) + '...' + key.substring(key.length - 4);
}

function buildModelOptions(providers: SupportedProvider[], models: KnownModels): string[] {
  const options: string[] = [];
  for (const p of providers) {
    for (const m of models[p] || []) {
      options.push(`${p} / ${m}`);
    }
  }
  return options;
}

function parseModelOption(option: string): { provider: string; model: string } {
  const idx = option.indexOf(' / ');
  return { provider: option.substring(0, idx), model: option.substring(idx + 3) };
}

function formatRouterEntry(entry: string | undefined): string {
  if (!entry) return '(not configured)';
  const comma = entry.indexOf(',');
  if (comma === -1) return entry;
  return `${entry.substring(0, comma)} / ${entry.substring(comma + 1)}`;
}

// ---------------------------------------------------------------------------
// Load existing config into SetupState (preserving raw api_key values)
// ---------------------------------------------------------------------------

function loadExistingConfig(): SetupState | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const raw = JSON5.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    const providers: SetupState['providers'] = [];
    if (Array.isArray(raw.Providers)) {
      for (const p of raw.Providers) {
        if (p.name && (SUPPORTED_PROVIDERS as readonly string[]).includes(p.name)) {
          providers.push({
            name: p.name,
            api_base_url: p.api_base_url || PROVIDER_DEFAULTS[p.name as SupportedProvider].baseUrl,
            api_key: p.api_key || '',
            ...(p.models?.length ? { models: p.models } : {}),
          });
        }
      }
    }
    const router: SetupState['router'] = {
      sonnet: raw.Router?.sonnet || raw.Router?.default || '',
    };
    if (raw.Router?.opus) router.opus = raw.Router.opus;
    if (raw.Router?.haiku) router.haiku = raw.Router.haiku;

    return {
      providers,
      router,
      port: raw.PORT ?? 3456,
      log: raw.LOG ?? false,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config summary display
// ---------------------------------------------------------------------------

function printSummary(state: SetupState): void {
  const providerList = state.providers
    .map((p) => `${PROVIDER_DEFAULTS[p.name].label} (${maskApiKey(p.api_key)})`)
    .join(', ');

  console.log(`
  Current configuration:

    Providers:  ${providerList || '(none)'}
    Sonnet:     ${formatRouterEntry(state.router.sonnet)}
    Opus:       ${formatRouterEntry(state.router.opus)}
    Haiku:      ${formatRouterEntry(state.router.haiku)}
    Port:       ${state.port}
    Logging:    ${state.log ? 'ON — full request/response capture' : 'OFF'}
`);
}

// ---------------------------------------------------------------------------
// Initial wizard (sequential, for first-time setup)
// ---------------------------------------------------------------------------

async function runInitialWizard(knownModels: KnownModels): Promise<SetupState> {
  // 1. Select providers
  const providerLabels = SUPPORTED_PROVIDERS.map((p) => PROVIDER_DEFAULTS[p].label);
  console.log('');
  const providerSelected = await selectMany(
    providerLabels,
    'Which providers would you like to enable? (space to toggle, enter to confirm)'
  );
  const selectedProviders = SUPPORTED_PROVIDERS.filter((_, i) => providerSelected[i]);
  if (selectedProviders.length === 0) {
    console.log('  No providers selected. At least one is required.\n');
    process.exit(1);
  }

  // 2. API keys
  const providers = await collectApiKeys(selectedProviders, knownModels);

  // 3. Router tiers
  const configuredNames = providers.map((p) => p.name);
  const router = await editRouterTiers(configuredNames, knownModels, {
    sonnet: '',
  });

  // 4. Port
  console.log('');
  const portStr = await promptInput('Port (press Enter for default 3456)', '3456');
  const port = parseInt(portStr, 10) || 3456;

  return { providers, router, port, log: false };
}

async function collectApiKeys(
  selectedProviders: SupportedProvider[],
  knownModels: KnownModels,
): Promise<SetupState['providers']> {
  const providers: SetupState['providers'] = [];
  for (const name of selectedProviders) {
    const defaults = PROVIDER_DEFAULTS[name];
    const models = knownModels[name];

    if (!defaults.envVar) {
      // Ollama — no key needed
      providers.push({
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

    providers.push({
      name,
      api_base_url: defaults.baseUrl,
      api_key: apiKey,
      ...(models?.length ? { models } : {}),
    });
  }
  return providers;
}

// ---------------------------------------------------------------------------
// Sub-editors
// ---------------------------------------------------------------------------

async function editProviders(state: SetupState, knownModels: KnownModels): Promise<void> {
  const providerLabels = SUPPORTED_PROVIDERS.map((p) => PROVIDER_DEFAULTS[p].label);
  const currentNames = new Set(state.providers.map((p) => p.name));
  const defaults = SUPPORTED_PROVIDERS.map((_, i) => currentNames.has(SUPPORTED_PROVIDERS[i]));

  console.log('');
  const selected = await selectMany(
    providerLabels,
    'Which providers would you like to enable? (space to toggle, enter to confirm)',
    defaults,
  );

  const newNames = new Set(SUPPORTED_PROVIDERS.filter((_, i) => selected[i]));
  if (newNames.size === 0) {
    console.log('  No providers selected. At least one is required. Keeping current selection.');
    return;
  }

  // Remove deselected providers
  const removed = [...currentNames].filter((n) => !newNames.has(n));
  state.providers = state.providers.filter((p) => newNames.has(p.name));

  // Add newly selected providers with default keys
  for (const name of newNames) {
    if (!currentNames.has(name)) {
      const def = PROVIDER_DEFAULTS[name];
      const models = knownModels[name];
      state.providers.push({
        name,
        api_base_url: def.baseUrl,
        api_key: def.envVar ? `$${def.envVar}` : 'ollama',
        ...(models?.length ? { models } : {}),
      });
    }
  }

  // Clear router tiers that reference removed providers
  for (const name of removed) {
    for (const tier of ['sonnet', 'opus', 'haiku'] as const) {
      const entry = state.router[tier];
      if (entry && entry.startsWith(name + ',')) {
        if (tier === 'sonnet') {
          state.router.sonnet = '';
          console.log(`  Warning: Sonnet tier cleared — it referenced removed provider "${name}".`);
        } else {
          delete state.router[tier];
          console.log(`  Note: ${tier} tier cleared — it referenced removed provider "${name}".`);
        }
      }
    }
  }
}

async function editApiKeys(state: SetupState): Promise<void> {
  for (const provider of state.providers) {
    const defaults = PROVIDER_DEFAULTS[provider.name];
    if (!defaults.envVar) continue; // Ollama

    const masked = maskApiKey(provider.api_key);
    console.log('');
    const options = [
      `Keep current (${masked})`,
      ...(defaults.envVar ? [`Use env var $${defaults.envVar}`] : []),
      'Paste new key',
    ];
    const choice = await selectOne(options, `${defaults.label} — API key:`);

    if (choice === 0) {
      // Keep current
    } else if (choice === 1 && defaults.envVar) {
      provider.api_key = `$${defaults.envVar}`;
    } else {
      console.log('  Warning: key will be stored in plaintext in config file.');
      const key = await promptInput('API key');
      if (key) provider.api_key = key;
    }
  }
}

async function editRouterTiers(
  providerNames: SupportedProvider[],
  knownModels: KnownModels,
  current: SetupState['router'],
): Promise<SetupState['router']> {
  const modelOptions = buildModelOptions(providerNames, knownModels);
  const customEntry = '[custom entry]';

  // Helper to find default index for a tier value
  const findDefault = (value: string | undefined): number => {
    if (!value) return -1;
    const comma = value.indexOf(',');
    if (comma === -1) return -1;
    const formatted = `${value.substring(0, comma)} / ${value.substring(comma + 1)}`;
    return modelOptions.indexOf(formatted);
  };

  // Sonnet (required)
  console.log('');
  const sonnetDefault = Math.max(0, findDefault(current.sonnet));
  const sonnetIdx = await selectOne(
    [...modelOptions, customEntry],
    'Which model for the Sonnet tier? (required)',
    sonnetDefault,
  );
  let sonnetEntry: string;
  if (sonnetIdx === modelOptions.length) {
    sonnetEntry = await promptInput('Custom entry (provider,model)');
  } else {
    const parsed = parseModelOption(modelOptions[sonnetIdx]);
    sonnetEntry = `${parsed.provider},${parsed.model}`;
  }

  // Opus (optional)
  console.log('');
  const opusModelOptions = ['[skip]', ...modelOptions, customEntry];
  const opusDefaultRaw = findDefault(current.opus);
  const opusDefault = opusDefaultRaw >= 0 ? opusDefaultRaw + 1 : 0; // +1 for [skip]
  const opusIdx = await selectOne(
    opusModelOptions,
    'Which model for the Opus tier? (optional, select [skip] to leave unconfigured)',
    opusDefault,
  );
  let opusEntry: string | undefined;
  if (opusIdx === 0) {
    opusEntry = undefined;
  } else if (opusIdx === opusModelOptions.length - 1) {
    const custom = await promptInput('Custom entry (provider,model)');
    opusEntry = custom || undefined;
  } else {
    const parsed = parseModelOption(opusModelOptions[opusIdx]);
    opusEntry = `${parsed.provider},${parsed.model}`;
  }

  // Haiku (optional)
  console.log('');
  const haikuModelOptions = ['[skip]', ...modelOptions, customEntry];
  const haikuDefaultRaw = findDefault(current.haiku);
  const haikuDefault = haikuDefaultRaw >= 0 ? haikuDefaultRaw + 1 : 0;
  const haikuIdx = await selectOne(
    haikuModelOptions,
    'Which model for the Haiku tier? (optional, select [skip] to leave unconfigured)',
    haikuDefault,
  );
  let haikuEntry: string | undefined;
  if (haikuIdx === 0) {
    haikuEntry = undefined;
  } else if (haikuIdx === haikuModelOptions.length - 1) {
    const custom = await promptInput('Custom entry (provider,model)');
    haikuEntry = custom || undefined;
  } else {
    const parsed = parseModelOption(haikuModelOptions[haikuIdx]);
    haikuEntry = `${parsed.provider},${parsed.model}`;
  }

  return {
    sonnet: sonnetEntry,
    ...(opusEntry ? { opus: opusEntry } : {}),
    ...(haikuEntry ? { haiku: haikuEntry } : {}),
  };
}

async function editPort(state: SetupState): Promise<void> {
  console.log('');
  const portStr = await promptInput('Port (press Enter for default 3456)', String(state.port));
  state.port = parseInt(portStr, 10) || 3456;
}

// ---------------------------------------------------------------------------
// Save config
// ---------------------------------------------------------------------------

function saveConfig(state: SetupState): void {
  const config: Record<string, any> = {
    LOG: state.log,
    API_TIMEOUT_MS: 300000,
    PORT: state.port,
    Providers: state.providers,
    Router: {
      sonnet: state.router.sonnet,
      ...(state.router.opus ? { opus: state.router.opus } : {}),
      ...(state.router.haiku ? { haiku: state.router.haiku } : {}),
    },
  };

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`\n  Config written to ${CONFIG_FILE}`);
}

async function validateConfig(): Promise<void> {
  try {
    const { ConfigService } = await import('../core/services/config');
    new ConfigService();
    console.log('  Config validated successfully.');
  } catch (err: any) {
    console.log(`  Warning: config validation failed — ${err.message}`);
    console.log('  The config file was written but may need manual fixes.');
  }
}

function cliPrefix(): string {
  // If running via tsx (dev mode), suggest npx tsx; otherwise ccasr
  const argv1 = process.argv[1] || '';
  if (argv1.includes('tsx') || argv1.endsWith('cli.ts')) {
    return 'npx tsx src/cli.ts';
  }
  return 'ccasr';
}

function printNextSteps(port: number): void {
  const cmd = cliPrefix();
  console.log(`
  Next steps:

    ${cmd} start          Start the proxy server
    ${cmd} run claude     Start proxy + launch Claude Code

  Or set env vars manually:

    export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}
    export ANTHROPIC_API_KEY=ccasr-proxy
`);
}

// ---------------------------------------------------------------------------
// Main menu loop
// ---------------------------------------------------------------------------

const MENU_OPTIONS = [
  'Edit providers',
  'Edit API keys',
  'Edit model routing',
  'Edit port',
  'Toggle detailed logging',
  'Save and exit',
  'Exit without saving',
];

async function mainMenuLoop(state: SetupState, knownModels: KnownModels): Promise<void> {
  while (true) {
    printSummary(state);

    const choice = await selectOne(MENU_OPTIONS, 'Setup menu:');

    switch (choice) {
      case 0: // Edit providers
        await editProviders(state, knownModels);
        break;

      case 1: // Edit API keys
        await editApiKeys(state);
        break;

      case 2: { // Edit model routing
        const providerNames = state.providers.map((p) => p.name);
        state.router = await editRouterTiers(providerNames, knownModels, state.router);
        break;
      }

      case 3: // Edit port
        await editPort(state);
        break;

      case 4: // Toggle detailed logging
        state.log = !state.log;
        console.log(`  Detailed logging ${state.log ? 'enabled' : 'disabled'}.`);
        if (state.log) {
          console.log('  When ON: logs full request/response bodies, outgoing URLs, and headers.');
          console.log('  Logs are written to ~/.ccasr/logs/ccasr.log and console.');
        }
        break;

      case 5: // Save and exit
        if (!state.router.sonnet) {
          console.log('  Cannot save: Sonnet tier (required) is not configured.');
          console.log('  Please configure model routing first.');
          break;
        }
        if (state.providers.length === 0) {
          console.log('  Cannot save: no providers configured.');
          break;
        }
        saveConfig(state);
        await validateConfig();
        printNextSteps(state.port);
        return;

      case 6: // Exit without saving
        console.log('  Exiting without saving.\n');
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSetup(): Promise<void> {
  console.log('\n  ccasr setup — configure your proxy\n');

  const knownModels = loadKnownModels();
  const existing = loadExistingConfig();

  let state: SetupState;

  if (existing && existing.providers.length > 0) {
    console.log(`  Loaded existing config from ${CONFIG_FILE}`);
    state = existing;
  } else {
    state = await runInitialWizard(knownModels);
  }

  await mainMenuLoop(state, knownModels);
}
