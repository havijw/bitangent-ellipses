#!/usr/bin/env node
/**
 * Minimal static file server for the browser UI.
 *
 * Chrome (and most browsers) refuse to load ES module imports from a
 * `file://` page, so `index.html` needs to be served over http rather than
 * opened directly. This server has no dependencies: it just maps request
 * paths onto files in this directory with the right MIME type.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let relPath = decodeURIComponent(url.pathname);
    if (relPath === '/') relPath = '/index.html';
    const filePath = normalize(join(ROOT, relPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      // Never let a browser reuse a previous response. Without this the server
      // sends no Cache-Control, ETag or Last-Modified at all, so browsers fall
      // back to *heuristic* caching and may hold on to a module for minutes.
      // index.html and each src/*.js are separate requests, so that produces
      // the worst kind of stale: new markup against an old ui.js, where a
      // freshly added control renders but nothing wires it up. This is a local
      // dev server — correctness on reload beats a cache hit.
      'Cache-Control': 'no-store, max-age=0',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Ellipse tool UI: http://localhost:${PORT}`);
});
