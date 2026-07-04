import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 创建临时目录和数据库路径，用于隔离测试 Session SQLite 持久化。
 * 返回 { dbPath, cleanup }，cleanup 会删除临时目录。
 */
export function createTempDb(): { dbPath: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'llm-agent-test-'));
  const dbPath = join(tmpDir, 'test-sessions.db');
  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}
