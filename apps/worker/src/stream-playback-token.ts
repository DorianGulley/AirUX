import type { AiruxConfig } from "./config.js";
import { EXPIRATION_POLICY } from "./expiration-policy.js";

const STREAM_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class StreamPlaybackTokenError extends Error {}

function decodeSigningJwk(encodedJwk: string) {
  try {
    const value: unknown = JSON.parse(atob(encodedJwk));
    if (
      typeof value !== "object" ||
      value === null ||
      !("kty" in value) ||
      value.kty !== "RSA" ||
      !("n" in value) ||
      typeof value.n !== "string" ||
      !("e" in value) ||
      typeof value.e !== "string" ||
      !("d" in value) ||
      typeof value.d !== "string"
    ) {
      throw new StreamPlaybackTokenError();
    }
    return value as JsonWebKey;
  } catch (error) {
    if (error instanceof StreamPlaybackTokenError) {
      throw error;
    }
    throw new StreamPlaybackTokenError();
  }
}

function encodeBase64Url(value: string | ArrayBuffer) {
  const binary =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  let encoded = "";
  for (const byte of binary) {
    encoded += String.fromCharCode(byte);
  }
  return btoa(encoded)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function createStreamPlaybackToken(
  streamVideoId: string,
  config: AiruxConfig,
  now = new Date(),
) {
  if (
    !STREAM_VIDEO_ID_PATTERN.test(streamVideoId) ||
    Number.isNaN(now.getTime())
  ) {
    throw new StreamPlaybackTokenError();
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      decodeSigningJwk(config.stream.signingJwk),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const expiresAt = issuedAt + EXPIRATION_POLICY.playbackTokenSeconds;
    const header = encodeBase64Url(
      JSON.stringify({ alg: "RS256", kid: config.stream.signingKeyId }),
    );
    const payload = encodeBase64Url(
      JSON.stringify({
        sub: streamVideoId,
        kid: config.stream.signingKeyId,
        exp: expiresAt,
        nbf: issuedAt,
      }),
    );
    const message = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(message),
    );

    return {
      token: `${message}.${encodeBase64Url(signature)}`,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    };
  } catch (error) {
    if (error instanceof StreamPlaybackTokenError) {
      throw error;
    }
    throw new StreamPlaybackTokenError();
  }
}
