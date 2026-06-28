import { createServer, Server } from 'http';

/**
 * 启动一个本地 HTTP 测试服务器，用于替代外部网络依赖。
 */
export function startLocalServer(port = 0): Promise<{ server: Server; port: number; url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: req.url, headers: req.headers }));
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        stop: () => new Promise<void>((res) => server.close(() => res())),
      });
    });

    server.on('error', reject);
  });
}
