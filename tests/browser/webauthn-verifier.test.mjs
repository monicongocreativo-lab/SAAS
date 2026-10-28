import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { makeServer } from "../../scripts/serve.mjs";
import { WebAuthnPrototypeVerifier } from "../../src/auth-prototype/webauthn-verifier.mjs";

const actor = {
  subjectId: "synthetic-worker-a",
  sessionBinding: "synthetic-server-session-a",
};

async function browserCeremony(page, operation, options) {
  return page.evaluate(
    async ({ operation: kind, options: values }) => {
      const decode = (value) =>
        Uint8Array.from(
          atob(
            value
              .replaceAll("-", "+")
              .replaceAll("_", "/")
              .padEnd(Math.ceil(value.length / 4) * 4, "="),
          ),
          (c) => c.charCodeAt(0),
        );
      const encode = (value) =>
        btoa(String.fromCharCode(...new Uint8Array(value)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/u, "");
      values.challenge = decode(values.challenge);
      if (values.user) values.user.id = decode(values.user.id);
      for (const name of ["allowCredentials", "excludeCredentials"])
        if (values[name])
          values[name] = values[name].map((item) => ({
            ...item,
            id: decode(item.id),
          }));
      const credential = await navigator.credentials[kind]({
        publicKey: values,
      });
      const response = {
        clientDataJSON: encode(credential.response.clientDataJSON),
      };
      if (kind === "create") {
        response.attestationObject = encode(
          credential.response.attestationObject,
        );
        response.transports = credential.response.getTransports();
      } else {
        response.authenticatorData = encode(
          credential.response.authenticatorData,
        );
        response.signature = encode(credential.response.signature);
        response.userHandle = credential.response.userHandle
          ? encode(credential.response.userHandle)
          : null;
      }
      return {
        id: credential.id,
        rawId: encode(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        response,
        clientExtensionResults: credential.getClientExtensionResults(),
      };
    },
    { operation, options },
  );
}

test("server verifies virtual-key registration and possession, rejects tampering/replay/revocation, and preserves challenges on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tamago-webauthn-server-"));
  const server = makeServer();
  let browser;
  let verifier;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://localhost:${server.address().port}`;
    const databasePath = join(directory, "webauthn.sqlite");
    verifier = new WebAuthnPrototypeVerifier({
      databasePath,
      rpId: "localhost",
      origin,
    });
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: false,
        hasUserVerification: false,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(`${origin}/experimental/security-key-check/`);

    const enrollment = await verifier.beginRegistration({
      ...actor,
      displayName: "Synthetic A",
    });
    const registration = await browserCeremony(
      page,
      "create",
      enrollment.options,
    );
    const enrollmentContext = { ...actor, ceremonyId: enrollment.ceremonyId };
    const registered = await verifier.finishRegistration(
      enrollmentContext,
      registration,
    );
    assert.equal(registered.status, "credential_registered");
    assert.equal(registered.hardwareAttested, false);
    await assert.rejects(
      verifier.finishRegistration(enrollmentContext, registration),
      { code: "CHALLENGE_UNAVAILABLE" },
    );
    const otherActor = {
      subjectId: "synthetic-worker-b",
      sessionBinding: "synthetic-server-session-b",
    };
    const otherEnrollment = await verifier.beginRegistration({
      ...otherActor,
      displayName: "Synthetic B",
    });
    const otherRegistered = await verifier.finishRegistration(
      { ...otherActor, ceremonyId: otherEnrollment.ceremonyId },
      await browserCeremony(page, "create", otherEnrollment.options),
    );
    const mismatched = await verifier.beginAuthentication(actor);
    const otherKeyResponse = await browserCeremony(page, "get", {
      ...mismatched.options,
      allowCredentials: [
        { type: "public-key", id: otherRegistered.credentialId },
      ],
    });
    await assert.rejects(
      verifier.finishAuthentication(
        { ...actor, ceremonyId: mismatched.ceremonyId },
        otherKeyResponse,
      ),
      { code: "CREDENTIAL_UNAVAILABLE" },
    );

    const authenticate = async (change = (value) => value) => {
      const request = await verifier.beginAuthentication(actor);
      const response = await browserCeremony(page, "get", request.options);
      return {
        request,
        response: change(response),
        context: { ...actor, ceremonyId: request.ceremonyId },
      };
    };
    const valid = await authenticate();
    // The server store, not browser storage, retains challenge and key across restart.
    verifier.close();
    verifier = new WebAuthnPrototypeVerifier({
      databasePath,
      rpId: "localhost",
      origin,
    });
    const result = await verifier.finishAuthentication(
      valid.context,
      valid.response,
    );
    assert.equal(result.status, "key_possession_verified");
    assert.equal(result.subjectId, actor.subjectId);
    assert.equal(
      result.userVerified,
      false,
      "touch-only possession is not PIN/biometric verification",
    );
    await assert.rejects(
      verifier.finishAuthentication(valid.context, valid.response),
      { code: "CHALLENGE_UNAVAILABLE" },
    );
    const concurrent = await authenticate();
    const secondVerifier = new WebAuthnPrototypeVerifier({
      databasePath,
      rpId: "localhost",
      origin,
    });
    try {
      const results = await Promise.allSettled([
        verifier.finishAuthentication(concurrent.context, concurrent.response),
        secondVerifier.finishAuthentication(
          concurrent.context,
          concurrent.response,
        ),
      ]);
      assert.equal(
        results.filter((item) => item.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter(
          (item) =>
            item.status === "rejected" &&
            item.reason.code === "CHALLENGE_UNAVAILABLE",
        ).length,
        1,
      );
    } finally {
      secondVerifier.close();
    }

    const wrongSubject = await authenticate();
    await assert.rejects(
      verifier.finishAuthentication(
        { ...wrongSubject.context, subjectId: "synthetic-worker-b" },
        wrongSubject.response,
      ),
      { code: "CHALLENGE_UNAVAILABLE" },
    );
    assert.equal(
      (
        await verifier.finishAuthentication(
          wrongSubject.context,
          wrongSubject.response,
        )
      ).status,
      "key_possession_verified",
    );

    for (const mutation of [
      (response) => {
        const data = JSON.parse(
          Buffer.from(response.response.clientDataJSON, "base64url"),
        );
        data.origin = "https://other.invalid";
        response.response.clientDataJSON = Buffer.from(
          JSON.stringify(data),
        ).toString("base64url");
      },
      (response) => {
        const bytes = Buffer.from(response.response.signature, "base64url");
        bytes[5] ^= 1;
        response.response.signature = bytes.toString("base64url");
      },
      (response) => {
        const bytes = Buffer.from(
          response.response.authenticatorData,
          "base64url",
        );
        bytes[0] ^= 1;
        response.response.authenticatorData = bytes.toString("base64url");
      },
      (response) => {
        const bytes = Buffer.from(
          response.response.authenticatorData,
          "base64url",
        );
        bytes[32] &= ~1;
        response.response.authenticatorData = bytes.toString("base64url");
      },
    ]) {
      const invalid = await authenticate((response) => {
        mutation(response);
        return response;
      });
      await assert.rejects(
        verifier.finishAuthentication(invalid.context, invalid.response),
        { code: "INVALID_PROOF" },
      );
    }

    const pending = await authenticate();
    assert.equal(
      verifier.revokeCredential({
        subjectId: "synthetic-worker-b",
        credentialId: registered.credentialId,
      }),
      false,
    );
    assert.equal(
      verifier.revokeCredential({
        subjectId: actor.subjectId,
        credentialId: registered.credentialId,
      }),
      true,
    );
    await assert.rejects(
      verifier.finishAuthentication(pending.context, pending.response),
      { code: "CREDENTIAL_UNAVAILABLE" },
    );
    await assert.rejects(verifier.beginAuthentication(actor), {
      code: "NO_ACTIVE_CREDENTIAL",
    });
    const otherLogin = await verifier.beginAuthentication(otherActor);
    assert.equal(
      (
        await verifier.finishAuthentication(
          { ...otherActor, ceremonyId: otherLogin.ceremonyId },
          await browserCeremony(page, "get", otherLogin.options),
        )
      ).subjectId,
      otherActor.subjectId,
    );
  } finally {
    verifier?.close();
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
