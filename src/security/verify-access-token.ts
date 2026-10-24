/**
 * Verifies the Access token carried in `Cf-Access-Jwt-Assertion`.
 *
 * This exists because Cloudflare's published behaviour says a Worker serving
 * Static Assets runs behind an internal router Worker, and that router does not
 * pass `ctx.access` through to this Worker. So there is no framework object to
 * read an identity from: either this header is verified here, or there is no
 * identity at all.
 *
 * Every failure path returns null rather than throwing, because this runs in
 * front of every request and a thrown error here would surface as a 500. A
 * refusal should be a refusal.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Everything a verified token tells us about who is calling. */
export interface AccessIdentity {
  accessSubject: string;
  email: string | null;
}

export interface AccessConfiguration {
  teamDomain: string;
  audience: string;
}

/**
 * The key set, cached across requests.
 *
 * Keys rotate every six weeks and the old ones stay valid for seven more days,
 * so a token's `kid` is matched against the published set rather than against a
 * single certificate. Caching here means a rotation is picked up, not pinned.
 */
/**
 * One key set per team domain.
 *
 * Caching per domain rather than in a single slot matters because a later call
 * with a different team domain must not be answered from the first one's keys.
 * Within one domain the set is cached, which is what keeps the per-six-week
 * rotation cheap to fetch while still being picked up.
 */
const keySetsByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksUrl(teamDomain: string): string {
  return `${teamDomain.replace(/\/+$/, '')}/cdn-cgi/access/certs`;
}

function keySetFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = keySetsByDomain.get(teamDomain);
  if (existing !== undefined) return existing;
  const fresh = createRemoteJWKSet(new URL(jwksUrl(teamDomain)));
  keySetsByDomain.set(teamDomain, fresh);
  return fresh;
}

/** Reads the subject claim, which is the stable identity key. §6 */
function readSubject(payload: Record<string, unknown>): string | null {
  const sub = payload['sub'];
  if (typeof sub === 'string' && sub.trim() !== '') return sub;
  // Fall back to the unique id claim some Access deployments carry.
  const email = payload['email'];
  if (typeof email === 'string' && email.trim() !== '') return `email:${email.trim()}`;
  return null;
}

function readEmail(payload: Record<string, unknown>): string | null {
  const email = payload['email'];
  return typeof email === 'string' && email.trim() !== '' ? email.trim() : null;
}

/**
 * Builds a verifier for one configuration.
 *
 * Returns an async function taking the raw header value, so the caller never has
 * to know how a token is checked and a test can substitute its own. It is async
 * because verifying a signature needs the published key set, and that key set is
 * fetched once and cached.
 */
export function accessTokenVerifier(
  configuration: AccessConfiguration,
): (headerValue: string | null) => Promise<AccessIdentity | null> {
  const { teamDomain, audience } = configuration;

  if (teamDomain.trim() === '' || audience.trim() === '') {
    // A partial configuration verifies nothing. §6's fail-closed rule.
    return async () => null;
  }

  return async (headerValue) => {
    if (headerValue === null || headerValue.trim() === '') return null;

    let verified;
    try {
      verified = await jwtVerify(headerValue, keySetFor(teamDomain), {
        issuer: teamDomain,
        audience,
      });
    } catch {
      // Every reason a token is refused lands here: bad signature, wrong
      // audience, wrong issuer, expired, unknown kid. Distinguishing them in the
      // response would tell an attacker which check they failed, so they are
      // all the same refusal.
      return null;
    }

    const payload = verified.payload as Record<string, unknown>;
    const subject = readSubject(payload);
    if (subject === null) return null;

    return { accessSubject: subject, email: readEmail(payload) };
  };
}
