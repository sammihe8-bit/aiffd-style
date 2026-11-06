import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

// This process-local key is only a fixture and is never a deployment secret.
const secret = "test-only-identity-validation-fixture";
process.env.JWT_SECRET = secret;
const { generateToken, verifyToken, authenticate, requireRole } = require("../api/middleware/auth");

const identity = { id: 1, email: "fixture@example.test", role: "user", membershipTier: "free" };
function signed(payload: object, options: jwt.SignOptions = { expiresIn: "5m" }) {
  return jwt.sign(payload, secret, options);
}
assert.equal(verifyToken(generateToken(1, identity.email, "user", "free")).id, 1);
assert.equal(verifyToken(generateToken(2, null, "user", "free")).email, null);
assert.equal(verifyToken("not-a-token"), null);
assert.equal(verifyToken(jwt.sign(identity, "wrong-key", { expiresIn: "5m" })), null);
assert.equal(verifyToken(signed(identity, { expiresIn: -1 })), null);
assert.equal(verifyToken(signed(identity, { algorithm: "HS384", expiresIn: "5m" })), null);
assert.equal(verifyToken(signed(identity, {})), null);
for (const patch of [{ id: -1 }, { id: 1.5 }, { id: "1" }, { role: "owner" }, { membershipTier: "unknown" }, { email: 5 }]) {
  assert.equal(verifyToken(signed({ ...identity, ...patch })), null);
}
assert.equal(verifyToken(signed({ id: 1 })), null);

async function main() {
  let status = 0;
  let called = false;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } };
  const next = () => { called = true; };
  await authenticate({ headers: {} }, res, next);
  assert.equal(status, 401);
  assert.equal(called, false);
  await authenticate({ headers: { authorization: "Bearer invalid" } }, res, next);
  assert.equal(status, 401);
  assert.equal(called, false);
  const req = { headers: { authorization: `Bearer ${signed(identity)}` }, user: undefined as any };
  await authenticate(req, res, next);
  assert.equal(called, true);
  assert.equal(req.user.id, 1);
  called = false;
  requireRole("admin")(req, res, next);
  assert.equal(status, 403);
  assert.equal(called, false);
  requireRole("admin")({ user: { ...identity, role: "admin" } }, res, next);
  assert.equal(called, true);
  console.log("Auth security regression checks passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
