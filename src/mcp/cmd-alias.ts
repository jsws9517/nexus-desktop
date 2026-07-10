const ALIASES: [RegExp, string][] = [
  [/^ls\b/, 'dir'],
  [/^pwd\b/, 'cd'],
  [/^cat\b/, 'type'],
  [/^clear\b/, 'cls'],
  [/^cp\b/, 'copy'],
  [/^mv\b/, 'move'],
  [/^rm\b/, 'del'],
  [/^grep\b/, 'findstr'],
  [/^which\b/, 'where'],
  [/^less\b/, 'more'],
  [/^diff\b/, 'fc'],
  [/^touch\b/, 'copy nul'],
  [/^env\b/, 'set'],
  [/^uname\b/, 'ver'],
  [/^whoami\b/, 'whoami'],
  [/^ps\b/, 'tasklist'],
  [/^kill\b/, 'taskkill /f /pid'],
  [/^sort\b/, 'sort'],
  [/^wc\b/, 'find /c /v ""'],
  [/^head\b/, 'cmd /c "more'],
  [/^date\b/, 'date /t'],
  [/^time\b/, 'time /t'],
];

export function translateCommand(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  for (const [pattern, replacement] of ALIASES) {
    if (pattern.test(cmd)) {
      return cmd.replace(pattern, replacement);
    }
  }
  return cmd;
}
