/**
 * P1 — Side-chat sidebar page (DSH Better SideBar port).
 * See docs/dsh-plugin-adoption-plan.md §4.2 ("side chat → new").
 *
 * A light secondary chat surface: a quick-prompt input for scratch questions
 * that must NOT disturb the main conversation. Every send goes through the
 * isolated `sideChat` IPC channel — a throwaway AgentService in the (global)
 * worker completes the renderer-held transcript and returns a single reply.
 * Nothing is persisted to the session store and the session's own worker/context
 * is never touched, so side chat stays usable while the main chat is mid-turn.
 *
 * The page holds its own bounded transcript; there is no event-bus mirroring
 * (which previously replayed the main session's streaming chunks as separate
 * "replies") and no load of the main session's later history into this surface.
 *
 * Dependency-injected for unit tests (fake chat sender).
 */

import type { SidebarContext } from '../types.js';

/** A single transcript entry. `pending` = waiting on the worker reply,
 *  `error` = the request failed (content holds the failure hint). */
interface ChatItem {
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
  error?: boolean;
}

export interface SideChatPageOptions {
  /** Send a transcript and resolve with the assistant reply (default: preload
   *  sideChat bridge — isolated, never the session worker). */
  send?: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  getUiLang?: () => string;
}

async function defaultSend(messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await window.nexusDesktop.sideChat(messages);
  return res && typeof res.reply === 'string' ? res.reply : '';
}

/**
 * Mount the side-chat page into `container`. Returns a dispose function that
 * removes every DOM node created here (no event subscriptions to release).
 */
export function mountSideChatPage(
  container: HTMLElement,
  _ctx: SidebarContext,
  opts: SideChatPageOptions = {},
): () => void {
  const send = opts.send ?? defaultSend;
  const getUiLang = opts.getUiLang ?? (() => 'zh-CN');
  const thinkingText = getUiLang() === 'zh-CN' ? '💭 思考中…' : '💭 thinking…';
  const failedText = getUiLang() === 'zh-CN' ? '❌ 请求失败，请重试' : '❌ request failed, try again';

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
  let items: ChatItem[] = [];
  let pending = false;

  const render = (): void => {
    history.replaceChildren();
    for (const item of items.slice(-MAX_HISTORY)) {
      const row = document.createElement('div');
      row.className = 'sidechat-msg ' + item.role + (item.pending ? ' pending' : '') + (item.error ? ' error' : '');
      row.textContent = item.content.length > 160 ? item.content.slice(0, 160) + '…' : item.content;
      history.appendChild(row);
    }
    history.scrollTop = history.scrollHeight;
  };

  const submit = (): void => {
    const text = input.value.trim();
    if (!text || pending) return;
    input.value = '';
    items.push({ role: 'user', content: text });
    items.push({ role: 'assistant', content: thinkingText, pending: true });
    pending = true;
    render();
    const messages = items
      .slice(-MAX_HISTORY)
      .filter((i) => !i.pending && !i.error)
      .map((i) => ({ role: i.role, content: i.content }));
    Promise.resolve(send(messages))
      .then((reply) => {
        const last = items[items.length - 1];
        if (last?.pending) {
          last.pending = false;
          last.content = reply || (getUiLang() === 'zh-CN' ? '（空回复）' : '(empty reply)');
        }
      })
      .catch(() => {
        const last = items[items.length - 1];
        if (last?.pending) {
          last.pending = false;
          last.error = true;
          last.content = failedText;
        }
      })
      .finally(() => {
        pending = false;
        render();
      });
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  sendBtn.addEventListener('click', submit);

  render();

  return () => {
    container.classList.remove('sidechat-page');
    container.innerHTML = '';
  };
}

/** Assistant binding: constructs the page with the real IPC bridge. */
export const SideChatPage = {
  id: 'side-chat',
  title: 'Side Chat',
  icon: '💬',
  mount: mountSideChatPage,
} as const;