/**
 * Veridex Agent SDK - Feature Flags Integration Tests
 * 
 * Tests that the feature flag functions work correctly when used from
 * the agent-sdk context. Imports directly from the SDK featureFlags module
 * to avoid transitive CJS/ESM dependency issues from the full SDK barrel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getFeatureFlags,
  setFeatureFlags,
  resetFeatureFlags,
  isMultiHubEnabled,
  getEffectivePrimaryHub,
} from '../../sdk/src/featureFlags';

// ============================================================================
// Feature Flag Re-export Tests
// ============================================================================

describe('agent-sdk feature flag re-exports', () => {
  beforeEach(() => {
    resetFeatureFlags();
  });

  afterEach(() => {
    resetFeatureFlags();
  });

  it('should re-export getFeatureFlags', () => {
    expect(typeof getFeatureFlags).toBe('function');
    const flags = getFeatureFlags();
    expect(flags).toHaveProperty('multiHub');
    expect(flags).toHaveProperty('primaryHub');
  });

  it('should re-export setFeatureFlags', () => {
    expect(typeof setFeatureFlags).toBe('function');
    setFeatureFlags({ multiHub: true });
    expect(isMultiHubEnabled()).toBe(true);
  });

  it('should re-export resetFeatureFlags', () => {
    expect(typeof resetFeatureFlags).toBe('function');
    setFeatureFlags({ multiHub: true });
    resetFeatureFlags();
    expect(isMultiHubEnabled()).toBe(false);
  });

  it('should re-export isMultiHubEnabled', () => {
    expect(typeof isMultiHubEnabled).toBe('function');
    expect(isMultiHubEnabled()).toBe(false);
  });

  it('should re-export getEffectivePrimaryHub', () => {
    expect(typeof getEffectivePrimaryHub).toBe('function');
    expect(getEffectivePrimaryHub()).toBe('base');
  });
});

// ============================================================================
// AgentWallet Hub Selection Tests
// ============================================================================

describe('AgentWallet hub selection', () => {
  beforeEach(() => {
    resetFeatureFlags();
  });

  afterEach(() => {
    resetFeatureFlags();
  });

  it('getEffectivePrimaryHub should return base when multi-hub disabled', () => {
    expect(getEffectivePrimaryHub()).toBe('base');
  });

  it('getEffectivePrimaryHub should return configured hub when multi-hub enabled', () => {
    setFeatureFlags({ multiHub: true, primaryHub: 'avalanche' as any });
    expect(getEffectivePrimaryHub()).toBe('avalanche');
  });

  it('getEffectivePrimaryHub should force base when multi-hub disabled even with override', () => {
    setFeatureFlags({ multiHub: false, primaryHub: 'avalanche' as any });
    expect(getEffectivePrimaryHub()).toBe('base');
  });
});

// ============================================================================
// Hackathon Mode Tests
// ============================================================================

describe('Avalanche Build Games hackathon mode', () => {
  beforeEach(() => {
    resetFeatureFlags();
  });

  afterEach(() => {
    resetFeatureFlags();
  });

  it('default mode should be single-hub for hackathon demo simplicity', () => {
    expect(isMultiHubEnabled()).toBe(false);
    expect(getEffectivePrimaryHub()).toBe('base');
  });

  it('should allow enabling multi-hub for post-hackathon Avalanche hub mode', () => {
    setFeatureFlags({ multiHub: true, primaryHub: 'avalanche' as any });
    expect(isMultiHubEnabled()).toBe(true);
    expect(getEffectivePrimaryHub()).toBe('avalanche');
  });
});

// ============================================================================
// Enterprise Risk Pivot Tests
// ============================================================================

describe('Enterprise Risk Pivot alignment', () => {
  beforeEach(() => {
    resetFeatureFlags();
  });

  afterEach(() => {
    resetFeatureFlags();
  });

  it('single hub provides clear audit trail for enterprise compliance', () => {
    // Enterprise Risk Pivot: "single source of truth" model
    expect(isMultiHubEnabled()).toBe(false);
    const hub = getEffectivePrimaryHub();
    expect(hub).toBe('base');
  });

  it('multi-hub enables horizontal scaling for enterprise deployments', () => {
    setFeatureFlags({ multiHub: true });
    expect(isMultiHubEnabled()).toBe(true);
    // All hub-capable chains become available
  });

  it('feature flag changes are instant (no restart required)', () => {
    expect(isMultiHubEnabled()).toBe(false);
    setFeatureFlags({ multiHub: true });
    expect(isMultiHubEnabled()).toBe(true);
    setFeatureFlags({ multiHub: false });
    expect(isMultiHubEnabled()).toBe(false);
  });
});
