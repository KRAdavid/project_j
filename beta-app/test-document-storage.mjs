import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDocumentStorage, DocumentStorageError, FileDocumentStorage, MemoryDocumentStorage, S3DocumentStorage } from './document-storage.mjs';
import { hashDocument } from './evidence-verifier.mjs';

const storage = createDocumentStorage({ environment: 'simulation' });
assert.ok(storage instanceof MemoryDocumentStorage);
const content = 'lot evidence';
const saved = await storage.put({ key: 'LOT-001/COA/v1', content, contentSha256: hashDocument(content) });
assert.match(saved.storageRef, /^memory:\/\/evidence\//);
assert.equal((await storage.get('LOT-001/COA/v1')).content, content);
await assert.rejects(() => storage.put({ key: 'LOT-001/SDS/v1', content, contentSha256: '0'.repeat(64) }), (error) => error instanceof DocumentStorageError && error.code === 'DOCUMENT_HASH_MISMATCH');
await assert.rejects(() => storage.put({ key: 'LOT-001/TDS/v1', content: '' }), (error) => error instanceof DocumentStorageError && error.code === 'DOCUMENT_CONTENT_REQUIRED');
assert.throws(() => createDocumentStorage({ environment: 'production' }), (error) => error instanceof DocumentStorageError && error.code === 'OBJECT_STORAGE_UNAVAILABLE');

const root = join(tmpdir(), `raw-material-evidence-${Date.now()}`);
const fileStorage = createDocumentStorage({ environment: 'simulation', persistenceMode: 'sqlite', root });
assert.ok(fileStorage instanceof FileDocumentStorage);
await fileStorage.put({ key: 'LOT-002/COA/v1', content: 'durable coa' });
const restartedFileStorage = createDocumentStorage({ environment: 'simulation', persistenceMode: 'sqlite', root });
assert.equal((await restartedFileStorage.get('LOT-002/COA/v1')).content, 'durable coa');
await rm(root, { recursive: true, force: true });

const s3Content = 's3 durable coa';
const s3Objects = new Map();
const s3Storage = new S3DocumentStorage({ endpoint: 'https://objects.example.test', bucket: 'raw-material', accessKeyId: 'ACCESS', secretAccessKey: 'secret', fetchImpl: async (url, options) => {
  const key = url.pathname.split('/').slice(2).join('/');
  if (options.method === 'PUT') {
    s3Objects.set(key, { content: options.body, hash: hashDocument(options.body), authorization: options.headers.authorization });
    return new Response('', { status: 200 });
  }
  const object = s3Objects.get(key);
  return new Response(object?.content || '', { status: object ? 200 : 404, headers: object ? { 'x-amz-meta-content-sha256': object.hash } : {} });
} });
assert.ok(s3Storage instanceof S3DocumentStorage);
const s3Saved = await s3Storage.put({ key: 'LOT-003/COA/v1', content: s3Content });
assert.match(s3Saved.storageRef, /^s3:\/\/raw-material\//);
assert.match(s3Objects.get('LOT-003/COA/v1').authorization, /^AWS4-HMAC-SHA256/);
assert.equal((await s3Storage.get('LOT-003/COA/v1')).content, s3Content);
console.log('document storage tests: PASS');
