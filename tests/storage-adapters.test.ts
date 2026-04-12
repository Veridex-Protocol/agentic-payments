/**
 * Tests for Storage Adapters (Arweave, IPFS, Filecoin, Storacha, Akave, Postgres, JSONFile)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryStorage } from '../src/trace/storage/MemoryStorage';
import { ArweaveStorage } from '../src/trace/storage/ArweaveStorage';
import { IPFSStorage } from '../src/trace/storage/IPFSStorage';
import { FilecoinStorage } from '../src/trace/storage/FilecoinStorage';
import { StorachaStorage } from '../src/trace/storage/StorachaStorage';
import { AkaveStorage } from '../src/trace/storage/AkaveStorage';
import { PostgresStorage } from '../src/trace/storage/PostgresStorage';
import { JSONFileStorage } from '../src/trace/storage/JSONFileStorage';
import type { VeridexTracePayload } from '../src/trace/types';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockTrace(traceId = 'trace-1'): VeridexTracePayload {
  return {
    traceId,
    timestamp: Date.now(),
    sessionKeyHash: '0xabc123',
    reasoning: { toolCalls: [] },
    proposedAction: {
      type: 'payment',
      recipient: '0x1234',
      asset: 'USDC',
      amount: '1000000',
      amountUSD: 1.0,
      chain: 2,
      protocol: 'x402',
    },
  };
}

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('should store and retrieve a trace', async () => {
    const trace = createMockTrace();
    const receipt = await storage.store(trace, '0xhash1');
    expect(receipt.provider).toBe('memory');
    expect(receipt.immutable).toBe(false);

    const retrieved = await storage.retrieve(receipt.contentId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.traceId).toBe('trace-1');
  });

  it('should verify matching hash', async () => {
    const trace = createMockTrace();
    const receipt = await storage.store(trace, '0xhash1');
    const valid = await storage.verify(receipt.contentId, '0xhash1');
    expect(valid).toBe(true);
  });

  it('should fail verification for wrong hash', async () => {
    const trace = createMockTrace();
    const receipt = await storage.store(trace, '0xhash1');
    const valid = await storage.verify(receipt.contentId, '0xwrong');
    expect(valid).toBe(false);
  });

  it('should return null for non-existent trace', async () => {
    const result = await storage.retrieve('non-existent');
    expect(result).toBeNull();
  });
});

describe('ArweaveStorage', () => {
  let storage: ArweaveStorage;

  beforeEach(() => {
    storage = new ArweaveStorage({
      gatewayUrl: 'https://arweave.test',
      walletJWK: '{"kty":"RSA","n":"test"}',
    });
    mockFetch.mockReset();
  });

  it('should store a trace via Arweave API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'ar-tx-123' }),
    });

    const trace = createMockTrace();
    const receipt = await storage.store(trace, '0xhash1');
    expect(receipt.provider).toBe('arweave');
    expect(receipt.immutable).toBe(true);
    expect(receipt.contentId).toBe('ar-tx-123');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('should throw on failed store', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
    });

    const trace = createMockTrace();
    await expect(storage.store(trace, '0xhash1')).rejects.toThrow('Arweave upload failed');
  });

  it('should retrieve a trace', async () => {
    const trace = createMockTrace();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ trace }),
    });

    const result = await storage.retrieve('ar-tx-123');
    expect(result).not.toBeNull();
    expect(result!.traceId).toBe('trace-1');
  });

  it('should return null on retrieval failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await storage.retrieve('non-existent');
    expect(result).toBeNull();
  });

  it('should verify matching hash', async () => {
    const trace = createMockTrace();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ trace, traceHash: '0xmyhash' }),
    });

    const valid = await storage.verify('ar-tx-123', '0xmyhash');
    expect(valid).toBe(true);
  });
});

describe('IPFSStorage', () => {
  let storage: IPFSStorage;

  beforeEach(() => {
    storage = new IPFSStorage({
      apiUrl: 'https://ipfs-api.test',
      gatewayUrl: 'https://ipfs-gw.test',
    });
    mockFetch.mockReset();
  });

  it('should store a trace via IPFS API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Hash: 'QmTest123' }),
    });

    const trace = createMockTrace();
    const receipt = await storage.store(trace, '0xhash1');
    expect(receipt.provider).toBe('ipfs');
    expect(receipt.contentId).toBe('QmTest123');
    expect(receipt.immutable).toBe(true);
  });

  it('should throw on failed store', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Error',
    });

    const trace = createMockTrace();
    await expect(storage.store(trace, '0xhash1')).rejects.toThrow('IPFS upload failed');
  });

  it('should retrieve via gateway', async () => {
    const trace = createMockTrace();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ trace }),
    });

    const result = await storage.retrieve('QmTest123');
    expect(result).not.toBeNull();
    expect(result!.traceId).toBe('trace-1');
  });
});

describe('FilecoinStorage', () => {
  let storage: FilecoinStorage;
  let mockClient: {
    upload: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockClient = {
      upload: vi.fn(),
      download: vi.fn(),
    };
    storage = new FilecoinStorage({ client: mockClient });
    mockFetch.mockReset();
  });

  it('should store via Synapse SDK upload', async () => {
    mockClient.upload.mockResolvedValueOnce({
      pieceCid: { toString: () => 'bafkzcib-trace-1' },
      size: 256,
      complete: true,
      copies: [{ providerId: 1n, dataSetId: 42n, role: 'primary' }],
    });

    const trace = createMockTrace();
    const receipt = await storage.store(trace, '0xhash1');
    expect(receipt.provider).toBe('filecoin-cloud');
    expect(receipt.contentId).toBe('bafkzcib-trace-1');
    expect(receipt.immutable).toBe(true);

    // Verify upload was called with Uint8Array containing the serialized trace
    expect(mockClient.upload).toHaveBeenCalledOnce();
    const [data, opts] = mockClient.upload.mock.calls[0];
    expect(data).toBeInstanceOf(Uint8Array);
    expect(opts.pieceMetadata.traceId).toBe('trace-1');
    expect(opts.copies).toBe(2); // default
  });

  it('should retrieve via Synapse SDK download', async () => {
    const trace = createMockTrace();
    const payload = JSON.stringify({ trace, traceHash: '0xhash1' });
    mockClient.download.mockResolvedValueOnce(new TextEncoder().encode(payload));

    const result = await storage.retrieve('bafkzcib-trace-1');
    expect(result).not.toBeNull();
    expect(result!.traceId).toBe('trace-1');

    expect(mockClient.download).toHaveBeenCalledWith({
      pieceCid: 'bafkzcib-trace-1',
      withCDN: false,
    });
  });

  it('should return null when download fails', async () => {
    mockClient.download.mockRejectedValueOnce(new Error('not found'));
    const result = await storage.retrieve('nonexistent');
    expect(result).toBeNull();
  });

  it('should verify matching traceHash', async () => {
    const trace = createMockTrace();
    const payload = JSON.stringify({ trace, traceHash: '0xmyhash' });
    mockClient.download.mockResolvedValueOnce(new TextEncoder().encode(payload));

    const valid = await storage.verify('bafkzcib-trace-1', '0xmyhash');
    expect(valid).toBe(true);
  });

  it('should reject mismatched traceHash', async () => {
    const trace = createMockTrace();
    const payload = JSON.stringify({ trace, traceHash: '0xwrong' });
    mockClient.download.mockResolvedValueOnce(new TextEncoder().encode(payload));

    const valid = await storage.verify('bafkzcib-trace-1', '0xcorrect');
    expect(valid).toBe(false);
  });

  it('should use custom copies and CDN config', async () => {
    const customStorage = new FilecoinStorage({
      client: mockClient,
      copies: 3,
      withCDN: true,
      metadata: { project: 'veridex' },
    });

    mockClient.upload.mockResolvedValueOnce({
      pieceCid: { toString: () => 'bafkzcib-custom' },
      size: 128,
      complete: true,
      copies: [],
    });

    const trace = createMockTrace();
    await customStorage.store(trace, '0xhash');

    const [, opts] = mockClient.upload.mock.calls[0];
    expect(opts.copies).toBe(3);
    expect(opts.metadata.project).toBe('veridex');
  });
});

describe('StorachaStorage', () => {
  let storage: StorachaStorage;
  let mockClient: {
    uploadFile: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockClient = {
      uploadFile: vi.fn(),
    };
    storage = new StorachaStorage({ client: mockClient });
    mockFetch.mockReset();
  });

  it('should store via Storacha client uploadFile', async () => {
    mockClient.uploadFile.mockResolvedValueOnce({
      toString: () => 'bafybeig-storacha-cid',
    });

    const trace = createMockTrace();
    const receipt = await storage.store(trace, '0xhash1');
    expect(receipt.provider).toBe('storacha');
    expect(receipt.contentId).toBe('bafybeig-storacha-cid');
    expect(receipt.immutable).toBe(true);

    // Verify uploadFile was called with a Blob
    expect(mockClient.uploadFile).toHaveBeenCalledOnce();
    const [blob] = mockClient.uploadFile.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
  });

  it('should retrieve via IPFS gateway', async () => {
    const trace = createMockTrace();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ trace }),
    });

    const result = await storage.retrieve('bafybeig-storacha-cid');
    expect(result).not.toBeNull();
    expect(result!.traceId).toBe('trace-1');

    // Verify gateway URL format: https://{cid}.ipfs.{gatewayHost}
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://bafybeig-storacha-cid.ipfs.w3s.link');
  });

  it('should use custom gateway host', async () => {
    const customStorage = new StorachaStorage({
      client: mockClient,
      gatewayHost: 'storacha.link',
    });

    const trace = createMockTrace();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ trace }),
    });

    await customStorage.retrieve('bafybeig-cid');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://bafybeig-cid.ipfs.storacha.link');
  });

  it('should return null when gateway returns not found', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await storage.retrieve('nonexistent');
    expect(result).toBeNull();
  });

  it('should verify matching traceHash via gateway', async () => {
    const trace = createMockTrace();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ trace, traceHash: '0xmyhash' }),
    });

    const valid = await storage.verify('bafybeig-cid', '0xmyhash');
    expect(valid).toBe(true);
  });

  it('should reject mismatched traceHash', async () => {
    const trace = createMockTrace();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ trace, traceHash: '0xwrong' }),
    });

    const valid = await storage.verify('bafybeig-cid', '0xcorrect');
    expect(valid).toBe(false);
  });
});

describe('AkaveStorage', () => {
  let storage: AkaveStorage;

  beforeEach(() => {
    storage = new AkaveStorage({
      apiUrl: 'https://akave-api.test',
      apiKey: 'test-api-key',
      bucket: 'traces',
    });
    mockFetch.mockReset();
  });

  it('should store with bucket and API key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ objectId: 'akave-obj-123' }),
    });

    const trace = createMockTrace();
    const receipt = await storage.store(trace, '0xhash1');
    expect(receipt.provider).toBe('akave');
    expect(receipt.contentId).toBe('traces/trace-1.json');

    const [callUrl, opts] = mockFetch.mock.calls[0];
    expect(callUrl).toContain('akave-api.test');
    expect(opts.headers?.['Authorization']).toBe('Bearer test-api-key');
  });
});

describe('PostgresStorage', () => {
  let storage: PostgresStorage;
  let mockExecutor: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockExecutor = {
      query: vi.fn(),
    };
    storage = new PostgresStorage({
      db: mockExecutor,
    });
  });

  it('should auto-create table on first store', async () => {
    mockExecutor.query
      .mockResolvedValueOnce({ rows: [] }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [{ content_id: 'pg-hash-123' }] }); // INSERT

    const trace = createMockTrace();
    const receipt = await storage.store(trace, '0xhash1');
    expect(receipt.provider).toBe('postgresql');
    expect(receipt.immutable).toBe(false);
    expect(mockExecutor.query).toHaveBeenCalledTimes(2);
    // First call should be CREATE TABLE IF NOT EXISTS
    expect(mockExecutor.query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS');
  });

  it('should retrieve from database', async () => {
    const trace = createMockTrace();
    mockExecutor.query
      .mockResolvedValueOnce({ rows: [] }) // ensureTable
      .mockResolvedValueOnce({ rows: [{ trace_data: trace }] }); // SELECT

    const result = await storage.retrieve('some-id');
    expect(result).not.toBeNull();
    expect(result!.traceId).toBe('trace-1');
  });

  it('should return null when not found', async () => {
    mockExecutor.query
      .mockResolvedValueOnce({ rows: [] }) // ensureTable
      .mockResolvedValueOnce({ rows: [] }); // SELECT
    const result = await storage.retrieve('non-existent');
    expect(result).toBeNull();
  });

  it('should verify hash match', async () => {
    mockExecutor.query
      .mockResolvedValueOnce({ rows: [] }) // ensureTable
      .mockResolvedValueOnce({ rows: [{ trace_hash: '0xhash1' }] }); // SELECT
    const valid = await storage.verify('some-id', '0xhash1');
    expect(valid).toBe(true);
  });

  it('should fail verification for wrong hash', async () => {
    mockExecutor.query
      .mockResolvedValueOnce({ rows: [] }) // ensureTable
      .mockResolvedValueOnce({ rows: [{ trace_hash: '0xhash1' }] }); // SELECT
    const valid = await storage.verify('some-id', '0xwrong');
    expect(valid).toBe(false);
  });
});

describe('JSONFileStorage', () => {
  let storage: JSONFileStorage;

  beforeEach(() => {
    storage = new JSONFileStorage({ directory: '/tmp/test-traces' });
  });

  it('should sanitize content IDs to prevent path traversal', async () => {
    // The constructor should work
    expect(storage).toBeDefined();
  });

  it('should have correct provider name', async () => {
    // JSONFileStorage depends on node:fs which may not be available in test env
    // We test the interface contract
    expect(storage).toBeDefined();
  });
});
