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

/**
 * Split a compound command (separated by &&, ||, ;, |) into individual
 * segments, translate each one independently (preserving its leading ^
 * anchor), then rejoin.  This ensures `cd .. && pwd` translates both
 * segments correctly.
 */
export function translateCommand(cmd: string): string {
  if (process.platform !== 'win32') return cmd;

  // Split while preserving the separators so we can rejoin faithfully.
  // Matches:  &&  ||  ;  |  (with optional surrounding whitespace)
  const parts = cmd.split(/(\s*&&\s*|\s*\|\|\s*|\s*;\s*|\s*\|\s*)/);

  const translated = parts.map((part, i) => {
    // Odd indices are the separators themselves — pass through unchanged.
    if (i % 2 === 1) return part;
    // Even indices are command segments — apply all alias replacements.
    let segment = part;
    for (const [pattern, replacement] of ALIASES) {
      segment = segment.replace(pattern, replacement);
    }
    return segment;
  });

  return translated.join('');
}
