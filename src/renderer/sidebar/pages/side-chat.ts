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

import { stripProtocolXml } from '../../../shared/constants.js';
import { STR } from '../../i18n.js';
import type { AgentEvent } from '../../../agent/types.js';
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

/** Translate a STR key using a live language getter. */
function str(key: string, lang: string, vars?: Record<string, string | number>): string {
  let out = STR[key]?.[lang as keyof (typeof STR)[string]] ?? STR[key]?.['zh-CN'] ?? key;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
  return out;
}

/**
 * Mount the side-chat page into `container`. Returns a dispose function that
 * removes every DOM node created here (no event subscriptions to release).
 */
export function mountSideChatPage(
  container: HTMLElement,
  ctx: SidebarContext,
  opts: SideChatPageOptions = {},
): () => void {
  const send = opts.send ?? defaultSend;
  // Live language: prefer the context accessor so static labels re-paint when
  // the UI language changes after mount.
  const getLang = (): string => ctx.getUiLang?.() ?? opts.getUiLang?.() ?? 'zh-CN';
  const thinkingText = () => str('sideChatThinking', getLang());
  const failedText = () => str('sideChatFailed', getLang());

  container.classList.add('sidechat-page');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'sidechat-root';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'sidechat-header';
  root.appendChild(header);

  const titleEl = document.createElement('span');
  titleEl.className = 'sidechat-title';
  titleEl.textContent = str('sideChatTitle', getLang());
  header.appendChild(titleEl);

  const legendEl = document.createElement('span');
  legendEl.className = 'sidechat-legend';
  legendEl.textContent = str('sideChatLegend', getLang());
  header.appendChild(legendEl);

  const history = document.createElement('div');
  history.className = 'sidechat-history';
  history.dataset.testid = 'sidechat-history';
  root.appendChild(history);

  const inputRow = document.createElement('div');
  inputRow.className = 'sidechat-input-row';
  root.appendChild(inputRow);

  const input = document.createElement('input');
  input.className = 'sidechat-input';
  input.placeholder = str('sideChatPlaceholder', getLang());
  input.spellcheck = false;
  inputRow.appendChild(input);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'sidechat-send';
  sendBtn.textContent = str('sideChatSend', getLang());
  inputRow.appendChild(sendBtn);

  // Re-paint the static labels (title / legend / placeholder / send) when the
  // running app's UI language changes — transcript content is left untouched.
  const applyLang = (): void => {
    titleEl.textContent = str('sideChatTitle', getLang());
    legendEl.textContent = str('sideChatLegend', getLang());
    input.placeholder = str('sideChatPlaceholder', getLang());
    sendBtn.textContent = str('sideChatSend', getLang());
  };

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
    items.push({ role: 'assistant', content: thinkingText(), pending: true });
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
          last.content = stripProtocolXml(reply) || str('sideChatEmptyReply', getLang());
        }
      })
      .catch(() => {
        const last = items[items.length - 1];
        if (last?.pending) {
          last.pending = false;
          last.error = true;
          last.content = failedText();
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

  // Language control events only: re-paint static labels when the UI language
  // changes. Real session events are deliberately ignored — side chat is an
  // isolated surface and must never mirror the main transcript's chunks.
  let unsubscribeLang: (() => void) | undefined;
  if (typeof ctx.subscribe === 'function') {
    const onEvent = (event: AgentEvent): void => {
      if (event.type === 'language_changed') applyLang();
    };
    unsubscribeLang = ctx.subscribe(onEvent);
  }

  return () => {
    unsubscribeLang?.();
    container.classList.remove('sidechat-page');
    container.innerHTML = '';
  };
}

/** Assistant binding: constructs the page with the real IPC bridge. */
export const SideChatPage = {
  id: 'side-chat',
  title: 'Side Chat',
  titleKey: 'sidebarSideChat',
  icon: '💬',
  mount: mountSideChatPage,
} as const;