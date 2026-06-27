import { Command } from 'commander';
import chalk from 'chalk';
import { SessionManager } from '../session/manager.js';

export function registerSessionCommand(program: Command): void {
  const sessionCmd = program.command('session').description('Session management');

  sessionCmd
    .command('list')
    .description('List all sessions')
    .action(async () => {
      const manager = new SessionManager();
      const sessions = manager.list();
      if (sessions.length === 0) {
        console.log(chalk.gray('No sessions found.'));
        return;
      }
      console.log(chalk.bold('Sessions:'));
      for (const s of sessions) {
        const date = new Date(s.updatedAt).toLocaleString();
        console.log(`  ${chalk.cyan(s.id)} ${chalk.white(s.name)} ${chalk.gray(date)}`);
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
      console.log(chalk.green(`Renamed session to "${name}"`));
    });

  sessionCmd
    .command('delete <id>')
    .description('Delete a session')
    .action(async (id: string) => {
      const manager = new SessionManager();
      manager.delete(id);
      console.log(chalk.green('Session deleted.'));
    });
}
