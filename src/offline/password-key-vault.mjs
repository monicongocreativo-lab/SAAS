import { openDB } from "idb";
import { calculateJwkThumbprint, SignJWT } from "jose";
import { createOfflineDeviceEventProof } from "./device-event-proof.mjs";

const DATABASE = "tamago-password-key-vault-lab-v1";
const FORMAT = "tamago.password-key-vault";
const ITERATIONS = 600_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = [
  "format",
  "schema_version",
  "factor_type",
  "vault_id",
  "subject_user_id",
  "device_id",
  "public_jwk",
  "thumbprint",
  "kdf",
  "cipher",
  "ciphertext",
].sort();

export class PasswordVaultError extends Error {
  constructor(code) {
    super(code);
    this.name = "PasswordVaultError";
    this.code = code;
  }
}

function contextValid(context) {
  if (!UUID.test(context?.subject_user_id) || !UUID.test(context?.device_id))
    throw new PasswordVaultError("VAULT_INVALID_CONTEXT");
}

function passwordValid(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 1024
  )
    throw new PasswordVaultError("VAULT_INVALID_PASSWORD_LENGTH");
}

function encode(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(value, size, maxLength = 4096) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length > maxLength
  )
    throw new PasswordVaultError("VAULT_INVALID_RECORD");
  const raw = value.replaceAll("-", "+").replaceAll("_", "/");
  const result = Uint8Array.from(
    atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "=")),
    (char) => char.charCodeAt(0),
  );
  if (encode(result) !== value || (size && result.length !== size))
    throw new PasswordVaultError("VAULT_INVALID_RECORD");
  return result;
}

function header(record) {
  return {
    format: record.format,
    schema_version: record.schema_version,
    factor_type: record.factor_type,
    vault_id: record.vault_id,
    subject_user_id: record.subject_user_id,
    device_id: record.device_id,
    public_jwk: {
      kty: record.public_jwk.kty,
      crv: record.public_jwk.crv,
      x: record.public_jwk.x,
      y: record.public_jwk.y,
    },
    thumbprint: record.thumbprint,
    kdf: {
      name: record.kdf.name,
      hash: record.kdf.hash,
      iterations: record.kdf.iterations,
      salt: record.kdf.salt,
    },
    cipher: {
      name: record.cipher.name,
      iv: record.cipher.iv,
      tag_length: record.cipher.tag_length,
    },
  };
}

async function validateRecord(record) {
  if (
    !record ||
    Object.keys(record).sort().join() !== FIELDS.join() ||
    record.format !== FORMAT ||
    record.schema_version !== 1 ||
    record.factor_type !== "password_wrapped_key"
  )
    throw new PasswordVaultError("VAULT_INVALID_RECORD");
  contextValid(record);
  if (
    !UUID.test(record.vault_id) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record.thumbprint) ||
    Object.keys(record.public_jwk ?? {})
      .sort()
      .join() !== "crv,kty,x,y" ||
    record.public_jwk.kty !== "EC" ||
    record.public_jwk.crv !== "P-256" ||
    Object.keys(record.kdf ?? {})
      .sort()
      .join() !== "hash,iterations,name,salt" ||
    record.kdf.name !== "PBKDF2" ||
    record.kdf.hash !== "SHA-256" ||
    record.kdf.iterations !== ITERATIONS ||
    Object.keys(record.cipher ?? {})
      .sort()
      .join() !== "iv,name,tag_length" ||
    record.cipher.name !== "AES-GCM" ||
    record.cipher.tag_length !== 128
  )
    throw new PasswordVaultError("VAULT_INVALID_RECORD");
  decode(record.kdf.salt, 16);
  decode(record.cipher.iv, 12);
  decode(record.public_jwk.x, 32);
  decode(record.public_jwk.y, 32);
  if (
    decode(record.ciphertext).length < 128 ||
    (await calculateJwkThumbprint(record.public_jwk, "sha256")) !==
      record.thumbprint
  )
    throw new PasswordVaultError("VAULT_INVALID_RECORD");
}

async function wrappingKey(password, salt, usages) {
  passwordValid(password);
  const bytes = new TextEncoder().encode(password);
  try {
    const material = await crypto.subtle.importKey(
      "raw",
      bytes,
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      usages,
    );
  } finally {
    bytes.fill(0);
  }
}

