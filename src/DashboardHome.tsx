import { Activity, ArrowRight, BarChart3, Camera, ImagePlus, Layers3, ShieldCheck, Sparkles } from 'lucide-react';
import type { CountSession } from './types/counting';

type Workspace = 'dashboard' | 'live' | 'photo' | 'history' | 'analytics';
type Props = {
  sessions: CountSession[];
  onNavigate: (workspace: Workspace) => void;
  onOpenSession: (session: CountSession) => void;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function DashboardHome({ sessions, onNavigate, onOpenSession }: Props) {
  const validSessions = sessions.filter(session => Number.isFinite(Date.parse(session.createdAt)));
  const detections = validSessions.reduce((sum, session) => sum + (Array.isArray(session.detections) ? session.detections.length : 0), 0);
  const corrected = validSessions.reduce((sum, session) => sum + (Array.isArray(session.detections) ? session.detections.filter(item => item.source === 'manual').length : 0), 0);
  const recent = [...validSessions].sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0,5);
  const today = new Date().toLocaleDateString();
  const todaySessions = validSessions.filter(session => new Date(session.createdAt).toLocaleDateString() === today).length;

  return <section className="dashboard-page" aria-labelledby="dashboard-title">
    <div className="dashboard-welcome">
      <div>
        <span className="step">SPAIS OPERATIONS / OVERVIEW</span>
        <h1 id="dashboard-title">Your operations, at a glance.</h1>
        <p>Monitor the capabilities available in this build, open counting workflows, and review local activity. Camera and recorder integrations are shown separately so unavailable evidence is never mistaken for healthy status.</p>
      </div>
      <span className="local-badge"><ShieldCheck size={14}/> Private by default</span>
    </div>
    <div className="dashboard-grid">
      <article className="dashboard-card dashboard-metric">
        <span className="metric-label">Saved sessions</span><strong>{validSessions.length}</strong><small>Photo sessions stored on this device</small>
      </article>
      <article className="dashboard-card dashboard-metric">
        <span className="metric-label">Recorded detections</span><strong>{detections.toLocaleString()}</strong><small>Observed labels across saved sessions</small>
      </article>
      <article className="dashboard-card dashboard-metric">
        <span className="metric-label">Manual corrections</span><strong>{corrected.toLocaleString()}</strong><small>Labels added or edited by you</small>
      </article>
      <article className="dashboard-card dashboard-metric">
        <span className="metric-label">Sessions today</span><strong>{todaySessions}</strong><small>Based on this device's local date</small>
      </article>

      <article className="dashboard-card dashboard-action">
        <div className="dashboard-action-icon"><Camera size={20}/></div>
        <h2>Live counter</h2>
        <p>Count line crossings from a camera attached to this browser. Start a live session when you're ready.</p>
        <button className="primary-button" onClick={() => onNavigate('live')}>Open live counter <ArrowRight size={15}/></button>
      </article>
      <article className="dashboard-card dashboard-action">
        <div className="dashboard-action-icon"><ImagePlus size={20}/></div>
        <h2>Photo count & review</h2>
        <p>Analyze a photo locally, review detections, and correct labels before exporting your results.</p>
        <button className="outline-button" onClick={() => onNavigate('photo')}>Count a photo <ArrowRight size={15}/></button>
      </article>
      <article className="dashboard-card dashboard-action">
        <div className="dashboard-action-icon"><BarChart3 size={20}/></div>
        <h2>Analytics</h2>
        <p>Review saved photo activity, category totals, and correction history over time.</p>
        <button className="outline-button" onClick={() => onNavigate('analytics')}>View analytics <ArrowRight size={15}/></button>
      </article>

      <article className="dashboard-card dashboard-recent">
        <div className="dashboard-card-head">
          <h2>Recent records</h2>
          <button className="dashboard-link" onClick={() => onNavigate('history')}>Full history <ArrowRight size={14}/></button>
        </div>
        {recent.length ? recent.map(session => <div className="dashboard-session" key={session.id}>
          <span className="dashboard-session-icon"><Layers3 size={17}/></span>
          <div className="dashboard-session-main"><strong>{session.title || 'Untitled session'}</strong><small>{formatDate(session.createdAt)} · {session.target || 'All supported objects'}</small></div>
          <span className="dashboard-session-count">{Array.isArray(session.detections) ? session.detections.length : 0}</span>
          <button className="icon-button" aria-label={'Open ' + (session.title || 'saved session')} onClick={() => onOpenSession(session)}><ArrowRight size={15}/></button>
        </div>) : <div className="dashboard-empty">
          <Sparkles size={24} color="#438a76"/>
          <strong>Your history starts here</strong>
          <p>Analyze a photo and save its results. Your latest sessions and totals will appear here automatically.</p>
          <button className="primary-button" onClick={() => onNavigate('photo')}>Create your first count <ArrowRight size={15}/></button>
        </div>}
      </article>
      <article className="dashboard-card dashboard-side" aria-labelledby="spais-readiness-title">
        <div className="dashboard-card-head"><h2 id="spais-readiness-title">SPAIS capability readiness</h2><Activity size={17} color="#3b8c76"/></div>
        <div className="dashboard-stat-row"><span>Photo detection & review</span><strong>Available</strong></div>
        <div className="dashboard-stat-row"><span>Browser-attached live camera</span><strong>Available</strong></div>
        <div className="dashboard-stat-row"><span>Local photo history</span><strong>{validSessions.length ? 'Available' : 'No records yet'}</strong></div>
        <div className="dashboard-stat-row"><span>Customer edge connector</span><strong>Not connected</strong></div>
        <div className="dashboard-stat-row"><span>NVR recording assurance</span><strong>Not connected</strong></div>
        <div className="dashboard-stat-row"><span>Incidents, SOP governance & learning</span><strong>Planned</strong></div>
        <p style={{fontSize:10,lineHeight:1.65,color:'#84928b',margin:'14px 0 0'}}>Status reflects this application build, not a remote health check. Browser camera access does not verify an NVR, recording coverage, or customer-network connectivity.</p>
      </article>
    </div>
  </section>;
}
