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

type TrackerState = ReturnType<typeof createTracker>;

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

  const [active, setActive] = useState(false);
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
    return (
    <section style={{ margin: '24px 0', padding: 20, border: '1px solid var(--border, #293c43)', borderRadius: 18, background: 'var(--panel, #101b20)', color: 'var(--text, #eef6f5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ color: '#42cdb1', fontSize: 12, letterSpacing: 1.4, fontWeight: 700 }}>LIVE COUNTER</div>
          <h2 style={{ margin: '5px 0' }}>Live monitoring</h2>
          <p style={{ margin: 0, opacity: 0.72, fontSize: 13 }}>Anonymous people tracking and line-crossing counts</p>
        </div>
        <span style={{
          borderRadius: 20,
          padding: '6px 10px',
          fontSize: 12,
          fontWeight: 700,
          textTransform: 'capitalize',
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
        {active && paused && (
          <div style={{ position: 'absolute', top: 12, right: 12, borderRadius: 8, padding: '6px 10px', background: '#402f17', color: '#ffd166', fontSize: 12, fontWeight: 700 }}>PAUSED</div>
        )}
      </div>

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
          <div style={{ opacity: 0.72, fontSize: 12 }}>TOTAL CROSSINGS</div>
          <strong style={{ display: 'block', fontSize: 30, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{total}</strong>
        </div>
        <div style={{ border: '1px solid #293c43', borderRadius: 10, padding: 14 }}>
          <div style={{ opacity: 0.72, fontSize: 12 }}>PEOPLE IN VIEW</div>
          <strong style={{ display: 'block', fontSize: 26, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{visiblePeople}</strong>
        </div>
        <div style={{ border: '1px solid #293c43', borderRadius: 10, padding: 14 }}>
          <div style={{ opacity: 0.72, fontSize: 12 }}>A TO B</div>
          <strong style={{ display: 'block', fontSize: 26, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{directions['A-to-B']}</strong>
        </div>
        <div style={{ border: '1px solid #293c43', borderRadius: 10, padding: 14 }}>
          <div style={{ opacity: 0.72, fontSize: 12 }}>B TO A</div>
          <strong style={{ display: 'block', fontSize: 26, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{directions['B-to-A']}</strong>
        </div>
      </div>

      {Object.keys(counts).length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }} aria-label="Crossings by category">
          {Object.entries(counts).map(([category, count]) => (
            <span key={category} style={{ border: '1px solid #40545b', borderRadius: 8, padding: '6px 10px', fontSize: 12 }}>
              {category}: <strong>{count}</strong>
            </span>
          ))}
        </div>
      )}

      <div className={`notice ${error ? 'notice-error' : ''}`} role="status" style={{ marginTop: 14 }}>
        <CircleHelp size={17} /><span>{status}</span>
      </div>

      <details style={{ marginTop: 14, border: '1px solid #293c43', borderRadius: 10, padding: '12px 14px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: 14 }}>Configure counting</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginTop: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Counting mode</span>
            <select value={detectionMode} onChange={event => changeMode(event.target.value as 'people' | 'all')} style={{ padding: 10, borderRadius: 8, background: '#101b20', color: 'inherit', border: '1px solid #40545b' }}>
              <option value="people">People only (recommended)</option>
              <option value="all">All supported classes</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Camera resolution</span>
            <select value={resolution} onChange={event => { void changeResolution(event.target.value as '720p' | '1080p' | '4k'); }} style={{ padding: 10, borderRadius: 8, background: '#101b20', color: 'inherit', border: '1px solid #40545b' }}>
              <option value="720p">HD - 1280 x 720</option>
              <option value="1080p">Full HD - 1920 x 1080</option>
              <option value="4k">4K - 3840 x 2160</option>
            </select>
            <span style={{ opacity: 0.68, fontSize: 12 }}>Selected: {resolution}. Actual: {actualResolution}.</span>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Image enhancement</span>
            <select value={preset} onChange={event => { const value = event.target.value as 'standard' | 'low-light' | 'backlit'; presetRef.current = value; setPreset(value); }} style={{ padding: 10, borderRadius: 8, background: '#101b20', color: 'inherit', border: '1px solid #40545b' }}>
              <option value="standard">Standard colour</option>
              <option value="low-light">Low-light brightening</option>
              <option value="backlit">Backlit scene</option>
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
        <p style={{ margin: '12px 0', fontSize: 12, opacity: 0.75 }}>
          Browser-camera telemetry only. A quiet scene is not considered a camera failure. {health.error ? `Issue: ${health.error}` : 'Health is based on video-frame freshness, stream state and local inference latency.'}
          {detectionMode === 'people' && acceptedDetectionCount === 0 ? ' No person detections currently pass the confidence filter; check lighting and framing, or temporarily select all supported classes to diagnose model output.' : ''}
        </p>
        <div style={{ borderTop: '1px solid #293c43', paddingTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>Recent health events</strong>
            <button className="outline-button" onClick={clearHealthHistory} style={{ padding: '5px 8px', fontSize: 12 }}>Clear history</button>
          </div>
          {healthHistory.length === 0
            ? <span style={{ opacity: 0.65, fontSize: 12 }}>No health transitions recorded yet.</span>
            : <div style={{ display: 'grid', gap: 6 }}>
                {healthHistory.slice(-4).reverse().map(event => (
                  <div key={`${event.timestamp}-${event.status}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, alignItems: 'baseline' }}>
                    <span style={{ opacity: 0.65, fontVariantNumeric: 'tabular-nums' }}>{new Date(event.timestamp).toLocaleTimeString()}</span>
                    <strong style={{ textTransform: 'capitalize' }}>{event.status.replace('-', ' ')}</strong>
                    {event.error && <span style={{ opacity: 0.8 }}>{event.error}</span>}
                  </div>
                ))}
              </div>
          }
          <div style={{ opacity: 0.55, fontSize: 11, marginTop: 7 }}>Up to 12 status transitions are stored in this browser; no video is stored.</div>
        </div>
      </details>

      <details style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5, opacity: 0.8 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Counting accuracy and limitations</summary>
        <p>
          Currently visible people are estimated from the current frame. Counts are based on tracked line-crossing events, not guaranteed unique individuals. Tracking may lose or reassign tracks during prolonged occlusion, crowded scenes, or major camera movement. A to B and B to A describe movement across the line, not necessarily entry and exit.
        </p>
      </details>
    </section>
  );
}
