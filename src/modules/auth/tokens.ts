import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessTokenClaims {
  sub: string; // user id
  sid: string; // session id
}

/**
 * Short-lived (default 15 min) access token. Authorisation data is NOT
 * embedded: permissions are loaded per request so revocations and suspensions
 * apply immediately, and the session id lets us reject tokens from revoked
 * sessions.
 */
export async function signAccessToken(claims: AccessTokenClaims): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + env.ACCESS_TOKEN_TTL_SECONDS * 1000);
  const token = await new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);
  return { token, expiresAt };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new AppError(401, 'TOKEN_INVALID', 'Invalid access token');
    }
    return { sub: payload.sub, sid: payload.sid };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof joseErrors.JWTExpired) throw new AppError(401, 'TOKEN_INVALID', 'Access token expired');
    throw new AppError(401, 'TOKEN_INVALID', 'Invalid access token');
  }
}
