# Camera health monitoring (Milestone 2)

## Scope

The current implementation monitors the browser camera used by CountAI's Live Counter. A customer-controlled connector can also poll one explicitly configured read-only JSON recorder-status endpoint and forward signed metadata reports. This is not universal RTSP/ONVIF support and does not directly inspect media streams.

## Signals and states

- **Starting**: camera has been opened but no usable video frame has been observed yet.
- **Healthy**: new video frames are arriving and local inference is within the current latency target.
- **Degraded**: frames have stalled for more than 2.5 seconds, no initial frame arrives before the startup threshold, or local inference exceeds 500 ms.
- **Disconnected**: the browser's video track has ended or camera acquisition failed.
- **Detection error**: local model inference threw an error; this is distinct from a quiet scene with zero detections.
- **Paused / Stopped**: operator-controlled states.

## Metrics

The Live Counter shows processed-frame rate, most recent local inference duration, age of the last processed frame, and the latest health issue. Processed FPS measures frames actually sent through inference, not the camera's hardware/native frame rate. No images or frames are uploaded by this monitoring module.

## Current safeguards and limitations

- Repeated `video.currentTime` values are skipped so the same decoded frame is not counted repeatedly by the inference loop.
- The UI watchdog checks stream state and frame freshness once per second.
- Recovery is intentionally operator-controlled in this milestone. Automatic reconnect must be designed with backoff, stream cleanup, and count-session continuity tests before being enabled.
- A healthy browser stream does not prove an NVR is recording. The report-based recording-assurance endpoint evaluates signed coverage-report ratios and reporting-window continuity, but every result remains `reported_not_independently_verified`; it does not prove footage was captured.
- Up to 12 health-state transitions are persisted in browser local storage. Stored events contain timestamps, status labels, and bounded error text only; no video or detections are stored.
- A formal SLA-grade uptime percentage is not yet reported. Server-side incidents and report-based coverage assessment exist, but continuous uptime still requires a continuously running connector, vendor-specific recorder adapters, and controlled customer validation.
