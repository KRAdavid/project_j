import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDocument } from './evidence-verifier.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const maxDocumentBytes = 10 * 1024 * 1024;
const decodeBase64Document = (contentBase64) => {
  const normalized = String(contentBase64 || '').trim();
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.replace(/=+$/, '').length % 4 === 1) {
    throw new DocumentStorageError('문서 원문 Base64 형식이 올바르지 않습니다.', 'DOCUMENT_BASE64_INVALID');
  }
  const bytes = Buffer.from(normalized, 'base64');
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  if (!bytes.length || canonical !== normalized.replace(/=+$/, '')) throw new DocumentStorageError('문서 원문 Base64 형식이 올바르지 않습니다.', 'DOCUMENT_BASE64_INVALID');
  if (bytes.length > maxDocumentBytes) throw new DocumentStorageError('문서 원문은 10MB 이하여야 합니다.', 'DOCUMENT_SIZE_INVALID');
  return bytes;
};
const normalizeBinaryDocument = ({ contentBase64, contentSha256 } = {}) => {
  const bytes = decodeBase64Document(contentBase64);
  const calculatedSha256 = sha256(bytes);
  if (contentSha256 && String(contentSha256).toLowerCase() !== calculatedSha256) throw new DocumentStorageError('문서 원문과 SHA-256 해시가 일치하지 않습니다.', 'DOCUMENT_HASH_MISMATCH');
  return { bytes, contentBase64: bytes.toString('base64'), contentSha256: calculatedSha256 };
};
const verifyStoredBinaryDocument = (document) => {
  const normalized = normalizeBinaryDocument({ contentBase64: document?.contentBase64, contentSha256: document?.contentSha256 });
  if (document?.size != null && Number(document.size) !== normalized.bytes.length) throw new DocumentStorageError('저장된 문서 크기가 원문과 일치하지 않습니다.', 'DOCUMENT_HASH_MISMATCH');
  return { ...document, contentBase64: normalized.contentBase64, contentSha256: normalized.contentSha256, size: normalized.bytes.length };
};
export const assertDocumentSignature = ({ fileName, contentBase64 } = {}) => {
  const extension = extname(String(fileName || '').trim()).toLowerCase();
  const bytes = decodeBase64Document(contentBase64);
  const signatures = {
    '.pdf': bytes.subarray(0, 5).toString('ascii') === '%PDF-',
    '.png': bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    '.jpg': bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
    '.jpeg': bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  };
  if (!(extension in signatures)) throw new DocumentStorageError('COA는 PDF·JPG·PNG 파일만 업로드할 수 있습니다.', 'DOCUMENT_FORMAT_UNSUPPORTED');
  if (!signatures[extension]) throw new DocumentStorageError('COA 파일 확장자와 실제 바이너리 형식이 일치하지 않습니다.', 'DOCUMENT_SIGNATURE_MISMATCH');
  return { extension, size: bytes.length };
};
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encodePath = (value) => String(value).split('/').map((segment) => encodeURIComponent(segment)).join('/');

export class DocumentStorageError extends Error {
  constructor(message, code = 'DOCUMENT_STORAGE_FAILED') {
    super(message);
    this.code = code;
  }
}

export class MemoryDocumentStorage {
  constructor() {
    this.mode = 'memory';
    this.documents = new Map();
  }

  referenceForKey(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new DocumentStorageError('문서 저장 키가 필요합니다.', 'DOCUMENT_KEY_REQUIRED');
    return `memory://evidence/${encodeURIComponent(normalizedKey)}`;
  }

  async put({ key, content, contentSha256 } = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new DocumentStorageError('문서 저장 키가 필요합니다.', 'DOCUMENT_KEY_REQUIRED');
    const normalizedContent = String(content ?? '');
    if (!normalizedContent) throw new DocumentStorageError('문서 원문이 비어 있어 저장할 수 없습니다.', 'DOCUMENT_CONTENT_REQUIRED');
    const calculatedSha256 = hashDocument(normalizedContent);
    if (contentSha256 && String(contentSha256).toLowerCase() !== calculatedSha256) {
      throw new DocumentStorageError('문서 원문과 SHA-256 해시가 일치하지 않습니다.', 'DOCUMENT_HASH_MISMATCH');
    }
    this.documents.set(normalizedKey, { content: normalizedContent, contentSha256: calculatedSha256 });
    return { storageRef: this.referenceForKey(normalizedKey), contentSha256: calculatedSha256 };
  }

