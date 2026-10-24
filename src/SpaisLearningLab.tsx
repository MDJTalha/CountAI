import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Beaker, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';

type CandidateStatus = 'proposed' | 'under_review' | 'evaluation_pending' | 'rejected';
type Candidate = {
  id: string; organizationId: string; siteId: string; title: string; rationale: string;
  baselineVersion: string; proposedVersion: string;
  changeType: 'model_weights' | 'thresholds' | 'preprocessing' | 'rule_set';
  artifactSha256: string; evaluationDatasetSha256: string; evaluationPlan: string[];
  status: CandidateStatus; createdBy: string; createdAt: string; updatedAt: string; lastNote: string | null;
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

  useEffect(() => {
    setCandidates([]);
    setMessage('');
    setIsError(false);
  }, [organizationId, siteId]);

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
    setBusy(true); setIsError(false);
    try {
      const query = new URLSearchParams({ siteId: siteId.trim(), limit: '100' });
      const response = await fetch(path() + '?' + query, { headers: headers(), cache: 'no-store' });
      const body = await readResponse<{ candidates: Candidate[]; count: number }>(response);
      setCandidates(body.candidates);
      setMessage(`Loaded ${body.count} learning proposal(s). No model was evaluated or deployed by this registry.`);
    } catch (error) {
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not load learning proposals.');
      setCandidates([]);
    } finally { setBusy(false); }
  }
  async function createCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const evaluationPlan = evaluationPlanText.split('\n').map(item => item.trim()).filter(Boolean);
    if (evaluationPlan.length < 1 || evaluationPlan.length > 12) {
      setIsError(true); setMessage('The evaluation plan must contain between 1 and 12 non-empty steps.'); return;
    }
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
      setTitle(''); setRationale(''); setProposedVersion(''); setArtifactSha256(''); setEvaluationDatasetSha256('');
      await loadCandidates();
    } catch (error) {
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not create learning proposal.');
    } finally { setBusy(false); }
  }
  async function transition(candidate: Candidate, status: CandidateStatus) {
    const note = (notes[candidate.id] || '').trim();
    if (note.length < 3) { setIsError(true); setMessage('Add an audit note of at least 3 characters before changing candidate status.'); return; }
    setBusy(true); setIsError(false);
    try {
      const response = await fetch(path() + '/' + encodeURIComponent(candidate.id) + '?' + new URLSearchParams({ siteId: siteId.trim() }), {
        method: 'PATCH', headers: headers(true), body: JSON.stringify({ status, note })
      });
      await readResponse<{ candidate: Candidate }>(response);
      setNotes(current => ({ ...current, [candidate.id]: '' }));
      await loadCandidates();
    } catch (error) {
      setIsError(true); setMessage(error instanceof Error ? error.message : 'Could not update learning proposal.');
    } finally { setBusy(false); }
  }

  return <section className="dashboard-card learning-lab" aria-labelledby="learning-lab-title">
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
        <div className="learning-candidate-heading"><div><b>{candidate.title}</b><small>{candidate.baselineVersion} → {candidate.proposedVersion} · {candidate.changeType.replace('_', ' ')}</small></div><span className={`governance-status status-${candidate.status}`}>{statusLabel(candidate.status)}</span></div>
        <p>{candidate.rationale}</p>
        <small>Artifact {candidate.artifactSha256.slice(0, 12)}… · Holdout {candidate.evaluationDatasetSha256.slice(0, 12)}… · Submitted by {candidate.createdBy}</small>
        <ol>{candidate.evaluationPlan.map((step, index) => <li key={index}>{step}</li>)}</ol>
        {candidate.lastNote && <p className="learning-last-note"><b>Latest review note:</b> {candidate.lastNote}</p>}
        {allowedNext.length > 0 && <div className="learning-transition"><input aria-label={`Audit note for ${candidate.title}`} value={notes[candidate.id] || ''} onChange={event => setNotes(current => ({ ...current, [candidate.id]: event.target.value }))} placeholder="Required audit note (3+ chars)"/>{allowedNext.map(next => <button className={next === 'rejected' ? 'subtle-button' : 'outline-button'} type="button" key={next} disabled={busy} onClick={() => void transition(candidate, next)}>{next === 'under_review' ? 'Submit for review' : next === 'evaluation_pending' ? 'Approve offline evaluation' : 'Reject'}</button>)}</div>}
      </article>;
    }) : <p className="governance-empty">No learning proposals loaded. Load existing proposals or register a candidate for offline evaluation review.</p>}
    <p className="governance-footnote"><ShieldCheck size={15}/> This registry stores metadata and SHA-256 identifiers only. It does not accept model artifacts, execute evaluation, train models, or change production inference behavior.</p>
  </section>;
}
