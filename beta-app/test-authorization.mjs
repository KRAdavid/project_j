import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authorize, AuthorizationError, loadAuthorizationPolicy, resolvePrincipal } from './authorization.mjs';

const policy = await loadAuthorizationPolicy();
const request = { headers: {} };
const buyer = resolvePrincipal(request, { environment: 'simulation', fallbackRole: 'BUYER' });
assert.equal(buyer.role, 'BUYER');
assert.equal(buyer.organizationId, 'SIM-BUYER-ORG');
assert.equal(authorize(buyer, 'create_order', policy), true);

const supplierRequest = { headers: { 'x-demo-role': 'SUPPLIER' } };
const supplier = resolvePrincipal(supplierRequest, { environment: 'simulation', fallbackRole: 'BUYER' });
assert.equal(supplier.userId, 'SIM-SUPPLIER-001');
assert.equal(authorize(supplier, 'accept_order', policy), true);
assert.throws(() => authorize(supplier, 'create_order', policy), (error) => error instanceof AuthorizationError && error.code === 'FORBIDDEN_ACTION');

const ai = { role: 'AI', userId: 'AI-01', organizationId: 'AI-ORG', environment: 'simulation' };
assert.throws(() => authorize(ai, 'approve_trade', policy), (error) => error instanceof AuthorizationError && error.code === 'FORBIDDEN_ACTION');
assert.throws(() => resolvePrincipal({ headers: { 'x-demo-role': 'BUYER' } }, { environment: 'production' }), (error) => ['AUTHENTICATION_REQUIRED', 'AUTH_PROVIDER_NOT_CONFIGURED'].includes(error.code));

const previousSecret = process.env.AUTH_JWT_SECRET;
const previousIssuer = process.env.AUTH_JWT_ISSUER;
const previousAudience = process.env.AUTH_JWT_AUDIENCE;
process.env.AUTH_JWT_SECRET = 'test-secret-that-is-at-least-32-bytes-long';
process.env.AUTH_JWT_ISSUER = 'test-issuer';
process.env.AUTH_JWT_AUDIENCE = 'test-audience';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const header = encode({ alg: 'HS256', typ: 'JWT' });
const payload = encode({ sub: 'USER-001', org: 'ORG-001', role: 'SUPPLIER', iss: 'test-issuer', aud: 'test-audience', exp: Math.floor(Date.now() / 1000) + 3600 });
const signature = createHmac('sha256', process.env.AUTH_JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
const principal = resolvePrincipal({ headers: { authorization: `Bearer ${header}.${payload}.${signature}`, 'x-raw-role': 'OWNER' } }, { environment: 'production' });
assert.deepEqual(principal, { role: 'SUPPLIER', userId: 'USER-001', organizationId: 'ORG-001', environment: 'production' });
assert.throws(() => resolvePrincipal({ headers: { authorization: `Bearer ${header}.${payload}.${'0'.repeat(signature.length)}` } }, { environment: 'production' }), (error) => error.code === 'AUTHENTICATION_INVALID');
if (previousSecret === undefined) delete process.env.AUTH_JWT_SECRET; else process.env.AUTH_JWT_SECRET = previousSecret;
if (previousIssuer === undefined) delete process.env.AUTH_JWT_ISSUER; else process.env.AUTH_JWT_ISSUER = previousIssuer;
if (previousAudience === undefined) delete process.env.AUTH_JWT_AUDIENCE; else process.env.AUTH_JWT_AUDIENCE = previousAudience;
console.log('authorization tests: PASS');
