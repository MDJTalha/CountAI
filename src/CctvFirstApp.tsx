import { useState } from 'react';
import {
  Activity, ArrowRight, Bell, Camera, CheckCircle2, CircleHelp, Cloud,
  Database, Eye, Gauge, Network, RadioTower, ShieldCheck, Video, Wifi,
  WifiOff, Workflow
} from 'lucide-react';
import { SpaisOperationsWorkspace } from './SpaisOperationsWorkspace';
import { SpaisGovernanceWorkspace } from './SpaisGovernanceWorkspace';
import './CctvFirstApp.css';

type Workspace = 'overview' | 'monitor' | 'infrastructure' | 'governance';

const navigation: Array<{ id: Workspace; label: string; icon: typeof Camera }> = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'monitor', label: 'Live monitoring', icon: Eye },
  { id: 'infrastructure', label: 'Sites & cameras', icon: Network },
  { id: 'governance', label: 'Incidents & AI', icon: Workflow }
];

const connectionTypes = [
  { name: 'IP camera', detail: 'Network video stream or camera API', icon: Camera, status: 'Adapter required' },
  { name: 'NVR / DVR', detail: 'Recorder stream, API or approved connector', icon: Database, status: 'Adapter required' },
  { name: 'ONVIF', detail: 'Discovery and device capabilities where supported', icon: RadioTower, status: 'Not configured' },
  { name: 'RTSP / vendor API', detail: 'Stream access through customer-approved network paths', icon: Network, status: 'Not configured' }
];

function StatusPill({ children, tone = 'pending' }: { children: React.ReactNode; tone?: 'pending' | 'safe' }) {
  return <span className={`cctv-status ${tone === 'safe' ? 'is-safe' : ''}`}>{children}</span>;
}

