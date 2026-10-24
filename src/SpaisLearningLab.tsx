import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Beaker, RefreshCw, ShieldAlert, ShieldCheck, Upload, Video, BookOpen } from 'lucide-react';

type CandidateStatus = 'proposed' | 'under_review' | 'evaluation_pending' | 'rejected';
type Candidate = {
  id: string; organizationId: string; siteId: string; title: string; rationale: string;
  baselineVersion: string; proposedVersion: string;
  changeType: 'model_weights' | 'thresholds' | 'preprocessing' | 'rule_set';
  artifactSha256: string; evaluationDatasetSha256: string; evaluationPlan: string[];
  status: CandidateStatus; createdBy: string; createdAt: string; updatedAt: string; lastNote: string | null;
  evaluationStatus: 'not_run' | 'passed' | 'failed'; latestEvaluationId: string | null;
};
type Evaluation = {
  id: string; runId: string; evaluatorVersion: string; evaluatorKeyId: string;
  evaluatedAt: string; receivedAt: string; sampleCount: number; precision: number;
  recall: number; falsePositiveRate: number; result: 'passed' | 'failed';
  thresholds: { minSampleCount: number; minPrecision: number; minRecall: number; maxFalsePositiveRate: number };
  attestationSha256: string;
};
type Props = { organizationId: string; siteId: string; token: string };

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof body.message === 'string' ? body.message
      : typeof body.error === 'string' ? body.error : `http_${response.status}`;
    throw new Error(reason);
  }
  return body as T;
}

function statusLabel(status: CandidateStatus) {
  return status === 'evaluation_pending' ? 'Approved for offline evaluation' : status.replace('_', ' ');
}

type LearningSource = {
  id: string; sourceType: 'document' | 'image' | 'observation' | 'video_recording';
  title: string; description: string; fileName: string | null; mimeType: string | null;
  sha256: string | null; byteSize: number; labels: string[]; status: string;
  createdAt: string; mediaStored: boolean; learningState: string; observedAt: string | null;
};

