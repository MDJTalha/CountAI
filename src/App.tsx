import { useEffect, useRef, useState } from 'react';
import { Camera, Check, ChevronRight, CircleHelp, Download, ImagePlus, LoaderCircle, Plus, ScanSearch, ShieldCheck, Smartphone, Trash2, Upload, Wifi, X } from 'lucide-react';

import { LiveCounter } from './LiveCounter';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import { formatDetectionOverlayLabel } from './engine/detectionOverlay.mjs';
import { DashboardHome } from './DashboardHome';
import { SpaisGovernanceWorkspace } from './SpaisGovernanceWorkspace';
import { SpaisOperationsWorkspace } from './SpaisOperationsWorkspace';
import { totalsByCategory } from './engine/counting';
import { listSessions, saveSession, deleteSession } from './storage/sessions';
import type { CountSession, Detection } from './types/counting';


// Lazy-load the heavy TensorFlow/COCO-SSD module on first use.
let detectorPromise: Promise<import('./engine/localDetector').CocoSsdDetector> | null = null;

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = import('./engine/localDetector')
      .then(({ CocoSsdDetector }) => new CocoSsdDetector())
      .catch(error => {
        detectorPromise = null;
        throw error;
      });
  }
  return detectorPromise;
}
const MAX_FILE = 12 * 1024 * 1024;
export function App() {
  const [activeWorkspace, setActiveWorkspace] = useState<'dashboard' | 'live' | 'photo' | 'history' | 'analytics' | 'governance' | 'operations'>('dashboard');
  const fileRef = useRef<HTMLInputElement>(null), cameraRef = useRef<HTMLVideoElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null), [imageUrl, setImageUrl] = useState(''), [filename, setFilename] = useState('');
  const [detections, setDetections] = useState<Detection[]>([]), [target, setTarget] = useState(''), [busy, setBusy] = useState(false), [engine, setEngine] = useState('Not loaded');
  const [message, setMessage] = useState('Choose a photo to begin. Your photo stays in this browser for local detection.'), [error, setError] = useState(false);
  const [enhancedPhotoScan, setEnhancedPhotoScan] = useState(true);
  const [showPhotoDiagnosticConfidence, setShowPhotoDiagnosticConfidence] = useState(false);
  const [sessions, setSessions] = useState<CountSession[]>([]), [cameraOpen, setCameraOpen] = useState(false), [stream, setStream] = useState<MediaStream | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null), [editCategory, setEditCategory] = useState('object'), [editConfidence, setEditConfidence] = useState('');
  const [editModalOpen, setEditModalOpen] = useState(false);
  const editModalRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const totals = totalsByCategory(detections);
  useEffect(() => { listSessions().then(setSessions).catch(() => setMessage('Local history is unavailable in this browser.')); }, []);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); stream?.getTracks().forEach(t => t.stop()); }, [imageUrl, stream]);
  useEffect(() => { draw(); }, [image, detections, showPhotoDiagnosticConfidence]);
  useEffect(() => {
    if (!editModalOpen) {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
      return;
    }
    const modal = editModalRef.current;
    const focusable = () => Array.from(modal?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
    focusable()[0]?.focus();
    function handleModalKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setEditModalOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', handleModalKeyDown);
    return () => document.removeEventListener('keydown', handleModalKeyDown);
  }, [editModalOpen]);
  useEffect(() => { if (cameraOpen && stream && cameraRef.current) { cameraRef.current.srcObject = stream; cameraRef.current.play().catch(() => notify('Camera preview could not start. Check browser permissions.', true)); } }, [cameraOpen, stream]);
  function notify(text: string, isError = false) { setMessage(text); setError(isError); }
  function loadFile(file?: File) {
    if (!file) return;
    if (!['image/jpeg','image/png','image/webp','image/avif'].includes(file.type)) return notify('Choose a JPG, PNG, WebP or AVIF image.', true);
    if (file.size > MAX_FILE) return notify('Images must be 12 MB or smaller.', true);
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { setImageUrl(url); setImage(img); setFilename(file.name); setDetections([]); notify('Photo ready. Run local AI detection when you are ready.'); };
    img.onerror = () => { URL.revokeObjectURL(url); notify('This image could not be opened.', true); };
    img.src = url;
  }
  function draw() {
    const canvas = canvasRef.current; if (!canvas || !image) return;
    const scale = Math.min(1, 1500 / image.naturalWidth, 1500 / image.naturalHeight);
    canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    detections.forEach((d, i) => { const [x,y,w,h] = d.bbox.map(v => v * scale); const color = d.source === 'manual' ? '#e6ae52' : '#42cdb1';
      ctx.lineWidth = Math.max(2, canvas.width / 400); ctx.strokeStyle = color; ctx.strokeRect(x,y,w,h);
      const detectionLabel = d.source === 'manual'
        ? `Manual · ${d.category}`
        : formatDetectionOverlayLabel(d.category, d.confidence, showPhotoDiagnosticConfidence);
      const label = `${i + 1} · ${detectionLabel}`;
      ctx.font = `600 ${Math.max(12, Math.min(18, canvas.width / 48))}px system-ui`; const th = 24, tw = Math.min(ctx.measureText(label).width + 14, canvas.width - x);
      ctx.fillStyle = color; ctx.fillRect(x, Math.max(0, y - th), tw, th); ctx.fillStyle = '#102321'; ctx.fillText(label, x + 6, Math.max(16, y - 7), Math.max(20, tw - 8));
    });
  }
  async function analyze() {
    if (!image) return notify('Choose or capture a photo first.', true);
    setBusy(true); notify('Loading the local model if needed…');
    try {
      const detector = await getDetector();
      await detector.load(); setEngine('COCO-SSD · loaded'); notify('Analyzing image in this browser…');
      let result = enhancedPhotoScan ? await detector.detectDetailed(image) : await detector.detect(image);
      const phrase = target.trim().toLowerCase();
      if (phrase && phrase !== 'all objects') {
        const aliases: Record<string,string[]> = { people:['person'], humans:['person'], bottles:['bottle'], cars:['car'], vehicles:['car','truck','bus','motorcycle','bicycle'], bikes:['bicycle','motorcycle'], motorcycles:['motorcycle'] };
        const terms = phrase.split(/[^a-z0-9]+/).filter(Boolean).flatMap(t => aliases[t] ?? [t]);
        result = result.filter(d => terms.some(t => d.category.toLowerCase().includes(t) || t.includes(d.category.toLowerCase())));
        if (!result.length) notify(`No supported model detections matched “${target}”. This does not prove the objects are absent.`, true);
      }
      setDetections(result); if (result.length) notify(`${result.length} model detection${result.length === 1 ? '' : 's'} returned. Check for hidden, overlapping, missed or duplicate objects.`);
      await persist(result);
    } catch (e) { notify(e instanceof Error ? e.message : 'AI analysis failed.', true); setEngine('Unavailable'); }
    finally { setBusy(false); }
  }
  async function persist(list = detections): Promise<boolean> {
    const session: CountSession = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), title: filename || 'Counting session', mode: 'photo', target: target || 'all objects', detections: list, totals: totalsByCategory(list) };
    try { await saveSession(session); setSessions(await listSessions()); return true; }
    catch { notify('Results are ready in this view, but the browser could not save this session.', true); return false; }
  }
  function openEditModal() {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditModalOpen(true);
  }
  function closeEditModal() { setEditModalOpen(false); }
  function addManual() { setEditingId(null); setEditCategory(target.trim() || 'object'); setEditConfidence(''); openEditModal(); }
  function editDetection(d: Detection) { setEditingId(d.id); setEditCategory(d.category); setEditConfidence(d.confidence == null ? '' : String(d.confidence)); openEditModal(); }
  async function saveEdit() {
    if (!editCategory.trim()) return notify('Enter a category before saving.', true);
    if (editConfidence !== '' && (!Number.isFinite(Number(editConfidence)) || Number(editConfidence) < 0 || Number(editConfidence) > 1)) return notify('Confidence must be a number from 0 to 1.', true);
    let updated: Detection[];
    if (editingId) updated = detections.map(d => d.id === editingId ? { ...d, category: editCategory.trim().slice(0,100), confidence: editConfidence === '' ? undefined : Math.max(0, Math.min(1, Number(editConfidence))), source: 'manual' as const } : d);
    else updated = [...detections, { id: crypto.randomUUID(), category: editCategory.trim().slice(0,100), bbox: [image ? image.naturalWidth * .3 : 0, image ? image.naturalHeight * .3 : 0, image ? image.naturalWidth * .4 : 0, image ? image.naturalHeight * .4 : 0] as [number,number,number,number], source: 'manual' }];
    setDetections(updated); closeEditModal();
    if (await persist(updated)) notify('Correction saved. Category totals have been recalculated.');
  }
  async function removeDetection(id: string) { const next = detections.filter(d => d.id !== id); setDetections(next); if (await persist(next)) notify('Detection removed and totals recalculated.'); }
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return notify('Camera requires HTTPS or localhost. You can upload a photo instead.', true);
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } }); setStream(s); setCameraOpen(true); }
    catch (e) { notify(e instanceof Error && e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in browser settings or upload a photo.' : 'Could not open the camera. Try photo upload.', true); }
  }
  function capture() { const video = cameraRef.current; if (!video || !video.videoWidth) return notify('Camera is still starting.', true); const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight; c.getContext('2d')?.drawImage(video,0,0); c.toBlob(blob => { if (blob) loadFile(new File([blob], 'camera-capture.jpg', {type:'image/jpeg'})); stopCamera(); }, 'image/jpeg', .92); }
  function stopCamera() { stream?.getTracks().forEach(t => t.stop()); setStream(null); setCameraOpen(false); }
  function exportCsv() { const rows = [['category','confidence','x','y','width','height','source'], ...detections.map(d => [d.category,d.confidence ?? '',...d.bbox,d.source])]; const csv = rows.map(r => r.map(v => `"${String(v).replaceAll('"','""')}"`).join(',')).join('\r\n'); download(new Blob([csv], {type:'text/csv;charset=utf-8'}), 'countai-counts.csv'); }
  function exportPng() { const canvas = canvasRef.current; if (!canvas) return; canvas.toBlob(b => { if (b) download(b,'countai-annotated.png'); },'image/png'); }
  function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); }
  async function openSession(s: CountSession) { setDetections(s.detections); setFilename(s.title); setTarget(s.target); setImage(null); setImageUrl(''); notify('Saved counts restored. Select the original photo again to display annotations.'); }
  async function eraseSession(id: string) { await deleteSession(id); setSessions(await listSessions()); }
  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="#top" aria-label="SPAIS home"><span className="brand-mark"><ScanSearch size={25}/></span><span><b>SPAIS</b><small>INTELLIGENT OPERATIONS</small></span></a><span className="local-badge"><ShieldCheck size={15}/> Local-first</span></header>
    <nav className="workspace-nav" aria-label="Main workspace">
      <button className={activeWorkspace === 'dashboard' ? 'nav-item active' : 'nav-item'} aria-pressed={activeWorkspace === 'dashboard'} onClick={() => setActiveWorkspace('dashboard')}>Overview</button>
      <button className={activeWorkspace === 'live' ? 'nav-item active' : 'nav-item'} aria-pressed={activeWorkspace === 'live'} onClick={() => setActiveWorkspace('live')}>Live Counter</button>
      <button className={activeWorkspace === 'photo' ? 'nav-item active' : 'nav-item'} aria-pressed={activeWorkspace === 'photo'} onClick={() => setActiveWorkspace('photo')}>Photo Review</button>
      <button className={activeWorkspace === 'history' ? 'nav-item active' : 'nav-item'} aria-pressed={activeWorkspace === 'history'} onClick={() => setActiveWorkspace('history')}>History</button>
      <button className={activeWorkspace === 'analytics' ? 'nav-item active' : 'nav-item'} aria-pressed={activeWorkspace === 'analytics'} onClick={() => setActiveWorkspace('analytics')}>Analytics</button>
      <button className={activeWorkspace === 'governance' ? 'nav-item active' : 'nav-item'} aria-pressed={activeWorkspace === 'governance'} onClick={() => setActiveWorkspace('governance')}>Governance, AI &amp; SOPs</button>
      <button className={activeWorkspace === 'operations' ? 'nav-item active' : 'nav-item'} aria-pressed={activeWorkspace === 'operations'} onClick={() => setActiveWorkspace('operations')}>Sites &amp; Cameras</button>
    </nav>
    <div style={{ display: activeWorkspace === 'dashboard' ? undefined : 'none' }}>
      <DashboardHome sessions={sessions} onNavigate={setActiveWorkspace} onOpenSession={(session) => { void openSession(session); setActiveWorkspace('photo'); }} />
    </div>
    <section className="hero" style={{ display: activeWorkspace === 'live' ? undefined : 'none' }} id="top"><div className="eyebrow">VISUAL INTELLIGENCE · BUILT FOR THE REAL WORLD</div><h1>Count what<br/><em>you can see.</em></h1><p>Turn a photo into a reviewable count. AI suggests detections; you stay in control of the final numbers.</p><div className="feature-pills"><span><Smartphone size={14}/> Installable PWA</span><span><ShieldCheck size={14}/> Private by default</span><span><Wifi size={14}/> Local AI</span></div></section>
