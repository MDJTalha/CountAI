import { useEffect, useRef, useState } from 'react';
import { Camera, CircleHelp, Pause, Play, RotateCcw, Square } from 'lucide-react';

import { createTracker, updateTracks, countCrossingEvents } from './engine/countingCore.mjs';
import type { Detection } from './types/counting';
import {
  createCameraHealthState,
  startCameraHealth,
  recordCameraFrame,
  recordCameraInference,
  evaluateCameraHealth,
  stopCameraHealth,
  getCameraHealthMetrics
} from './engine/cameraHealth.mjs';
import {
  appendCameraHealthEvent,
  loadCameraHealthHistory,
  saveCameraHealthHistory
} from './engine/cameraHealthHistory.mjs';
import type { CameraHealthEvent } from './engine/cameraHealthHistory.mjs';
import { formatDetectionOverlayLabel } from './engine/detectionOverlay.mjs';
import { startLiveSession, recordLiveSessionEvent, finishLiveSession, listLiveSessions, deleteLiveSession } from './storage/liveSessions.mjs';
import type { LiveSessionRecord } from './storage/liveSessions.mjs';

type TrackerState = ReturnType<typeof createTracker>;

function readSavedLiveSessions(): LiveSessionRecord[] {
  try {
    return listLiveSessions(window.localStorage);
  } catch {
    return [];
  }
}

function readableStopReason(reason: string | null): string {
  return (reason || 'unknown').replaceAll('_', ' ');
}

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

function readSavedCameraHealthHistory(): CameraHealthEvent[] {
  try {
    return typeof window === 'undefined' ? [] : loadCameraHealthHistory(window.localStorage);
  } catch {
    return [];
  }
}