function LearningSourcesPanel({ organizationId, siteId, token }: Props) {
  const [sources, setSources] = useState<LearningSource[]>([]);
  const [sourceType, setSourceType] = useState<LearningSource['sourceType']>('observation');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [contentText, setContentText] = useState('');
  const [cameraId, setCameraId] = useState('');
  const [labelsText, setLabelsText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const scopeKey = JSON.stringify([organizationId.trim(), siteId.trim(), token.trim()]);
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;

  useEffect(() => {
    setSources([]);
    setMessage('');
    setFile(null);
  }, [organizationId, siteId, token]);

  async function loadSources() {
    if (!organizationId.trim() || !siteId.trim() || !token.trim()) {
      setIsError(true); setMessage('Connect an authorized organization, site, and bearer token first.'); return;
    }
    const requestedScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const query = new URLSearchParams({ siteId: siteId.trim(), limit: '100' });
      const response = await fetch('/api/v1/organizations/' + encodeURIComponent(organizationId.trim()) + '/learning-sources?' + query, {
        headers: { authorization: 'Bearer ' + token.trim() }, cache: 'no-store'
      });
      const body = await readResponse<{ sources: LearningSource[]; count: number }>(response);
      if (requestedScope !== currentScopeKey.current) return;
      setSources(body.sources);
      setMessage('Loaded ' + body.count + ' learning source(s). Sources await review/annotation; ingestion alone does not train a model.');
    } catch (error) {
      if (requestedScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not load learning sources.');
    } finally { setBusy(false); }
  }

  async function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authorized) { setIsError(true); setMessage('Confirm that you are authorized to use this data before uploading.'); return; }
    if (!organizationId.trim() || !siteId.trim() || !token.trim()) { setIsError(true); setMessage('Connect an authorized organization and site first.'); return; }
    if (file && file.size > 8 * 1024 * 1024) { setIsError(true); setMessage('Each media file must be 8 MB or smaller in this initial ingestion version.'); return; }
    if (['document','image','video_recording'].includes(sourceType) && !file) { setIsError(true); setMessage('Choose a file for the selected source type.'); return; }
    if (sourceType === 'observation' && !contentText.trim()) { setIsError(true); setMessage('Enter an observation note.'); return; }
    const requestedScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const payload: Record<string, unknown> = {
        siteId: siteId.trim(), sourceType, title: title.trim(), description: description.trim(),
        consentConfirmed: true, labels: labelsText.split(',').map(item => item.trim()).filter(Boolean),
        ...(cameraId.trim() ? { cameraId: cameraId.trim() } : {}),
        ...(contentText.trim() ? { contentText: contentText.trim() } : {}),
        observedAt: new Date().toISOString()
      };
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
        }
        const extension = file.name.toLowerCase().split('.').pop();
        const inferredMime: Record<string, string> = {
          txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
          csv: 'text/csv', json: 'application/json', pdf: 'application/pdf',
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
          webm: 'video/webm', mp4: 'video/mp4'
        };
        payload.fileName = file.name;
        payload.mimeType = file.type || inferredMime[extension || ''] || '';
        payload.fileBase64 = btoa(binary);
        if (sourceType === 'document' && ['text/plain','text/markdown','text/csv','application/json'].includes(String(payload.mimeType))) {
          payload.contentText = await file.text();
        }
      }
      const response = await fetch('/api/v1/organizations/' + encodeURIComponent(organizationId.trim()) + '/learning-sources', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token.trim(), 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      await readResponse<{ source: LearningSource }>(response);
      if (requestedScope !== currentScopeKey.current) return;
      setTitle(''); setDescription(''); setContentText(''); setLabelsText(''); setFile(null); setAuthorized(false);
      setMessage('Source securely ingested into the customer-host learning registry. Human review/annotation is still required before it can be used for training.');
      await loadSources();
    } catch (error) {
      if (requestedScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not ingest the learning source.');
    } finally { setBusy(false); }
  }

  return <section className="dashboard-card learning-lab learning-sources-panel" aria-labelledby="learning-sources-title">
    <div className="dashboard-card-head"><div><span className="step">COUNTAl / AUTONOMOUS LEARNING</span><h2 id="learning-sources-title">Learning data & observations</h2></div><button className="outline-button" type="button" onClick={() => void loadSources()} disabled={busy}><RefreshCw size={15}/>{busy ? 'Working…' : 'Load sources'}</button></div>
    <div className="learning-boundary"><ShieldCheck size={17}/><span>Customer-controlled ingestion with explicit authorization. Uploading a source does not automatically label data, train a neural network, or deploy a model. Raw media stays on the configured CountAI host.</span></div>
    <form className="learning-create-form" onSubmit={event => void submitSource(event)}>
      <div className="learning-form-grid">
        <label>Source type<select value={sourceType} onChange={event => { setSourceType(event.target.value as LearningSource['sourceType']); setFile(null); setContentText(''); }}><option value="observation">Human observation / correction</option><option value="document">Document / SOP / PDF</option><option value="image">Reference image</option><option value="video_recording">Authorized video recording clip</option></select></label>
        <label>Title<input required maxLength={180} value={title} onChange={event => setTitle(event.target.value)} placeholder="Describe this source"/></label>
        <label>Camera ID (optional)<input maxLength={128} value={cameraId} onChange={event => setCameraId(event.target.value)} placeholder="Registered camera ID"/></label>
        <label>Labels (comma-separated)<input value={labelsText} onChange={event => setLabelsText(event.target.value)} placeholder="queue, entrance, line-crossing"/></label>
      </div>
      <label>Description / context<textarea rows={2} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} placeholder="Site, time, scenario, correction or intended use"/></label>
      {sourceType === 'observation' && <label>Observation / human correction<textarea required rows={3} maxLength={4000} value={contentText} onChange={event => setContentText(event.target.value)} placeholder="What happened, what the model missed, and the correct interpretation"/></label>}
      {sourceType === 'document' && <label>Optional extracted text<textarea rows={3} maxLength={10000} value={contentText} onChange={event => setContentText(event.target.value)} placeholder="Paste text if extraction is needed; text files are indexed automatically"/></label>}
      {sourceType !== 'observation' && <label className="learning-file-picker"><span><Upload size={16}/> Choose authorized {sourceType === 'image' ? 'image' : sourceType === 'video_recording' ? 'video clip' : 'document'}</span><input type="file" accept={sourceType === 'image' ? 'image/jpeg,image/png,image/webp' : sourceType === 'video_recording' ? 'video/mp4,video/webm' : '.txt,.md,.csv,.json,.pdf,text/plain,text/markdown,text/csv,application/json,application/pdf'} onChange={event => setFile(event.target.files?.[0] || null)}/>{file && <small>{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</small>}</label>}
      {sourceType === 'video_recording' && <p className="learning-help"><Video size={15}/> Upload a short clip exported from an authorized recorder. Direct continuous capture from network CCTV requires the stream adapter and recording session service, which are separate implementation gates.</p>}
      <label className="learning-consent"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} required/><span>I confirm I am authorized to submit this material and that it follows the organization's privacy, consent, retention and access policies.</span></label>
      <button className="primary-button" type="submit" disabled={busy || !organizationId.trim() || !siteId.trim() || !token.trim() || !authorized}><Upload size={15}/>{busy ? 'Ingesting…' : 'Ingest learning source'}</button>
    </form>
    {message && <p className={'learning-message ' + (isError ? 'is-error' : '')} role="status">{message}</p>}
    {sources.length > 0 && <div className="learning-source-list">{sources.map(source => <article className="learning-candidate" key={source.id}><div className="learning-candidate-heading"><div><b>{source.title}</b><small>{source.sourceType.replace('_',' ')} · {source.fileName || 'Text / observation'} · {new Date(source.createdAt).toLocaleString()}</small></div><span className="governance-status status-under_review">{source.status.replaceAll('_',' ')}</span></div><p>{source.description || 'No additional context supplied.'}</p><small>{source.mediaStored ? 'Media stored on customer host' : 'Text/metadata record'} · {source.sha256 ? 'SHA-256 ' + source.sha256.slice(0,16) + '…' : 'No binary hash'} · Learning state: {source.learningState.replaceAll('_',' ')}</small></article>)}</div>}
    <div className="learning-tip"><BookOpen size={16}/><span>Pipeline status: ingest → human annotation/validation → versioned dataset → model-specific training job → holdout evaluation → governed approval. This initial stage implements source ingestion and traceability; the training worker and real-time stream adapter remain separate stages.</span></div>
  </section>;
}

