import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { ConfigManager } from './index.js';
import { NativeManager } from './native.js';
import { ConfigSchema, ProviderConfigSchema, ServerConfigSchema, VisionProviderConfigSchema, AcpConfigSchema } from './types.js';

interface SchemaField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'password' | 'select' | 'array' | 'object';
  description?: string;
  required?: boolean;
  enumValues?: string[];
  fields?: SchemaField[];
  itemType?: SchemaField;
}

interface SchemaCategory {
  id: string;
  label: string;
  fields: SchemaField[];
  dynamic?: boolean;
}

const CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || '~', '.nexus');

function buildSchema(): SchemaCategory[] {
  return [
    {
      id: 'general',
      label: 'General',
      fields: [
        { key: 'language', label: 'Language', type: 'select', enumValues: ['en', 'zh-CN'] },
        { key: 'promptName', label: 'Prompt Name', type: 'string' },
        { key: 'activeProvider', label: 'Active Provider', type: 'select', enumValues: [] },
        { key: 'visionMode', label: 'Vision Mode', type: 'select', enumValues: ['local-first', 'cloud-first', 'local-only', 'cloud-only'] },
        { key: 'activeVisionProvider', label: 'Active Vision Provider', type: 'select', enumValues: [] },
        { key: 'qualityGate.autoTest', label: 'Quality Gate: Auto-Test', type: 'boolean' },
        { key: 'qualityGate.autoCommit', label: 'Quality Gate: Auto-Commit', type: 'boolean' },
      ],
    },
    {
      id: 'providers',
      label: 'LLM Providers',
      dynamic: true,
      fields: [
        { key: 'name', label: 'Name', type: 'string' },
        { key: 'type', label: 'Type', type: 'select', enumValues: ['anthropic', 'openai', 'custom'] },
        { key: 'apiKey', label: 'API Key', type: 'password' },
        { key: 'baseUrl', label: 'Base URL', type: 'string' },
        { key: 'model', label: 'Model', type: 'string' },
        { key: 'maxContextTokens', label: 'Max Context Tokens', type: 'number' },
      ],
    },
    {
      id: 'vision',
      label: 'Vision Providers',
      dynamic: true,
      fields: [
        { key: 'name', label: 'Name', type: 'string' },
        { key: 'apiKey', label: 'API Key', type: 'password' },
        { key: 'baseUrl', label: 'Base URL', type: 'string' },
        { key: 'model', label: 'Model', type: 'string' },
      ],
    },
    {
      id: 'mcp',
      label: 'MCP Servers',
      dynamic: true,
      fields: [
        { key: 'name', label: 'Name', type: 'string' },
        { key: 'command', label: 'Command', type: 'string' },
        { key: 'args', label: 'Arguments', type: 'string' },
        { key: 'autoStart', label: 'Auto Start', type: 'boolean' },
      ],
    },
    {
      id: 'acp',
      label: 'ACP',
      fields: [
        { key: 'acp.enabled', label: 'Enabled', type: 'boolean' },
        { key: 'acp.port', label: 'Port', type: 'number' },
        { key: 'acp.skillsPath', label: 'Skills Path', type: 'string' },
        { key: 'acp.agents', label: 'Agents', type: 'object' },
      ],
    },
    {
      id: 'native',
      label: 'Native Packages',
      fields: [
        { key: 'nativeInstalled', label: 'Installed Packages', type: 'array', itemType: { key: 'item', label: 'Package', type: 'string' } },
      ],
    },
    {
      id: 'permissions',
      label: 'Permissions',
      fields: [
        { key: 'permissions.mode', label: 'Mode', type: 'select', enumValues: ['prompt', 'auto'], description: 'prompt = ask before each tool; auto = honor the whitelist' },
        { key: 'permissions.allowlist', label: 'Tool Allowlist', type: 'array', itemType: { key: 'item', label: 'Tool', type: 'string' }, description: 'Tools auto-approved in auto mode (e.g. edit_file, write_file)' },
        { key: 'permissions.safePaths', label: 'Exec Safe Paths', type: 'array', itemType: { key: 'item', label: 'Path', type: 'string' }, description: 'Directories where exec_command is auto-approved (e.g. ~/.nexus/tasks, .)' },
        { key: 'permissions.mcpAllowlist', label: 'MCP Whitelist', type: 'array', itemType: { key: 'item', label: 'Entry', type: 'string' }, description: 'MCP tools auto-approved: "mcp:<server>" or exact tool name. High-risk tools always ask.' },
      ],
    },
  ];
}

