import { createInterface } from 'readline';
import { ConfigManager } from '../config/index.js';
import { ThemeManager } from '../theme/manager.js';
import { setCurrentLang } from '../i18n/index.js';
import {
  OPENCODE_ZEN_AUTH_URL,
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_DOCS_URL,
  OPENCODE_ZEN_ENV_VARS,
  OPENCODE_ZEN_MODELS,
  OPENCODE_ZEN_PROVIDER_NAME,
  buildOpencodeZenProviderConfig,
  findModel,
  getDefaultModelId,
} from '../config/opencode-zen.js';
import { openBrowser } from '../util/open-browser.js';

const _theme = new ThemeManager();
const t = _theme.token;

interface LoginOpts {
  key?: string;
  model?: string;
  use?: boolean;
  noBrowser?: boolean;
}

interface UseOpts {
  switch?: boolean;
}

/**
 * Prompt the user for a value on stdin. Echoes nothing for sensitive values.
 * Note: Node's `readline` does not support true silent input cross-platform
 * (TTY raw mode is the only reliable approach). When `silent: true`, we still
 * accept input from stdin but disconnect the writable side from the local
 * terminal by piping output to `/dev/null` on POSIX and `NUL` on Windows —
 * the caller can additionally `--key` to skip any echo.
 */
