import { openDB } from "idb";
import { decodeJwt, decodeProtectedHeader, importJWK } from "jose";
import { validateCollectionEventV2 } from "../auth-prototype/collection-contract.mjs";
import { verifyOfflineGrant } from "./identity-grant.mjs";
import { openPasswordVaultStore } from "./password-key-vault.mjs";
import { openProtectedCollectionQueue } from "./protected-collection-queue.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function scopeValid(scope) {
  if (
    !scope ||
    Object.keys(scope).sort().join() !== "company_id,house_id,lot_id,site_id"
  )
    throw new Error("OFFLINE_IDENTITY_INVALID_SCOPE");
  if (
    !["company_id", "site_id", "house_id", "lot_id"].every((key) =>
      UUID.test(scope?.[key]),
    )
  )
    throw new Error("OFFLINE_IDENTITY_INVALID_SCOPE");
}

// No access/refresh tokens or plaintext password are persisted here. This is
// Local capture and delivery evidence use a separate encrypted queue.
export class PasswordOfflineIdentity {
  #generation = 0;
  #session = null;
  #profile = null;
  #grant = null;

  static async open(request) {
    const db = await openDB("tamago-password-offline-identity-lab-v1", 1, {
      upgrade(database) {
        database.createObjectStore("meta");
        database.createObjectStore("profiles", { keyPath: "profile_id" });
      },
    });
    const tx = db.transaction("meta", "readwrite");
    let deviceId = await tx.store.get("device_id");
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      await tx.store.put(deviceId, "device_id");
    }
    await tx.done;
    if (!UUID.test(deviceId)) {
      db.close();
      throw new Error("OFFLINE_DEVICE_INVALID");
    }
    const vaults = await openPasswordVaultStore();
    let queue;
    try {
      queue = await openProtectedCollectionQueue();
    } catch (error) {
      vaults.close();
      db.close();
      throw error;
    }
    return new PasswordOfflineIdentity(db, vaults, request, deviceId, queue);
  }

  constructor(db, vaults, request, deviceId, queue) {
    this.db = db;
    this.vaults = vaults;
    this.request = request;
    this.deviceId = deviceId;
    this.queue = queue;
  }

  get active() {
    return this.#profile
      ? {
          profile_id: this.#profile.profile_id,
          subject_user_id: this.#profile.subject_user_id,
          scope: structuredClone(this.#profile.scope),
          grant_state:
            this.#grant.grant_state === "expired" ||
            Date.now() >= decodeJwt(this.#profile.token).exp * 1000
              ? "expired"
              : "current",
        }
      : null;
  }

  lock() {
    this.#generation += 1;
    this.#session?.lock();
    this.#session = null;
    this.#profile = null;
    this.#grant = null;
  }

  check(generation, session) {
    if (generation !== this.#generation) {
      session?.lock();
      throw new Error("OFFLINE_IDENTITY_CANCELLED");
    }
  }

  close() {
    this.lock();
    this.vaults.close();
    this.db.close();
    this.queue.close();
  }

  async saveCollection(input) {
    const generation = this.#generation;
    const session = this.#session;
    const profile = this.#profile;
    if (!session || !profile) throw new Error("OFFLINE_IDENTITY_LOCKED");
    const grant = await this.verify(profile, session);
    this.check(generation, session);
    const event = {
      schema_version: 2,
      event_id: input.event_id ?? crypto.randomUUID(),
      ...profile.scope,
      business_date: input.business_date,
      occurrence: input.occurrence,
      quantity_eggs: input.quantity_eggs,
      occurred_at: input.occurred_at,
      captured_at: input.captured_at ?? new Date().toISOString(),
      actor_declared_id: profile.subject_user_id,
      device_id: this.deviceId,
    };
    if (!validateCollectionEventV2(event, profile.scope.company_id))
      throw new Error("PROTECTED_QUEUE_INVALID_RECORD");
    const proof = await session.createEventProof(event, grant);
    this.check(generation, session);
    const record = {
      event,
      identity_binding: {
        grant_id: grant.grant_id,
        subject_user_id: profile.subject_user_id,
        attribution_status: "pending_server_verification",
      },
      device_proof: proof,
      delivery: { status: "pending" },
    };
    const saved = await this.queue.save(record, grant, session);
    this.check(generation, session);
    return saved;
  }

  async collectionDeliveries() {
    const generation = this.#generation;
    const session = this.#session;
    const profile = this.#profile;
    if (!session || !profile) throw new Error("OFFLINE_IDENTITY_LOCKED");
    const grant = await this.verify(profile, session);
    this.check(generation, session);
    const rows = await this.queue.deliveries(grant, session);
    this.check(generation, session);
    return rows;
  }

  async synchronizeCollections() {
    const generation = this.#generation;
    const session = this.#session;
    const profile = this.#profile;
    if (!session || !profile) throw new Error("OFFLINE_IDENTITY_LOCKED");
    const current = await this.request("/v1/auth/me");
    this.check(generation, session);
    // This cut sends only the open worker's own records. Bridge transport is
    // a separate workflow; it does not inherit this worker's password/key.
    if (
      current?.user_id !== profile.subject_user_id ||
      current.password_change_required !== false
    )
      throw new Error("COLLECTION_SYNC_ACCOUNT_MISMATCH");
    const grant = await this.verify(profile, session);
    this.check(generation, session);
    const rows = await this.queue.deliveries(grant, session);
    this.check(generation, session);
    let received = 0;
    let review = 0;
    for (const row of rows) {
      if (row.status !== "pending") continue;
      this.check(generation, session);
      const receipt = await this.request(
        `/v1/companies/${profile.scope.company_id}/offline-collection-events`,
        {
          method: "POST",
          body: JSON.stringify({
            format: "tamago.offline-collection-bundle",
            schema_version: 1,
            records: [row.record],
          }),
        },
      );
      this.check(generation, session);
      await this.queue.acknowledge(
        row.record,
        receipt,
        grant,
        session,
        current.user_id,
      );
      this.check(generation, session);
      if (receipt.review_status === "review_required") review += 1;
      else received += 1;
    }
    return { received, review };
  }

  async exportCollections() {
    const generation = this.#generation;
    const session = this.#session;
    const profile = this.#profile;
    if (!session || !profile) throw new Error("OFFLINE_IDENTITY_LOCKED");
    const grant = await this.verify(profile, session);
    this.check(generation, session);
    const bundle = await this.queue.export(grant, session);
    this.check(generation, session);
    return bundle;
  }

  async list() {
    return (await this.db.getAll("profiles"))
      .filter((profile) => profile.token)
      .map((profile) => ({
        profile_id: profile.profile_id,
        subject_user_id: profile.subject_user_id,
        label: profile.label,
      }));
  }

  async verify(profile, session) {
    scopeValid(profile.scope);
    if (
      !UUID.test(profile.subject_user_id) ||
      profile.device_id !== this.deviceId ||
      profile.issuer_jwk?.kid !== decodeProtectedHeader(profile.token).kid ||
      "d" in profile.issuer_jwk
    )
      throw new Error("OFFLINE_PROFILE_INVALID");
    const grant = await verifyOfflineGrant(profile.token, {
      publicKey: await importJWK(profile.issuer_jwk, "ES256"),
      expected: {
        ...profile.scope,
        sub: profile.subject_user_id,
        device_id: this.deviceId,
        permission: "collection.capture",
        device_key_thumbprint: session.thumbprint,
      },
    });
    if (grant.device_key_thumbprint !== session.thumbprint)
      throw new Error("OFFLINE_PROFILE_INVALID");
    return grant;
  }

  async prepare({ userId, scope, password, label }) {
    this.lock();
    const generation = this.#generation;
    scopeValid(scope);
    scope = structuredClone(scope);
    if (!UUID.test(userId)) throw new Error("OFFLINE_IDENTITY_INVALID_USER");
    let session;
    try {
      const confirmed = await this.request("/v1/auth/confirm-password", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      this.check(generation);
      if (
        confirmed?.password_confirmed !== true ||
        confirmed.user_id !== userId
      )
        throw new Error("SESSION_IDENTITY_MISMATCH");
      const context = { subject_user_id: userId, device_id: this.deviceId };
      if (!(await this.vaults.read(context))) {
        this.check(generation);
        await this.vaults.provision(context, password);
      }
      this.check(generation);
      session = await this.vaults.unlock(context, password);
      this.check(generation, session);
      const profileId = [
        userId,
        this.deviceId,
        scope.company_id,
        scope.site_id,
        scope.house_id,
        scope.lot_id,
      ].join(":");
      const previous = await this.db.get("profiles", profileId);
      const requestId =
        previous?.pending_request_id &&
        Date.now() - previous.pending_at < 24 * 60 * 60 * 1000
          ? previous.pending_request_id
          : crypto.randomUUID();
      const pending = {
        ...previous,
        profile_id: profileId,
        subject_user_id: userId,
        device_id: this.deviceId,
        scope,
        label: String(label ?? userId).slice(0, 240),
        pending_request_id: requestId,
        pending_at:
          previous?.pending_request_id === requestId
            ? previous.pending_at
            : Date.now(),
      };
      this.check(generation, session);
      await this.db.put("profiles", pending);
      const discovery = await this.request("/v1/offline-grant-keys");
      this.check(generation, session);
      const proof = await session.createRegistrationProof({
        ...scope,
        request_id: requestId,
      });
      this.check(generation, session);
      const issued = await this.request(
        `/v1/companies/${scope.company_id}/offline-capture-grants`,
        {
          method: "POST",
          body: JSON.stringify({
            request_id: requestId,
            device_id: this.deviceId,
            site_id: scope.site_id,
            house_id: scope.house_id,
            lot_id: scope.lot_id,
            proof,
          }),
        },
      );
      this.check(generation, session);
      const keyId = decodeProtectedHeader(issued.token).kid;
      const keys = discovery?.keys?.filter(
        (key) =>
          key.kid === keyId &&
          key.kty === "EC" &&
          key.crv === "P-256" &&
          key.alg === "ES256" &&
          !("d" in key),
      );
      if (keys?.length !== 1) throw new Error("OFFLINE_ISSUER_KEY_UNAVAILABLE");
      const profile = {
        profile_id: profileId,
        subject_user_id: userId,
        device_id: this.deviceId,
        scope,
        label: pending.label,
        token: issued.token,
        issuer_jwk: keys[0],
      };
      const grant = await this.verify(profile, session);
      this.check(generation, session);
      if (grant.grant_id !== issued.grant_id || grant.grant_state !== "current")
        throw new Error("OFFLINE_PROFILE_INVALID");
      await this.db.put("profiles", profile);
      this.check(generation, session);
      this.#session = session;
      this.#profile = profile;
      this.#grant = grant;
      return this.active;
    } catch (error) {
      session?.lock();
      throw error;
    }
  }

  async unlock(profileId, password) {
    this.lock();
    const generation = this.#generation;
    let session;
    try {
      const profile = await this.db.get("profiles", profileId);
      this.check(generation);
      if (!profile?.token) throw new Error("OFFLINE_PROFILE_NOT_PREPARED");
      session = await this.vaults.unlock(
        { subject_user_id: profile.subject_user_id, device_id: this.deviceId },
        password,
      );
      this.check(generation, session);
      const grant = await this.verify(profile, session);
      this.check(generation, session);
      this.#session = session;
      this.#profile = profile;
      this.#grant = grant;
      return this.active;
    } catch (error) {
      session?.lock();
      throw error;
    }
  }
}