  async putBinary({ key, contentBase64, contentSha256, contentType = 'application/octet-stream' } = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new DocumentStorageError('문서 저장 키가 필요합니다.', 'DOCUMENT_KEY_REQUIRED');
    const normalized = normalizeBinaryDocument({ contentBase64, contentSha256 });
    this.documents.set(normalizedKey, { contentBase64: normalized.contentBase64, contentSha256: normalized.contentSha256, size: normalized.bytes.length, contentType: String(contentType || 'application/octet-stream') });
    return { storageRef: this.referenceForKey(normalizedKey), contentSha256: normalized.contentSha256, size: normalized.bytes.length, contentType: String(contentType || 'application/octet-stream') };
  }

  async get(key) {
    const document = this.documents.get(String(key || ''));
    if (!document) throw new DocumentStorageError('문서 원문을 찾을 수 없습니다.', 'DOCUMENT_NOT_FOUND');
    return { ...document };
  }

  async getBinary(key) { return verifyStoredBinaryDocument(await this.get(key)); }
}

export class FileDocumentStorage {
  constructor(root) {
    this.mode = 'file';
    this.root = resolve(root);
    this.ready = mkdir(this.root, { recursive: true });
  }

  filePath(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new DocumentStorageError('문서 저장 키가 필요합니다.', 'DOCUMENT_KEY_REQUIRED');
    const filename = `${Buffer.from(normalizedKey, 'utf8').toString('base64url')}.json`;
    return join(this.root, filename);
  }

  referenceForKey(key) { return `file://${this.filePath(key)}`; }

  async put({ key, content, contentSha256 } = {}) {
    const normalizedContent = String(content ?? '');
    if (!normalizedContent) throw new DocumentStorageError('문서 원문이 비어 있어 저장할 수 없습니다.', 'DOCUMENT_CONTENT_REQUIRED');
    const calculatedSha256 = hashDocument(normalizedContent);
    if (contentSha256 && String(contentSha256).toLowerCase() !== calculatedSha256) throw new DocumentStorageError('문서 원문과 SHA-256 해시가 일치하지 않습니다.', 'DOCUMENT_HASH_MISMATCH');
    const path = this.filePath(key);
    await this.ready;
    await writeFile(path, JSON.stringify({ content: normalizedContent, contentSha256: calculatedSha256 }), 'utf8');
    return { storageRef: this.referenceForKey(key), contentSha256: calculatedSha256 };
  }

  async putBinary({ key, contentBase64, contentSha256, contentType = 'application/octet-stream' } = {}) {
    const normalized = normalizeBinaryDocument({ contentBase64, contentSha256 });
    const path = this.filePath(key);
    await this.ready;
    await writeFile(path, JSON.stringify({ contentBase64: normalized.contentBase64, contentSha256: normalized.contentSha256, size: normalized.bytes.length, contentType: String(contentType || 'application/octet-stream') }), 'utf8');
    return { storageRef: this.referenceForKey(key), contentSha256: normalized.contentSha256, size: normalized.bytes.length, contentType: String(contentType || 'application/octet-stream') };
  }

  async get(key) {
    try {
      const document = JSON.parse(await readFile(this.filePath(key), 'utf8'));
      return document;
    } catch (error) {
      if (error.code === 'ENOENT') throw new DocumentStorageError('문서 원문을 찾을 수 없습니다.', 'DOCUMENT_NOT_FOUND');
      throw error;
    }
  }

  async getBinary(key) { return verifyStoredBinaryDocument(await this.get(key)); }
}

