import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { accessTokenVerifier } from '../src/security/verify-access-token.ts';

/**
 * The six refusals §6 asks about, tested against a real key pair rather than a
 * mock. A verifier that has never seen a forged token is a verifier nobody has
 * checked.
 */

const TEAM_DOMAIN = 'https://sadec-demo-team.cloudflareaccess.com';
const AUD = '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2';

let privateKeyPem: string;
let publicKeyPem: string;

// The key pair is created before any test runs, so a refusal test never signs a
// token with a key that has not been generated yet — which would fail for a
// reason that has nothing to do with verification.
beforeAll(async () => {
  const keyPair = await generateKeyPair('RS256', { extractable: true });
  privateKeyPem = await exportPKCS8(keyPair.privateKey);
  publicKeyPem = await exportSPKI(keyPair.publicKey);
});

/** A token signed with the test key, shaped like the ones Access issues. */
async function sign(
  options: {
    audience?: string;
    issuer?: string;
    expiresIn?: string;
    kid?: string;
  } = {},
): Promise<string> {
  const builder = new SignJWT({ email: 'founder@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'test-key' })
    .setSubject('sub-founder')
    .setIssuedAt()
    .setIssuer(options.issuer ?? TEAM_DOMAIN)
    .setAudience(options.audience ?? AUD)
    .setJti(`test-${Math.random().toString(36).slice(2)}`);

  if (options.expiresIn !== undefined) {
    builder.setExpirationTime(options.expiresIn);
  } else {
    builder.setExpirationTime('5m');
  }

  return builder.sign(await importPrivateKey());
}

async function importPrivateKey() {
  const { importPKCS8 } = await import('jose');
  return importPKCS8(privateKeyPem, 'RS256');
}

describe('access token verification', () => {
  it('refuses a wrong audience', async () => {
    const verify = accessTokenVerifier({ teamDomain: TEAM_DOMAIN, audience: AUD });
    const token = await sign({ audience: 'wrong-audience-tag' });
    expect(await verify(token)).toBeNull();
  });

  it('refuses a wrong issuer', async () => {
    const verify = accessTokenVerifier({ teamDomain: TEAM_DOMAIN, audience: AUD });
    const token = await sign({ issuer: 'https://attacker.example' });
    expect(await verify(token)).toBeNull();
  });

  it('refuses an already-expired token', async () => {
    const verify = accessTokenVerifier({ teamDomain: TEAM_DOMAIN, audience: AUD });
    // A token that expired a minute ago. jose enforces exp, so this is refused
    // without this code knowing why.
    const token = await sign({ expiresIn: '-1m' });
    expect(await verify(token)).toBeNull();
  });

  it('refuses a missing header entirely', async () => {
    const verify = accessTokenVerifier({ teamDomain: TEAM_DOMAIN, audience: AUD });
    expect(await verify(null)).toBeNull();
    expect(await verify('   ')).toBeNull();
  });

  it('refuses a malformed token rather than half-parsing it', async () => {
    const verify = accessTokenVerifier({ teamDomain: TEAM_DOMAIN, audience: AUD });
    expect(await verify('not-a-jwt')).toBeNull();
    expect(await verify('a.b.c')).toBeNull();
  });

  it('refuses when the configuration is incomplete', async () => {
    // §6's fail-closed: no team domain or no audience means no token verifies.
    const noDomain = accessTokenVerifier({ teamDomain: '', audience: AUD });
    expect(await noDomain('any-token')).toBeNull();

    const noAudience = accessTokenVerifier({ teamDomain: TEAM_DOMAIN, audience: '   ' });
    expect(await noAudience('any-token')).toBeNull();
  });

  it('refuses a signature it cannot match to any published key', async () => {
    // A token signed by an unknown key. The check is the signature itself, so
    // this is refused even though every claim in it is correct.
    const otherKey = await generateKeyPair('RS256', { extractable: true });
    const otherPem = await exportPKCS8(otherKey.privateKey);
    const { importPKCS8 } = await import('jose');
    const token = await new SignJWT({ email: 'founder@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'unknown-key' })
      .setSubject('sub-founder')
      .setIssuedAt()
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUD)
      .setExpirationTime('5m')
      .sign(await importPKCS8(otherPem, 'RS256'));

    const verify = accessTokenVerifier({ teamDomain: TEAM_DOMAIN, audience: AUD });
    expect(await verify(token)).toBeNull();
  });
});

/**
 * The verification path that succeeds needs a real JWKS to fetch keys from, so
 * it is exercised against a local HTTP server serving the public key. That is
 * the case §15 case 17 depends on, and it is the one a mock would get wrong.
 */
describe('a correctly signed token', () => {
  it('yields an identity once a published key matches', async () => {
    const { createServer } = await import('node:http');
    const { importSPKI } = await import('jose');

    const jwk = await importSPKI(publicKeyPem, 'RS256').then(async (key) => {
      const { exportJWK } = await import('jose');
      return { ...(await exportJWK(key)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    });

    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      // The verifier is built after the JWKS server is listening. Building it
      // earlier pins a key set whose first fetch already failed.
      const verify = accessTokenVerifier({
        teamDomain: `http://127.0.0.1:${port}`,
        audience: AUD,
      });
      // The token must carry the team domain the verifier was built with, or the
      // issuer check refuses it for a reason unrelated to the signature.
      const token = await sign({ issuer: `http://127.0.0.1:${port}` });
      const identity = await verify(token);
      expect(identity).not.toBeNull();
      expect(identity?.accessSubject).toBe('sub-founder');
      expect(identity?.email).toBe('founder@example.test');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
