import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Activity, Camera, CircleAlert, Database, Plus, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react';

type Resource = {
  id: string; name: string; organizationId: string; siteId?: string | null;
  status: string; resourceType: string; metadata?: Record<string, unknown>;
  createdAt?: string; updatedAt?: string;
};
type EnrollmentChallenge = { enrollmentId: string; challenge: string; connectorId: string; siteId: string; expiresAt: string; keyThumbprint: string };
type OperationalEvent = {
  id: string; organizationId: string; siteId: string; recordedAt: string;
  eventType: string; actorId?: string; payload?: Record<string, unknown>;
};
type Props = { visible: boolean };

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof body.message === 'string' ? body.message
      : typeof body.error === 'string' ? body.error : `http_${response.status}`;
    throw new Error(reason);
  }
  return body as T;
}

function safeDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}

export function SpaisOperationsWorkspace({ visible }: Props) {
  const [organizationId, setOrganizationId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [token, setToken] = useState('');
  const [sites, setSites] = useState<Resource[]>([]);
  const [cameras, setCameras] = useState<Resource[]>([]);
  const [connectors, setConnectors] = useState<Resource[]>([]);
  const [events, setEvents] = useState<OperationalEvent[]>([]);
  const [section, setSection] = useState<'sites' | 'cameras' | 'connectors' | 'events'>('sites');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Connect using an authorized organization, site, and bearer token to load live API data.');
  const [isError, setIsError] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [resourceName, setResourceName] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [resourceType, setResourceType] = useState<'site' | 'camera' | 'connector'>('site');
  const [cameraVendor, setCameraVendor] = useState('');
  const [cameraModel, setCameraModel] = useState('');
  const [cameraProtocol, setCameraProtocol] = useState<'unknown' | 'rtsp' | 'onvif' | 'vendor_api' | 'https_gateway'>('unknown');
  const [cameraTransport, setCameraTransport] = useState<'ethernet' | 'wifi' | 'other'>('ethernet');
  const [enrollmentConnectorId, setEnrollmentConnectorId] = useState('');
  const [publicKeyText, setPublicKeyText] = useState('');
  const [enrollmentChallenge, setEnrollmentChallenge] = useState<EnrollmentChallenge | null>(null);
  const scopeKey = JSON.stringify([organizationId.trim(), siteId.trim(), token.trim()]);
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;

  function clearScopedRecords(messageText: string) {
    setSites([]); setCameras([]); setConnectors([]); setEvents([]);
    setEnrollmentChallenge(null); setEnrollmentConnectorId('');
    setMessage(messageText); setIsError(false);
  }

  if (!visible) return null;

  function headers(json = false): HeadersInit {
    return { authorization: `Bearer ${token.trim()}`, ...(json ? { 'content-type': 'application/json' } : {}) };
  }
  function resourcePath(type: 'sites' | 'cameras' | 'connectors') {
    return `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/${type}`;
  }
  function validateConnection(requireSite = false) {
    if (!organizationId.trim() || !token.trim() || (requireSite && !siteId.trim())) {
      setIsError(true);
      setMessage(requireSite
        ? 'Enter organization ID, active site ID, and a trusted bearer token.'
        : 'Enter organization ID and a trusted bearer token.');
      return false;
    }
    return true;
  }
  async function loadAll() {
    if (!validateConnection()) return;
    const requestScope = scopeKey;
    setBusy(true); setIsError(false); setMessage('Loading authorized sites and service records…');
    try {
      const siteResponse = await fetch(resourcePath('sites') + '?limit=100', { headers: headers(), cache: 'no-store' });
      const siteBody = await readResponse<{ resources: Resource[] }>(siteResponse);
      if (requestScope !== currentScopeKey.current) return;
      setSites(siteBody.resources);
      const effectiveSite = siteBody.resources.some(site => site.id === siteId.trim()) ? siteId.trim() : (siteBody.resources[0]?.id || '');
      if (effectiveSite) {
        setSiteId(effectiveSite);
        const query = '?siteId=' + encodeURIComponent(effectiveSite) + '&limit=100';
        const [cameraResponse, connectorResponse, eventResponse] = await Promise.all([
          fetch(resourcePath('cameras') + query, { headers: headers(), cache: 'no-store' }),
          fetch(resourcePath('connectors') + query, { headers: headers(), cache: 'no-store' }),
          fetch(`/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/events${query}`, { headers: headers(), cache: 'no-store' })
        ]);
        const [cameraBody, connectorBody, eventBody] = await Promise.all([
          readResponse<{ resources: Resource[] }>(cameraResponse),
          readResponse<{ resources: Resource[] }>(connectorResponse),
          readResponse<{ events: OperationalEvent[] }>(eventResponse)
        ]);
        if (JSON.stringify([organizationId.trim(), effectiveSite, token.trim()]) !== currentScopeKey.current) return;
        setCameras(cameraBody.resources);
        setConnectors(connectorBody.resources);
        setEvents(eventBody.events);
        setMessage(`Loaded ${siteBody.resources.length} site(s), ${cameraBody.resources.length} camera(s), ${connectorBody.resources.length} connector(s), and ${eventBody.events.length} event(s) for site ${effectiveSite}.`);
      } else {
        setCameras([]); setConnectors([]); setEvents([]);
        setMessage('No accessible sites were returned. Create or request access to a site before loading camera and connector inventory.');
      }
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true);
      setMessage(error instanceof Error ? error.message : 'Could not load the authorized operations workspace.');
      setSites([]); setSiteId(''); setCameras([]); setConnectors([]); setEvents([]);
    } finally { setBusy(false); }
  }
  async function loadSiteResources(nextSiteId: string) {
    setSiteId(nextSiteId); setEnrollmentChallenge(null); setEnrollmentConnectorId('');
    setCameras([]); setConnectors([]); setEvents([]);
    if (!organizationId.trim() || !token.trim() || !nextSiteId) return;
    const requestScope = JSON.stringify([organizationId.trim(), nextSiteId, token.trim()]);
    setBusy(true); setIsError(false); setMessage('Loading records for the selected site…');
    try {
      const query = '?siteId=' + encodeURIComponent(nextSiteId) + '&limit=100';
      const [cameraResponse, connectorResponse, eventResponse] = await Promise.all([
        fetch(resourcePath('cameras') + query, { headers: headers(), cache: 'no-store' }),
        fetch(resourcePath('connectors') + query, { headers: headers(), cache: 'no-store' }),
        fetch(`/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/events${query}`, { headers: headers(), cache: 'no-store' })
      ]);
      const [cameraBody, connectorBody, eventBody] = await Promise.all([
        readResponse<{ resources: Resource[] }>(cameraResponse),
        readResponse<{ resources: Resource[] }>(connectorResponse),
        readResponse<{ events: OperationalEvent[] }>(eventResponse)
      ]);
      if (requestScope !== currentScopeKey.current) return;
      setCameras(cameraBody.resources); setConnectors(connectorBody.resources); setEvents(eventBody.events);
      setMessage(`Loaded selected site inventory and ${eventBody.events.length} operational event(s).`);
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not load the selected site.');
    } finally { setBusy(false); }
  }
  async function createResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateConnection(resourceType !== 'site')) return;
    if (!resourceId.trim() || !resourceName.trim()) { setIsError(true); setMessage('Resource ID and display name are required.'); return; }
    const requestScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const collection = resourceType === 'site' ? 'sites' : resourceType === 'camera' ? 'cameras' : 'connectors';
      const metadata = resourceType === 'camera' ? {
        sourceType: 'network_camera',
        integrationState: 'not_configured',
        protocol: cameraProtocol,
        transport: cameraTransport,
        ...(cameraVendor.trim() ? { vendor: cameraVendor.trim().slice(0, 100) } : {}),
        ...(cameraModel.trim() ? { model: cameraModel.trim().slice(0, 100) } : {})
      } : resourceType === 'connector' ? { integrationState: 'not_enrolled' } : {};
      const body = { id: resourceId.trim(), name: resourceName.trim(), ...(resourceType === 'site' ? {} : { siteId: siteId.trim() }), metadata };
      await readResponse<{ resource: Resource }>(await fetch(resourcePath(collection), {
        method: 'POST', headers: headers(true), body: JSON.stringify(body)
      }));
      if (requestScope !== currentScopeKey.current) return;
      setResourceId(''); setResourceName(''); setCameraVendor(''); setCameraModel(''); setCameraProtocol('unknown'); setCameraTransport('ethernet'); setCreateOpen(false);
      await loadAll();
      setMessage(`${resourceType} metadata created. Inventory registration does not connect a camera or enroll a connector.`);
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not create inventory record.');
    } finally { setBusy(false); }
  }
  async function createEnrollmentChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateConnection(true)) return;
    if (!enrollmentConnectorId) { setIsError(true); setMessage('Select a connector record first.'); return; }
    let publicKeyJwk: unknown;
    try { publicKeyJwk = JSON.parse(publicKeyText); }
    catch { setIsError(true); setMessage('Paste a valid public RSA JWK JSON object. Do not paste a private key.'); return; }
    if (!publicKeyJwk || typeof publicKeyJwk !== 'object' || Array.isArray(publicKeyJwk)) {
      setIsError(true); setMessage('The public key must be a JSON object.'); return;
    }
    const requestScope = scopeKey;
    setBusy(true); setIsError(false); setEnrollmentChallenge(null);
    try {
      const url = `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/connectors/${encodeURIComponent(enrollmentConnectorId)}/enrollment-challenges?siteId=${encodeURIComponent(siteId.trim())}`;
      const body = await readResponse<{ enrollment: EnrollmentChallenge }>(await fetch(url, {
        method: 'POST', headers: headers(true), body: JSON.stringify({ publicKeyJwk }), cache: 'no-store'
      }));
      if (requestScope !== currentScopeKey.current) return;
      setEnrollmentChallenge(body.enrollment);
      setMessage('One-time enrollment challenge created. Complete proof-of-possession on the customer-controlled connector before it expires.');
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not create enrollment challenge.');
    } finally { setBusy(false); }
  }

  const activeSite = sites.find(site => site.id === siteId);
  const currentResources = section === 'sites' ? sites : section === 'cameras' ? cameras : connectors;
  const currentTitle = section === 'sites' ? 'Sites' : section === 'cameras' ? 'Camera inventory' : section === 'connectors' ? 'Edge connectors' : 'Operational events';

  return <section className="ops-workspace" aria-labelledby="ops-title">
    <div className="ops-welcome">
      <div><span className="step">SPAIS OPERATIONS / CONTROL CENTER</span><h1 id="ops-title">Infrastructure &amp; activity</h1>
        <p>Manage authorized inventory metadata and inspect operational events. Camera status and recording integrity are never inferred from inventory records alone.</p></div>
      <span className="local-badge"><ShieldCheck size={14}/> Scoped API access</span>
    </div>
    <div className="ops-connect-panel">
      <div className="ops-panel-title"><div><Database size={18}/><div><h2>Trusted connection</h2><p>Credentials remain in component memory and are not saved to browser storage.</p></div></div><button className="primary-button" onClick={() => void loadAll()} disabled={busy}><RefreshCw size={15} className={busy ? 'spin' : ''}/>{busy ? 'Loading…' : 'Connect & refresh'}</button></div>
      <div className="ops-connection-fields">
        <label>Organization ID<input value={organizationId} onChange={e => { setOrganizationId(e.target.value); setSiteId(''); setSites([]); setCameras([]); setConnectors([]); setEvents([]); setEnrollmentChallenge(null); setEnrollmentConnectorId(''); setMessage('Organization changed. Refresh to load records authorized for the new organization.'); setIsError(false); }} placeholder="e.g. org-acme" autoComplete="off"/></label>
        <label>Active site<select value={siteId} onChange={e => void loadSiteResources(e.target.value)}><option value="">Choose an authorized site</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name} · {site.id}</option>)}</select></label>
        <label className="ops-token-field">Bearer token<input type="password" value={token} onChange={e => { setToken(e.target.value); clearScopedRecords('Token changed. Refresh to load records for the current identity.'); }} placeholder="Paste a trusted token" autoComplete="off" spellCheck={false}/></label>
      </div>
      <div className={`notice ${isError ? 'notice-error' : ''}`} role="status"><Activity size={16}/><span>{message}</span></div>
      {activeSite && <p className="ops-scope-note">Selected site: <strong>{activeSite.name}</strong> · {activeSite.status}. All site-level requests are explicitly scoped.</p>}
    </div>
    <div className="ops-summary-grid">
      <article className="dashboard-card"><span className="metric-label">Authorized sites</span><strong>{sites.length}</strong><small>Visible to the current principal</small></article>
      <article className="dashboard-card"><span className="metric-label">Camera records</span><strong>{cameras.length}</strong><small>Inventory metadata only</small></article>
      <article className="dashboard-card"><span className="metric-label">Connector records</span><strong>{connectors.length}</strong><small>Enrollment may still be required</small></article>
      <article className="dashboard-card"><span className="metric-label">Recent events</span><strong>{events.length}</strong><small>Selected site · newest first</small></article>
    </div>
    <div className="ops-tabs" role="tablist" aria-label="Operations sections">
      {([{id:'sites',label:'Sites',icon:Database},{id:'cameras',label:'Cameras',icon:Camera},{id:'connectors',label:'Connectors',icon:Wifi},{id:'events',label:'Event timeline',icon:Activity}] as const).map(item => <button key={item.id} role="tab" aria-selected={section === item.id} className={section === item.id ? 'ops-tab active' : 'ops-tab'} onClick={() => setSection(item.id)}><item.icon size={15}/>{item.label}<span>{item.id === 'sites' ? sites.length : item.id === 'cameras' ? cameras.length : item.id === 'connectors' ? connectors.length : events.length}</span></button>)}
    </div>
    <div className="ops-content-panel">
      <div className="dashboard-card-head"><div><h2>{currentTitle}</h2><p>{section === 'events' ? 'Authorized event records for the selected site.' : 'Tenant-scoped metadata; this does not establish device connectivity.'}</p></div>
        {section !== 'events' && <button className="outline-button" onClick={() => { setResourceType(section === 'sites' ? 'site' : section === 'cameras' ? 'camera' : 'connector'); setCreateOpen(true); }}><Plus size={15}/> Add record</button>}
      </div>
      {createOpen && section !== 'events' && <form className="ops-create-form" onSubmit={event => void createResource(event)}>
        <label>Resource type<select value={resourceType} onChange={e => setResourceType(e.target.value as typeof resourceType)}><option value="site">Site</option><option value="camera">Camera</option><option value="connector">Connector</option></select></label>
        <label>Stable ID<input required maxLength={100} value={resourceId} onChange={e => setResourceId(e.target.value)} placeholder="e.g. site-lahore-01"/></label>
        <label>Display name<input required maxLength={160} value={resourceName} onChange={e => setResourceName(e.target.value)} placeholder={resourceType === 'camera' ? 'e.g. Warehouse entrance camera' : resourceType === 'connector' ? 'e.g. Warehouse edge connector' : 'e.g. Lahore warehouse'}/></label>
        {resourceType === 'camera' && <div className="ops-camera-profile">
          <p>Camera integration profile <strong>Metadata only</strong></p>
          <div className="ops-connection-fields">
            <label>Manufacturer / vendor<input maxLength={100} value={cameraVendor} onChange={e => setCameraVendor(e.target.value)} placeholder="e.g. Hikvision, Dahua, Axis" autoComplete="off"/></label>
            <label>Model (optional)<input maxLength={100} value={cameraModel} onChange={e => setCameraModel(e.target.value)} placeholder="Device model" autoComplete="off"/></label>
            <label>Expected protocol<select value={cameraProtocol} onChange={e => setCameraProtocol(e.target.value as typeof cameraProtocol)}><option value="unknown">Not known yet</option><option value="rtsp">RTSP stream</option><option value="onvif">ONVIF-supported device</option><option value="vendor_api">Vendor API / NVR SDK</option><option value="https_gateway">HTTPS / HLS / WebRTC gateway</option></select></label>
            <label>Network transport<select value={cameraTransport} onChange={e => setCameraTransport(e.target.value as typeof cameraTransport)}><option value="ethernet">Ethernet / wired LAN</option><option value="wifi">Wi-Fi</option><option value="other">Other / bridge</option></select></label>
          </div>
          <small>Do not enter stream URLs, passwords, tokens, or private keys here. This profile records intended compatibility only; the camera remains unconnected until a customer-approved adapter validates the stream.</small>
        </div>}
        {resourceType !== 'site' && !siteId && <p className="notice notice-error">Choose an authorized site before creating a camera or connector.</p>}
        <div className="ops-form-actions"><button type="button" className="outline-button" onClick={() => setCreateOpen(false)}>Cancel</button><button className="primary-button" disabled={busy || (resourceType !== 'site' && !siteId)}><Plus size={15}/> Create metadata</button></div>
        <small>Only metadata is created. Camera connectivity and connector enrollment are separate workflows.</small>
      </form>}
      {section === 'connectors' && <section className="ops-enrollment-panel" aria-labelledby="connector-enrollment-title">
        <div className="ops-enrollment-heading"><div><h3 id="connector-enrollment-title">Enroll an edge connector</h3><p>Create a short-lived challenge using the connector's public key. The private key must remain on the customer-controlled host.</p></div><span className="capability-state is-pending">10-minute challenge</span></div>
        <form className="ops-enrollment-form" onSubmit={event => void createEnrollmentChallenge(event)}>
          <label>Connector record<select required value={enrollmentConnectorId} onChange={event => { setEnrollmentConnectorId(event.target.value); setEnrollmentChallenge(null); }}><option value="">Choose a connector</option>{connectors.map(connector => <option key={connector.id} value={connector.id}>{connector.name} · {connector.id} · {connector.status}</option>)}</select></label>
          <label>Public RSA JWK JSON<textarea required rows={4} value={publicKeyText} onChange={event => setPublicKeyText(event.target.value)} placeholder='{"kty":"RSA","n":"…","e":"AQAB"}' spellCheck={false}/></label>
          <div className="ops-form-actions"><button className="primary-button" disabled={busy || !siteId || !connectors.length}><ShieldCheck size={15}/>{busy ? 'Creating…' : 'Create one-time challenge'}</button></div>
        </form>
        {enrollmentChallenge && <div className="ops-challenge-result"><strong>Challenge created · expires {safeDate(enrollmentChallenge.expiresAt)}</strong><small>Enrollment ID</small><code>{enrollmentChallenge.enrollmentId}</code><small>One-time challenge — copy it to the approved connector enrollment procedure</small><textarea readOnly rows={3} value={enrollmentChallenge.challenge} aria-label="One-time enrollment challenge"/><small>Public-key thumbprint: <code>{enrollmentChallenge.keyThumbprint}</code></small><p>Keep the challenge available only to the authorized enrollment operator. The server stores its hash and will reject expired or reused challenges.</p></div>}
      </section>}
      {section === 'events' ? events.length ? <div className="ops-event-list">{events.map(item => <article className="ops-event-row" key={item.id}><span className="ops-event-icon"><Activity size={16}/></span><div><strong>{item.eventType.replaceAll('_',' ')}</strong><small>{safeDate(item.recordedAt)} · {item.actorId || 'System actor'}</small><code>{item.id}</code></div><span className="ops-event-site">{item.siteId}</span></article>)}</div> : <div className="dashboard-empty"><CircleAlert size={23}/><strong>No operational events loaded</strong><p>Connect with an authorized token and select a site to read the scoped event timeline.</p></div> :
        currentResources.length ? <div className="ops-resource-list">{currentResources.map(item => <article className="ops-resource-row" key={item.id}><span className="ops-resource-icon">{section === 'sites' ? <Database size={17}/> : section === 'cameras' ? <Camera size={17}/> : <WifiOff size={17}/>}</span><div className="ops-resource-main"><strong>{item.name}</strong><small>{item.id}{item.siteId ? ` · site ${item.siteId}` : ''}</small>{section === 'cameras' && <small>{String(item.metadata?.vendor || 'Vendor unknown')} · {String(item.metadata?.model || 'Model unknown')} · {String(item.metadata?.protocol || 'Protocol unknown')} · {String(item.metadata?.transport || 'transport unknown')}</small>}<small>Created {safeDate(item.createdAt)}</small></div><span className={`capability-state ${item.status === 'active' || item.status === 'enrolled' ? 'is-available' : 'is-pending'}`}>{item.status.replaceAll('_',' ')}</span></article>)}</div> :
        <div className="dashboard-empty"><Database size={23}/><strong>No records to display</strong><p>Connect with a trusted token, then refresh to load authorized inventory. API configuration and authorization are required.</p></div>}
    </div>
    <p className="ops-disclaimer">Security boundary: this workspace never accepts camera stream URLs, credentials, private keys, or arbitrary recorder endpoints. Connector enrollment and recording assurance remain separate, explicitly authorized operations.</p>
  </section>;
}
