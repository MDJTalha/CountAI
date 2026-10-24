import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeSpaisAction,
  getSpaisContractManifest,
  isResourceId,
  validateSpaisResourceEnvelope
} from '../server/spais/contracts.mjs';

test('manifest advertises versioned contracts without claiming enabled tenant APIs', () => {
  const manifest = getSpaisContractManifest();
  assert.equal(manifest.apiVersion, 'v1');
  assert.equal(manifest.contractVersion, 1);
  assert.ok(manifest.resourceTypes.includes('camera'));
  assert.equal(manifest.authenticationConfigured, false);
  assert.equal(manifest.tenantResourceApiEnabled, false);
});

test('resource identifiers reject empty, whitespace and path-like values', () => {
  assert.equal(isResourceId('org-01'), true);
  assert.equal(isResourceId(''), false);
  assert.equal(isResourceId('org / other'), false);
  assert.equal(isResourceId('../admin'), false);
});

test('resource envelope requires version, matching type and tenant identity', () => {
  const valid = validateSpaisResourceEnvelope({
    contractVersion: 1, resourceType: 'camera', id: 'cam-01',
    organizationId: 'org-01', siteId: 'site-01'
  }, 'camera');
  assert.deepEqual(valid, { valid: true, errors: [] });

  const invalid = validateSpaisResourceEnvelope({
    contractVersion: 2, resourceType: 'incident', id: '../bad',
    organizationId: '', siteId: ''
  }, 'camera');
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length >= 4);
});

test('authorization denies missing principals and cross-organization access', () => {
  assert.equal(authorizeSpaisAction({
    principal: null, organizationId: 'org-01', action: 'camera:read'
  }).allowed, false);

  const result = authorizeSpaisAction({
    principal: {
      subjectId: 'user-1',
      organizationIds: ['org-2'],
      permissions: ['camera:read']
    },
    organizationId: 'org-1',
    action: 'camera:read'
  });
  assert.deepEqual(result, { allowed: false, reason: 'organization_scope_denied' });
});

test('authorization checks site scope and explicit action permission', () => {
  const principal = {
    subjectId: 'user-1',
    organizationIds: ['org-1'],
    sitesByOrganization: { 'org-1': ['site-1'] },
    permissions: ['camera:read']
  };
  assert.equal(authorizeSpaisAction({
    principal, organizationId: 'org-1', siteId: 'site-1', action: 'camera:read'
  }).allowed, true);
  assert.deepEqual(authorizeSpaisAction({
    principal, organizationId: 'org-1', siteId: 'site-2', action: 'camera:read'
  }), { allowed: false, reason: 'site_scope_denied' });
  assert.deepEqual(authorizeSpaisAction({
    principal, organizationId: 'org-1', siteId: 'site-1', action: 'camera:manage'
  }), { allowed: false, reason: 'action_permission_denied' });
});
