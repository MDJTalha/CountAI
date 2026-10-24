import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { getSpaisContractManifest } from './spais/contracts.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT || 8787);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json', '.png':'image/png', '.ico':'image/x-icon' };
function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  return res.end(JSON.stringify(body));
}
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') return json(res, 200, {ok:true, service:'countai-api', cloudRecognitionConfigured:false});
  if (url.pathname === '/api/v1/spais/contracts' && req.method === 'GET') {
    return json(res, 200, getSpaisContractManifest());
  }
  // Tenant resource APIs fail closed until a trusted auth adapter, tenant store,
  // and server-side authorization are configured. Never trust client-supplied tenant IDs.
  if (url.pathname.startsWith('/api/v1/organizations') || url.pathname.startsWith('/api/v1/sites') ||
      url.pathname.startsWith('/api/v1/cameras') || url.pathname.startsWith('/api/v1/connectors') ||
      url.pathname.startsWith('/api/v1/incidents') || url.pathname.startsWith('/api/v1/sops') ||
      url.pathname.startsWith('/api/v1/models') || url.pathname.startsWith('/api/v1/audit')) {
    return json(res, 503, {
      error: 'tenant_api_not_enabled',
      message: 'Tenant-scoped SPAIS APIs are disabled until trusted authentication, authorization and persistence are configured.'
    });
  }
  if (url.pathname === '/api/recognize' && req.method === 'POST') {
    return json(res, 501, {error:'Cloud recognition provider is not configured. No image was analyzed by a cloud service.'});
  }
  if (url.pathname.startsWith('/api/')) return json(res, 404, {error:'Not found'});
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  let file = normalize(join(root, pathname));
  if (!file.startsWith(root)) { res.writeHead(400); return res.end('Bad request'); }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) file = join(root, 'index.html');
  if (!existsSync(file)) { res.writeHead(503, {'content-type':'text/plain'}); return res.end('SPAIS has not been built. Run npm run build first.'); }
  res.writeHead(200, {'content-type':mime[extname(file)] || 'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin'});
  createReadStream(file).pipe(res);
});
server.listen(port, '0.0.0.0', () => console.log(`SPAIS API listening on ${port}`));