function maskKey(key: string): string {
  if (!key || key === '') return '';
  if (key.startsWith('$') || key.startsWith('env:')) return key;
  if (key.length <= 8) return '••••' + key.slice(-4);
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

function sanitizeConfigForDisplay(cfg: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  const providers = copy.providers as Record<string, Record<string, unknown>> | undefined;
  if (providers) {
    for (const key of Object.keys(providers)) {
      if (providers[key]?.apiKey) providers[key].apiKey = maskKey(String(providers[key].apiKey));
    }
  }
  const visionProviders = copy.visionProviders as Record<string, Record<string, unknown>> | undefined;
  if (visionProviders) {
    for (const key of Object.keys(visionProviders)) {
      if (visionProviders[key]?.apiKey) visionProviders[key].apiKey = maskKey(String(visionProviders[key].apiKey));
    }
  }
  return copy;
}

// A random token is required to access the config API. It is generated per
// server start and printed to stderr; the SPA reads it from a bootstrap
// endpoint. This prevents arbitrary local pages (DNS-rebinding / localhost
// attacks) from reading or writing API keys and MCP config.
const API_TOKEN = randomBytes(24).toString('hex');

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': LOCAL_ORIGIN || 'null',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer',
    'Access-Control-Allow-Origin': LOCAL_ORIGIN || 'null',
  });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

// The single allowed web origin is the SPA served by THIS server (same host:port).
// We never echo a foreign origin, and we never use credentials, so a malicious
// localhost page cannot make credentialed cross-origin calls.
let LOCAL_ORIGIN: string | null = null;