export function SpaisLearningLab({ organizationId, siteId, token }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [baselineVersion, setBaselineVersion] = useState('');
  const [proposedVersion, setProposedVersion] = useState('');
  const [changeType, setChangeType] = useState<Candidate['changeType']>('thresholds');
  const [artifactSha256, setArtifactSha256] = useState('');
  const [evaluationDatasetSha256, setEvaluationDatasetSha256] = useState('');
  const [evaluationPlanText, setEvaluationPlanText] = useState('Use a separate, consented holdout set with no training-data overlap.\nReport precision, recall, false-positive rate, and confidence intervals.\nCompare against the pinned baseline and pre-agreed acceptance thresholds.');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [evaluationHistory, setEvaluationHistory] = useState<Record<string, Evaluation[]>>({});
  const scopeKey = JSON.stringify([organizationId.trim(), siteId.trim(), token.trim()]);
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;

  useEffect(() => {
    setCandidates([]);
    setEvaluationHistory({});
    setMessage('');
    setIsError(false);
  }, [organizationId, siteId, token]);

  function path() {
    return `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/model-candidates`;
  }
  function headers(json = false): HeadersInit {
    return { authorization: `Bearer ${token.trim()}`, ...(json ? { 'content-type': 'application/json' } : {}) };
  }
  async function loadCandidates() {
    if (!organizationId.trim() || !siteId.trim() || !token.trim()) {
      setIsError(true); setMessage('Connect a trusted token and choose an organization and site first.'); return;
    }
    const requestScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const query = new URLSearchParams({ siteId: siteId.trim(), limit: '100' });
      const response = await fetch(path() + '?' + query, { headers: headers(), cache: 'no-store' });
      const body = await readResponse<{ candidates: Candidate[]; count: number }>(response);
      if (requestScope !== currentScopeKey.current) return;
      setCandidates(body.candidates);
      setMessage(`Loaded ${body.count} learning proposal(s). No model was evaluated or deployed by this registry.`);
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not load learning proposals.');
      setCandidates([]);
    } finally { setBusy(false); }
  }
  async function loadEvaluations(candidate: Candidate) {
    if (!token.trim()) { setIsError(true); setMessage('A trusted bearer token is required to read evaluation reports.'); return; }
    const requestScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const query = new URLSearchParams({ siteId: siteId.trim(), limit: '100' });
      const response = await fetch(path() + '/' + encodeURIComponent(candidate.id) + '/evaluations?' + query, {
        headers: headers(), cache: 'no-store'
      });
      const body = await readResponse<{ evaluations: Evaluation[]; count: number }>(response);
      if (requestScope !== currentScopeKey.current) return;
      setEvaluationHistory(current => ({ ...current, [candidate.id]: body.evaluations }));
      setMessage(`Loaded ${body.count} signed evaluation report(s). A passing result is not production approval.`);
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not load evaluation reports.');
    } finally { setBusy(false); }
  }
  async function createCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const evaluationPlan = evaluationPlanText.split('\n').map(item => item.trim()).filter(Boolean);
    if (evaluationPlan.length < 1 || evaluationPlan.length > 12) {
      setIsError(true); setMessage('The evaluation plan must contain between 1 and 12 non-empty steps.'); return;
    }
    const requestScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const response = await fetch(path(), {
        method: 'POST', headers: headers(true),
        body: JSON.stringify({
          siteId: siteId.trim(), title: title.trim(), rationale: rationale.trim(),
          baselineVersion: baselineVersion.trim(), proposedVersion: proposedVersion.trim(),
          changeType, artifactSha256: artifactSha256.trim(),
          evaluationDatasetSha256: evaluationDatasetSha256.trim(), evaluationPlan
        })
      });
      await readResponse<{ candidate: Candidate }>(response);
      if (requestScope !== currentScopeKey.current) return;
      setTitle(''); setRationale(''); setProposedVersion(''); setArtifactSha256(''); setEvaluationDatasetSha256('');
      await loadCandidates();
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not create learning proposal.');
    } finally { setBusy(false); }
  }
  async function transition(candidate: Candidate, status: CandidateStatus) {
    const note = (notes[candidate.id] || '').trim();
    if (note.length < 3) { setIsError(true); setMessage('Add an audit note of at least 3 characters before changing candidate status.'); return; }
    const requestScope = scopeKey;
    setBusy(true); setIsError(false);
    try {
      const response = await fetch(path() + '/' + encodeURIComponent(candidate.id) + '?' + new URLSearchParams({ siteId: siteId.trim() }), {
        method: 'PATCH', headers: headers(true), body: JSON.stringify({ status, note })
      });
      await readResponse<{ candidate: Candidate }>(response);
      if (requestScope !== currentScopeKey.current) return;
      setNotes(current => ({ ...current, [candidate.id]: '' }));
      await loadCandidates();
    } catch (error) {
      if (requestScope !== currentScopeKey.current) return;
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not update learning proposal.');
    } finally { setBusy(false); }
  }

  return <div className="learning-workbench"><LearningSourcesPanel organizationId={organizationId} siteId={siteId} token={token}/><section className="dashboard-card learning-lab" aria-labelledby="learning-lab-title">
    <div className="dashboard-card-head"><div><span className="step">SPAIS / GOVERNED LEARNING</span><h2 id="learning-lab-title">Learning proposals</h2></div><button className="outline-button" type="button" onClick={() => void loadCandidates()} disabled={busy}><RefreshCw size={15}/>{busy ? 'Working…' : 'Load proposals'}</button></div>
    <div className="learning-boundary"><ShieldAlert size={17}/><span>This is a proposal registry, not an autonomous evaluator. Approval means permission to run offline evaluation only. There is no shadow, canary, or production promotion endpoint in this workflow.</span></div>
    <form className="learning-create-form" onSubmit={event => void createCandidate(event)}>
      <label>Proposal title<input required maxLength={180} value={title} onChange={event => setTitle(event.target.value)} placeholder="What improvement should be evaluated?"/></label>
      <label>Rationale<textarea required maxLength={2000} rows={2} value={rationale} onChange={event => setRationale(event.target.value)} placeholder="Expected benefit and risks"/></label>
      <div className="learning-form-grid">
        <label>Baseline version<input required maxLength={64} value={baselineVersion} onChange={event => setBaselineVersion(event.target.value)} placeholder="Current version"/></label>
        <label>Proposed version<input required maxLength={64} value={proposedVersion} onChange={event => setProposedVersion(event.target.value)} placeholder="Candidate version"/></label>
        <label>Change type<select value={changeType} onChange={event => setChangeType(event.target.value as Candidate['changeType'])}><option value="thresholds">Thresholds</option><option value="preprocessing">Preprocessing</option><option value="rule_set">Rule set</option><option value="model_weights">Model weights</option></select></label>
        <label>Candidate artifact SHA-256<input required pattern="[a-fA-F0-9]{64}" minLength={64} maxLength={64} value={artifactSha256} onChange={event => setArtifactSha256(event.target.value)} placeholder="64 hexadecimal characters"/></label>
        <label>Evaluation dataset SHA-256<input required pattern="[a-fA-F0-9]{64}" minLength={64} maxLength={64} value={evaluationDatasetSha256} onChange={event => setEvaluationDatasetSha256(event.target.value)} placeholder="64 hexadecimal characters"/></label>
      </div>
      <label>Offline evaluation plan<textarea required rows={3} value={evaluationPlanText} onChange={event => setEvaluationPlanText(event.target.value)} placeholder="One evaluation step per line"/></label>
      <button className="primary-button" type="submit" disabled={busy || !organizationId.trim() || !siteId.trim() || !token.trim()}><Beaker size={15}/> Register proposal</button>
    </form>
    {message && <p className={`learning-message ${isError ? 'is-error' : ''}`} role="status">{message}</p>}
    {candidates.length ? candidates.map(candidate => {
      const allowedNext: CandidateStatus[] = candidate.status === 'proposed' ? ['under_review', 'rejected']
        : candidate.status === 'under_review' ? ['evaluation_pending', 'rejected']
        : candidate.status === 'evaluation_pending' ? ['rejected'] : [];
      return <article className="learning-candidate" key={candidate.id}>
        <div className="learning-candidate-heading"><div><b>{candidate.title}</b><small>{candidate.baselineVersion} → {candidate.proposedVersion} · {candidate.changeType.replace('_', ' ')}</small></div><div className="learning-status-stack"><span className={`governance-status status-${candidate.status}`}>{statusLabel(candidate.status)}</span><span className={`governance-status ${candidate.evaluationStatus === 'passed' ? 'status-approved' : candidate.evaluationStatus === 'failed' ? 'status-open' : ''}`}>Evaluation: {candidate.evaluationStatus.replace('_', ' ')}</span></div></div>
        <p>{candidate.rationale}</p>
        <small>Artifact {candidate.artifactSha256.slice(0, 12)}… · Holdout {candidate.evaluationDatasetSha256.slice(0, 12)}… · Submitted by {candidate.createdBy}</small>
        <ol>{candidate.evaluationPlan.map((step, index) => <li key={index}>{step}</li>)}</ol>
        {candidate.lastNote && <p className="learning-last-note"><b>Latest review note:</b> {candidate.lastNote}</p>}
        <div className="learning-evaluation-actions"><button className="subtle-button" type="button" disabled={busy} onClick={() => void loadEvaluations(candidate)}>{busy ? 'Working…' : 'View signed evaluation reports'}</button>{candidate.evaluationStatus === 'passed' && <small>Evaluation thresholds passed; this does not approve a production release.</small>}</div>
        {evaluationHistory[candidate.id] && <div className="learning-evaluation-history">{evaluationHistory[candidate.id].length ? evaluationHistory[candidate.id].map(evaluation => <div className="learning-evaluation-item" key={evaluation.id}>
          <div><b>{evaluation.result.toUpperCase()}</b><small>Run {evaluation.runId} · {new Date(evaluation.evaluatedAt).toLocaleString()}</small></div>
          <p>Samples {evaluation.sampleCount.toLocaleString()} · Precision {(evaluation.precision * 100).toFixed(2)}% · Recall {(evaluation.recall * 100).toFixed(2)}% · False positives {(evaluation.falsePositiveRate * 100).toFixed(2)}%</p>
          <small>Evaluator {evaluation.evaluatorVersion} ({evaluation.evaluatorKeyId}) · Attestation {evaluation.attestationSha256.slice(0, 16)}…</small>
        </div>) : <p className="governance-empty">No signed evaluation reports have been recorded for this proposal.</p>}</div>}
        {allowedNext.length > 0 && <div className="learning-transition"><input aria-label={`Audit note for ${candidate.title}`} value={notes[candidate.id] || ''} onChange={event => setNotes(current => ({ ...current, [candidate.id]: event.target.value }))} placeholder="Required audit note (3+ chars)"/>{allowedNext.map(next => <button className={next === 'rejected' ? 'subtle-button' : 'outline-button'} type="button" key={next} disabled={busy} onClick={() => void transition(candidate, next)}>{next === 'under_review' ? 'Submit for review' : next === 'evaluation_pending' ? 'Approve offline evaluation' : 'Reject'}</button>)}</div>}
      </article>;
    }) : <p className="governance-empty">No learning proposals loaded. Load existing proposals or register a candidate for offline evaluation review.</p>}
    <p className="governance-footnote"><ShieldCheck size={15}/> This registry stores metadata and SHA-256 identifiers only. It does not accept model artifacts, execute evaluation, train models, or change production inference behavior.</p>
  </section></div>;
}