function formatElapsedDuration(durationMs: number | null): string {
  if (durationMs === null) return '—';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

export function LiveCounter() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRequestIdRef = useRef(0);
  const frameRef = useRef<number>(0);
  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);
  const enhancementRef = useRef(50);
  const presetRef = useRef<'standard' | 'low-light' | 'backlit'>('standard');
  const latestDetectionsRef = useRef<Detection[]>([]);
  const modeRef = useRef<'people' | 'all'>('people');
  const trackerRef = useRef<TrackerState>(createTracker());
  const countsRef = useRef<Record<string, number>>({});
  const directionsRef = useRef({ 'A-to-B': 0, 'B-to-A': 0 });
  const lastProcessedVideoTimeRef = useRef(Number.NaN);
  const healthRef = useRef(createCameraHealthState());
  const [health, setHealth] = useState(() => createCameraHealthState());
  const [healthClock, setHealthClock] = useState(() => Date.now());
  const [healthHistory, setHealthHistory] = useState<CameraHealthEvent[]>(readSavedCameraHealthHistory);
  const healthHistoryRef = useRef(healthHistory);
  const lastHealthEventKeyRef = useRef('idle|');
  const liveSessionIdRef = useRef<string | null>(null);
  const [savedLiveSessions, setSavedLiveSessions] = useState<LiveSessionRecord[]>(readSavedLiveSessions);

  const [active, setActive] = useState(false);
  const [showDiagnosticConfidence, setShowDiagnosticConfidence] = useState(false);
  const [paused, setPaused] = useState(false);
  const [detectionMode, setDetectionMode] = useState<'people' | 'all'>('people');
  const [resolution, setResolution] = useState<'720p' | '1080p' | '4k'>('720p');
  const [linePosition, setLinePosition] = useState(50);
  const [enhancement, setEnhancement] = useState(50);
  const [preset, setPreset] = useState<'standard' | 'low-light' | 'backlit'>('standard');
  const [actualResolution, setActualResolution] = useState('Camera not connected');
  const [total, setTotal] = useState(0);
  const [visiblePeople, setVisiblePeople] = useState(0);
  const [rawDetectionCount, setRawDetectionCount] = useState(0);
  const [acceptedDetectionCount, setAcceptedDetectionCount] = useState(0);
  const [trackedObjectCount, setTrackedObjectCount] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [directions, setDirections] = useState({ 'A-to-B': 0, 'B-to-A': 0 });
  const [status, setStatus] = useState('Start your camera to begin live counting.');
  const [error, setError] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setHealthClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    enhancementRef.current = enhancement;
    presetRef.current = preset;
    drawFrame(latestDetectionsRef.current);
  }, [enhancement, preset, linePosition, showDiagnosticConfidence]);

  function drawFrame(items: Detection[]) {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Enhance the displayed image only. Detection still uses the original video.
    const strength = enhancementRef.current / 100;
    const brightness =
      1 +
      strength * (
        presetRef.current === 'low-light' ? 0.55 :
        presetRef.current === 'backlit' ? 0.18 : 0.08
      );
    const contrast =
      1 + strength * (presetRef.current === 'backlit' ? 0.24 : 0.12);
    const saturation = 1 + strength * 0.18;

    ctx.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.filter = 'none';

    const lineY = canvas.height * linePosition / 100;

    // Dark outline improves contrast against bright and dark backgrounds.
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#101820';
    ctx.lineWidth = Math.max(8, canvas.width / 100);
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(canvas.width, lineY);
    ctx.stroke();

    // High-visibility gold counting line.
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = Math.max(3, canvas.width / 350);
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(canvas.width, lineY);
    ctx.stroke();

    // Position label at the top-left of the line.
    const lineLabel = `COUNTING LINE • ${linePosition}%`;
    ctx.font = `bold ${Math.max(14, canvas.width / 75)}px sans-serif`;
    const labelHeight = Math.max(24, canvas.width / 35);
    const labelWidth = ctx.measureText(lineLabel).width + 20;
    const labelY = Math.max(labelHeight, lineY - 8);

    ctx.fillStyle = '#101820';
    ctx.fillRect(8, labelY - labelHeight, labelWidth, labelHeight);
    ctx.fillStyle = '#ffd166';
    ctx.textBaseline = 'middle';
    ctx.fillText(lineLabel, 18, labelY - labelHeight / 2);

    for (const d of items) {
      const [x, y, w, h] = d.bbox;
      ctx.strokeStyle = d.counted ? '#e6ae52' : '#42cdb1';
      ctx.lineWidth = Math.max(2, canvas.width / 600);
      ctx.strokeRect(x, y, w, h);

      const label = formatDetectionOverlayLabel(d.category, d.confidence, showDiagnosticConfidence);
      ctx.font = `600 ${Math.max(13, canvas.width / 65)}px system-ui`;
      const labelY = Math.max(0, y - 25);
      ctx.fillStyle = d.counted ? '#e6ae52' : '#42cdb1';
      ctx.fillRect(x, labelY, Math.min(ctx.measureText(label).width + 12, canvas.width - x), 25);
      ctx.fillStyle = '#102321';
      ctx.fillText(label, x + 5, Math.max(17, y - 7));
    }
  }

  function refreshLiveSessions() {
    try {
      setSavedLiveSessions(listLiveSessions(window.localStorage));
    } catch {
      // Live counting remains usable if browser storage is unavailable.
    }
  }

  function persistLiveEvent(type: string, payload: Record<string, unknown>) {
    const sessionId = liveSessionIdRef.current;
    if (!sessionId) return;
    try {
      recordLiveSessionEvent(window.localStorage, sessionId, type, payload);
    } catch {
      // Storage failures must not stop live inference or counting.
    }
  }

  function closeLiveSession(reason: string) {
    const sessionId = liveSessionIdRef.current;
    if (!sessionId) return;
    // Clear first so cleanup/watchdog paths cannot close the same session twice.
    liveSessionIdRef.current = null;
    try {
      finishLiveSession(window.localStorage, sessionId, {
        reason,
        actualResolution,
        linePosition,
        detectionMode: modeRef.current,
        totals: { ...countsRef.current },
        directions: { ...directionsRef.current },
        totalCrossings: Object.values(countsRef.current).reduce((sum, value) => sum + value, 0)
      });
      refreshLiveSessions();
    } catch {
      // Keep the camera lifecycle independent from local history availability.
    }
  }

  function releaseCameraResources() {
    runningRef.current = false;
    cancelAnimationFrame(frameRef.current);
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach(track => track.stop());
    if (videoRef.current && videoRef.current.srcObject === stream) {
      videoRef.current.srcObject = null;
    }
    pausedRef.current = false;
    setPaused(false);
    setActive(false);
  }

  function stopCamera() {
    cameraRequestIdRef.current += 1;
    releaseCameraResources();
    busyRef.current = false;
    healthRef.current = stopCameraHealth(healthRef.current);
    setHealth(healthRef.current);
    closeLiveSession('operator_stopped');
    setStatus('Camera stopped. Results remain on screen.');
  }

  useEffect(() => () => {
    cameraRequestIdRef.current += 1;
    runningRef.current = false;
    cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach(track => track.stop());
    closeLiveSession('workspace_closed');
  }, []);

  async function changeResolution(value: '720p' | '1080p' | '4k') {
    setResolution(value);
    if (runningRef.current) {
      stopCamera();
      await startCamera(value);
    } else {
      setStatus('Resolution selected. Start the camera to apply it.');
    }
  }

  async function startCamera(requestedResolution: '720p' | '1080p' | '4k' = resolution) {
    const requestId = ++cameraRequestIdRef.current;
    let acquiredStream: MediaStream | null = null;
    let startupStage: 'model' | 'camera' | 'playback' = 'model';
    setError(false);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access requires localhost or HTTPS in a supported browser.');
      }

      setStatus('Loading local AI model?');
      const detector = await getDetector();
      await detector.load();
      if (requestId !== cameraRequestIdRef.current) return;

      startupStage = 'camera';
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: {
            ideal: requestedResolution === '4k' ? 3840 : requestedResolution === '1080p' ? 1920 : 1280
          },
          height: {
            ideal: requestedResolution === '4k' ? 2160 : requestedResolution === '1080p' ? 1080 : 720
          }
        }
      });
      acquiredStream = stream;

      if (requestId !== cameraRequestIdRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      const video = videoRef.current;
      if (!video) throw new Error('Camera preview is unavailable.');

      streamRef.current = stream;
      video.srcObject = stream;
      startupStage = 'playback';
      await video.play();

      if (requestId !== cameraRequestIdRef.current) {
        stream.getTracks().forEach(track => track.stop());
        if (video.srcObject === stream) video.srcObject = null;
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }

      const settings = stream.getVideoTracks()[0]?.getSettings();
      const width = settings?.width ?? video.videoWidth;
      const height = settings?.height ?? video.videoHeight;
      const requestedWidth = requestedResolution === '4k' ? 3840 : requestedResolution === '1080p' ? 1920 : 1280;
      const requestedHeight = requestedResolution === '4k' ? 2160 : requestedResolution === '1080p' ? 1080 : 720;

      setActualResolution(`${width} x ${height}`);
      setStatus(`Camera connected at ${width} x ${height}. Display enhancement is ${preset === 'standard' ? 'standard' : preset === 'low-light' ? 'low-light' : 'backlit'}; counting uses the original camera frames.`);

      trackerRef.current = createTracker();
      lastProcessedVideoTimeRef.current = Number.NaN;
      healthRef.current = startCameraHealth(healthRef.current);
      setHealth(healthRef.current);
      runningRef.current = true;
      pausedRef.current = false;
      setPaused(false);
      setActive(true);
      try {
        const session = startLiveSession(window.localStorage, {
          startedAt: new Date().toISOString(),
          requestedResolution,
          actualResolution: `${width} x ${height}`,
          linePosition,
          detectionMode: modeRef.current
        });
        liveSessionIdRef.current = session.id;
        refreshLiveSessions();
      } catch {
        setStatus(current => current + ' Local session history is unavailable in this browser.');
      }
      setStatus(
        width < requestedWidth || height < requestedHeight
          ? `Camera running at ${width}x${height}. Requested ${requestedWidth}x${requestedHeight} is unavailable from this camera/browser; choose a supported resolution.`
          : `Camera running at ${width}x${height}. Valid line crossings are counted in either direction; a deadband and cooldown help suppress duplicate counts from line jitter.`
      );
      frameRef.current = requestAnimationFrame(processFrame);
    } catch (e) {
      if (requestId !== cameraRequestIdRef.current) {
        acquiredStream?.getTracks().forEach(track => track.stop());
        return;
      }

      acquiredStream?.getTracks().forEach(track => track.stop());
      if (streamRef.current === acquiredStream) streamRef.current = null;
      if (videoRef.current?.srcObject === acquiredStream) {
        videoRef.current.srcObject = null;
      }

      runningRef.current = false;
      healthRef.current = {
        ...healthRef.current,
        status: startupStage === 'model' ? 'detection-error' : 'disconnected',
        error: e instanceof Error ? e.message : 'Could not start the camera.',
        updatedAt: Date.now()
      };
      setHealth(healthRef.current);
      setActive(false);
      setError(true);
      setStatus(e instanceof Error ? e.message : 'Could not start the live counter.');
    }
  }

  async function processFrame() {
    if (!runningRef.current) return;

    const video = videoRef.current;
    if (!video || video.readyState < 2 || busyRef.current || pausedRef.current) {
      frameRef.current = requestAnimationFrame(processFrame);
      return;
    }

    // Do not run inference repeatedly on the same decoded video frame.
    if (video.currentTime === lastProcessedVideoTimeRef.current) {
      frameRef.current = requestAnimationFrame(processFrame);
      return;
    }
    lastProcessedVideoTimeRef.current = video.currentTime;
    healthRef.current = recordCameraFrame(healthRef.current, {
      now: Date.now(),
      videoTime: video.currentTime,
      readyState: video.readyState,
      trackState: streamRef.current?.getVideoTracks()[0]?.readyState ?? 'ended'
    });

    busyRef.current = true;
    const inferenceStartedAt = performance.now();
    try {
      const raw = await (await getDetector()).detect(video);
      if (!runningRef.current) return;
      setRawDetectionCount(raw.length);
      healthRef.current = recordCameraInference(healthRef.current, {
        now: Date.now(),
        durationMs: performance.now() - inferenceStartedAt
      });

      const mode = modeRef.current;
      const confidenceThreshold = mode === 'people' ? 0.40 : 0.50;
      const found = raw.filter(d =>
        (d.confidence ?? 0) >= confidenceThreshold &&
        (mode === 'all' || d.category.toLowerCase() === 'person')
      );
      setAcceptedDetectionCount(found.length);

      const tracker = updateTracks(trackerRef.current, found);
      trackerRef.current = tracker;
      setTrackedObjectCount(tracker.tracks.length);

      const line: [[number, number], [number, number]] = [
        [0, video.videoHeight * linePosition / 100],
        [video.videoWidth, video.videoHeight * linePosition / 100]
      ];

      const events = countCrossingEvents(tracker, line);
      const nextCounts = { ...countsRef.current };
      const nextDirections = { ...directionsRef.current };

      for (const event of events) {
        persistLiveEvent('crossing_counted', { trackId: event.trackId, direction: event.direction, category: event.category });
        nextCounts[event.category] = (nextCounts[event.category] ?? 0) + 1;

        if (event.direction === 'A-to-B') {
          nextDirections['A-to-B'] += 1;
        } else {
          nextDirections['B-to-A'] += 1;
        }
      }

      countsRef.current = nextCounts;
      directionsRef.current = nextDirections;
      setCounts(nextCounts);
      setDirections({ ...nextDirections });
      setTotal(Object.values(nextCounts).reduce((sum, n) => sum + n, 0));

      const visibleIds = new Set(
        found
          .filter(d => d.category.toLowerCase() === 'person')
          .map(d => d.trackId)
          .filter((id): id is number => typeof id === 'number')
      );
      setVisiblePeople(visibleIds.size);
      latestDetectionsRef.current = found;
      drawFrame(found);
    } catch (e) {
      if (!runningRef.current) return;
      const failure = recordCameraInference(healthRef.current, {
        now: Date.now(),
        durationMs: performance.now() - inferenceStartedAt,
        error: e instanceof Error ? e.message : 'Unknown inference error'
      });
      // Freeze elapsed session time while retaining the distinct inference-error state.
      healthRef.current = stopCameraHealth(failure, Date.now(), {
        status: 'detection-error',
        error: failure.error ?? 'Unknown inference error'
      });
      setHealth(healthRef.current);
      closeLiveSession('inference_error');
      releaseCameraResources();
      setError(true);
      setStatus(e instanceof Error ? `Live detection stopped: ${e.message}` : 'Live detection failed.');
    } finally {
      busyRef.current = false;
      if (runningRef.current) {
        frameRef.current = requestAnimationFrame(processFrame);
      }
    }
  }

  function togglePause() {
    if (!active) return;
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) {
      healthRef.current = { ...healthRef.current, status: 'paused', updatedAt: Date.now() };
    } else {
      healthRef.current = evaluateCameraHealth(healthRef.current, {
        now: Date.now(),
        trackState: streamRef.current?.getVideoTracks()[0]?.readyState ?? 'ended',
        paused: false
      });
    }
    setHealth(healthRef.current);
    setStatus(next ? 'Counting paused.' : 'Live detection resumed.');
  }

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const trackState = streamRef.current?.getVideoTracks()[0]?.readyState ?? 'ended';
      const now = Date.now();
      healthRef.current = evaluateCameraHealth(healthRef.current, {
        now,
        trackState,
        paused: pausedRef.current
      });
      const healthError = healthRef.current.error ?? '';
      const stalled = healthRef.current.status === 'degraded' &&
        /video frames have stalled|no video frames received yet/i.test(healthError);

      if (healthRef.current.status === 'disconnected' || stalled) {
        // A live track can still have a frozen video clock. Release it after the
        // watchdog confirms stale frames; slow inference alone must not stop the camera.
        const reason = healthError || 'Camera track ended';
        closeLiveSession(stalled ? 'camera_stalled' : 'camera_disconnected');
        releaseCameraResources();
        busyRef.current = false;
        healthRef.current = stopCameraHealth(healthRef.current, now, {
          status: 'disconnected',
          error: reason
        });
        setHealth(healthRef.current);
        setError(true);
        setStatus(stalled
          ? 'Video frames stopped updating. Camera resources were released. Check the camera, then start a new session.'
          : 'Camera disconnected. Reconnect the camera, then start a new session.');
      } else {
        setHealth(healthRef.current);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    const eventKey = `${health.status}|${health.error ?? ''}`;
    if (eventKey === lastHealthEventKeyRef.current) return;
    lastHealthEventKeyRef.current = eventKey;
    persistLiveEvent('camera_health_changed', { status: health.status, ...(health.error ? { error: health.error } : {}) });
    const next = appendCameraHealthEvent(healthHistoryRef.current, {
      timestamp: Date.now(),
      status: health.status,
      error: health.error
    });
    if (next === healthHistoryRef.current) return;
    healthHistoryRef.current = next;
    setHealthHistory(next);
    try {
      saveCameraHealthHistory(window.localStorage, next);
    } catch {
      // Health monitoring must continue if browser storage is blocked.
    }
    refreshLiveSessions();
  }, [health.status, health.error]);

  function removeSavedLiveSession(sessionId: string) {
    try {
      deleteLiveSession(window.localStorage, sessionId);
      refreshLiveSessions();
    } catch {
      setStatus('Could not delete the saved live-session record in this browser.');
    }
  }

  function clearHealthHistory() {
    healthHistoryRef.current = [];
    setHealthHistory([]);
    try {
      saveCameraHealthHistory(window.localStorage, []);
    } catch {
      // The visible in-memory history is still cleared.
    }
  }

  function resetCounts() {
    countsRef.current = {};
    directionsRef.current = { 'A-to-B': 0, 'B-to-A': 0 };
    trackerRef.current = createTracker();
    setCounts({});
    setDirections({ 'A-to-B': 0, 'B-to-A': 0 });
    setTotal(0);
    setVisiblePeople(0);
    setRawDetectionCount(0);
    setAcceptedDetectionCount(0);
    setTrackedObjectCount(0);
    latestDetectionsRef.current = [];
    drawFrame([]);
    setStatus('Counts reset. Tracking has restarted.');
  }

  function changeMode(value: 'people' | 'all') {
    modeRef.current = value;
    setDetectionMode(value);
    resetCounts();
    setStatus(value === 'people'
      ? 'People-only mode enabled. Only person-class detections can be counted.'
      : 'All-classes mode enabled. Low-confidence detections are filtered.');
  }

  function exportCsv() {
    const rows = [
      ['metric', 'value'],
      ['exported_at', new Date().toISOString()],
      ['counting_mode', detectionMode],
      ['requested_resolution', resolution],
      ['actual_resolution', actualResolution],
      ['total_unique_crossings', total],
      ...Object.entries(counts).map(([category, count]) => [category + ' crossings', count]),
      ['A-to-B crossings', directions['A-to-B']],
      ['B-to-A crossings', directions['B-to-A']],
      ['Currently visible people', visiblePeople]
    ];
    const csv = rows
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'countai-live-counts.csv';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section style={{ margin: '24px 0', padding: 20, border: '1px solid var(--border, #293c43)', borderRadius: 18, background: 'var(--panel, #101b20)', color: 'var(--text, #eef6f5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ color: '#42cdb1', fontSize: 12, letterSpacing: 1.4, fontWeight: 700 }}>LIVE COUNTER</div>
          <h2 style={{ margin: '5px 0' }}>Live monitoring</h2>
          <p style={{ margin: 0, opacity: 0.72, fontSize: 13 }}>Anonymous people tracking and line-crossing counts</p>
        </div>
        <span style={{
          borderRadius: 20, padding: '6px 10px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize',
          color: health.status === 'healthy' ? '#42cdb1' : ['degraded', 'detection-error', 'disconnected'].includes(health.status) ? '#ffb4a2' : '#d7e3e0',
          background: health.status === 'healthy' ? '#12352f' : ['degraded', 'detection-error', 'disconnected'].includes(health.status) ? '#40231f' : '#202e33'
        }} aria-live="polite">{health.status.replace('-', ' ')}</span>
      </div>

      <video ref={videoRef} muted playsInline style={{ display: 'none' }} />
      <div style={{ position: 'relative', width: '100%', background: '#080d10', borderRadius: 12, overflow: 'hidden', minHeight: 220, border: '1px solid #293c43' }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 560, objectFit: 'contain' }} />
        {!active && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, padding: 20, textAlign: 'center' }}>
            <Camera size={30} />
            <strong>{error ? 'Camera needs attention' : 'Camera not connected'}</strong>
            <span style={{ opacity: 0.72, fontSize: 13 }}>{error ? 'Review the message below, then retry when ready.' : 'Start the camera to view detections and count crossings.'}</span>
          </div>
        )}
        {active && paused && <div style={{ position: 'absolute', top: 12, right: 12, borderRadius: 8, padding: '6px 10px', background: '#402f17', color: '#ffd166', fontSize: 12, fontWeight: 700 }}>PAUSED</div>}
      </div>
      <p style={{ margin: '9px 2px 0', fontSize: 12, lineHeight: 1.6, color: '#c1d0ca' }}>
        Box labels are AI predictions, not verified facts. Confidence is hidden in the normal view. A detection is not a counted event; totals increase only when the tracker registers a line crossing.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        {!active
          ? <button className="primary-button" onClick={() => { void startCamera(); }}><Play size={16} /> Start camera</button>
          : <>
              <button className="primary-button" onClick={togglePause}>{paused ? <Play size={16} /> : <Pause size={16} />}{paused ? 'Resume counting' : 'Pause counting'}</button>
              <button className="outline-button" onClick={stopCamera}><Square size={16} /> Stop camera</button>
            </>
        }
        <button className="outline-button" onClick={resetCounts}><RotateCcw size={16} /> Reset count</button>
        <button className="outline-button" onClick={exportCsv}><Camera size={16} /> Export CSV</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 10, marginTop: 16 }}>
        <div style={{ border: '1px solid #293c43', borderRadius: 10, padding: 14, background: '#0b1519' }}>
          <div style={{ opacity: 0.72, fontSize: 12 }}>TOTAL CROSSINGS</div><strong style={{ display: 'block', fontSize: 30, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{total}</strong>
        </div>
        <div style={{ border: '1px solid #293c43', borderRadius: 10, padding: 14 }}>
          <div style={{ opacity: 0.72, fontSize: 12 }}>PEOPLE IN VIEW</div><strong style={{ display: 'block', fontSize: 26, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{visiblePeople}</strong>
        </div>
        <div style={{ border: '1px solid #293c43', borderRadius: 10, padding: 14 }}>
          <div style={{ opacity: 0.72, fontSize: 12 }}>A TO B</div><strong style={{ display: 'block', fontSize: 26, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{directions['A-to-B']}</strong>
        </div>
        <div style={{ border: '1px solid #293c43', borderRadius: 10, padding: 14 }}>
          <div style={{ opacity: 0.72, fontSize: 12 }}>B TO A</div><strong style={{ display: 'block', fontSize: 26, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{directions['B-to-A']}</strong>
        </div>
      </div>
      {Object.keys(counts).length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }} aria-label="Crossings by category">
          {Object.entries(counts).map(([category, count]) => <span key={category} style={{ border: '1px solid #40545b', borderRadius: 8, padding: '6px 10px', fontSize: 12 }}>{category}: <strong>{count}</strong></span>)}
        </div>
      )}

      <div className={`notice ${error ? 'notice-error' : ''}`} role="status" style={{ marginTop: 14 }}><CircleHelp size={17} /><span>{status}</span></div>

      <details style={{ marginTop: 14, border: '1px solid #293c43', borderRadius: 10, padding: '12px 14px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: 14 }}>Configure counting</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginTop: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Counting mode</span>
            <select value={detectionMode} onChange={event => changeMode(event.target.value as 'people' | 'all')} style={{ padding: 10, borderRadius: 8, background: '#101b20', color: 'inherit', border: '1px solid #40545b' }}>
              <option value="people">People only (recommended)</option><option value="all">All supported classes</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Camera resolution</span>
            <select value={resolution} onChange={event => { void changeResolution(event.target.value as '720p' | '1080p' | '4k'); }} style={{ padding: 10, borderRadius: 8, background: '#101b20', color: 'inherit', border: '1px solid #40545b' }}>
              <option value="720p">HD - 1280 x 720</option><option value="1080p">Full HD - 1920 x 1080</option><option value="4k">4K - 3840 x 2160</option>
            </select>
            <span style={{ opacity: 0.68, fontSize: 12 }}>Selected: {resolution}. Actual: {actualResolution}.</span>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Image enhancement</span>
            <select value={preset} onChange={event => { const value = event.target.value as 'standard' | 'low-light' | 'backlit'; presetRef.current = value; setPreset(value); }} style={{ padding: 10, borderRadius: 8, background: '#101b20', color: 'inherit', border: '1px solid #40545b' }}>
              <option value="standard">Standard colour</option><option value="low-light">Low-light brightening</option><option value="backlit">Backlit scene</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span>Enhancement strength: {enhancement}%</span>
            <input type="range" min="0" max="100" step="5" value={enhancement} onChange={event => { const value = Number(event.target.value); enhancementRef.current = value; setEnhancement(value); }} style={{ width: '100%', accentColor: '#42cdb1' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, gridColumn: '1 / -1' }}>
            <span style={{ fontWeight: 600 }}>Counting line position: {linePosition}%</span>
            <input type="range" min="10" max="90" step="1" value={linePosition} disabled={active} onChange={event => setLinePosition(Number(event.target.value))} style={{ width: '100%', accentColor: '#e6ae52' }} aria-label="Counting line vertical position" />
            <span style={{ opacity: 0.68, fontSize: 12 }}>Stop the camera before changing the line position.</span>
          </label>
        </div>
      </details>

      <details style={{ marginTop: 10, border: '1px solid #293c43', borderRadius: 10, padding: '12px 14px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: 14 }}>Diagnostics and camera health <span style={{ opacity: 0.65, fontWeight: 400 }}>- {health.status.replace('-', ' ')}</span></summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 12, marginTop: 14 }}>
          <div><div style={{ opacity: 0.7, fontSize: 12 }}>Processed FPS</div><strong>{getCameraHealthMetrics(health, healthClock).fps.toFixed(1)}</strong></div>
          <div><div style={{ opacity: 0.7, fontSize: 12 }}>AI inference</div><strong>{health.inferenceMs === null ? '-' : `${Math.round(health.inferenceMs)} ms`}</strong></div>
          <div><div style={{ opacity: 0.7, fontSize: 12 }}>Last frame age</div><strong>{health.lastFrameAt === null ? '-' : `${getCameraHealthMetrics(health, healthClock).frameAgeMs} ms`}</strong></div>
          <div><div style={{ opacity: 0.7, fontSize: 12 }}>Session elapsed</div><strong>{formatElapsedDuration(getCameraHealthMetrics(health, healthClock).sessionDurationMs)}</strong></div>
          <div><div style={{ opacity: 0.7, fontSize: 12 }}>Raw AI detections</div><strong>{rawDetectionCount}</strong></div>
          <div><div style={{ opacity: 0.7, fontSize: 12 }}>Accepted detections</div><strong>{acceptedDetectionCount}</strong></div>
          <div><div style={{ opacity: 0.7, fontSize: 12 }}>Active tracks</div><strong>{trackedObjectCount}</strong></div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={showDiagnosticConfidence} onChange={event => setShowDiagnosticConfidence(event.target.checked)} />
          Show model confidence on overlay (diagnostic only)
        </label>
        <p style={{ margin: '12px 0', fontSize: 12, lineHeight: 1.5, opacity: 0.75, minHeight: 36 }}>Confidence is the model's score for its predicted category, not a calibrated probability that the label is correct. Browser-camera telemetry only. Empty scenes are normal. Raw and accepted detection counts update as frames are processed; use these diagnostics to investigate missed detections. {health.error ? `Issue: ${health.error}` : 'Camera health is based on video-frame freshness, stream state and local inference latency.'}</p>
        <div style={{ borderTop: '1px solid #293c43', paddingTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>Recent health events</strong><button className="outline-button" onClick={clearHealthHistory} style={{ padding: '5px 8px', fontSize: 12 }}>Clear history</button>
          </div>
          {healthHistory.length === 0 ? <span style={{ opacity: 0.65, fontSize: 12 }}>No health transitions recorded yet.</span> : (
            <div style={{ display: 'grid', gap: 6 }}>
              {healthHistory.slice(-4).reverse().map(event => <div key={`${event.timestamp}-${event.status}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, alignItems: 'baseline' }}><span style={{ opacity: 0.65, fontVariantNumeric: 'tabular-nums' }}>{new Date(event.timestamp).toLocaleTimeString()}</span><strong style={{ textTransform: 'capitalize' }}>{event.status.replace('-', ' ')}</strong>{event.error && <span style={{ opacity: 0.8 }}>{event.error}</span>}</div>)}
            </div>
          )}
          <div style={{ opacity: 0.55, fontSize: 11, marginTop: 7 }}>Up to 12 status transitions are stored in this browser; no video is stored.</div>
        </div>
      </details>

      <details style={{ marginTop: 10, border: '1px solid #293c43', borderRadius: 10, padding: '12px 14px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: 14 }}>Recent live sessions · saved on this device</summary>
        <p style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.72 }}>Summaries and bounded operational events only; no video frames are stored. This is browser-local history, not recorder-side evidence.</p>
        {savedLiveSessions.length === 0 ? <span style={{ opacity: 0.65, fontSize: 12 }}>No saved live sessions yet. Start and stop a camera session to create one.</span> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {savedLiveSessions.slice(0, 5).map(session => {
              const started = Date.parse(session.startedAt);
              const ended = session.endedAt ? Date.parse(session.endedAt) : Date.now();
              const duration = Number.isFinite(started) && Number.isFinite(ended) ? formatElapsedDuration(Math.max(0, ended - started)) : '—';
              return <div key={session.id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, borderTop: '1px solid #293c43', paddingTop: 9 }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <strong style={{ display: 'block', fontSize: 12 }}>{new Date(session.startedAt).toLocaleString()}</strong>
                  <span style={{ opacity: 0.72, fontSize: 11 }}>{session.status === 'running' ? 'Running' : readableStopReason(session.stopReason)} · {duration} · {session.totalCrossings} crossings</span>
                  <span style={{ display: 'block', opacity: 0.62, fontSize: 10 }}>{session.eventCount} events{session.droppedEventCount ? ` · ${session.droppedEventCount} older events omitted` : ''} · line {session.linePosition ?? '—'}%</span>
                </div>
                <button className="outline-button" onClick={() => removeSavedLiveSession(session.id)} aria-label={'Delete live session from ' + session.startedAt} style={{ padding: '5px 8px', fontSize: 11 }}>Delete</button>
              </div>;
            })}
          </div>
        )}
      </details>

      <details style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5, opacity: 0.8 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Counting accuracy and limitations</summary>
        <p>Currently visible people are estimated from the current frame. Counts are based on tracked line-crossing events, not guaranteed unique individuals. Tracking may lose or reassign tracks during prolonged occlusion, crowded scenes, or major camera movement. A to B and B to A describe movement across the line, not necessarily entry and exit.</p>
      </details>
    </section>
  );
}
