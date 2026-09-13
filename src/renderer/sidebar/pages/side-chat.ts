/**
 * P1 — Side-chat sidebar page (DSH Better SideBar port).
 * See docs/dsh-plugin-adoption-plan.md §4.2 ("side chat → new").
 *
 * A light secondary chat surface: a quick-prompt input that sends into the
 * active session alongside the main conversation. It renders only the last
 * few exchanges (bounded) so the page stays cheap and never blocks the chat.
 *
 * Dependency-injected for unit tests (fake chat + fake message loader).
 */

import type { AgentEvent } from '../../../agent/types.js';
import type { SidebarContext } from '../types.js';

export interface SideChatPageOptions {
  /** Send a message into the session (default: preload chat bridge). */
  send?: (input: string, sessionId: string) => void;
  /** Load recent messages; default uses the preload getMessages bridge. */
  loadMessages?: (sessionId: string, limit: number) => Promise<Array<{ role: string; content: string }>>;
  getUiLang?: () => string;
}

function defaultSend(input: string, sessionId: string): void {
  void window.nexusDesktop.chat(input, { sessionId: sessionId || undefined });
}

async function defaultLoadMessages(
  sessionId: string,
  limit: number,
): Promise<Array<{ role: string; content: string }>> {
  try {
    const res = await window.nexusDesktop.getMessages(sessionId, { last: limit });
    const rows = (res as { items?: Array<{ role?: string; content?: string }> })?.items ?? [];
    return rows.map((r) => ({ role: r.role ?? 'user', content: typeof r.content === 'string' ? r.content : '' }));
  } catch {
    return [];
  }
}

/**
 * Mount the side-chat page into `container`. Returns a dispose function that
 * unsubscribes from the event bus and removes every DOM node created here.
 */
export function mountSideChatPage(
  container: HTMLElement,
  ctx: SidebarContext,
  opts: SideChatPageOptions = {},
): () => void {
  const send = opts.send ?? defaultSend;
  const loadMessages = opts.loadMessages ?? defaultLoadMessages;
  const getUiLang = opts.getUiLang ?? (() => 'zh-CN');

  container.classList.add('sidechat-page');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'sidechat-root';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'sidechat-header';
  header.innerHTML = `
    <span class="sidechat-title">${getUiLang() === 'zh-CN' ? '💬 旁路聊天' : '💬 Side Chat'}</span>
    <span class="sidechat-legend">${getUiLang() === 'zh-CN' ? '快速提问，不打断主对话' : 'quick prompts, main chat untouched'}</span>
  `;
  root.appendChild(header);

  const history = document.createElement('div');
  history.className = 'sidechat-history';
  history.dataset.testid = 'sidechat-history';
  root.appendChild(history);

  const inputRow = document.createElement('div');
  inputRow.className = 'sidechat-input-row';
  root.appendChild(inputRow);

  const input = document.createElement('input');
  input.className = 'sidechat-input';
  input.placeholder = getUiLang() === 'zh-CN' ? '输入快捷提问并回车…' : 'type a quick prompt and press Enter…';
  input.spellcheck = false;
  inputRow.appendChild(input);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'sidechat-send';
  sendBtn.textContent = getUiLang() === 'zh-CN' ? '发送' : 'Send';
  inputRow.appendChild(sendBtn);

  const MAX_HISTORY = 100;
  let items: Array<{ role: string; content: string }> = [];

  const render = (): void => {
    history.replaceChildren();
    for (const item of items.slice(-MAX_HISTORY)) {
      const row = document.createElement('div');
      row.className = 'sidechat-msg ' + (item.role === 'user' ? 'user' : 'agent');
      row.textContent = item.content.length > 160 ? item.content.slice(0, 160) + '…' : item.content;
      history.appendChild(row);
    }
    history.scrollTop = history.scrollHeight;
  };

  const submit = (): void => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    items.push({ role: 'user', content: text });
    render();
    try {
      send(text, ctx.sessionId);
    } catch {
      // Send failures never break the side-chat page.
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  sendBtn.addEventListener('click', submit);

  const unsubscribe = ctx.subscribe((event: AgentEvent) => {
    // Reflect assistant turns arriving for this session.
    if (event.sessionId && event.sessionId !== ctx.sessionId && ctx.sessionId) return;
    if (event.type === 'text' && typeof event.text === 'string') {
      items.push({ role: 'agent', content: event.text });
      render();
    }
  });

  void loadMessages(ctx.sessionId, 20).then((rows) => {
    items = [...rows, ...items].slice(-MAX_HISTORY);
    render();
  });

  render();

  return () => {
    unsubscribe();
    container.classList.remove('sidechat-page');
    container.innerHTML = '';
  };
}

/** Assistant binding: constructs the page with the real IPC bridges. */
export const SideChatPage = {
  id: 'side-chat',
  title: 'Side Chat',
  icon: '💬',
  mount: mountSideChatPage,
} as const;