# SPAIS integration status — CountAI codebase

## Current integration branch
- Branch: `feat/spais-operator-console-foundation`
- Purpose: evolve the existing CountAI React/TypeScript PWA into SPAIS incrementally.
- This change is a UI/product-identity foundation; it does not claim that a customer connector, NVR recording assurance, incident workflow, SOP engine, or autonomous model-training pipeline is operational.

## Available in this build
- Browser-local photo detection and manual review.
- Browser-attached live-camera workflow.
- Local photo session history and analytics.
- PWA shell and existing automated test suites.

## Not connected or not implemented in this build
- Customer-controlled edge connector and camera/NVR inventory.
- Recorder-side recording coverage evidence.
- Server-enforced organization/site tenancy and role authorization.
- Incident lifecycle and SOP/policy governance.
- Governed model candidate evaluation and promotion.

## Integration rules
1. Preserve local-first processing; no raw frames/video leave the customer environment by default.
2. Do not infer recorder health from browser camera health or a network ping.
3. Use versioned contracts and server-side authorization before multi-tenant data access.
4. Treat operator feedback as candidate labels, not automatic ground truth.
5. Require independent evaluation, human approval, controlled rollout, monitoring, and rollback for production model changes.
6. Report each capability as planned, implemented, automated-test passed, lab-verified, pilot-accepted, or production-approved with evidence.

## Next implementation gate
Verify the candidate branch using the repository CI, then continue with versioned operational event/session contracts and integration tests before adding real customer network or recorder access.