/** Validate the Authorization: Bearer <token> header on an API request. */
function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers['authorization'] || '';
  if (typeof header !== 'string') return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  // Constant-time-ish comparison to avoid trivial timing leaks.
  const provided = Buffer.from(match[1]!, 'utf-8');
  const expected = Buffer.from(API_TOKEN, 'utf-8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

function handleApi(req: IncomingMessage, res: ServerResponse, url: string, method: string): void {
  if (!isAuthorized(req)) {
    return unauthorized(res);
  }

  const config = new ConfigManager();

  if (url === '/api/schema' && method === 'GET') {
    const schema = buildSchema();
    const cfg = config.get() as Record<string, unknown>;
    const providerNames = Object.keys((cfg.providers as Record<string, unknown>) || {});
    const visionNames = Object.keys((cfg.visionProviders as Record<string, unknown>) || {});
    for (const cat of schema) {
      if (cat.id === 'general') {
        const ap = cat.fields.find((f) => f.key === 'activeProvider');
        if (ap) ap.enumValues = providerNames;
        const avp = cat.fields.find((f) => f.key === 'activeVisionProvider');
        if (avp) avp.enumValues = visionNames;
      }
    }
    return jsonResponse(res, { categories: schema });
  }

  if (url === '/api/config' && method === 'GET') {
    const cfg = config.get() as Record<string, unknown>;
    return jsonResponse(res, sanitizeConfigForDisplay(cfg));
  }

  if (url === '/api/config' && method === 'PUT') {
    readBody(req).then((body) => {
      try {
        const updates = JSON.parse(body) as Record<string, unknown>;
        const cfg = config.get() as Record<string, unknown>;
        for (const [key, value] of Object.entries(updates)) {
          if (key === 'providers' || key === 'visionProviders' || key === 'mcpServers') continue;
          cfg[key] = value;
        }
        config.save();
        jsonResponse(res, { ok: true });
      } catch (err) {
        jsonResponse(res, { error: String(err) }, 400);
      }
    });
    return;
  }

  if (url === '/api/config/provider' && method === 'POST') {
    readBody(req).then((body) => {
      try {
        const { name, ...providerConfig } = JSON.parse(body) as Record<string, unknown>;
        const raw = providerConfig as { type: string; apiKey: string; model: string; baseUrl?: string };
        config.setProvider(String(name), {
          type: raw.type as 'anthropic' | 'openai' | 'custom',
          apiKey: raw.apiKey,
          model: raw.model,
          baseUrl: raw.baseUrl,
        });
        jsonResponse(res, { ok: true });
      } catch (err) {
        jsonResponse(res, { error: String(err) }, 400);
      }
    });
    return;
  }

  if (url.startsWith('/api/config/provider/') && method === 'DELETE') {
    const name = decodeURIComponent(url.slice('/api/config/provider/'.length));
    try {
      config.removeProvider(name);
      jsonResponse(res, { ok: true });
    } catch (err) {
      jsonResponse(res, { error: String(err) }, 400);
    }
    return;
  }

  if (url === '/api/config/vision-provider' && method === 'POST') {
    readBody(req).then((body) => {
      try {
        const { name, ...vpConfig } = JSON.parse(body) as Record<string, unknown>;
        const vp = vpConfig as { apiKey: string; baseUrl: string; model: string };
        config.setVisionProvider(String(name), vp);
        jsonResponse(res, { ok: true });
      } catch (err) {
        jsonResponse(res, { error: String(err) }, 400);
      }
    });
    return;
  }

  if (url.startsWith('/api/config/vision-provider/') && method === 'DELETE') {
    const name = url.slice('/api/config/vision-provider/'.length);
    config.removeVisionProvider(name);
    jsonResponse(res, { ok: true });
    return;
  }

  if (url === '/api/config/mcp-server' && method === 'POST') {
    readBody(req).then((body) => {
      try {
        const { name, ...srvConfig } = JSON.parse(body) as Record<string, unknown>;
        const srv = srvConfig as { command: string; args?: string[]; autoStart?: boolean };
        config.addMcpServer(String(name), srv);
        jsonResponse(res, { ok: true });
      } catch (err) {
        jsonResponse(res, { error: String(err) }, 400);
      }
    });
    return;
  }

  if (url.startsWith('/api/config/mcp-server/') && method === 'DELETE') {
    const name = url.slice('/api/config/mcp-server/'.length);
    config.removeMcpServer(name);
    jsonResponse(res, { ok: true });
    return;
  }

  if (url === '/api/native/list' && method === 'GET') {
    const native = new NativeManager();
    const available = native.listAvailable();
    const installed = native.listInstalled();
    jsonResponse(res, {
      available: available.map(p => ({ name: p.name, description: p.description, type: p.type, version: p.version })),
      installed: installed.map(p => p.name),
    });
    return;
  }

  if (url.startsWith('/api/native/install/') && method === 'POST') {
    const name = url.slice('/api/native/install/'.length);
    const native = new NativeManager();
    native.install(name).then((msg) => jsonResponse(res, { ok: true, message: msg })).catch((err) => {
      jsonResponse(res, { error: String(err) }, 400);
    });
    return;
  }

  jsonResponse(res, { error: 'Not found' }, 404);
}

// The SPA is served by THIS server only. We embed the per-process access token
// directly into the HTML so the SPA can authenticate without an unauthenticated
// bootstrap endpoint (which previously leaked the token to any localhost origin).
function buildSpaHtml(token: string): string {
  const embedded = JSON.stringify(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nexus Config</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text-dim: #8b949e; --accent: #58a6ff;
    --success: #3fb950; --warn: #d29922; --danger: #f85149;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; }
  nav { width: 220px; background: var(--surface); border-right: 1px solid var(--border); padding: 20px 0; flex-shrink: 0; height: 100vh; position: sticky; top: 0; overflow-y: auto; }
  nav h1 { font-size: 16px; padding: 0 16px 16px; border-bottom: 1px solid var(--border); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  nav h1 span { color: var(--accent); }
  .nav-item { padding: 8px 16px; cursor: pointer; color: var(--text-dim); font-size: 14px; display: flex; align-items: center; gap: 8px; transition: 0.15s; }
  .nav-item:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .nav-item.active { color: var(--accent); background: rgba(88,166,255,0.1); border-right: 2px solid var(--accent); }
  .nav-item .badge { margin-left: auto; background: var(--accent); color: #000; font-size: 11px; padding: 1px 6px; border-radius: 8px; font-weight: 600; }
  main { flex: 1; padding: 24px 32px; max-width: 960px; overflow-y: auto; height: 100vh; }
  h2 { font-size: 20px; margin-bottom: 20px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .card h3 { font-size: 15px; margin-bottom: 12px; color: var(--text); }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .field input, .field select, .field textarea {
    width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font-size: 14px; outline: none; transition: 0.15s;
  }
  .field input:focus, .field select:focus, .field textarea:focus { border-color: var(--accent); }
  .field input[type="checkbox"] { width: auto; }
  .field .checkbox-label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .field .checkbox-label input { width: auto; }
  .field .checkbox-label span { font-size: 14px; text-transform: none; letter-spacing: 0; color: var(--text); }
  .btn { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font-size: 13px; }
  .btn:hover { border-color: var(--accent); }
  .btn-primary { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 500; }
  .btn-primary:hover { opacity: 0.9; }
  .btn-danger { border-color: var(--danger); color: var(--danger); }
  .btn-danger:hover { background: var(--danger); color: #000; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .toast {
    position: fixed; bottom: 20px; right: 20px; padding: 10px 18px; border-radius: 8px;
    font-size: 13px; z-index: 1000; opacity: 0; transform: translateY(10px); transition: 0.3s;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast-success { background: var(--success); color: #000; }
  .toast-error { background: var(--danger); color: #fff; }
  .inline-group { display: flex; gap: 8px; align-items: center; }
  .inline-group input { flex: 1; }
  .array-item { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .array-item input { flex: 1; }
  .empty-state { color: var(--text-dim); font-size: 13px; padding: 16px; text-align: center; }
  .loading { color: var(--text-dim); text-align: center; padding: 40px; }
  @media (max-width: 720px) { body { flex-direction: column; } nav { width: 100%; height: auto; position: static; } main { padding: 16px; } }
</style>
</head>
<body>
<nav id="nav"><h1><span>◆</span> Nexus Config</h1></nav>
<main id="main"><div class="loading">Loading...</div></main>
<div id="toast" class="toast"></div>
<script>
const API = '';
window.__NEXUS_TOKEN__ = ${embedded};
let API_TOKEN = '';
let state = { config: null, schema: null, activeTab: null };

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_TOKEN, ...opts.headers },
    ...opts,
  });
  return res.json();
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.className = 'toast toast-' + type + ' show';
  el.textContent = msg;
  setTimeout(() => el.classList.remove('show'), 2500);
}

async function loadSchema() {
  const data = await api('/api/schema');
  state.schema = data.categories;
  renderNav();
  if (!state.activeTab) switchTab(state.schema[0].id);
}

async function loadConfig() {
  state.config = await api('/api/config');
  if (state.activeTab) renderTab(state.activeTab);
}

function switchTab(id) {
  state.activeTab = id;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === id));
  renderTab(id);
}

function renderNav() {
  const nav = document.getElementById('nav');
  const existing = nav.querySelectorAll('.nav-item');
  existing.forEach(el => el.remove());
  for (const cat of state.schema) {
    const item = document.createElement('div');
    item.className = 'nav-item' + (cat.id === state.activeTab ? ' active' : '');
    item.dataset.tab = cat.id;
    item.textContent = cat.label;
    item.onclick = () => switchTab(cat.id);
    nav.appendChild(item);
  }
}

function renderTab(id) {
  const cat = state.schema.find(c => c.id === id);
  if (!cat) return;
  const main = document.getElementById('main');
  main.innerHTML = '<h2>' + cat.label + '</h2>';

  if (cat.dynamic) {
    renderDynamicCategory(main, cat);
  } else {
    renderStaticCategory(main, cat);
  }
}

function renderDynamicCategory(main, cat) {
  const items = getDynamicItems(cat.id);
  const container = document.createElement('div');

  for (const [name, item] of Object.entries(items)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<h3 style="margin:0">' + esc(name) + '</h3>' +
      '<button class="btn btn-danger btn-sm" onclick="deleteItem(\\'' + cat.id + '\\',\\'' + esc(name) + '\\')">Remove</button></div>';
    const fieldsDiv = document.createElement('div');
    for (const field of cat.fields) {
      if (field.key === 'name') continue;
      const val = item[field.key];
      fieldsDiv.appendChild(renderField(field, val, (v) => {
        item[field.key] = v;
        saveDynamicItem(cat.id, name, item);
      }));
    }
    card.appendChild(fieldsDiv);
    container.appendChild(card);
  }

  // Add new item form
  const addCard = document.createElement('div');
  addCard.className = 'card';
  addCard.innerHTML = '<h3>Add New</h3>';
  const newForm = document.createElement('div');
  const newData = {};
  for (const field of cat.fields) {
    if (field.key === 'name') continue;
    newData[field.key] = field.type === 'boolean' ? false : field.type === 'number' ? 0 : '';
  }
  let newName = '';
  const nameField = renderField({ key: 'name', label: 'Name', type: 'string', required: true }, '', (v) => { newName = v; });
  newForm.appendChild(nameField);
  for (const field of cat.fields) {
    if (field.key === 'name') continue;
    newForm.appendChild(renderField(field, newData[field.key], (v) => { newData[field.key] = v; }));
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = 'Add ' + cat.label.slice(0, -1);
  addBtn.onclick = () => {
    if (!newName) { toast('Name is required', 'error'); return; }
    saveNewDynamicItem(cat.id, newName, newData);
  };
  newForm.appendChild(addBtn);
  addCard.appendChild(newForm);
  container.appendChild(addCard);

  main.appendChild(container);
}

function renderStaticCategory(main, cat) {
  const card = document.createElement('div');
  card.className = 'card';
  const fieldsDiv = document.createElement('div');

  for (const field of cat.fields) {
    const val = getNestedValue(state.config, field.key);
    fieldsDiv.appendChild(renderField(field, val, (v) => {
      setNestedValue(state.config, field.key, v);
      saveConfig();
    }));
  }
  card.appendChild(fieldsDiv);
  main.appendChild(card);
}

function renderField(field, value, onChange) {
  const div = document.createElement('div');
  div.className = 'field';

  if (field.type === 'boolean') {
    div.innerHTML = '<label class="checkbox-label"><input type="checkbox" ' + (value ? 'checked' : '') + '><span>' + field.label + '</span></label>';
    div.querySelector('input').onchange = (e) => onChange(e.target.checked);
    return div;
  }

  const label = document.createElement('label');
  label.textContent = field.label + (field.required ? ' *' : '');
  div.appendChild(label);

  if (field.type === 'select' && field.enumValues) {
    const sel = document.createElement('select');
    for (const opt of field.enumValues) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (opt === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = (e) => onChange(e.target.value);
    div.appendChild(sel);
  } else if (field.type === 'password') {
    const group = document.createElement('div');
    group.className = 'inline-group';
    const inp = document.createElement('input');
    inp.type = 'password';
    inp.value = value || '';
    inp.placeholder = field.label;
    inp.onchange = (e) => onChange(e.target.value);
    const toggle = document.createElement('button');
    toggle.className = 'btn btn-sm';
    toggle.textContent = 'Show';
    toggle.onclick = () => {
      inp.type = inp.type === 'password' ? 'text' : 'password';
      toggle.textContent = inp.type === 'password' ? 'Show' : 'Hide';
    };
    group.appendChild(inp); group.appendChild(toggle);
    div.appendChild(group);
    } else if (field.type === 'object' && field.key === 'acp.agents') {
      const agents = Array.isArray(value) ? value : [];
      const container = document.createElement('div');
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
          '<strong>' + esc(a.name || a.id) + '</strong>' +
          '<button class="btn btn-danger btn-sm" data-idx="' + i + '">Remove</button></div>';
        card.querySelector('button').onclick = () => {
          agents.splice(i, 1);
          onChange([...agents]);
        };
        const rows = [
          { label: 'ID', val: a.id },
          { label: 'Endpoint', val: a.endpoint },
          { label: 'Capabilities', val: Array.isArray(a.capabilities) ? a.capabilities.join(', ') : '' },
        ];
        for (const r of rows) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;margin-bottom:4px;font-size:13px';
          row.innerHTML = '<span style="color:var(--text-dim);width:120px;flex-shrink:0">' + r.label + ':</span>' +
            '<span>' + esc(r.val || '') + '</span>';
          card.appendChild(row);
        }
        container.appendChild(card);
      }
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-primary';
      addBtn.textContent = '+ Add Agent';
      addBtn.style.marginTop = '8px';
      addBtn.onclick = () => {
        const name = prompt('Agent name:');
        if (!name) return;
        const endpoint = prompt('Agent endpoint URL:');
        if (!endpoint) return;
        const caps = prompt('Capabilities (comma-separated, e.g. chat,code):');
        const id = name.toLowerCase().replace(/\s+/g, '-');
        agents.push({
          id,
          name,
          endpoint,
          capabilities: caps ? caps.split(',').map((c) => c.trim()).filter(Boolean) : [],
        });
        onChange([...agents]);
      };
      container.appendChild(addBtn);
      div.appendChild(container);
      return div;
    } else if (field.type === 'object') {
      const ta = document.createElement('textarea');
      ta.rows = 8;
      ta.style.fontFamily = 'monospace';
      ta.style.fontSize = '12px';
      ta.value = value ? JSON.stringify(value, null, 2) : '';
      ta.placeholder = field.label + ' (JSON)';
      ta.onchange = () => {
        try { onChange(JSON.parse(ta.value)); }
        catch { toast('Invalid JSON', 'error'); }
      };
      div.appendChild(ta);
    } else if (field.type === 'number') {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.value = value ?? '';
      inp.placeholder = field.label;
      inp.onchange = (e) => onChange(Number(e.target.value));
      div.appendChild(inp);
  } else if (field.type === 'array' && field.itemType) {
    const arr = Array.isArray(value) ? value : [];
    const list = document.createElement('div');
    function renderArray() {
      list.innerHTML = '';
      for (let i = 0; i < arr.length; i++) {
        const row = document.createElement('div');
        row.className = 'array-item';
        const inp = document.createElement('input');
        inp.value = arr[i]; inp.readOnly = true;
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger btn-sm';
        delBtn.textContent = '×';
        delBtn.onclick = () => { arr.splice(i, 1); renderArray(); onChange([...arr]); };
        row.appendChild(inp); row.appendChild(delBtn);
        list.appendChild(row);
      }
    }
    renderArray();
    div.appendChild(list);
    // Add-new row (editable for permissions-style string arrays)
    const addRow = document.createElement('div');
    addRow.className = 'array-item';
    const newInp = document.createElement('input');
    newInp.placeholder = 'Add entry, then press +';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary btn-sm';
    addBtn.textContent = '+';
    addBtn.onclick = () => {
      const v = newInp.value.trim();
      if (!v) return;
      arr.push(v); newInp.value = '';
      renderArray(); onChange([...arr]);
    };
    newInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.onclick(); });
    addRow.appendChild(newInp); addRow.appendChild(addBtn);
    div.appendChild(addRow);
    if (field.description) {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:6px;line-height:1.5';
      hint.textContent = field.description;
      div.appendChild(hint);
    }
  } else {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = value ?? '';
    inp.placeholder = field.label;
    inp.onchange = (e) => onChange(e.target.value);
    div.appendChild(inp);
  }

  return div;
}

function getDynamicItems(catId) {
  const cfg = state.config || {};
  if (catId === 'providers') return cfg.providers || {};
  if (catId === 'vision') return cfg.visionProviders || {};
  if (catId === 'mcp') return cfg.mcpServers || {};
  return {};
}

function getNestedValue(obj, key) {
  return key.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}

function setNestedValue(obj, key, val) {
  const keys = key.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!o[keys[i]]) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = val;
}

async function saveConfig() {
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({
      language: state.config.language,
      promptName: state.config.promptName,
      activeProvider: state.config.activeProvider,
      visionMode: state.config.visionMode,
      activeVisionProvider: state.config.activeVisionProvider,
      qualityGate: state.config.qualityGate || { autoTest: true, autoCommit: false },
      acp: state.config.acp,
      permissions: state.config.permissions || { mode: 'prompt', allowlist: [], safePaths: [], mcpAllowlist: [] },
    })});
    toast('Saved');
  } catch { toast('Save failed', 'error'); }
}

