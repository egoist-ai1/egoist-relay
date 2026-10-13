import { describe, expect, it, vi } from 'vitest';

import {
  getNetworkErrorKey, getNetworkRouteKey, getNetworkStateKey, normalizeNetworkStatus,
  NOT_CONFIGURED_STATUS, parseNetworkErrorCode,
} from './relayNetwork';

vi.mock('../browser/globalEnvironment', () => ({ IS_TAURI: false }));

describe('Network status mapping', () => {
  it('Fills missing fields of a partial payload', () => {
    const status = normalizeNetworkStatus({ state: 'tunnel', services: { x: 'direct' } });
    expect(status.state).toBe('tunnel');
    expect(status.services).toEqual({ telegram: 'unknown', x: 'direct', instagram: 'unknown' });
    expect(status.hasMtproxy).toBe(false);
  });

  it('Falls back to the not-configured status for garbage', () => {
    expect(normalizeNetworkStatus(undefined)).toBe(NOT_CONFIGURED_STATUS);
    expect(normalizeNetworkStatus('tunnel')).toBe(NOT_CONFIGURED_STATUS);
  });

  it('Maps every state and route to a language key', () => {
    expect(getNetworkStateKey('dnsOnly')).toBe('RelayNetStateDnsOnly');
    expect(getNetworkStateKey('restartRequired')).toBe('RelayNetStateRestart');
    expect(getNetworkRouteKey('unavailable')).toBe('RelayNetRouteUnavailable');
    expect(getNetworkRouteKey('disabled')).toBe('RelayNetRouteDisabled');
  });
});

describe('Network error codes', () => {
  it('Reads a code from a string, an Error and an object', () => {
    expect(parseNetworkErrorCode('INVALID_VPN')).toBe('INVALID_VPN');
    expect(parseNetworkErrorCode(new Error('relay_network_apply: PROBE_FAILED'))).toBe('PROBE_FAILED');
    expect(parseNetworkErrorCode({ code: 'INVALID_DOH' })).toBe('INVALID_DOH');
  });

  it('Treats unknown failures as a generic error with its own text', () => {
    const code = parseNetworkErrorCode(42);
    expect(code).toBe('UNKNOWN');
    expect(getNetworkErrorKey(code)).toBe('RelayNetErrUnknown');
    expect(getNetworkErrorKey('PROBE_FAILED')).toBe('RelayNetErrProbeFailed');
  });
});
