import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, CheckCircle2, ClipboardCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { SpaisLearningLab } from './SpaisLearningLab';

type Incident = {
  id: string; siteId: string; title: string; description: string; sopVersionId?: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string; status: 'open' | 'acknowledged' | 'investigating' | 'resolved';
  evidenceState: string; createdAt: string;
};
type Sop = {
  id: string; siteId: string; policyId: string; version: number; title: string;
  content: string; category: string; status: 'draft' | 'in_review' | 'approved' | 'retired';
  createdBy: string; approvedBy: string | null; createdAt: string; approvedAt: string | null;
};
type CoverageAssessment = {
  reportCount: number; evaluatedReportCount: number; partialReportCount: number;
  expectedReportedSeconds: number; recordedReportedSeconds: number; reportedGapSeconds: number;
  reportedCoveragePercent: number | null; windowContinuity: string; assessment: string;
  latestReceiptAt: string | null; latestReceiptAgeSeconds: number | null; latestReportFresh: boolean;
  trustLevel: string; interpretation: string;
};
type Props = { visible: boolean };

function localDateTimeValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof body.message === 'string' ? body.message
      : typeof body.error === 'string' ? body.error : `http_${response.status}`;
    throw new Error(reason);
  }
  return body as T;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}

export function SpaisGovernanceWorkspace({ visible }: Props) {
  const [organizationId, setOrganizationId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [token, setToken] = useState('');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [sops, setSops] = useState<Sop[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [incidentTitle, setIncidentTitle] = useState('');
  const [incidentDescription, setIncidentDescription] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState<Incident['severity']>('medium');
  const [incidentSopVersionId, setIncidentSopVersionId] = useState('');
  const [sopPolicyId, setSopPolicyId] = useState('');
  const [sopTitle, setSopTitle] = useState('');
  const [sopContent, setSopContent] = useState('');
  const [sopCategory, setSopCategory] = useState('operations');
  const [transitionNotes, setTransitionNotes] = useState<Record<string, string>>({});
  const [cameraId, setCameraId] = useState('');
  const [coverageWindowStart, setCoverageWindowStart] = useState(() => localDateTimeValue(new Date(Date.now() - 60 * 60 * 1000)));
  const [coverageWindowEnd, setCoverageWindowEnd] = useState(() => localDateTimeValue(new Date()));
  const [coverageAssessment, setCoverageAssessment] = useState<CoverageAssessment | null>(null);

  const approvedSops = sops.filter(sop => sop.status === 'approved');
  const scopeKey = JSON.stringify([organizationId.trim(), siteId.trim(), token.trim()]);
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;

  function invalidateScopedData() {
    setIncidents([]);
    setSops([]);
    setCoverageAssessment(null);
    setTransitionNotes({});
    setMessage('Connection scope changed. Refresh to load records for the current organization, site, and token.');
    setIsError(false);
  }

  if (!visible) return null;

  function basePath(resource: 'incidents' | 'sops') {
    return `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/${resource}`;
  }
  function authHeaders(json = false): HeadersInit {
    return { authorization: `Bearer ${token.trim()}`, ...(json ? { 'content-type': 'application/json' } : {}) };
  }
  async function refresh() {
    if (!organizationId.trim() || !siteId.trim() || !token.trim()) {
      setIsError(true);
      setMessage('Enter organization ID, active site ID, and a trusted bearer token to connect.');
      return;
    }
    const requestScope = scopeKey;
    setBusy(true); setMessage('Loading authorized incident and SOP records…'); setIsError(false);
    try {
      const query = `?siteId=${encodeURIComponent(siteId.trim())}&limit=100`;
      const [incidentResponse, sopResponse] = await Promise.all([
        fetch(basePath('incidents') + query, { headers: authHeaders(), cache: 'no-store' }),
        fetch(basePath('sops') + query, { headers: authHeaders(), cache: 'no-store' })
      ]);
      const [incidentBody, sopBody] = await Promise.all([
        readResponse<{ incidents: Incident[] }>(incidentResponse),
        readResponse<{ sops: Sop[] }>(sopResponse)
      ]);
      if (requestScope !== currentScopeKey.current) return;
      setIncidents(incidentBody.incidents);
      setSops(sopBody.sops);
      setMessage(`Loaded ${incidentBody.incidents.length} incident(s) and ${sopBody.sops.length} SOP version(s) for the selected site.`);
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true);
      setMessage(error instanceof Error ? error.message : 'Could not load governance records.');
      setIncidents([]); setSops([]);
    } finally { setBusy(false); }
  }
  async function assessCoverage() {
    if (!organizationId.trim() || !siteId.trim() || !token.trim() || !cameraId.trim() || !coverageWindowStart || !coverageWindowEnd) {
      setIsError(true); setMessage('Enter the trusted connection details, camera ID, and reporting window.'); return;
    }
    const start = new Date(coverageWindowStart);
    const end = new Date(coverageWindowEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      setIsError(true); setMessage('The recording-assurance end time must be after the start time.'); return;
    }
    const requestScope = scopeKey;
    setBusy(true); setIsError(false); setMessage('Evaluating signed coverage reports…');
    try {
      const query = new URLSearchParams({
        siteId: siteId.trim(), windowStart: start.toISOString(), windowEnd: end.toISOString()
      });
      const response = await fetch(`/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/cameras/${encodeURIComponent(cameraId.trim())}/recording-assurance?${query}`, {
        headers: authHeaders(), cache: 'no-store'
      });
      const body = await readResponse<{ assessment: CoverageAssessment }>(response);
      if (requestScope !== currentScopeKey.current) return;
      setCoverageAssessment(body.assessment);
      setMessage(`Assessment returned: ${body.assessment.assessment.replaceAll('_', ' ')}. Connector reports are not independently verified recording proof.`);
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true); setCoverageAssessment(null);
      setMessage(error instanceof Error ? error.message : 'Could not assess recording coverage.');
    } finally { setBusy(false); }
  }
  async function submitIncident(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const response = await fetch(basePath('incidents'), {
        method: 'POST', headers: authHeaders(true),
        body: JSON.stringify({ siteId: siteId.trim(), title: incidentTitle.trim(), description: incidentDescription.trim(), severity: incidentSeverity, source: 'operator', ...(incidentSopVersionId ? { sopVersionId: incidentSopVersionId } : {}) })
      });
      await readResponse<{ incident: Incident }>(response);
      if (requestScope !== currentScopeKey.current) return;
      setIncidentTitle(''); setIncidentDescription(''); setIncidentSopVersionId('');
      await refresh();
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not create incident.');
    } finally { setBusy(false); }
  }
  async function transitionIncident(incident: Incident, status: Incident['status']) {
    const note = (transitionNotes[`incident:${incident.id}`] || '').trim();
    if (note.length < 3) { setIsError(true); setMessage('Add a transition note of at least 3 characters before changing incident status.'); return; }
    const requestScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const response = await fetch(`${basePath('incidents')}/${encodeURIComponent(incident.id)}?siteId=${encodeURIComponent(siteId.trim())}`, {
        method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ status, note })
      });
      await readResponse<{ incident: Incident }>(response);
      if (requestScope !== currentScopeKey.current) return;
      setTransitionNotes(current => ({ ...current, [`incident:${incident.id}`]: '' }));
      await refresh();
    } catch (error) { if (requestScope !== currentScopeKey.current) return; setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not update incident.'); }
    finally { setBusy(false); }
  }
  async function submitSop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const response = await fetch(basePath('sops'), {
        method: 'POST', headers: authHeaders(true),
        body: JSON.stringify({ siteId: siteId.trim(), policyId: sopPolicyId.trim(), title: sopTitle.trim(), content: sopContent.trim(), category: sopCategory })
      });
      await readResponse<{ sop: Sop }>(response);
      if (requestScope !== currentScopeKey.current) return;
      setSopTitle(''); setSopContent('');
      await refresh();
    } catch (error) { if (requestScope !== currentScopeKey.current) return; setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not create SOP version.'); }
    finally { setBusy(false); }
  }
  async function transitionSop(sop: Sop, status: Sop['status']) {
    const note = (transitionNotes[`sop:${sop.id}`] || '').trim();
    if (note.length < 3) { setIsError(true); setMessage('Add a transition note of at least 3 characters before changing SOP status.'); return; }
    const requestScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const response = await fetch(`${basePath('sops')}/${encodeURIComponent(sop.id)}?siteId=${encodeURIComponent(siteId.trim())}`, {
        method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ status, note })
      });
      await readResponse<{ sop: Sop }>(response);
      if (requestScope !== currentScopeKey.current) return;
      setTransitionNotes(current => ({ ...current, [`sop:${sop.id}`]: '' }));
      await refresh();
    } catch (error) { if (requestScope !== currentScopeKey.current) return; setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not update SOP status.'); }
    finally { setBusy(false); }
  }
  function incidentNext(status: Incident['status']): Incident['status'] | null {
    return ({ open: 'acknowledged', acknowledged: 'investigating', investigating: 'resolved', resolved: 'open' } as const)[status] || null;
  }
  function sopNext(status: Sop['status']): Sop['status'] | null {
    return ({ draft: 'in_review', in_review: 'approved', approved: 'retired', retired: null } as const)[status] || null;
  }

  return <section className="governance-page" aria-labelledby="governance-title">
    <div className="dashboard-welcome">
      <div><span className="step">SPAIS OPERATIONS / GOVERNANCE</span><h1 id="governance-title">Incidents &amp; SOPs</h1><p>Manage site-scoped incidents and versioned operating procedures through the existing authenticated APIs. Requests are sent only after you enter the connection details.</p></div>
      <span className="local-badge"><ShieldCheck size={14}/> Server-authorized</span>
    </div>
    <article className="dashboard-card governance-connect">
      <div className="dashboard-card-head"><h2>Secure connection</h2><div className="governance-header-actions"><button className="outline-button" type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15}/>{busy ? 'Working…' : 'Refresh records'}</button><button className="subtle-button" type="button" onClick={() => { setToken(''); setIncidents([]); setSops([]); setCoverageAssessment(null); setMessage('Connection cleared. The bearer token was removed from component memory.'); setIsError(false); }}>Clear token</button></div></div>
      <div className="governance-form-grid">
        <label>Organization ID<input value={organizationId} onChange={event => { setOrganizationId(event.target.value); setSiteId(''); invalidateScopedData(); }} autoComplete="off" placeholder="Organization identifier"/></label>
        <label>Active site ID<input value={siteId} onChange={event => { setSiteId(event.target.value); invalidateScopedData(); }} autoComplete="off" placeholder="Site identifier"/></label>
        <label className="governance-token">Trusted bearer token<input type="password" value={token} onChange={event => { setToken(event.target.value); invalidateScopedData(); }} autoComplete="off" spellCheck={false} placeholder="Token held in memory only"/></label>
      </div>
      <p className={`governance-notice ${isError ? 'is-error' : ''}`} role="status">{isError ? <AlertCircle size={16}/> : <CheckCircle2 size={16}/>}<span>{message || 'Token is not saved to local storage, IndexedDB, URL, or browser history. Clear it when you finish.'}</span></p>
    </article>
    <article className="dashboard-card governance-assurance">
      <div className="dashboard-card-head"><h2>Recording coverage assessment</h2><span className="governance-status">Report-based</span></div>
      <p className="governance-panel-copy">Evaluate signed recorder coverage reports for one camera and a bounded time window. This computes the reported ratio and report-window continuity; it does not independently prove that footage was captured.</p>
      <div className="governance-assurance-form">
        <label>Camera ID<input value={cameraId} onChange={event => setCameraId(event.target.value)} placeholder="Registered camera identifier" autoComplete="off"/></label>
        <label>Window start<input type="datetime-local" value={coverageWindowStart} onChange={event => setCoverageWindowStart(event.target.value)}/></label>
        <label>Window end<input type="datetime-local" value={coverageWindowEnd} onChange={event => setCoverageWindowEnd(event.target.value)}/></label>
        <button className="primary-button" type="button" onClick={() => void assessCoverage()} disabled={busy || !token.trim() || !organizationId.trim() || !siteId.trim() || !cameraId.trim()}><RefreshCw size={15}/>{busy ? 'Working…' : 'Assess reported coverage'}</button>
      </div>
      {coverageAssessment && <div className="governance-assessment-results">
        <div className="governance-assessment-metrics">
          <div><small>Reported coverage</small><strong>{coverageAssessment.reportedCoveragePercent === null ? '—' : `${coverageAssessment.reportedCoveragePercent}%`}</strong></div>
          <div><small>Reported gap</small><strong>{coverageAssessment.reportedGapSeconds.toLocaleString()}s</strong></div>
          <div><small>Windows evaluated</small><strong>{coverageAssessment.evaluatedReportCount.toLocaleString()}</strong></div>
          <div><small>Assessment</small><strong className="governance-assessment-label">{coverageAssessment.assessment.replaceAll('_', ' ')}</strong></div>
        </div>
        <p className="governance-assessment-detail">Report continuity: <b>{coverageAssessment.windowContinuity.replaceAll('_', ' ')}</b>. Latest report: {coverageAssessment.latestReceiptAt ? dateLabel(coverageAssessment.latestReceiptAt) : 'none'}{coverageAssessment.latestReportFresh ? ' · recent receipt' : ' · stale or unavailable receipt'}.</p>
        <p className="governance-panel-copy">Trust level: {coverageAssessment.trustLevel}. Interpretation: <b>{coverageAssessment.interpretation.replaceAll('_', ' ')}</b>.</p>
      </div>}
    </article>
    <div className="governance-columns">
      <article className="dashboard-card">
        <div className="dashboard-card-head"><h2>Incident register</h2><span className="governance-count">{incidents.length}</span></div>
        <form className="governance-create-form" onSubmit={event => void submitIncident(event)}>
          <label>Incident title<input required maxLength={180} value={incidentTitle} onChange={event => setIncidentTitle(event.target.value)} placeholder="Describe the operational issue"/></label>
          <label>Severity<select value={incidentSeverity} onChange={event => setIncidentSeverity(event.target.value as Incident['severity'])}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
          <label>Approved SOP version (optional)<select value={incidentSopVersionId} onChange={event => setIncidentSopVersionId(event.target.value)}><option value="">No linked SOP</option>{approvedSops.map(sop => <option key={sop.id} value={sop.id}>{sop.title} · v{sop.version}</option>)}</select></label>
          <label>Description<textarea maxLength={2000} rows={2} value={incidentDescription} onChange={event => setIncidentDescription(event.target.value)} placeholder="Optional context; do not include credentials or sensitive footage."/></label>
          <button className="primary-button" type="submit" disabled={busy || !token.trim() || !organizationId.trim() || !siteId.trim()}>Create incident</button>
        </form>
        {incidents.length ? incidents.map(incident => {
          const next = incidentNext(incident.status);
          return <div className="governance-record" key={incident.id}>
            <div className="governance-record-heading"><b>{incident.title}</b><span className={`governance-status status-${incident.status}`}>{incident.status.replace('_', ' ')}</span></div>
            <p>{incident.description || 'No description supplied.'}</p>
            {incident.sopVersionId && <small>Linked SOP: {sops.find(sop => sop.id === incident.sopVersionId)?.title || incident.sopVersionId}{sops.find(sop => sop.id === incident.sopVersionId) ? ` · v${sops.find(sop => sop.id === incident.sopVersionId)?.version}` : ''}</small>}
            <small>{incident.severity.toUpperCase()} · {dateLabel(incident.createdAt)}{incident.evidenceState === 'reported_not_independently_verified' ? ' · Recorder report not independently verified' : ''}</small>
            {next && <div className="governance-transition"><input aria-label={`Transition note for ${incident.title}`} value={transitionNotes[`incident:${incident.id}`] || ''} onChange={event => setTransitionNotes(current => ({ ...current, [`incident:${incident.id}`]: event.target.value }))} placeholder="Required audit note (3+ chars)"/><button className="subtle-button" type="button" disabled={busy} onClick={() => void transitionIncident(incident, next)}>{next === 'open' ? 'Reopen' : `Mark ${next}`}</button></div>}
          </div>;
        }) : <p className="governance-empty">No incident records loaded. Connect to an active site and refresh.</p>}
      </article>
      <article className="dashboard-card">
        <div className="dashboard-card-head"><h2>SOP / policy versions</h2><span className="governance-count">{sops.length}</span></div>
        <form className="governance-create-form" onSubmit={event => void submitSop(event)}>
          <label>Stable policy ID<input required maxLength={128} value={sopPolicyId} onChange={event => setSopPolicyId(event.target.value)} placeholder="e.g. recording-assurance"/></label>
          <label>Title<input required maxLength={180} value={sopTitle} onChange={event => setSopTitle(event.target.value)} placeholder="Procedure title"/></label>
          <label>Category<select value={sopCategory} onChange={event => setSopCategory(event.target.value)}><option value="operations">Operations</option><option value="safety">Safety</option><option value="security">Security</option><option value="recording_assurance">Recording assurance</option><option value="privacy">Privacy</option><option value="other">Other</option></select></label>
          <label>Procedure content<textarea required maxLength={12000} rows={3} value={sopContent} onChange={event => setSopContent(event.target.value)} placeholder="Write the operating steps and escalation criteria."/></label>
          <button className="primary-button" type="submit" disabled={busy || !token.trim() || !organizationId.trim() || !siteId.trim()}>Create draft version</button>
        </form>
        {sops.length ? sops.map(sop => {
          const next = sopNext(sop.status);
          return <div className="governance-record" key={sop.id}>
            <div className="governance-record-heading"><b>{sop.title} <small>v{sop.version}</small></b><span className={`governance-status status-${sop.status}`}>{sop.status.replace('_', ' ')}</span></div>
            <p>{sop.content}</p><small>{sop.category.replace('_', ' ')} · Policy {sop.policyId} · {dateLabel(sop.createdAt)}{sop.approvedBy ? ' · Independently approved' : ''}</small>
            {next && <div className="governance-transition"><input aria-label={`Transition note for ${sop.title}`} value={transitionNotes[`sop:${sop.id}`] || ''} onChange={event => setTransitionNotes(current => ({ ...current, [`sop:${sop.id}`]: event.target.value }))} placeholder="Required audit note (3+ chars)"/><button className="subtle-button" type="button" disabled={busy} onClick={() => void transitionSop(sop, next)}>{next === 'in_review' ? 'Submit for review' : next === 'approved' ? 'Approve version' : 'Retire version'}</button></div>}
            {sop.status === 'in_review' && <small className="governance-approval-hint">Approval requires the separate sop:approve permission and a different actor from the author.</small>}
          </div>;
        }) : <p className="governance-empty">No SOP versions loaded. Create a draft to begin a versioned approval workflow.</p>}
      </article>
    </div>
    <SpaisLearningLab organizationId={organizationId} siteId={siteId} token={token} />
    <p className="governance-footnote"><ClipboardCheck size={15}/> Server-side authorization remains authoritative. This workspace does not persist bearer tokens. API availability still depends on trusted identity-provider configuration and the server's persistent SQLite path.</p>
  </section>;
}
