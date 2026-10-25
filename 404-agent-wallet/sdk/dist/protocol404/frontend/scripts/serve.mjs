import './build.mjs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheControlFor } from './cache-policy.mjs';

const root = fileURLToPath(new URL('../build/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.dat': 'application/octet-stream', '.svg': 'image/svg+xml', '.map': 'application/json' };
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`) || !(await stat(path)).isFile()) { response.writeHead(404).end(); return; }
    response.setHeader('Cache-Control', cacheControlFor(pathname));
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    response.end(request.method === 'HEAD' ? undefined : await readFile(path));
  } catch (error) {
    if (error instanceof URIError || error.code === 'ERR_INVALID_URL') response.writeHead(400).end('Bad request');
    else if (['ENOENT', 'ENOTDIR'].includes(error.code)) response.writeHead(404).end('Not found');
    else { console.error('Static server error:', error.message); response.writeHead(500).end('Internal server error'); }
  }
});
const port = Number(process.env.PORT ?? 4173);
server.listen(port, '127.0.0.1', () => console.log(`404: http://127.0.0.1:${port}`));