// Only ciphertext/public metadata is returned. The generated extractable key is
// transient during wrapping; it is never stored as a CryptoKey or plain PKCS#8.
// Enrollment authorization and server binding must be supplied by the caller.
export async function createPasswordVault(expectedContext, password) {
  const context = {
    subject_user_id: expectedContext?.subject_user_id,
    device_id: expectedContext?.device_id,
  };
  contextValid(context);
  passwordValid(password);
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const record = {
    format: FORMAT,
    schema_version: 1,
    factor_type: "password_wrapped_key",
    vault_id: crypto.randomUUID(),
    subject_user_id: context.subject_user_id,
    device_id: context.device_id,
    public_jwk: publicJwk,
    thumbprint: await calculateJwkThumbprint(publicJwk, "sha256"),
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: ITERATIONS,
      salt: encode(crypto.getRandomValues(new Uint8Array(16))),
    },
    cipher: {
      name: "AES-GCM",
      iv: encode(crypto.getRandomValues(new Uint8Array(12))),
      tag_length: 128,
    },
  };
  const key = await wrappingKey(password, decode(record.kdf.salt, 16), [
    "wrapKey",
  ]);
  const wrapped = await crypto.subtle.wrapKey("pkcs8", pair.privateKey, key, {
    name: "AES-GCM",
    iv: decode(record.cipher.iv, 12),
    tagLength: 128,
    additionalData: new TextEncoder().encode(JSON.stringify(header(record))),
  });
  return { ...record, ciphertext: encode(wrapped) };
}

export async function unlockPasswordVault(value, expectedContext, password) {
  const context = {
    subject_user_id: expectedContext?.subject_user_id,
    device_id: expectedContext?.device_id,
  };
  let record;
  try {
    record = structuredClone(value);
  } catch {
    throw new PasswordVaultError("VAULT_INVALID_RECORD");
  }
  contextValid(context);
  await validateRecord(record);
  if (
    record.subject_user_id !== context.subject_user_id ||
    record.device_id !== context.device_id
  )
    throw new PasswordVaultError("VAULT_CONTEXT_MISMATCH");
  passwordValid(password);
  let pair;
  let dataKey;
  try {
    const key = await wrappingKey(password, decode(record.kdf.salt, 16), [
      "unwrapKey",
    ]);
    const privateKey = await crypto.subtle.unwrapKey(
      "pkcs8",
      decode(record.ciphertext),
      key,
      {
        name: "AES-GCM",
        iv: decode(record.cipher.iv, 12),
        tagLength: 128,
        additionalData: new TextEncoder().encode(
          JSON.stringify(header(record)),
        ),
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      record.public_jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      challenge,
    );
    if (
      !(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        challenge,
      ))
    )
      throw new Error("Key mismatch");
    pair = {
      privateKey,
      publicKey,
      publicJwk: structuredClone(record.public_jwk),
      thumbprint: record.thumbprint,
    };
    const salt = decode(record.kdf.salt, 16);
    const domain = new TextEncoder().encode("tamago.protected-queue.v1");
    const dataSalt = new Uint8Array(salt.length + domain.length);
    dataSalt.set(salt);
    dataSalt.set(domain, salt.length);
    dataKey = await wrappingKey(password, dataSalt, ["encrypt", "decrypt"]);
  } catch {
    throw new PasswordVaultError("VAULT_UNLOCK_FAILED");
  }
  // No key/password accessor. A lock drops references and prevents delivery of
  // an in-flight proof. JS cannot promise immediate erasure from process memory.
  let generation = 0;
  return Object.freeze({
    vaultId: record.vault_id,
    thumbprint: record.thumbprint,
    get locked() {
      return pair === null;
    },
    lock() {
      pair = null;
      dataKey = null;
      generation += 1;
    },
    async sealLocalPayload(payload, metadata) {
      if (!pair || !dataKey) throw new PasswordVaultError("VAULT_LOCKED");
      const current = generation;
      const binding = {
        format: "tamago.protected-queue-record",
        schema_version: 1,
        vault_id: record.vault_id,
        subject_user_id: record.subject_user_id,
        device_id: record.device_id,
        metadata: sortedMetadata(metadata),
      };
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      if (bytes.length > 24 * 1024)
        throw new PasswordVaultError("VAULT_LOCAL_PAYLOAD_INVALID");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          tagLength: 128,
          additionalData: new TextEncoder().encode(JSON.stringify(binding)),
        },
        dataKey,
        bytes,
      );
      if (current !== generation || !pair)
        throw new PasswordVaultError("VAULT_LOCKED");
      return { ...binding, iv: encode(iv), ciphertext: encode(ciphertext) };
    },
    async openLocalPayload(value) {
      if (!pair || !dataKey) throw new PasswordVaultError("VAULT_LOCKED");
      const current = generation;
      let result;
      try {
        const sealed = structuredClone(value);
        if (
          Object.keys(sealed).sort().join() !==
            "ciphertext,device_id,format,iv,metadata,schema_version,subject_user_id,vault_id" ||
          sealed.format !== "tamago.protected-queue-record" ||
          sealed.schema_version !== 1 ||
          sealed.vault_id !== record.vault_id ||
          sealed.subject_user_id !== record.subject_user_id ||
          sealed.device_id !== record.device_id
        )
          throw new Error("Invalid binding");
        const binding = {
          format: sealed.format,
          schema_version: sealed.schema_version,
          vault_id: sealed.vault_id,
          subject_user_id: sealed.subject_user_id,
          device_id: sealed.device_id,
          metadata: sortedMetadata(sealed.metadata),
        };
        const bytes = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: decode(sealed.iv, 12),
            tagLength: 128,
            additionalData: new TextEncoder().encode(JSON.stringify(binding)),
          },
          dataKey,
          decode(sealed.ciphertext, undefined, 48 * 1024),
        );
        if (bytes.byteLength > 24 * 1024) throw new Error("Payload too large");
        result = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new PasswordVaultError("VAULT_LOCAL_PAYLOAD_INVALID");
      }
      if (current !== generation || !pair)
        throw new PasswordVaultError("VAULT_LOCKED");
      return result;
    },
    async createRegistrationProof(scope, { now = new Date() } = {}) {
      if (!pair) throw new PasswordVaultError("VAULT_LOCKED");
      if (
        !["company_id", "site_id", "house_id", "lot_id", "request_id"].every(
          (key) => UUID.test(scope?.[key]),
        ) ||
        !Number.isFinite(now?.getTime?.())
      )
        throw new PasswordVaultError("VAULT_INVALID_CONTEXT");
      const current = generation;
      const jws = await new SignJWT({
        company_id: scope.company_id,
        site_id: scope.site_id,
        house_id: scope.house_id,
        lot_id: scope.lot_id,
        device_id: record.device_id,
        permission: "collection.capture",
      })
        .setProtectedHeader({
          alg: "ES256",
          typ: "tamago-device-registration+jwt",
          jwk: pair.publicJwk,
        })
        .setSubject(record.subject_user_id)
        .setJti(scope.request_id)
        .setIssuedAt(Math.floor(now.getTime() / 1000))
        .sign(pair.privateKey);
      if (current !== generation || !pair)
        throw new PasswordVaultError("VAULT_LOCKED");
      return { jws };
    },
    async createEventProof(event, grant, options) {
      if (!pair) throw new PasswordVaultError("VAULT_LOCKED");
      if (
        event?.actor_declared_id !== record.subject_user_id ||
        event?.device_id !== record.device_id ||
        grant?.subject_user_id !== record.subject_user_id ||
        grant?.device_id !== record.device_id
      )
        throw new PasswordVaultError("VAULT_CONTEXT_MISMATCH");
      const current = generation;
      const proof = await createOfflineDeviceEventProof(
        event,
        grant,
        pair,
        options,
      );
      if (current !== generation || !pair)
        throw new PasswordVaultError("VAULT_LOCKED");
      return proof;
    },
  });
}