export class S3DocumentStorage {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'us-east-1', sessionToken = '', fetchImpl = globalThis.fetch } = {}) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || typeof fetchImpl !== 'function') throw new DocumentStorageError('S3 Object Storage 설정이 불완전합니다.', 'OBJECT_STORAGE_CONFIG_INVALID');
    this.mode = 's3';
    this.endpoint = new URL(endpoint);
    this.bucket = String(bucket);
    this.accessKeyId = String(accessKeyId);
    this.secretAccessKey = String(secretAccessKey);
    this.region = String(region);
    this.sessionToken = String(sessionToken || '');
    this.fetchImpl = fetchImpl;
  }

  objectUrl(key) {
    const pathPrefix = this.endpoint.pathname.replace(/\/$/, '');
    const path = `${pathPrefix}/${encodePath(this.bucket)}/${encodePath(key)}`;
    const url = new URL(this.endpoint.toString());
    url.pathname = path;
    return url;
  }

  referenceForKey(key) { return `s3://${this.bucket}/${String(key || '').trim()}`; }

  async request(method, key, content = '') {
    const url = this.objectUrl(key);
    const body = method === 'PUT' ? String(content) : '';
    const payloadHash = sha256(body);
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const shortDate = amzDate.slice(0, 8);
    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (method === 'PUT') headers['x-amz-meta-content-sha256'] = sha256(body);
    if (this.sessionToken) headers['x-amz-security-token'] = this.sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
    const canonicalRequest = [method, url.pathname || '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${shortDate}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, shortDate);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const requestHeaders = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
    const response = await this.fetchImpl(url, { method, headers: requestHeaders, body: method === 'PUT' ? body : undefined });
    if (!response.ok) throw new DocumentStorageError(`Object Storage 응답 코드 ${response.status}`, 'OBJECT_STORAGE_REQUEST_FAILED');
    return response;
  }

  async requestBinary(method, key, bytes, contentType = 'application/octet-stream') {
    const url = this.objectUrl(key);
    const body = method === 'PUT' ? Buffer.from(bytes) : Buffer.alloc(0);
    const payloadHash = sha256(body);
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const shortDate = amzDate.slice(0, 8);
    const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (method === 'PUT') {
      headers['content-type'] = String(contentType || 'application/octet-stream');
      headers['x-amz-meta-content-sha256'] = payloadHash;
    }
    if (this.sessionToken) headers['x-amz-security-token'] = this.sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
    const canonicalRequest = [method, url.pathname || '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${shortDate}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, shortDate);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const requestHeaders = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
    const response = await this.fetchImpl(url, { method, headers: requestHeaders, body: method === 'PUT' ? body : undefined });
    if (!response.ok) throw new DocumentStorageError(`Object Storage 응답 코드 ${response.status}`, 'OBJECT_STORAGE_REQUEST_FAILED');
    return response;
  }

  async put({ key, content, contentSha256 } = {}) {
    const normalizedContent = String(content ?? '');
    if (!normalizedContent) throw new DocumentStorageError('문서 원문이 비어 있어 저장할 수 없습니다.', 'DOCUMENT_CONTENT_REQUIRED');
    const calculatedSha256 = hashDocument(normalizedContent);
    if (contentSha256 && String(contentSha256).toLowerCase() !== calculatedSha256) throw new DocumentStorageError('문서 원문과 SHA-256 해시가 일치하지 않습니다.', 'DOCUMENT_HASH_MISMATCH');
    await this.request('PUT', key, normalizedContent);
    return { storageRef: this.referenceForKey(key), contentSha256: calculatedSha256 };
  }

  async putBinary({ key, contentBase64, contentSha256, contentType = 'application/octet-stream' } = {}) {
    const normalized = normalizeBinaryDocument({ contentBase64, contentSha256 });
    await this.requestBinary('PUT', key, normalized.bytes, contentType);
    return { storageRef: this.referenceForKey(key), contentSha256: normalized.contentSha256, size: normalized.bytes.length, contentType: String(contentType || 'application/octet-stream') };
  }

  async get(key) {
    const response = await this.request('GET', key);
    const content = await response.text();
    const expected = response.headers.get('x-amz-meta-content-sha256');
    const actual = hashDocument(content);
    if (expected && expected !== actual) throw new DocumentStorageError('Object Storage 원문 해시가 손상되었습니다.', 'DOCUMENT_HASH_MISMATCH');
    return { content, contentSha256: actual };
  }

  async getBinary(key) {
    const response = await this.requestBinary('GET', key, Buffer.alloc(0));
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = response.headers.get('x-amz-meta-content-sha256');
    const actual = sha256(bytes);
    if (expected && expected !== actual) throw new DocumentStorageError('Object Storage 원문 해시가 손상되었습니다.', 'DOCUMENT_HASH_MISMATCH');
    return { contentBase64: bytes.toString('base64'), contentSha256: actual, size: bytes.length, contentType: response.headers.get('content-type') || 'application/octet-stream' };
  }
}

export const createDocumentStorage = ({ environment = process.env.APP_ENV || 'simulation', persistenceMode = process.env.PERSISTENCE_MODE || 'memory', root = process.env.DOCUMENT_STORAGE_ROOT || resolve(fileURLToPath(new URL('../data/beta-evidence', import.meta.url))) } = {}) => {
  if (environment === 'production') {
    const config = {
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
      bucket: process.env.OBJECT_STORAGE_BUCKET,
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
      region: process.env.OBJECT_STORAGE_REGION || 'us-east-1',
      sessionToken: process.env.OBJECT_STORAGE_SESSION_TOKEN || '',
    };
    if (Object.values(config).slice(0, 4).some((value) => !value)) throw new DocumentStorageError('상용 Object Storage 어댑터 설정이 없어 서버를 시작할 수 없습니다.', 'OBJECT_STORAGE_UNAVAILABLE');
    return new S3DocumentStorage(config);
  }
  if (persistenceMode === 'sqlite') return new FileDocumentStorage(root);
  return new MemoryDocumentStorage();
};
