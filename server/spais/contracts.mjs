/**
 * Versioned SPAIS resource contracts and deny-by-default authorization helpers.
 * These guards are server-side primitives; they do not authenticate a principal.
 */

export const SPAIS_API_VERSION = "v1";
export const SPAIS_CONTRACT_VERSION = 1;

export const SPAIS_RESOURCE_TYPES = Object.freeze([
  "organization",
  "site",
  "camera",
  "connector",
  "live_session",
  "incident",
  "sop_version",
  "model_release",
  "audit_event"
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_ACTIONS = new Set([
  "organization:read",
  "organization:manage",
  "site:read",
  "site:manage",
  "camera:read",
  "camera:manage",
  "connector:read",
  "connector:manage",
  "session:read",
  "session:manage",
  "incident:read",
  "incident:manage",
  "sop:read",
  "sop:manage",
  "sop:approve",
  "model:read",
  "model:propose",
  "model:approve",
  "audit:read"
]);

export function isResourceId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Return a stable, versioned descriptor; it contains no tenant/customer data. */
export function getSpaisContractManifest({ authenticationConfigured = false, tenantResourceApiEnabled = false } = {}) {
  return Object.freeze({
    apiVersion: SPAIS_API_VERSION,
    contractVersion: SPAIS_CONTRACT_VERSION,
    resourceTypes: [...SPAIS_RESOURCE_TYPES],
    authenticationConfigured: Boolean(authenticationConfigured),
    tenantResourceApiEnabled: Boolean(tenantResourceApiEnabled),
    notes: [
      tenantResourceApiEnabled
        ? "Site, camera and connector metadata APIs are enabled with verified bearer-token scope and configured SQLite persistence."
        : "Tenant-scoped resource routes remain disabled until trusted authentication and persistent storage are configured.",
      "Browser-local sessions are not server-side tenant records.",
      "Recorder health requires recorder-side evidence; browser camera status is not recording assurance.",
      "Report-based recording assessment computes reported coverage ratios and window continuity from signed connector reports; it is not independent proof of recording."
    ]
  });
}

/**
 * Enforce organization, site and action scope for an already-authenticated
 * principal. Callers MUST obtain principal from a trusted authentication
 * adapter, never from request body or client-controlled headers.
 */
export function authorizeSpaisAction({ principal, organizationId, siteId, action }) {
  const deny = reason => ({ allowed: false, reason });
  if (!principal || typeof principal !== "object") return deny("principal_required");
  if (!isResourceId(principal.subjectId)) return deny("trusted_subject_required");
  if (!isResourceId(organizationId)) return deny("valid_organization_required");
  if (!ALLOWED_ACTIONS.has(action)) return deny("unsupported_action");

  const organizationIds = Array.isArray(principal.organizationIds) ? principal.organizationIds : [];
  if (!organizationIds.includes(organizationId)) return deny("organization_scope_denied");

  if (siteId !== undefined && siteId !== null) {
    if (!isResourceId(siteId)) return deny("valid_site_required");
    const sitesByOrganization = principal.sitesByOrganization;
    const scopedSites = sitesByOrganization && Array.isArray(sitesByOrganization[organizationId])
      ? sitesByOrganization[organizationId]
      : [];
    if (!scopedSites.includes(siteId)) return deny("site_scope_denied");
  }

  const permissions = Array.isArray(principal.permissions) ? principal.permissions : [];
  if (!permissions.includes(action)) return deny("action_permission_denied");
  return { allowed: true, reason: "authorized" };
}

export function validateSpaisResourceEnvelope(value, expectedType) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["resource must be an object"] };
  }
  if (value.contractVersion !== SPAIS_CONTRACT_VERSION) errors.push("contractVersion must be 1");
  if (value.resourceType !== expectedType || !SPAIS_RESOURCE_TYPES.includes(expectedType)) {
    errors.push("resourceType does not match the expected supported type");
  }
  if (!isResourceId(value.id)) errors.push("id must be a valid resource identifier");
  if (!isResourceId(value.organizationId)) errors.push("organizationId must be a valid resource identifier");
  if (expectedType !== "organization" && !isResourceId(value.siteId) && expectedType !== "site") {
    // A site itself belongs to an organization; child resources must be site-scoped.
    errors.push("siteId must be a valid resource identifier for this resource type");
  }
  if (expectedType === "site" && !isResourceId(value.id)) errors.push("site id is required");
  return { valid: errors.length === 0, errors };
}