export function CctvFirstApp() {
  const [active, setActive] = useState<Workspace>('overview');

  return <div className="cctv-app">
    <aside className="cctv-sidebar">
      <a className="cctv-brand" href="#overview" onClick={event => { event.preventDefault(); setActive('overview'); }}>
        <span className="cctv-brand-mark"><Eye size={22} /></span>
        <span><strong>CountAI</strong><small>CAMERA INTELLIGENCE</small></span>
      </a>
      <div className="cctv-tenant"><span className="cctv-tenant-dot" /> Customer-managed deployment <small>Connect an authorized site</small></div>
      <nav className="cctv-nav" aria-label="Primary navigation">
        {navigation.map(item => {
          const Icon = item.icon;
          return <button key={item.id} className={active === item.id ? 'active' : ''} aria-current={active === item.id ? 'page' : undefined} onClick={() => setActive(item.id)}>
            <Icon size={18} /><span>{item.label}</span>{active === item.id && <ArrowRight size={15} className="nav-arrow" />}
          </button>;
        })}
      </nav>
      <div className="cctv-sidebar-foot">
        <ShieldCheck size={17} />
        <div><strong>Privacy-aware by design</strong><small>Video stays on customer-approved paths. No facial identity recognition.</small></div>
      </div>
    </aside>

    <main className="cctv-main">
      <header className="cctv-topbar">
        <div><span className="cctv-eyebrow">SURVEILLANCE & OPERATIONAL INTELLIGENCE</span><strong>{navigation.find(item => item.id === active)?.label}</strong></div>
        <div className="cctv-top-status"><span className="cctv-status-dot" /> Integration not configured</div>
      </header>

      {active === 'overview' && <section className="cctv-page" aria-labelledby="overview-title">
        <div className="cctv-hero">
          <div>
            <span className="cctv-eyebrow">CAMERA-FIRST OPERATIONS</span>
            <h1 id="overview-title">Every camera. One operational view.</h1>
            <p>Bring authorized IP cameras, NVRs and DVRs into one workspace for live monitoring, counting, camera health, events and recording assurance.</p>
            <div className="cctv-actions">
              <button className="cctv-button primary" onClick={() => setActive('infrastructure')}><Network size={16} /> Set up sites & cameras</button>
              <button className="cctv-button secondary" onClick={() => setActive('monitor')}><Eye size={16} /> Open live monitoring</button>
            </div>
          </div>
          <div className="cctv-hero-art" aria-hidden="true"><div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" /><div className="hero-camera"><Camera size={58} strokeWidth={1.25} /></div><span className="hero-signal signal-one" /><span className="hero-signal signal-two" /><span className="hero-signal signal-three" /></div>
        </div>

        <div className="cctv-notice" role="status"><WifiOff size={18} /><div><strong>No camera stream is connected yet</strong><p>Inventory records are configuration metadata, not proof of a live feed. Connect an approved edge/recorder adapter before expecting video, AI detections or recording assurance.</p></div><StatusPill>Pending setup</StatusPill></div>

        <div className="cctv-metrics">
          <article><span><Camera size={17} /> Camera inventory</span><strong>Not loaded</strong><small>Connect to an authorized organization</small></article>
          <article><span><Activity size={17} /> Live streams</span><strong>0 verified</strong><small>Only validated feeds will be marked online</small></article>
          <article><span><Bell size={17} /> Operational events</span><strong>Awaiting connection</strong><small>Events appear after authenticated API access</small></article>
          <article><span><ShieldCheck size={17} /> Recording assurance</span><strong>Not verified</strong><small>Connector reports are not independent proof</small></article>
        </div>

        <div className="cctv-section-head"><div><span className="cctv-eyebrow">SUPPORTED INTEGRATION TARGETS</span><h2>Connect your camera estate</h2><p>Use the method your equipment actually supports and your IT team approves.</p></div></div>
        <div className="cctv-connection-grid">{connectionTypes.map(item => { const Icon = item.icon; return <article className="cctv-connection-card" key={item.name}><span className="cctv-connection-icon"><Icon size={21} /></span><div><h3>{item.name}</h3><p>{item.detail}</p><StatusPill>{item.status}</StatusPill></div></article>; })}</div>
        <div className="cctv-tip"><CircleHelp size={18} /><p><strong>Wi-Fi and Bluetooth are connectivity methods, not universal video protocols.</strong> Wi-Fi can carry IP video if routing and access permit. Bluetooth is generally for setup/provisioning; it usually does not carry CCTV video. Integration requires a compatible stream/API and explicit customer authorization.</p></div>
      </section>}

      {active === 'monitor' && <section className="cctv-page" aria-labelledby="monitor-title">
        <div className="cctv-page-heading"><span className="cctv-eyebrow">LIVE OPERATIONS</span><h1 id="monitor-title">Live camera monitoring</h1><p>Video will appear here after a compatible stream adapter is implemented and connected to an authorized camera or recorder.</p></div>
        <div className="cctv-monitor-placeholder">
          <div className="monitor-screen"><div className="monitor-screen-grid" /><div className="monitor-center-icon"><Video size={42} /><span>NO VERIFIED STREAM</span></div><span className="monitor-corner top-left">SOURCE: NOT CONFIGURED</span><span className="monitor-corner bottom-left">AI INFERENCE: INACTIVE</span><span className="monitor-corner bottom-right">RECORDER: UNKNOWN</span></div>
          <div className="monitor-detail"><StatusPill>Adapter required</StatusPill><h2>Waiting for an authorized source</h2><p>CountAI will not scan the network, guess camera credentials, or mark a camera online based on an inventory record.</p><ul><li>Customer-approved IP/host and stream path</li><li>Least-privilege connector identity</li><li>Validated video decode and health checks</li><li>Visible evidence timestamps and failure states</li></ul><button className="cctv-button primary" onClick={() => setActive('infrastructure')}><Network size={16} /> Configure infrastructure <ArrowRight size={15} /></button></div>
        </div>
      </section>}

      {active === 'infrastructure' && <section className="cctv-page cctv-embedded-workspace" aria-labelledby="infrastructure-title">
        <div className="cctv-page-heading"><span className="cctv-eyebrow">CUSTOMER-CONTROLLED EDGE</span><h1 id="infrastructure-title">Sites, cameras & connectors</h1><p>Register authorized inventory and manage connector enrollment. Creating a camera record does not establish a video stream.</p></div>
        <SpaisOperationsWorkspace visible />
      </section>}

      {active === 'governance' && <section className="cctv-page cctv-embedded-workspace" aria-labelledby="governance-title">
        <div className="cctv-page-heading"><span className="cctv-eyebrow">INCIDENTS, RECORDING & LEARNING</span><h1 id="governance-title">Governance and operational assurance</h1><p>Review incidents, SOP versions, reported recording coverage and model-evaluation attestations using an authorized organization and site.</p></div>
        <SpaisGovernanceWorkspace visible />
      </section>}

      <footer className="cctv-footer"><span><ShieldCheck size={15} /> Customer-controlled access</span><span>Camera status is never inferred without evidence</span><span>CountAI · CCTV-first frontend</span></footer>
    </main>
  </div>;
}
