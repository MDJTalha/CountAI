import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT || 8787);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json', '.png':'image/png', '.ico':'image/x-icon' };
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') { res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'}); return res.end(JSON.stringify({ok:true, service:'countai-api', cloudRecognitionConfigured:false})); }
  if (url.pathname === '/api/recognize' && req.method === 'POST') {
    res.writeHead(501, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({error:'Cloud recognition provider is not configured. No image was analyzed by a cloud service.'}));
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(404, {'content-type':'application/json'}); return res.end(JSON.stringify({error:'Not found'})); }
  let pathname = decodeURIComponent(url.pathname);
  let file = normalize(join(root, pathname));
  if (!file.startsWith(root)) { res.writeHead(400); return res.end('Bad request'); }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) file = join(root, 'index.html');
  if (!existsSync(file)) { res.writeHead(503, {'content-type':'text/plain'}); return res.end('CountAI has not been built. Run npm run build first.'); }
  res.writeHead(200, {'content-type':mime[extname(file)] || 'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin'});
  createReadStream(file).pipe(res);
});
server.listen(port, '0.0.0.0', () => console.log(`CountAI server listening on ${port}`));
