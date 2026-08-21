import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createStreamPlaybackToken,
  StreamPlaybackTokenError,
} from "../src/stream-playback-token.js";
import { TEST_ENV } from "./fixtures.js";

function decodeBase64Url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function createSigningFixture() {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  return {
    config: loadConfig({
      ...TEST_ENV,
      STREAM_SIGNING_JWK: btoa(JSON.stringify(privateJwk)),
    }),
    publicKey: keys.publicKey,
  };
}

describe("Stream playback token signing", () => {
  it("creates a verifiable 15-minute token for exactly one video", async () => {
    const { config, publicKey } = await createSigningFixture();
    const now = new Date("2026-08-20T08:00:00.900Z");
    const result = await createStreamPlaybackToken(
      "private-stream-video",
      config,
      now,
    );
    const [header, payload, signature] = result.token.split(".");
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload ?? "")),
    );

    expect(claims).toEqual({
      sub: "private-stream-video",
      kid: "stream-signing-test-key",
      exp: 1_787_213_700,
      nbf: 1_787_212_800,
    });
    expect(result.expiresAt).toBe("2026-08-20T08:15:00.000Z");
    await expect(
      crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        decodeBase64Url(signature ?? ""),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).resolves.toBe(true);
  });

  it("fails closed without revealing invalid signing material", async () => {
    const config = loadConfig(TEST_ENV);

    await expect(
      createStreamPlaybackToken("private-stream-video", config),
    ).rejects.toEqual(new StreamPlaybackTokenError());
    await expect(
      createStreamPlaybackToken("private/stream/video", config),
    ).rejects.toEqual(new StreamPlaybackTokenError());
  });
});
