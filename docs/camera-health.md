# Camera health monitoring (Milestone 2)

## Scope

The current implementation monitors the browser camera used by CountAI's Live Counter. It does not yet monitor RTSP/ONVIF IP cameras, NVR/DVR reachability, or recorder-side recording completeness; those require a later customer-controlled connector.

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
- A healthy browser stream does not prove an NVR is recording. Recording assurance is a separate later milestone requiring recorder-side evidence.
- Health state is currently in memory for the active page session; persistent incident history and uptime percentages are not yet implemented.