<div style={{ display: activeWorkspace === 'live' ? 'block' : 'none' }}><LiveCounter /></div>
    <section className="workspace" style={{ display: activeWorkspace === 'photo' ? undefined : 'none' }}><div className="section-heading"><div><span className="step">01 / PHOTO COUNTER</span><h2>Start with an image</h2></div><span className="engine-state"><i className={engine.includes('loaded') ? 'ready' : ''}/>{engine}</span></div>
      <input ref={fileRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/avif" onChange={e => loadFile(e.target.files?.[0])}/>
      {!cameraOpen && <div className={`upload-panel ${image ? 'has-image' : ''}`} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();loadFile(e.dataTransfer.files[0]);}}>
        {image ? <><canvas ref={canvasRef} className="result-canvas" aria-label="Image with numbered detection annotations"/><div className="image-footer"><span><Check size={15}/>{filename}</span><button className="subtle-button" onClick={()=>fileRef.current?.click()}>Change image</button></div></> : <><div className="upload-icon"><ImagePlus size={29}/></div><h3>Drop a photo here</h3><p>JPG, PNG, WebP or AVIF · up to 12 MB</p><button className="primary-button" onClick={()=>fileRef.current?.click()}><Upload size={17}/> Choose a photo</button><span className="or-label">or use your camera</span><button className="outline-button" onClick={startCamera}><Camera size={17}/> Open camera</button></>}
      </div>}
      {cameraOpen && <div className="camera-wrap"><video ref={cameraRef} autoPlay playsInline muted/><div className="camera-actions"><button className="primary-button" onClick={capture}><Camera size={17}/> Capture photo</button><button className="outline-button" onClick={stopCamera}>Cancel</button></div></div>}
      <label className="field-label" htmlFor="target">WHAT SHOULD WE COUNT? <span>OPTIONAL</span></label><div className="target-row"><input id="target" value={target} onChange={e=>setTarget(e.target.value)} placeholder="e.g. bottles, people, parked cars"/><button className="primary-button analyze-button" onClick={analyze} disabled={!image || busy}>{busy ? <LoaderCircle className="spin" size={18}/> : <ScanSearch size={18}/>} {busy ? 'Analyzing' : 'Analyze photo'}</button></div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 12, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
        <input type="checkbox" checked={enhancedPhotoScan} onChange={e => setEnhancedPhotoScan(e.target.checked)} style={{ marginTop: 3, accentColor: '#42cdb1' }} />
        <span><b>Enhanced detail scan (recommended)</b><br/><span style={{ opacity: 0.72 }}>Uses overlapping image crops to help find smaller supported objects. Slower than a single pass; it cannot recognize classes outside COCO-SSD and results still need review.</span></span>
      </label>
      <div className={`notice ${error ? 'notice-error' : ''}`} role="status">{error ? <CircleHelp size={17}/> : <ShieldCheck size={17}/>}<span>{message}</span></div>
    </section>
    <section className="results-section" style={{ display: activeWorkspace === 'photo' ? undefined : 'none' }}><div className="section-heading"><div><span className="step">02 / REVIEW</span><h2>Your count, verified</h2></div><span className="result-number">{detections.length} <small>detections</small></span></div>
      <div className="summary-grid"><div className="summary-card total-card"><span>Total detections</span><strong>{detections.length}</strong><small>AI + manual corrections</small></div><div className="summary-card"><span>Categories</span><strong>{Object.keys(totals).length}</strong><small>Detected class labels</small></div></div>
      <div className="category-panel"><h3>Category breakdown</h3>{Object.entries(totals).length ? Object.entries(totals).sort((a,b)=>b[1]-a[1]).map(([name,n])=><div className="category-row" key={name}><span>{name}</span><div className="bar"><i style={{width:`${n / Math.max(...Object.values(totals)) * 100}%`}}/></div><b>{n}</b></div>) : <p className="empty-copy">Run analysis to see category totals. Verify the image for missed or overlapping objects.</p>}</div>
      <div className="review-heading"><h3>Individual detections</h3><button className="small-action" onClick={addManual}><Plus size={15}/> Add manually</button></div>
      {detections.length ? <div className="detection-list">{detections.map((d,i)=><div className="detection-row" key={d.id}><span className="detection-index">{String(i+1).padStart(2,'0')}</span><div className="detection-info"><b>{d.category}</b><small>{d.source === 'manual' ? 'Manual entry' : `${d.source === 'local' ? 'Local model' : 'Cloud model'} · ${d.confidence == null ? 'confidence unavailable' : `${Math.round(d.confidence*100)}% confidence`}`}</small></div><button className="icon-button" onClick={()=>editDetection(d)} aria-label={`Edit ${d.category}`}><span>Edit</span></button><button className="icon-button danger" onClick={()=>removeDetection(d.id)} aria-label={`Remove ${d.category}`}><X size={17}/></button></div>)}</div> : <div className="empty-results"><ScanSearch size={25}/><p>No detections yet</p><small>AI results will appear here after analysis.</small></div>}
      <div className="export-row"><button className="outline-button" disabled={!detections.length} onClick={exportCsv}><Download size={16}/> Export CSV</button><button className="outline-button" disabled={!image || !detections.length} onClick={exportPng}><ImagePlus size={16}/> Annotated PNG</button></div>
      <p className="accuracy-note"><CircleHelp size={16}/> Labels are AI predictions, not verified facts. Detection counts can be wrong when items overlap, are small, obscured, or outside the model's supported classes. Manual entries are labelled separately; review before relying on totals.</p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: '#72817c', cursor: 'pointer' }}>
        <input type="checkbox" checked={showPhotoDiagnosticConfidence} onChange={event => setShowPhotoDiagnosticConfidence(event.target.checked)} />
        Show model confidence on annotated photo (diagnostic only)
      </label>
    </section>
    <section className="history-section" style={{ display: activeWorkspace === 'history' ? undefined : 'none' }}><div className="section-heading"><div><span className="step">03 / ON THIS DEVICE</span><h2>Recent sessions</h2></div><span className="local-badge">IndexedDB</span></div>{sessions.length ? sessions.slice(0,8).map(s=><div className="session-row" key={s.id}><button className="session-open" onClick={()=>openSession(s)}><span><b>{s.title}</b><small>{new Date(s.createdAt).toLocaleString()} · {s.target}</small></span><strong>{s.detections.length}<ChevronRight size={16}/></strong></button><button className="icon-button danger" aria-label="Delete session" onClick={()=>eraseSession(s.id)}><Trash2 size={15}/></button></div>) : <p className="empty-copy">Your saved sessions will appear here after you analyze or correct a count.</p>}</section>
    <div style={{ display: activeWorkspace === 'analytics' ? undefined : 'none' }}><AnalyticsDashboard sessions={sessions} onOpenSession={openSession} /></div>
    <SpaisGovernanceWorkspace visible={activeWorkspace === 'governance'} />
    <SpaisOperationsWorkspace visible={activeWorkspace === 'operations'} />
    <footer><div className="footer-brand">SPAIS <span>INTELLIGENT OPERATIONS</span></div><p>SPAIS · Surveillance and operational intelligence, with human oversight.</p><small>Photos are processed locally by default. This build does not identify people or perform biometric matching.</small></footer>
    <div id="edit-modal" ref={editModalRef} className={editModalOpen ? 'modal' : 'modal hidden'} role="dialog" aria-modal="true" aria-labelledby="edit-heading"><div className="modal-card"><div className="modal-head"><h2 id="edit-heading">Correct detection</h2><button className="icon-button" onClick={closeEditModal} aria-label="Close"><X size={18}/></button></div><label className="field-label" htmlFor="edit-category">CATEGORY</label><input id="edit-category" value={editCategory} onChange={e=>setEditCategory(e.target.value)} maxLength={100}/><label className="field-label" htmlFor="edit-confidence">CONFIDENCE (0–1, OPTIONAL)</label><input id="edit-confidence" type="number" min="0" max="1" step="0.01" value={editConfidence} onChange={e=>setEditConfidence(e.target.value)}/><div className="modal-actions"><button className="outline-button" onClick={closeEditModal}>Cancel</button><button className="primary-button" onClick={saveEdit}><Check size={16}/> Save correction</button></div></div></div>
  </main>;
}