function sortedMetadata(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 4096 ||
    Object.values(value).some(
      (item) => !["string", "number", "boolean"].includes(typeof item),
    )
  )
    throw new PasswordVaultError("VAULT_LOCAL_PAYLOAD_INVALID");
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

// Dedicated experimental storage. Never opens DEV-002 databases or overwrites
// an existing subject/device vault when a password is wrong or forgotten.
export async function openPasswordVaultStore() {
  const db = await openDB(DATABASE, 1, {
    upgrade(database) {
      const store = database.createObjectStore("vaults", {
        keyPath: "vault_id",
      });
      store.createIndex("subject_device", ["subject_user_id", "device_id"], {
        unique: true,
      });
    },
  });
  return Object.freeze({
    close() {
      db.close();
    },
    async provision(context, password) {
      const record = await createPasswordVault(context, password);
      const transaction = db.transaction("vaults", "readwrite");
      try {
        await transaction.store.add(record);
        await transaction.done;
      } catch {
        await transaction.done.catch(() => {});
        throw new PasswordVaultError("VAULT_NOT_SAVED");
      }
      return structuredClone(record);
    },
    async read(context) {
      contextValid(context);
      return (
        (await db.getFromIndex("vaults", "subject_device", [
          context.subject_user_id,
          context.device_id,
        ])) ?? null
      );
    },
    async unlock(context, password) {
      const record = await this.read(context);
      if (!record) throw new PasswordVaultError("VAULT_NOT_FOUND");
      return unlockPasswordVault(record, context, password);
    },
  });
}
