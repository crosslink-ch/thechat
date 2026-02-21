import { SignJWT, jwtVerify } from "jose";

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? (() => {
    console.warn("JWT_SECRET not set — using insecure dev fallback");
    return "dev-insecure-jwt-secret-do-not-use-in-production";
  })()
);

export interface JwtPayload {
  sub: string;
  name: string;
  email: string | null;
  avatar: string | null;
  type: "human";
}

export async function signAccessToken(payload: JwtPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secret);
}

export async function verifyAccessToken(
  token: string
): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}
