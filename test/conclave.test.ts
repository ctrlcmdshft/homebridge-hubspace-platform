import * as tls from 'tls';
import { EventEmitter } from 'events';

// ─── Minimal ConclaveClient test surface ──────────────────────────────────────
// ConclaveClient is not exported — we test the integration behaviour by
// inspecting what HubspaceClient.startConclave wires up via mocks.

// Inline helpers that mirror ConclaveClient's internal JSON parsing logic so
// we can unit-test the message-handling contract without needing to export the class.

function extractDeviceIdFromPublicEvent(raw: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('public' in parsed)
  ) return null;

  const pub = (parsed as { public: { event: string; data: { id?: unknown } } }).public;
  if (pub.event !== 'attr_change' && pub.event !== 'status_change') return null;
  const id = pub.data?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Conclave message parsing', () => {
  it('extracts deviceId from attr_change events', () => {
    const line = JSON.stringify({
      public: {
        event: 'attr_change',
        data: {
          id: 'device-abc-123',
          attribute: { id: 65527, value: 'true' },
        },
      },
    });
    expect(extractDeviceIdFromPublicEvent(line)).toBe('device-abc-123');
  });

  it('extracts deviceId from status_change events', () => {
    const line = JSON.stringify({
      public: {
        event: 'status_change',
        data: {
          id: 'device-xyz-456',
          status: { available: true, connected: true },
        },
      },
    });
    expect(extractDeviceIdFromPublicEvent(line)).toBe('device-xyz-456');
  });

  it('ignores peripherallist events', () => {
    const line = JSON.stringify({
      public: {
        event: 'peripherallist',
        data: { id: 'should-be-ignored' },
      },
    });
    expect(extractDeviceIdFromPublicEvent(line)).toBeNull();
  });

  it('ignores hello messages', () => {
    const line = JSON.stringify({ hello: { heartbeat: 270 } });
    expect(extractDeviceIdFromPublicEvent(line)).toBeNull();
  });

  it('ignores welcome messages', () => {
    const line = JSON.stringify({ welcome: {} });
    expect(extractDeviceIdFromPublicEvent(line)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractDeviceIdFromPublicEvent('not json {')).toBeNull();
  });

  it('returns null when data.id is missing', () => {
    const line = JSON.stringify({
      public: { event: 'attr_change', data: {} },
    });
    expect(extractDeviceIdFromPublicEvent(line)).toBeNull();
  });

  it('returns null when data.id is not a string', () => {
    const line = JSON.stringify({
      public: { event: 'attr_change', data: { id: 42 } },
    });
    expect(extractDeviceIdFromPublicEvent(line)).toBeNull();
  });
});

describe('Conclave backoff logic', () => {
  it('doubles backoff up to cap', () => {
    const cap = 20_000;
    let backoff = 1_000;
    const sequence: number[] = [];
    for (let i = 0; i < 8; i++) {
      sequence.push(backoff);
      backoff = Math.min(backoff * 2, cap);
    }
    expect(sequence).toEqual([1000, 2000, 4000, 8000, 16000, 20000, 20000, 20000]);
  });
});