async function saveDynamicItem(catId, name, data) {
  const map = { providers: 'provider', vision: 'vision-provider', mcp: 'mcp-server' };
  const ep = map[catId];
  if (!ep) return;
  try {
    await api('/api/config/' + ep, { method: 'POST', body: JSON.stringify({ name, ...data }) });
    toast('Saved');
  } catch { toast('Save failed', 'error'); }
}

async function saveNewDynamicItem(catId, name, data) {
  const map = { providers: 'provider', vision: 'vision-provider', mcp: 'mcp-server' };
  const ep = map[catId];
  if (!ep) return;
  try {
    await api('/api/config/' + ep, { method: 'POST', body: JSON.stringify({ name, ...data }) });
    toast('Added');
    await loadConfig();
    renderTab(catId);
  } catch { toast('Add failed', 'error'); }
}

async function deleteItem(catId, name) {
  if (!confirm('Remove "' + name + '"?')) return;
  const map = { providers: 'provider', vision: 'vision-provider', mcp: 'mcp-server' };
  const ep = map[catId];
  if (!ep) return;
  try {
    await api('/api/config/' + ep + '/' + encodeURIComponent(name), { method: 'DELETE' });
    toast('Removed');
    await loadConfig();
    renderTab(catId);
  } catch { toast('Remove failed', 'error'); }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

(async () => {
  try {
    // The access token is embedded into the served HTML by the server, so there
    // is no unauthenticated bootstrap endpoint for foreign pages to call.
    API_TOKEN = window.__NEXUS_TOKEN__ || '';
    state.schema = (await api('/api/schema')).categories;
    state.config = await api('/api/config');
    renderNav();
    switchTab(state.schema[0].id);
    if (state.activeTab) renderTab(state.activeTab);
  } catch (err) {
    document.getElementById('main').innerHTML =
      '<div style="color:var(--danger);padding:40px;text-align:center">' +
      '<h2>Connection Failed</h2>' +
      '<p>Could not connect to the config API. Make sure the server is running.</p>' +
      '<p style="font-size:13px;color:var(--text-dim)">' + err + '</p>' +
      '<button class="btn btn-primary" style="margin-top:16px" onclick="location.reload()">Retry</button>' +
      '</div>';
  }
})();
</script>
</body>
</html>`;
}

export function startWebUi(port = 3457): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url || '/';
      const method = req.method || 'GET';

      if (url.startsWith('/api/')) {
        handleApi(req, res, url, method);
        return;
      }

      // Serve SPA (token embedded so no unauthenticated bootstrap endpoint)
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        });
        res.end(buildSpaHtml(API_TOKEN));
        return;
      }

      // Serve favicon (silent 204)
      if (url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    // Try port, fallback to next available
    function tryListen(p: number) {
      server.listen(p, 'localhost', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : p;
        LOCAL_ORIGIN = `http://localhost:${port}`;
        process.stderr.write(`\n  ◆ Config Web UI: http://localhost:${port}\n  ◆ Access token: ${API_TOKEN}\n  Press Ctrl+C to stop\n\n`);
        resolve({
          port,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          tryListen(p + 1);
        }
      });
    }

    tryListen(port);
  });
}
