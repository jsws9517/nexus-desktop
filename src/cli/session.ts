import { Command } from 'commander';
import { SessionManager } from '../session/manager.js';
import { ThemeManager } from '../theme/manager.js';

const _theme = new ThemeManager();
const t = _theme.token;

export function registerSessionCommand(program: Command): void {
  const sessionCmd = program.command('session').description('Session management');

  sessionCmd
    .command('list')
    .description('List all sessions')
    .action(async () => {
      const manager = new SessionManager();
      const sessions = manager.list().items;
      if (sessions.length === 0) {
        console.log(t.textDim('No sessions found.'));
        return;
      }
      console.log(t.heading('Sessions:'));
      for (const s of sessions) {
        const date = new Date(s.updatedAt).toLocaleString();
        console.log(`  ${t.entityName(s.id)} ${t.textPrimary(s.name)} ${t.textDim(date)}`);
      }
    });

  sessionCmd
    .command('resume <id>')
    .description('Resume a session')
    .action(async (id: string) => {
      const { startInteractiveChat } = await import('./chat.js');
      await startInteractiveChat(id);
    });

  sessionCmd
    .command('rename <id> <name>')
    .description('Rename a session')
    .action(async (id: string, name: string) => {
      const manager = new SessionManager();
      manager.rename(id, name);
      console.log(t.success(`Renamed session to "${name}"`));
    });

  sessionCmd
    .command('delete <id>')
    .description('Delete a session')
    .action(async (id: string) => {
      const manager = new SessionManager();
      manager.delete(id);
      console.log(t.success('Session deleted.'));
    });
}
