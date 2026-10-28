import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { WebAuthnPrototypeVerifier } from "../src/auth-prototype/webauthn-verifier.mjs";

const context = {
  subjectId: "synthetic-worker-a",
  sessionBinding: "synthetic-session-a-0001",
};

test("WebAuthn challenge is subject/session bound, expiring, and consumed on a failed proof", async () => {
  let clock = 1_000;
  const service = new WebAuthnPrototypeVerifier({
    databasePath: ":memory:",
    rpId: "localhost",
    origin: "http://localhost:8765",
    now: () => clock,
  });
  try {
    const start = await service.beginRegistration({
      ...context,
      displayName: "Demo A",
    });
    const finishContext = { ...context, ceremonyId: start.ceremonyId };
    await assert.rejects(
      service.finishRegistration(
        { ...finishContext, subjectId: "synthetic-worker-b" },
        {},
      ),
      { code: "CHALLENGE_UNAVAILABLE" },
    );
    await assert.rejects(
      service.finishRegistration(
        { ...finishContext, sessionBinding: "synthetic-session-b-0001" },
        {},
      ),
      { code: "CHALLENGE_UNAVAILABLE" },
    );
    await assert.rejects(service.finishRegistration(finishContext, {}), {
      code: "INVALID_PROOF",
    });
    await assert.rejects(service.finishRegistration(finishContext, {}), {
      code: "CHALLENGE_UNAVAILABLE",
    });
    const attested = await service.beginRegistration({
      ...context,
      displayName: "Demo A",
    });
    const attestationObject = Buffer.from(
      isoCBOR.encode(new Map([["fmt", "packed"]])),
    ).toString("base64url");
    await assert.rejects(
      service.finishRegistration(
        { ...context, ceremonyId: attested.ceremonyId },
        { response: { attestationObject } },
      ),
      { code: "UNSUPPORTED_ATTESTATION" },
    );
    for (const data of [
      { crossOrigin: true },
      { crossOrigin: false, topOrigin: "https://other.invalid" },
    ]) {
      const embedded = await service.beginRegistration({
        ...context,
        displayName: "Demo A",
      });
      await assert.rejects(
        service.finishRegistration(
          { ...context, ceremonyId: embedded.ceremonyId },
          {
            response: {
              attestationObject: Buffer.from(
                isoCBOR.encode(new Map([["fmt", "none"]])),
              ).toString("base64url"),
              clientDataJSON: Buffer.from(JSON.stringify(data)).toString(
                "base64url",
              ),
            },
          },
        ),
        { code: "CROSS_ORIGIN_NOT_ALLOWED" },
      );
    }
    const expiring = await service.beginRegistration({
      ...context,
      displayName: "Demo A",
    });
    clock += 300_000;
    await assert.rejects(
      service.finishRegistration(
        { ...context, ceremonyId: expiring.ceremonyId },
        {},
      ),
      { code: "CHALLENGE_UNAVAILABLE" },
    );
  } finally {
    service.close();
  }
});

test("WebAuthn store refuses unrelated and future-schema databases without modifying them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tamago-webauthn-store-"));
  try {
    for (const future of [false, true]) {
      const databasePath = join(
        directory,
        future ? "future.sqlite" : "unrelated.sqlite",
      );
      const db = new DatabaseSync(databasePath);
      db.exec(
        future
          ? "CREATE TABLE webauthn_lab_meta(version INTEGER); INSERT INTO webauthn_lab_meta VALUES(99)"
          : "CREATE TABLE preserved(id INTEGER); INSERT INTO preserved VALUES(7)",
      );
      const before = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all();
      db.close();
      assert.throws(
        () =>
          new WebAuthnPrototypeVerifier({
            databasePath,
            rpId: "localhost",
            origin: "http://localhost:8765",
          }),
        {
          code: future ? "UNSUPPORTED_DATABASE_VERSION" : "UNRELATED_DATABASE",
        },
      );
      const after = new DatabaseSync(databasePath);
      assert.deepEqual(
        after
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all(),
        before,
      );
      after.close();
    }
    assert.throws(
      () =>
        new WebAuthnPrototypeVerifier({
          databasePath: ":memory:",
          rpId: "localhost",
          origin: "https://other.invalid",
        }),
      { code: "INVALID_RP_CONFIGURATION" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
