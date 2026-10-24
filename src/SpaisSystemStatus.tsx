import { useEffect, useState } from 'react';
import { Activity, CheckCircle2, CircleAlert, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react';

type ContractManifest = {
  apiVersion: string;
  contractVersion: number;
  authenticationConfigured: boolean;
  tenantResourceApiEnabled: boolean;
  resourceTypes?: string[];
  notes?: string[];
};

type Status = 'ready' | 'warning' | 'unavailable' | 'loading';

function StatePill({ status, children }: { status: Status; children: string }) {
  return <span className={'spais-status-pill is-' + status}>{children}</span>;
}

export function SpaisSystemStatus() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [manifest, setManifest] = useState<ContractManifest | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      fetch('/api/health', { cache: 'no-store' }),
      fetch('/api/v1/spais/contracts', { cache: 'no-store' })
    ]).then(async ([healthResponse, contractResponse]) => {
      if (!healthResponse.ok || !contractResponse.ok) throw new Error('SPAIS status endpoints are unavailable');
      const nextManifest = await contractResponse.json() as ContractManifest;
      if (typeof nextManifest.apiVersion !== 'string' ||
          typeof nextManifest.authenticationConfigured !== 'boolean' ||
          typeof nextManifest.tenantResourceApiEnabled !== 'boolean') {
        throw new Error('SPAIS status response was not recognized');
      }
      if (!active) return;
      setManifest(nextManifest);
      setApiAvailable(true);
      setLastChecked(new Date().toISOString());
    }).catch(() => {
      if (!active) return;
      setApiAvailable(false);
      setManifest(null);
      setLastChecked(new Date().toISOString());
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [refreshKey]);

  const apiStatus: Status = loading ? 'loading' : apiAvailable ? 'ready' : 'unavailable';
  const authStatus: Status = loading ? 'loading' : manifest?.authenticationConfigured ? 'ready' : apiAvailable ? 'warning' : 'unavailable';
  const tenantStatus: Status = loading ? 'loading' : manifest?.tenantResourceApiEnabled ? 'ready' : apiAvailable ? 'warning' : 'unavailable';
  const telemetryReady = Boolean(manifest?.authenticationConfigured && manifest?.tenantResourceApiEnabled);
  const timeLabel = lastChecked ? new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Not checked';

  return <article className="dashboard-card spais-system-status" aria-labelledby="spais-system-status-title">
    <div className="dashboard-card-head">
      <div className="spais-status-heading">
        <span className="dashboard-action-icon"><Activity size={19}/></span>
        <div>
          <h2 id="spais-system-status-title">SPAIS service readiness</h2>
          <p>Live configuration checks from this application’s backend; no customer camera feeds are accessed.</p>
        </div>
      </div>
      <button className="outline-button spais-refresh-button" onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>
        <RefreshCw size={14} className={loading ? 'spin' : ''}/> Refresh
      </button>
    </div>
    <div className="spais-status-grid" aria-live="polite" aria-busy={loading}>
      <div className="spais-status-item">
        <span className="spais-status-icon">{apiAvailable === false ? <WifiOff size={17}/> : <Wifi size={17}/>}</span>
        <div><span className="metric-label">Backend API</span><strong>{loading ? 'Checking…' : apiAvailable ? 'Reachable' : 'Unavailable'}</strong></div>
        <StatePill status={apiStatus}>{loading ? 'Checking' : apiAvailable ? 'Online' : 'Offline'}</StatePill>
      </div>
      <div className="spais-status-item">
        <span className="spais-status-icon"><ShieldCheck size={17}/></span>
        <div><span className="metric-label">Trusted identity</span><strong>{loading ? 'Checking…' : manifest?.authenticationConfigured ? 'Configured' : apiAvailable ? 'Not configured' : 'Unknown'}</strong></div>
        <StatePill status={authStatus}>{loading ? 'Checking' : manifest?.authenticationConfigured ? 'Ready' : apiAvailable ? 'Setup needed' : 'Unknown'}</StatePill>
      </div>
      <div className="spais-status-item">
        <span className="spais-status-icon"><CheckCircle2 size={17}/></span>
        <div><span className="metric-label">Tenant APIs</span><strong>{loading ? 'Checking…' : manifest?.tenantResourceApiEnabled ? 'Enabled' : apiAvailable ? 'Disabled safely' : 'Unknown'}</strong></div>
        <StatePill status={tenantStatus}>{loading ? 'Checking' : manifest?.tenantResourceApiEnabled ? 'Enabled' : apiAvailable ? 'Protected' : 'Unknown'}</StatePill>
      </div>
      <div className="spais-status-item">
        <span className="spais-status-icon"><CircleAlert size={17}/></span>
        <div><span className="metric-label">Connector telemetry</span><strong>{loading ? 'Checking…' : telemetryReady ? 'Enrollment prerequisites ready' : apiAvailable ? 'Configuration required' : 'Unknown'}</strong></div>
        <StatePill status={loading ? 'loading' : telemetryReady ? 'ready' : apiAvailable ? 'warning' : 'unavailable'}>{loading ? 'Checking' : telemetryReady ? 'Prerequisites ready' : apiAvailable ? 'Not ready' : 'Unknown'}</StatePill>
      </div>
    </div>
    <div className="spais-status-footnote">
      <span>API {manifest?.apiVersion ?? '—'} · Contract v{manifest?.contractVersion ?? '—'}</span>
      <span>Last checked: {timeLabel}</span>
    </div>
    <p className="spais-status-disclaimer">A configured API is not proof that a camera is connected or that an NVR is recording. Recorder assurance requires customer-controlled connector evidence and independent validation.</p>
  </article>;
}
