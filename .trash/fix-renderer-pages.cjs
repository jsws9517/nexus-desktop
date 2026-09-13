const fs = require('fs');
const p = 'D:/agent-cli/nexus-desktop/src/renderer/renderer.ts';
let s = fs.readFileSync(p, 'utf8');
const NL = '\n';

// 1. Imports (LF)
const anchor =
  "import { SubAgentsPage, mountSubAgentsPage } from './sidebar/pages/sub-agents.js';" + NL;
const addition =
  anchor +
  "import { TerminalPage, mountTerminalPage } from './sidebar/pages/terminal.js';" + NL +
  "import { SideChatPage, mountSideChatPage } from './sidebar/pages/side-chat.js';" + NL +
  "import { GitPage, mountGitPage } from './sidebar/pages/git.js';" + NL;

const n = s.indexOf(anchor);
if (n < 0) {
  console.log('import anchor not found');
  process.exit(1);
}
s = s.slice(0, n) + addition + s.slice(n + anchor.length);

// 2. Registrations (LF)
const regAnchor =
  "    sidebarRegistry.register({" + NL +
  "      id: SubAgentsPage.id," + NL +
  "      title: SubAgentsPage.title," + NL +
  "      icon: SubAgentsPage.icon," + NL +
  "      mount: mountSubAgentsPage," + NL +
  "    });" + NL +
  "    renderSidebarTabs();";

const regAdd =
  "    sidebarRegistry.register({" + NL +
  "      id: SubAgentsPage.id," + NL +
  "      title: SubAgentsPage.title," + NL +
  "      icon: SubAgentsPage.icon," + NL +
  "      mount: mountSubAgentsPage," + NL +
  "    });" + NL +
  "    sidebarRegistry.register({" + NL +
  "      id: TerminalPage.id," + NL +
  "      title: TerminalPage.title," + NL +
  "      icon: TerminalPage.icon," + NL +
  "      mount: mountTerminalPage," + NL +
  "    });" + NL +
  "    sidebarRegistry.register({" + NL +
  "      id: SideChatPage.id," + NL +
  "      title: SideChatPage.title," + NL +
  "      icon: SideChatPage.icon," + NL +
  "      mount: mountSideChatPage," + NL +
  "    });" + NL +
  "    sidebarRegistry.register({" + NL +
  "      id: GitPage.id," + NL +
  "      title: GitPage.title," + NL +
  "      icon: GitPage.icon," + NL +
  "      mount: mountGitPage," + NL +
  "    });" + NL +
  "    renderSidebarTabs();";

const m = s.indexOf(regAnchor);
if (m < 0) {
  console.log('register anchor not found');
  process.exit(1);
}
s = s.slice(0, m) + regAdd + s.slice(m + regAnchor.length);

// 3. Comment
s = s.replace(
  "    // P1: register built-in sidebar tabs (currently the Sub-Agents flagship page)" + NL +
  "    // and render the tab bar. The registry is the single extension surface; more" + NL +
  "    // tabs (terminal, side-chat, git) attach the same way in later phases.",
  "    // P1: register built-in sidebar tabs (Sub-Agents flagship + terminal," + NL +
  "    // side-chat, Git) and render the tab bar. The registry is the single" + NL +
  "    // extension surface; third-party tabs attach the same way."
);

fs.writeFileSync(p, s);
console.log('renderer.ts updated');