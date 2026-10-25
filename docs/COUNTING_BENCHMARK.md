# CountAI counting benchmark evaluator

The evaluator compares **human-reviewed ground-truth crossing events** with exported predicted crossing events. It is a measurement tool, not an inference engine and not proof of accuracy until representative clips have been annotated and evaluated.

## Run

After installing dependencies, execute:

\`\`\`bash
node scripts/evaluate-counting-benchmark.mjs path/to/benchmark.json
\`\`\`

Input format:

\`\`\`json
{
  "toleranceMs": 1000,
  "groundTruth": [
    {
      "clipId": "lobby-am-001",
      "cameraId": "camera-01",
      "category": "person",
      "direction": "A-to-B",
      "timestampMs": 1710000000000
    }
  ],
  "predictions": [
    {
      "clipId": "lobby-am-001",
      "cameraId": "camera-01",
      "category": "person",
      "direction": "A-to-B",
      "timestampMs": 1710000000500
    }
  ]
}
\`\`\`

Each event needs a stable clip ID, camera ID, category, direction (A-to-B or B-to-A), and event timestamp in milliseconds. Use a consistent timestamp origin per clip. The default matching tolerance is 1,000 ms; choose and document a tolerance appropriate to the frame rate and annotation policy before looking at held-out results.

The evaluator performs one-to-one matching constrained by clip, camera, category, direction, and tolerance. It reports TP/FP/FN, precision, recall, F1, per-clip absolute count error, mean absolute count error, and matched-pair timing differences. A prediction can match at most one ground-truth event.

## Recommended benchmark procedure

1. Select customer-authorized clips that represent camera angles, lighting, density, occlusion, movement direction and expected operating conditions.
2. Have reviewers annotate ground-truth crossings under a written counting policy; adjudicate ambiguous events.
3. Freeze and hash the clip list, annotation version, model version and inference configuration.
4. Split data by clip/camera/time before tuning; do not tune on the held-out test set.
5. Export model crossing events to the input schema and run the evaluator.
6. Review aggregate and per-clip results plus false positives, missed crossings, wrong directions, duplicate counts and track-ID switches.
7. Record acceptance thresholds agreed with the customer, the full report, exclusions, and reviewer approval.

This evaluator does not decide whether results are acceptable; acceptance thresholds must be agreed in advance. Empty prediction or ground-truth sets yield null precision/recall when the denominator is undefined. Never claim measured production accuracy from unit tests alone.