function prompt(question: string, _opts: { silent?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdout.isTTY === true,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Basic sanity check on the key shape. Zen keys are `sk-...` prefixed. */
function looksLikeApiKey(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]{8,}$/.test(key);
}

function describeSource(configKey: string, envVars: readonly string[]): string {
  if (!configKey) {
    for (const v of envVars) {
      if (process.env[v]) return t.success('env: ' + v);
    }
    return t.warning('not configured');
  }
  if (configKey.startsWith('$') || configKey.startsWith('env:')) {
    return t.textDim('env ref: ' + configKey);
  }
  if (configKey.startsWith('enc:') || configKey.startsWith('mem:')) {
    return t.success('encrypted local key');
  }
  return t.warning('plaintext key in config.json');
}

export function renderOpencodeZenStatus(cfg: ReturnType<ConfigManager['get']>): string {
  const provider = cfg.providers[OPENCODE_ZEN_PROVIDER_NAME];
  if (!provider) {
    return t.textDim('  Not configured. Run `nexus config opencode-zen login` to set up.');
  }
  const active = cfg.activeProvider === OPENCODE_ZEN_PROVIDER_NAME ? t.success('★ active') : t.textDim('  not active');
  const keyStatus = describeSource(provider.apiKey, OPENCODE_ZEN_ENV_VARS);
  const baseUrl = provider.baseUrl ?? '(default: ' + OPENCODE_ZEN_BASE_URL + ')';
  const modelInfo = findModel(provider.model);
  const modelNote = modelInfo ? t.textDim(' (' + modelInfo.label + ')') : '';
  return [
    active,
    `  Provider: ${OPENCODE_ZEN_PROVIDER_NAME}`,
    `  Model:    ${provider.model}${modelNote}`,
    `  Endpoint: ${baseUrl}`,
    `  API key:  ${keyStatus}`,
  ].join('\n');
}

function resolveProvider(cfg: ReturnType<ConfigManager['get']>): {
  exists: boolean;
  provider: ReturnType<ConfigManager['get']>['providers'][string] | undefined;
} {
  const p = cfg.providers[OPENCODE_ZEN_PROVIDER_NAME];
  return { exists: !!p, provider: p };
}

async function cmdLogin(opts: LoginOpts): Promise<void> {
  const config = new ConfigManager();

  console.log('');
  console.log(t.heading('OpenCode Zen — Authentication'));
  console.log('');
  console.log('  OpenCode Zen is an Anthropic-compatible model gateway curated by the');
  console.log('  OpenCode team. Nexus will store your API key encrypted at rest and route');
  console.log('  chat requests through it as a regular Anthropic-compatible provider.');
  console.log('');

  const opened = !opts.noBrowser ? await openBrowser(OPENCODE_ZEN_AUTH_URL) : false;
  if (opened) {
    console.log(t.success('Opened ' + OPENCODE_ZEN_AUTH_URL + ' in your browser.'));
    console.log(t.textDim('  1. Sign in (or sign up)'));
    console.log(t.textDim('  2. Add billing details'));
    console.log(t.textDim('  3. Copy the API key (starts with sk-)'));
    console.log(t.textDim('  Docs: ' + OPENCODE_ZEN_DOCS_URL));
  } else {
    if (opts.noBrowser) {
      console.log(t.textDim('Browser open skipped (--no-browser).'));
    } else {
      console.log(t.warning('Could not open a browser. Open this URL manually:'));
    }
    console.log('  ' + t.entityName(OPENCODE_ZEN_AUTH_URL));
  }
  console.log('');

  let key = (opts.key ?? '').trim();
  if (key) {
    console.log(t.textDim('  Using API key from --key flag.'));
    if (!looksLikeApiKey(key)) {
      console.log(t.warning('  Key does not look like a typical OpenCode/Zen key (expected sk-...).'));
      console.log(t.textDim('  Continuing anyway — please double-check before saving.'));
    }
  } else {
    const ans = await prompt('Paste your OpenCode Zen API key (input hidden): ', { silent: true });
    key = ans.trim();
    if (!key) {
      console.log(t.error('No key provided. Aborting.'));
      return;
    }
    if (!looksLikeApiKey(key)) {
      const confirm = await prompt('Key does not start with "sk-". Continue? [y/N] ');
      if (confirm.toLowerCase() !== 'y') {
        console.log(t.textDim('Cancelled.'));
        return;
      }
    }
  }

  const model = opts.model ?? getDefaultModelId();
  config.setProvider(OPENCODE_ZEN_PROVIDER_NAME, buildOpencodeZenProviderConfig({ apiKey: key, model }));
  setCurrentLang(config.getLanguage() as 'en' | 'zh-CN');

  console.log('');
  console.log(t.success(`Saved OpenCode Zen provider.`));
  console.log(t.textDim(`  Provider name: ${OPENCODE_ZEN_PROVIDER_NAME}`));
  console.log(t.textDim(`  Endpoint:      ${OPENCODE_ZEN_BASE_URL}`));
  console.log(t.textDim(`  Model:         ${model}`));

  if (opts.use) {
    config.setActiveProvider(OPENCODE_ZEN_PROVIDER_NAME);
    console.log(t.success(`Active provider switched to: ${OPENCODE_ZEN_PROVIDER_NAME}`));
    console.log(t.textDim('  Start a chat with `nexus` to use it.'));
  } else {
    console.log('');
    console.log(t.textDim('  Make it active with: nexus config opencode-zen use'));
    console.log(t.textDim('  Switch the model with: nexus config opencode-zen use <model>'));
  }
}

function cmdStatus(): void {
  const config = new ConfigManager();
  console.log(t.heading('OpenCode Zen:\n'));
  console.log(renderOpencodeZenStatus(config.get()));
  if (process.env[OPENCODE_ZEN_ENV_VARS[0]]) {
    console.log(t.textDim('  Runtime env: ' + OPENCODE_ZEN_ENV_VARS[0] + ' is set and will be used in preference to the stored key.'));
  }
}

function cmdLogout(): void {
  const config = new ConfigManager();
  const { exists, provider } = resolveProvider(config.get());
  if (!exists || !provider) {
    console.log(t.textDim('OpenCode Zen is not configured. Nothing to remove.'));
    return;
  }
  const cfg = config.get();
  delete cfg.providers[OPENCODE_ZEN_PROVIDER_NAME];
  if (cfg.activeProvider === OPENCODE_ZEN_PROVIDER_NAME) {
    const remaining = Object.keys(cfg.providers);
    if (remaining.length > 0) {
      config.setActiveProvider(remaining[0]!);
      console.log(t.textDim('  Active provider reset to: ' + remaining[0]));
    }
  }
  config.save();
  console.log(t.success('Removed OpenCode Zen provider.'));
}

function cmdModels(): void {
  console.log(t.heading('OpenCode Zen models (curated subset):\n'));
  for (const m of OPENCODE_ZEN_MODELS) {
    const tier =
      m.tier === 'free' ? t.success('[free]') :
      m.tier === 'recommended' ? t.success('[recommended]') :
      t.textDim('[paid]');
    console.log(`  ${tier} ${t.entityName(m.id)}`);
    console.log(`    ${t.textDim(m.label)}`);
    if (m.notes) console.log(`    ${t.textDim(m.notes)}`);
  }
  console.log('');
  console.log(t.textDim('Any model exposed by Zen works — pick by id with:'));
  console.log(t.textDim('  nexus config opencode-zen use <model-id>'));
}

function cmdUse(modelId: string | undefined, opts: UseOpts): void {
  const config = new ConfigManager();

  const { exists } = resolveProvider(config.get());
  if (!exists && !modelId) {
    console.log(t.error('OpenCode Zen provider is not configured yet.'));
    console.log(t.textDim('  Run `nexus config opencode-zen login` first.'));
    return;
  }

  if (!modelId) {
    if (opts.switch !== false) {
      config.setActiveProvider(OPENCODE_ZEN_PROVIDER_NAME);
      console.log(t.success(`Active provider switched to: ${OPENCODE_ZEN_PROVIDER_NAME}`));
    }
    return;
  }

  if (!findModel(modelId) && !modelId.includes('/')) {
    console.log(t.warning(`Unknown curated model "${modelId}". `) + '');
    console.log(t.textDim('  You can still use it — Zen exposes additional models beyond the curated list.'));
  }

  if (!exists) {
    const envKey = OPENCODE_ZEN_ENV_VARS.map((v) => process.env[v]).find(Boolean);
    if (!envKey) {
      console.log(t.error('No API key available. Set OPENCODE_API_KEY or OPENCODE_ZEN_API_KEY first, or run `nexus config opencode-zen login`.'));
      return;
    }
    config.setProvider(OPENCODE_ZEN_PROVIDER_NAME, buildOpencodeZenProviderConfig({ apiKey: envKey, model: modelId }));
  } else {
    config.setProviderField(OPENCODE_ZEN_PROVIDER_NAME, 'model', modelId);
  }

  if (opts.switch !== false) {
    config.setActiveProvider(OPENCODE_ZEN_PROVIDER_NAME);
    console.log(t.success(`Switched to ${OPENCODE_ZEN_PROVIDER_NAME} / ${modelId}`));
  } else {
    console.log(t.success(`Set model to ${modelId} on ${OPENCODE_ZEN_PROVIDER_NAME}`));
  }
}

export function registerOpencodeZenCommand(program: import('commander').Command): void {
  const cmd = program
    .command('opencode-zen')
    .description('Authenticate and switch to OpenCode Zen (Anthropic-compatible gateway)')
    .addHelpText('after', `
Examples:
  # Interactive login — opens browser and saves encrypted key
  nexus config opencode-zen login

  # Login non-interactively (for CI / scripts). Prints the auth URL.
  nexus config opencode-zen login --key sk-... --use

  # Show current state + API key source
  nexus config opencode-zen status

  # Activate Zen
  nexus config opencode-zen use

  # Switch to a specific model (and activate)
  nexus config opencode-zen use claude-sonnet-4-6
  nexus config opencode-zen use big-pickle

  # Just change the model, keep current provider
  nexus config opencode-zen use claude-opus-4-6 --no-switch

  # List curated models
  nexus config opencode-zen models

  # Remove the stored key
  nexus config opencode-zen logout
`);

  cmd
    .command('login')
    .description('Open the auth page, save an encrypted API key, and optionally activate Zen')
    .option('-k, --key <key>', 'API key (sk-...). Skips the interactive prompt.')
    .option('-m, --model <model>', `Model to set (default: ${getDefaultModelId()})`)
    .option('--use', 'Switch the active provider to opencode-zen after login')
    .option('--no-browser', 'Do not try to open the browser; print the URL instead')
    .action(async (options: LoginOpts) => {
      await cmdLogin(options);
    });

  cmd
    .command('status')
    .description('Show whether OpenCode Zen is configured and where the key comes from')
    .action(() => cmdStatus());

  cmd
    .command('logout')
    .description('Remove the OpenCode Zen provider entry from config')
    .action(() => cmdLogout());

  cmd
    .command('models')
    .description('List the curated OpenCode Zen models')
    .action(() => cmdModels());

  cmd
    .command('use [model]')
    .description('Make opencode-zen the active provider; optionally change the model')
    .option('--no-switch', 'Only update the model; do not change the active provider')
    .action((model: string | undefined, options: UseOpts) => cmdUse(model, options));
}
