// CDP: test the real user flow by clicking a sidebar session row
// (triggers the full renderer openTab/switchTab path, not just IPC).
// Then click a file row in FileBrowser and verify [preview] logs appear.
const http = require('http');
const fs = require('fs');
const path = require('path');

const CWD = 'D:\\agent-cli\\nexus-desktop';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await fetchJson('http://127.0.0.1:9222/json');
  const app = targets.find((t) => t.url.includes('index.html'));
  if (!app) { console.error('No index.html target'); process.exit(1); }

  const ws = new WebSocket(app.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const consoleLogs = [];

  ws.onmessage = (ev) => {
    const raw = typeof ev === 'string' ? ev : ev.data;
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => (typeof a.value === 'string' ? a.value : a.description || '')).join(' ');
      consoleLogs.push(`[${msg.params.type}] ${text}`);
      if (text.includes('[preview]')) console.log('CONSOLE [preview]:', text.slice(0, 400));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleLogs.push(`[EXCEPTION] ${d.exception?.description || d.text}`);
      console.log('EXCEPTION:', (d.exception?.description || d.text || '').slice(0, 400));
    }
  };

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result && res.result.exceptionDetails) console.log('EVAL EXC:', JSON.stringify(res.result.exceptionDetails).slice(0, 600));
    return res.result && res.result.result ? res.result.result.value : undefined;
  };

  ws.onopen = async () => {
    try {
      await send('Runtime.enable');
      await send('Page.enable');

      // ── Step 1: Check sidebar session list ────────────────────────────────
      const sidebar = await evaluate(`({
        sessionRows: document.querySelectorAll('#session-list li').length,
        sessionNames: [...document.querySelectorAll('#session-list li .session-name')].map(el => el.textContent),
        activeSession: document.querySelector('#session-list li.active')?.querySelector('.session-name')?.textContent || null,
      })`);
      console.log('Sidebar:', JSON.stringify(sidebar, null, 2));

      // ── Step 2: Click the active session row (or first one) to trigger switchTab ─
      // Clicking a session name in the sidebar calls openTab -> switchTab ->
      // notifyActiveSessionChanged -> session_changed -> FileBrowser refresh.
      const clicked = await evaluate(`(async () => {
        const rows = [...document.querySelectorAll('#session-list li')];
        if (rows.length === 0) return { error: 'no session rows in sidebar' };
        // Prefer "APEC-III" (has known previewable files); fall back to active or first.
        let target;
        const apec = rows.find(r => r.querySelector('.session-name')?.textContent?.includes('APEC'));
        if (apec) target = apec.querySelector('.session-name');
        if (!target) target = document.querySelector('#session-list li.active .session-name')
          || document.querySelector('#session-list li .session-name');
        target.click();
        // switchTab is async; wait for FileBrowser to refresh.
        await new Promise(r => setTimeout(r, 5000));
        return {
          clicked: target.textContent,
          fileRows: document.querySelectorAll('#file-browser .filebrowser-row.fb-file').length,
          dirRows: document.querySelectorAll('#file-browser .filebrowser-row.fb-directory').length,
          empty: (document.querySelector('#file-browser .filebrowser-empty')||{}).textContent || null,
        };
      })()`);
      console.log('After session click:', JSON.stringify(clicked, null, 2));

      if (clicked.error || (clicked.fileRows === 0 && clicked.dirRows === 0)) {
        // Try expanding a directory if dirs are visible
        if (clicked.dirRows > 0) {
          console.log('Expanding first directory…');
          await evaluate(`document.querySelector('#file-browser .filebrowser-row.fb-directory')?.click()`);
          await new Promise(r => setTimeout(r, 3000));
          const re = await evaluate(`({
            fileRows: document.querySelectorAll('#file-browser .filebrowser-row.fb-file').length,
          })`);
          console.log('After dir expand:', JSON.stringify(re));
          clicked.fileRows = re.fileRows;
        }
        if (!clicked.fileRows || clicked.fileRows === 0) {
          console.log('No file rows to click. Cannot test preview flow.');
          const shot = await send('Page.captureScreenshot', { format: 'png' });
          if (shot.result?.data) fs.writeFileSync(path.join(CWD, 'cdp-final.png'), Buffer.from(shot.result.data, 'base64'));
          ws.close();
          return;
        }
      }

      // ── Step 3: Get the file paths and pick a previewable one ─────────────
      const filePaths = await evaluate(`[...document.querySelectorAll('#file-browser .filebrowser-row.fb-file')].map(el => el.dataset.path)`);
      console.log('File rows:', filePaths.length, filePaths.slice(0, 10));

      const preferred = filePaths.find((p) => /\.(html|htm|md|txt|json|csv|png|jpg|jpeg|gif|webp|pdf)$/i.test(p)) || filePaths[0];
      if (!preferred) { console.log('No files available.'); ws.close(); return; }
      console.log('Clicking file:', preferred);

      // ── Step 4: Click the file row ────────────────────────────────────────
      const click = await evaluate(`(async () => {
        const row = [...document.querySelectorAll('#file-browser .filebrowser-row.fb-file')]
          .find(el => el.dataset.path === ${JSON.stringify(preferred)});
        if (!row) return { error: 'row not found' };
        row.click();
        // openPath is async: awaits close() + IPC + render. Give it 3s.
        await new Promise(r => setTimeout(r, 3500));
        const section = document.getElementById('preview-section');
        const host = document.getElementById('preview-host');
        const overlay = document.getElementById('preview-overlay-root');
        const btn = document.getElementById('btn-preview');
        return {
          clicked: ${JSON.stringify(preferred)},
          sectionExists: !!section,
          sectionHidden: section ? section.classList.contains('hidden') : null,
          sectionClasses: section ? section.className : null,
          hostExists: !!host,
          hostChildCount: host ? host.children.length : null,
          hostInner: host ? host.innerHTML.slice(0, 800) : null,
          overlayExists: !!overlay,
          overlayClasses: overlay ? overlay.className : null,
          overlayInBody: overlay ? document.body.contains(overlay) : null,
          btnPreview: btn ? {
            active: btn.classList.contains('active'),
            title: btn.title,
          } : null,
        };
      })()`);
      console.log('\nClick result:', JSON.stringify(click, null, 2));

      // ── Step 5: Screenshot + logs ─────────────────────────────────────────
      await new Promise(r => setTimeout(r, 500));
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot.result?.data) fs.writeFileSync(path.join(CWD, 'cdp-final.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('Screenshot: cdp-final.png');

      console.log('\n=== [preview] logs ===');
      const pLogs = consoleLogs.filter((l) => l.includes('[preview]'));
      pLogs.forEach((l) => console.log(l.slice(0, 400)));
      if (!pLogs.length) console.log('(none — previewPath was never called or openPath never ran)');

      console.log('\n=== Exceptions ===');
      const exLogs = consoleLogs.filter((l) => l.includes('EXCEPTION'));
      exLogs.forEach((l) => console.log(l.slice(0, 400)));
      if (!exLogs.length) console.log('(none)');

      ws.close();
    } catch (err) {
      console.error('CDP error:', err);
      ws.close();
    }
  };

  ws.onerror = () => console.error('WebSocket error');
}

main().catch((err) => { console.error(err); process.exit(1); });
