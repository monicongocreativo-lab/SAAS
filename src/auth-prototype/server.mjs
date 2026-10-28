import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { assertOfflineCaptureBindings } from "../offline/capture-envelope.mjs";
import { bindCollectionReceipt } from "../offline/collection-receipt.mjs";
import { verifyOfflineDeviceEventProof } from "../offline/device-event-proof.mjs";
import { validateCollectionEventV2 } from "./collection-contract.mjs";
import { custodyApi } from "./custody-api.mjs";
import { verifyDeviceRegistrationProof } from "./device-registration-proof.mjs";
import { feedDeliveryApi } from "./feed-delivery-api.mjs";
import { feedInventoryApi } from "./feed-inventory-api.mjs";
import { feedOpeningApi } from "./feed-opening-api.mjs";
import { feedSupplyApi } from "./feed-supply-api.mjs";
import { manualClassificationApi } from "./manual-classification-api.mjs";
import { issueOfflineCaptureGrant } from "./offline-grant-issuer.mjs";
import { DurableSessionStore } from "./session-store.mjs";

const SESSION_COOKIE = "__Host-tamago_dev_session";
const MAX_BODY_BYTES = 8 * 1024;
const MAX_OFFLINE_BUNDLE_BYTES = 24 * 1024;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

export function createAuthPrototypeServer({
  apiUrl,
  restUrl,
  publishableKey,
  serviceRoleKey,
  allowedOrigins,
  sessionDbPath,
  sessionEncryptionKey,
  offlineGrantSigningKey,
  offlineGrantKeyId,
  offlineGrantPublicJwk,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  const authBase = new URL("/auth/v1/", apiUrl);
  const restBase = new URL(restUrl.endsWith("/") ? restUrl : `${restUrl}/`);
  const sessions = new DurableSessionStore({
    databasePath: sessionDbPath,
    encryptionKey: sessionEncryptionKey,
    now,
  });
  const origins = new Set(allowedOrigins);
  const provisioningTasks = new Map();
  const passwordConfirmAttempts = new Map();

  const server = createServer(async (request, response) => {
    setBaseHeaders(response);

    if (request.method === "GET" && request.url === "/health")
      return sendJson(response, 200, {
        status: "ok",
        mode: "local-auth-prototype",
      });

    if (request.method === "GET" && request.url === "/v1/offline-grant-keys") {
      if (
        !offlineGrantKeyId ||
        !isRecord(offlineGrantPublicJwk) ||
        "d" in offlineGrantPublicJwk
      )
        return sendJson(response, 503, {
          error: "OFFLINE_GRANT_KEYS_UNAVAILABLE",
        });
      return sendJson(response, 200, {
        keys: [
          {
            ...offlineGrantPublicJwk,
            alg: "ES256",
            use: "sig",
            kid: offlineGrantKeyId,
          },
        ],
      });
    }

    if (request.method === "POST" && request.url === "/v1/auth/login") {
      if (!hasAllowedOrigin(request, origins))
        return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });

      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        const status =
          error.code === "BODY_TOO_LARGE"
            ? 413
            : error.code === "UNSUPPORTED_MEDIA_TYPE"
              ? 415
              : 400;
        return sendJson(response, status, {
          error:
            status === 413
              ? "BODY_TOO_LARGE"
              : status === 415
                ? "UNSUPPORTED_MEDIA_TYPE"
                : "INVALID_REQUEST",
        });
      }

      if (
        !isRecord(body) ||
        typeof body.email !== "string" ||
        body.email.length < 3 ||
        body.email.length > 320 ||
        typeof body.password !== "string" ||
        body.password.length < 1 ||
        body.password.length > 1024
      )
        return sendJson(response, 400, { error: "INVALID_CREDENTIALS_FORMAT" });

      try {
        const authResponse = await fetchImpl(
          new URL("token?grant_type=password", authBase),
          {
            method: "POST",
            headers: {
              apikey: publishableKey,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              email: body.email,
              password: body.password,
            }),
          },
        );
        if (!authResponse.ok)
          return sendJson(response, 401, { error: "INVALID_CREDENTIALS" });

        const authSession = await authResponse.json();
        if (
          typeof authSession.access_token !== "string" ||
          typeof authSession.refresh_token !== "string" ||
          typeof authSession.user?.id !== "string"
        )
          return sendJson(response, 502, {
            error: "AUTH_PROVIDER_RESPONSE_INVALID",
          });

        const sessionId = randomBytes(32).toString("base64url");
        const expiresInMs = Number(authSession.expires_in ?? 3600) * 1000;
        const createdAt = now();
        if (!Number.isFinite(expiresInMs) || expiresInMs <= 0)
          return sendJson(response, 502, {
            error: "AUTH_PROVIDER_RESPONSE_INVALID",
          });
        try {
          sessions.create(hashSessionId(sessionId), {
            accessToken: authSession.access_token,
            refreshToken: authSession.refresh_token,
            userId: authSession.user.id,
            accessExpiresAt: createdAt + expiresInMs,
            createdAt,
            expiresAt: createdAt + SESSION_MAX_AGE_MS,
          });
        } catch {
          return sendJson(response, 503, {
            error: "SESSION_STORE_UNAVAILABLE",
          });
        }
        response.setHeader("set-cookie", sessionCookie(sessionId));
        return sendJson(response, 200, {
          user_id: authSession.user.id,
          password_change_required:
            authSession.user.app_metadata?.tamago_initial_access_state ===
            "pending",
        });
      } catch {
        return sendJson(response, 503, { error: "AUTH_PROVIDER_UNAVAILABLE" });
      }
    }

    if (
      request.method === "POST" &&
      request.url === "/v1/auth/confirm-password"
    ) {
      if (!hasAllowedOrigin(request, origins))
        return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      const auth = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!auth.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      if (auth.session.passwordChangeRequired)
        return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return sendJson(response, bodyErrorStatus(error), {
          error: bodyErrorCode(error),
        });
      }
      if (
        !isRecord(body) ||
        Object.keys(body).join() !== "password" ||
        typeof body.password !== "string" ||
        body.password.length < 1 ||
        body.password.length > 1024
      )
        return sendJson(response, 400, { error: "INVALID_CREDENTIALS_FORMAT" });
      for (const [key, value] of passwordConfirmAttempts)
        if (value.until <= now()) passwordConfirmAttempts.delete(key);
      const sessionKey = auth.session.sessionHash;
      const attempts = passwordConfirmAttempts.get(sessionKey) ?? {
        count: 0,
        until: now() + 60_000,
      };
      if (
        attempts.count >= 5 ||
        (!passwordConfirmAttempts.has(sessionKey) &&
          passwordConfirmAttempts.size >= 1024)
      ) {
        response.setHeader("retry-after", "60");
        return sendJson(response, 429, {
          error: "PASSWORD_CONFIRM_RATE_LIMITED",
        });
      }
      attempts.count += 1;
      passwordConfirmAttempts.set(sessionKey, attempts);
      try {
        if (typeof auth.session.email !== "string")
          return sendJson(response, 503, {
            error: "AUTH_PROVIDER_RESPONSE_INVALID",
          });
        const checked = await fetchImpl(
          new URL("token?grant_type=password", authBase),
          {
            method: "POST",
            headers: {
              apikey: publishableKey,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              email: auth.session.email,
              password: body.password,
            }),
          },
        );
        if (!checked.ok)
          return sendJson(response, 401, { error: "INVALID_CREDENTIALS" });
        const renewed = await checked.json();
        if (renewed.user?.id !== auth.session.userId)
          return sendJson(response, 403, {
            error: "SESSION_IDENTITY_MISMATCH",
          });
        if (
          renewed.user.app_metadata?.tamago_initial_access_state === "pending"
        )
          return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });
        const duration = Number(renewed.expires_in ?? 3600) * 1000;
        if (
          typeof renewed.access_token !== "string" ||
          typeof renewed.refresh_token !== "string" ||
          !Number.isFinite(duration) ||
          duration <= 0
        )
          return sendJson(response, 503, {
            error: "AUTH_PROVIDER_RESPONSE_INVALID",
          });
        if (!safeGetSession(sessions, sessionKey))
          return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
        auth.session.accessToken = renewed.access_token;
        auth.session.refreshToken = renewed.refresh_token;
        auth.session.accessExpiresAt = now() + duration;
        sessions.saveTokens(auth.session);
        return sendJson(response, 200, {
          user_id: auth.session.userId,
          password_confirmed: true,
        });
      } catch {
        return sendJson(response, 503, { error: "AUTH_PROVIDER_UNAVAILABLE" });
      }
    }

    if (request.method === "POST" && request.url === "/v1/auth/logout") {
      if (!hasAllowedOrigin(request, origins))
        return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
      const key = sessionId ? hashSessionId(sessionId) : null;
      const session = key ? safeGetSession(sessions, key) : null;
      if (key) sessions.revoke(key);
      response.setHeader("set-cookie", clearSessionCookie());
      if (session) {
        try {
          await fetchImpl(new URL("logout?scope=local", authBase), {
            method: "POST",
            headers: {
              apikey: publishableKey,
              authorization: `Bearer ${session.accessToken}`,
            },
          });
        } catch {
          // Local cookie invalidation still succeeds when Auth is unavailable.
        }
      }
      response.writeHead(204);
      return response.end();
    }

    if (request.method === "GET" && request.url === "/v1/auth/me") {
      const result = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!result.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      return sendJson(response, 200, {
        user_id: result.session.userId,
        password_change_required: result.session.passwordChangeRequired,
      });
    }

    if (
      request.method === "POST" &&
      request.url === "/v1/auth/change-initial-password"
    ) {
      if (!hasAllowedOrigin(request, origins))
        return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return sendJson(response, bodyErrorStatus(error), {
          error: bodyErrorCode(error),
        });
      }
      if (
        !isRecord(body) ||
        typeof body.new_password !== "string" ||
        body.new_password.length < 12 ||
        body.new_password.length > 1024
      )
        return sendJson(response, 400, { error: "INVALID_NEW_PASSWORD" });
      const auth = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!auth.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      if (!auth.session.passwordChangeRequired)
        return sendJson(response, 409, {
          error: "PASSWORD_CHANGE_NOT_REQUIRED",
        });
      if (!serviceRoleKey)
        return sendJson(response, 503, { error: "IDENTITY_ADMIN_UNAVAILABLE" });
      if (!isLoopbackApi(authBase))
        return sendJson(response, 503, { error: "IDENTITY_ADMIN_UNAVAILABLE" });

      const suppliedDigest = createHash("sha256")
        .update(body.new_password)
        .digest();
      const storedDigest = Buffer.from(
        auth.session.temporaryPasswordDigest ?? "",
        "hex",
      );
      if (
        storedDigest.length === suppliedDigest.length &&
        timingSafeEqual(suppliedDigest, storedDigest)
      )
        return sendJson(response, 400, {
          error: "NEW_PASSWORD_MUST_DIFFER",
        });

      try {
        const changed = await fetchImpl(
          new URL(`admin/users/${auth.session.userId}`, authBase),
          {
            method: "PUT",
            headers: {
              apikey: serviceRoleKey,
              authorization: `Bearer ${serviceRoleKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              password: body.new_password,
              // GoTrue merges app_metadata updates. Null explicitly removes
              // these server-managed onboarding markers from the durable row.
              app_metadata: {
                tamago_initial_access_state: null,
                tamago_initial_password_sha256: null,
              },
            }),
          },
        );
        if (!changed.ok)
          return sendJson(response, 400, { error: "PASSWORD_CHANGE_REJECTED" });

        const changedUser = await changed.json();
        if (
          changedUser.id !== auth.session.userId ||
          changedUser.app_metadata?.tamago_initial_access_state === "pending"
        )
          return sendJson(response, 503, {
            error: "INITIAL_ACCESS_UPDATE_UNCONFIRMED",
          });

        // Auth may invalidate the temporary-password session as part of the
        // password update. Reauthenticate with the new password and replace
        // the encrypted tokens in the same durable server-side session.
        const reauthenticated = await fetchImpl(
          new URL("token?grant_type=password", authBase),
          {
            method: "POST",
            headers: {
              apikey: publishableKey,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              email: auth.session.email,
              password: body.new_password,
            }),
          },
        );
        if (!reauthenticated.ok)
          return sendJson(response, 503, {
            error: "SESSION_REAUTHENTICATION_REQUIRED",
          });
        const renewedSession = await reauthenticated.json();
        if (
          renewedSession.user?.id !== auth.session.userId ||
          typeof renewedSession.access_token !== "string" ||
          typeof renewedSession.refresh_token !== "string"
        )
          return sendJson(response, 503, {
            error: "SESSION_REAUTHENTICATION_REQUIRED",
          });
        const renewedExpiresIn =
          Number(renewedSession.expires_in ?? 3600) * 1000;
        if (!Number.isFinite(renewedExpiresIn) || renewedExpiresIn <= 0)
          return sendJson(response, 503, {
            error: "SESSION_REAUTHENTICATION_REQUIRED",
          });
        auth.session.accessToken = renewedSession.access_token;
        auth.session.refreshToken = renewedSession.refresh_token;
        auth.session.accessExpiresAt = now() + renewedExpiresIn;
        auth.session.store.saveTokens(auth.session);
        return sendJson(response, 200, { password_changed: true });
      } catch {
        return sendJson(response, 503, { error: "AUTH_PROVIDER_UNAVAILABLE" });
      }
    }

    const custodyRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/custody-(?:origins|flow|transfers|incidents|case-actions)(?:\/[^?]*)?(?:\?.*)?$/.exec(
        request.url ?? "",
      );
    const classificationRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/manual-classification(?:s(?:\/[0-9a-f-]+)?|-inputs|-catalog)(?:\?.*)?$/.exec(
        request.url ?? "",
      );
    const feedRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/feed-suppl(?:ies(?:\/[0-9a-f-]+)?|y-context)(?:\?.*)?$/.exec(
        request.url ?? "",
      );
    const deliveryRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/feed-deliveries(?:\/[0-9a-f-]+)?(?:\?.*)?$/.exec(
        request.url ?? "",
      );
    const openingRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/feed-opening(?:s(?:\/[0-9a-f-]+)?|-counts|-approvals)(?:\?.*)?$/.exec(
        request.url ?? "",
      );
    const inventoryRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/feed-inventory\/(?:ledger-activate|ledger-post|ledger-(?:review|entries|actions)\/[0-9a-f-]+|corrections|history\/(?:binding|cutoff)\/[0-9a-f-]+|context|catalog|bindings(?:\/(?:supply|delivery|count)\/[0-9a-f-]+)?|cutoff-decisions|previews\/[0-9a-f-]+)(?:\?.*)?$/.exec(
        request.url ?? "",
      );
    const operationRoute =
      custodyRoute ??
      classificationRoute ??
      feedRoute ??
      deliveryRoute ??
      openingRoute ??
      inventoryRoute;
    if (operationRoute) {
      if (!["GET", "POST"].includes(request.method))
        return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      if (request.method === "POST" && !hasAllowedOrigin(request, origins))
        return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      const auth = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!auth.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      if (auth.session.passwordChangeRequired)
        return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });
      if (request.headers["x-tamago-user"] !== auth.session.userId)
        return sendJson(response, 409, { error: "SESSION_IDENTITY_MISMATCH" });
      if (!isUuid(operationRoute[1]))
        return sendJson(response, 400, { error: "INVALID_COMPANY_ID" });
      let body;
      if (request.method === "POST") {
        try {
          body = await readJson(
            request,
            classificationRoute ? 64 * 1024 : MAX_BODY_BYTES,
          );
        } catch (error) {
          return sendJson(response, bodyErrorStatus(error), {
            error: bodyErrorCode(error),
          });
        }
      }
      const handler = inventoryRoute
        ? feedInventoryApi
        : openingRoute
          ? feedOpeningApi
          : deliveryRoute
            ? feedDeliveryApi
            : feedRoute
              ? feedSupplyApi
              : classificationRoute
                ? manualClassificationApi
                : custodyApi;
      const result = await handler({
        url: new URL(request.url, "http://local.invalid"),
        method: request.method,
        body,
        companyId: operationRoute[1],
        userId: auth.session.userId,
        accessToken: auth.session.accessToken,
        restBase,
        publishableKey,
        fetchImpl,
      });
      return sendJson(response, result.status, result.body);
    }

    const collectionRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/collection-events$/.exec(
        request.url ?? "",
      );
    if (collectionRoute) {
      if (request.method !== "POST")
        return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      if (!hasAllowedOrigin(request, origins))
        return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      const auth = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!auth.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      if (auth.session.passwordChangeRequired)
        return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });
      const companyId = collectionRoute[1];
      if (!isUuid(companyId))
        return sendJson(response, 400, { error: "INVALID_COMPANY_ID" });
      let event;
      try {
        event = await readJson(request);
      } catch (error) {
        return sendJson(response, bodyErrorStatus(error), {
          error: bodyErrorCode(error),
        });
      }
      if (!validateCollectionEventV2(event, companyId))
        return sendJson(response, 400, { error: "INVALID_COLLECTION_EVENT" });
      return receiveCollectionEvent(
        response,
        restBase,
        publishableKey,
        auth.session,
        event,
        fetchImpl,
      );
    }

    const offlineGrantRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/offline-capture-grants$/.exec(
        request.url ?? "",
      );
    if (offlineGrantRoute) {
      if (request.method !== "POST")
        return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      if (!hasAllowedOrigin(request, origins))
        return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      const auth = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!auth.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      if (auth.session.passwordChangeRequired)
        return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });
      if (!offlineGrantSigningKey || !offlineGrantKeyId)
        return sendJson(response, 503, {
          error: "OFFLINE_GRANT_SIGNER_UNAVAILABLE",
        });
      const companyId = offlineGrantRoute[1];
      if (!isUuid(companyId))
        return sendJson(response, 400, { error: "INVALID_COMPANY_ID" });

      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return sendJson(response, bodyErrorStatus(error), {
          error: bodyErrorCode(error),
        });
      }
      const requiredIds = [
        "request_id",
        "device_id",
        "site_id",
        "house_id",
        "lot_id",
      ];
      if (
        !isRecord(body) ||
        Object.keys(body).sort().join(",") !==
          [...requiredIds, "proof"].sort().join(",") ||
        !requiredIds.every((field) => isUuid(body[field])) ||
        !isRecord(body.proof) ||
        Object.keys(body.proof).length !== 1 ||
        typeof body.proof.jws !== "string"
      )
        return sendJson(response, 400, {
          error: "INVALID_OFFLINE_GRANT_REQUEST",
        });

      const expectedProof = {
        sub: auth.session.userId,
        jti: body.request_id,
        company_id: companyId,
        device_id: body.device_id,
        site_id: body.site_id,
        house_id: body.house_id,
        lot_id: body.lot_id,
        permission: "collection.capture",
      };
      let deviceProof;
      try {
        deviceProof = await verifyDeviceRegistrationProof(body.proof, {
          expected: expectedProof,
          now: new Date(now()),
        });
      } catch {
        return sendJson(response, 401, { error: "DEVICE_PROOF_INVALID" });
      }

      try {
        const rpcResponse = await fetchImpl(
          new URL("rpc/register_offline_capture_grant_v2", restBase),
          {
            method: "POST",
            headers: {
              ...userHeaders(publishableKey, auth.session).headers,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              p_company_id: companyId,
              p_device_id: body.device_id,
              p_site_id: body.site_id,
              p_house_id: body.house_id,
              p_lot_id: body.lot_id,
              p_request_id: deviceProof.request_id,
              p_device_key_thumbprint: deviceProof.device_key_thumbprint,
            }),
          },
        );
        if (!rpcResponse.ok) {
          const error = await rpcResponse.json().catch(() => ({}));
          if (error.code === "42501")
            return sendJson(response, 403, {
              error: "OFFLINE_GRANT_FORBIDDEN",
            });
          if (error.code === "22023")
            return sendJson(response, 409, {
              error: "OFFLINE_GRANT_REQUEST_CONFLICT",
            });
          return sendJson(response, 503, {
            error: "OFFLINE_GRANT_REGISTRY_UNAVAILABLE",
          });
        }
        const registration = await rpcResponse.json();
        const grant = await issueOfflineCaptureGrant(registration, {
          privateKey: offlineGrantSigningKey,
          keyId: offlineGrantKeyId,
          now: new Date(now()),
        });
        return sendJson(response, 201, grant);
      } catch (error) {
        if (error?.name === "OfflineGrantIssuanceError")
          return sendJson(response, 503, { error: error.code });
        return sendJson(response, 503, {
          error: "OFFLINE_GRANT_ISSUANCE_UNAVAILABLE",
        });
      }
    }

    const offlineCollectionRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/offline-collection-events$/.exec(
        request.url ?? "",
      );
    if (offlineCollectionRoute) {
      if (request.method !== "POST")
        return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      if (!hasAllowedOrigin(request, origins))
        return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      const auth = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!auth.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      if (auth.session.passwordChangeRequired)
        return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });
      const companyId = offlineCollectionRoute[1];
      if (!isUuid(companyId))
        return sendJson(response, 400, { error: "INVALID_COMPANY_ID" });

      let bundle;
      try {
        bundle = await readJson(request, MAX_OFFLINE_BUNDLE_BYTES);
      } catch (error) {
        return sendJson(response, bodyErrorStatus(error), {
          error: bodyErrorCode(error),
        });
      }
      const record = validateSingleOfflineBundleRecord(bundle, companyId);
      if (!record)
        return sendJson(response, 400, {
          error: "INVALID_OFFLINE_COLLECTION_BUNDLE",
        });
      try {
        assertOfflineCaptureBindings(bundle);
      } catch {
        return sendJson(response, 400, {
          error: "OFFLINE_IDENTITY_BINDING_INVALID",
        });
      }

      const { event, identity_binding: binding, device_proof: proof } = record;
      let grantResolution;
      try {
        const resolutionResponse = await fetchImpl(
          new URL("rpc/resolve_offline_capture_grant_v2", restBase),
          {
            method: "POST",
            headers: {
              ...userHeaders(publishableKey, auth.session).headers,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              p_grant_id: binding.grant_id,
              p_company_id: companyId,
              p_subject_user_id: binding.subject_user_id,
              p_device_id: event.device_id,
              p_site_id: event.site_id,
              p_house_id: event.house_id,
              p_lot_id: event.lot_id,
            }),
          },
        );
        if (!resolutionResponse.ok) {
          const error = await resolutionResponse.json().catch(() => ({}));
          if (error.code === "42501")
            return sendJson(response, 403, {
              error: "OFFLINE_RECEIPT_FORBIDDEN",
            });
          return sendJson(response, 503, {
            error: "OFFLINE_GRANT_REGISTRY_UNAVAILABLE",
          });
        }
        grantResolution = await resolutionResponse.json();
      } catch {
        return sendJson(response, 503, {
          error: "OFFLINE_GRANT_REGISTRY_UNAVAILABLE",
        });
      }

      let proofStatus = "unresolved";
      let proofErrorCode = null;
      if (
        grantResolution.registry_status !== "not_found" &&
        grantResolution.registry_status !== "scope_mismatch" &&
        typeof grantResolution.device_key_thumbprint === "string"
      ) {
        const grant = grantFromRegistryResolution(grantResolution, now());
        try {
          await verifyOfflineDeviceEventProof(proof, event, grant, {
            now: new Date(now()),
          });
          proofStatus = "verified";
        } catch (error) {
          proofStatus = "invalid";
          proofErrorCode = error?.code ?? "OFFLINE_DEVICE_PROOF_INVALID";
        }
      }

      if (
        proofStatus === "verified" &&
        grantResolution.registry_status === "registry_current_unverified"
      ) {
        if (!serviceRoleKey || !isLoopbackApi(authBase))
          return sendJson(response, 503, {
            error: "OFFLINE_RECEIPT_UNAVAILABLE",
          });
        try {
          const receiveResponse = await fetchImpl(
            new URL("rpc/receive_offline_collection_event", restBase),
            {
              method: "POST",
              headers: {
                apikey: serviceRoleKey,
                authorization: `Bearer ${serviceRoleKey}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({
                p_event: event,
                p_grant_id: binding.grant_id,
                p_subject_user_id: binding.subject_user_id,
                p_device_proof: proof,
                p_received_by_user_id: auth.session.userId,
              }),
            },
          );
          if (receiveResponse.ok) {
            const receipt = await receiveResponse.json();
            return sendJson(
              response,
              200,
              await bindCollectionReceipt(
                receipt,
                record,
                auth.session.userId,
                {
                  identity_status: "verified",
                  registry_status: grantResolution.registry_status,
                },
              ),
            );
          }
          const error = await receiveResponse.json().catch(() => ({}));
          if (error.code === "42501")
            return quarantineOfflineCollectionEvent({
              response,
              restBase,
              serviceRoleKey,
              authSession: auth.session,
              event,
              binding,
              proof,
              proofStatus,
              grantStatus: grantResolution.registry_status,
              reason: "receiver_capture_forbidden",
              fetchImpl,
              authBase,
            });
          if (error.code === "23505")
            return quarantineOfflineCollectionEvent({
              response,
              restBase,
              serviceRoleKey,
              authSession: auth.session,
              event,
              binding,
              proof,
              proofStatus,
              grantStatus: grantResolution.registry_status,
              reason: "collection_occurrence_conflict",
              fetchImpl,
              authBase,
            });
          if (error.code === "22023")
            return quarantineOfflineCollectionEvent({
              response,
              restBase,
              serviceRoleKey,
              authSession: auth.session,
              event,
              binding,
              proof,
              proofStatus,
              grantStatus: grantResolution.registry_status,
              reason: "collection_event_conflict",
              fetchImpl,
              authBase,
            });
          if (error.code === "23503")
            return sendJson(response, 409, {
              error: "COLLECTION_TARGET_UNAVAILABLE",
            });
          return sendJson(response, 503, {
            error: "COLLECTION_RECEIPT_UNAVAILABLE",
          });
        } catch {
          return sendJson(response, 503, {
            error: "COLLECTION_RECEIPT_UNAVAILABLE",
          });
        }
      }

      const reason = quarantineReason(
        grantResolution.registry_status,
        proofStatus,
        proofErrorCode,
      );
      return quarantineOfflineCollectionEvent({
        response,
        restBase,
        serviceRoleKey,
        authSession: auth.session,
        event,
        binding,
        proof,
        proofStatus,
        grantStatus: grantResolution.registry_status,
        reason,
        fetchImpl,
        authBase,
      });
    }

    const identityProvisioningRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/identities(?:\/provisionings\/([0-9a-f-]+)\/acknowledge|\/provisionings\/pending)?$/.exec(
        request.url ?? "",
      );
    if (identityProvisioningRoute) {
      const auth = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!auth.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      if (auth.session.passwordChangeRequired)
        return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });
      if (request.method !== "GET" && !hasAllowedOrigin(request, origins))
        return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      if (!serviceRoleKey)
        return sendJson(response, 503, { error: "IDENTITY_ADMIN_UNAVAILABLE" });
      if (!isLoopbackApi(authBase))
        return sendJson(response, 503, { error: "IDENTITY_ADMIN_UNAVAILABLE" });
      const companyId = identityProvisioningRoute[1];
      const operationId = identityProvisioningRoute[2];
      if (!isUuid(companyId) || (operationId && !isUuid(operationId)))
        return sendJson(response, 400, { error: "INVALID_RESOURCE_ID" });
      if (
        request.method === "GET" &&
        request.url.endsWith("/provisionings/pending")
      ) {
        try {
          const authorization = await fetchImpl(
            new URL("rpc/authorize_company_identity_creation", restBase),
            {
              method: "POST",
              headers: {
                ...userHeaders(publishableKey, auth.session).headers,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                p_company_id: companyId,
                p_role_key: "capture",
              }),
            },
          );
          if (!authorization.ok || (await authorization.json()) !== true)
            return sendJson(response, 403, {
              error: "IDENTITY_CREATION_FORBIDDEN",
            });
          const pending = sessions.listPendingProvisionings(
            auth.session.userId,
            companyId,
          );
          return sendJson(
            response,
            200,
            pending.map((item) => ({
              operation_id: item.operationId,
              email: item.email,
              role_key: item.roleKey,
              user_id: item.userId,
              membership_id: item.membershipId,
              temporary_password: item.temporaryPassword,
            })),
          );
        } catch {
          return sendJson(response, 503, {
            error: "PROVISIONING_RECOVERY_UNAVAILABLE",
          });
        }
      }
      if (request.method !== "POST")
        return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });

      if (operationId) {
        const consumed = sessions.consumeProvisioning(
          operationId,
          auth.session.userId,
        );
        return consumed
          ? sendJson(response, 200, { credential_discarded: true })
          : sendJson(response, 404, { error: "PROVISIONING_NOT_FOUND" });
      }

      const idempotencyKey = request.headers["idempotency-key"];
      if (!isUuid(idempotencyKey))
        return sendJson(response, 400, { error: "IDEMPOTENCY_KEY_REQUIRED" });
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        return sendJson(response, bodyErrorStatus(error), {
          error: bodyErrorCode(error),
        });
      }
      const email = normalizeEmail(body?.email);
      if (!email || !isRoleKey(body?.role_key) || body.role_key === "director")
        return sendJson(response, 400, { error: "INVALID_IDENTITY_INPUT" });

      let task = provisioningTasks.get(idempotencyKey);
      if (!task) {
        task = provisionIdentity({
          operationId: idempotencyKey,
          actorUserId: auth.session.userId,
          companyId,
          email,
          roleKey: body.role_key,
          actorAccessToken: auth.session.accessToken,
          restBase,
          authBase,
          publishableKey,
          serviceRoleKey,
          sessions,
          fetchImpl,
          now,
        });
        provisioningTasks.set(idempotencyKey, task);
        task
          .finally(() => provisioningTasks.delete(idempotencyKey))
          .catch(() => {});
      }
      const result = await task;
      return sendJson(response, result.status, result.body);
    }

    const membershipRoute =
      /^\/v1\/companies\/([0-9a-f-]+)\/memberships(?:\/([0-9a-f-]+))?$/.exec(
        request.url ?? "",
      );
    if (membershipRoute) {
      const auth = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!auth.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      const companyId = membershipRoute[1];
      const membershipId = membershipRoute[2];
      if (auth.session.passwordChangeRequired)
        return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });
      if (!isUuid(companyId) || (membershipId && !isUuid(membershipId)))
        return sendJson(response, 400, { error: "INVALID_RESOURCE_ID" });

      if (request.method === "GET" && !membershipId)
        return listCompanyMemberships(
          response,
          restBase,
          publishableKey,
          auth.session,
          companyId,
          fetchImpl,
        );

      if (request.method === "POST" && !membershipId) {
        if (!hasAllowedOrigin(request, origins))
          return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
        let body;
        try {
          body = await readJson(request);
        } catch (error) {
          return sendJson(response, bodyErrorStatus(error), {
            error: bodyErrorCode(error),
          });
        }
        if (
          !isRecord(body) ||
          !isUuid(body.user_id) ||
          !isRoleKey(body.role_key)
        )
          return sendJson(response, 400, { error: "INVALID_MEMBERSHIP_INPUT" });
        return manageMembership(
          response,
          restBase,
          publishableKey,
          auth.session,
          {
            p_company_id: companyId,
            p_user_id: body.user_id,
            p_membership_id: null,
            p_action: "invite",
            p_role_key: body.role_key,
          },
          fetchImpl,
        );
      }

      if (request.method === "PATCH" && membershipId) {
        if (!hasAllowedOrigin(request, origins))
          return sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
        let body;
        try {
          body = await readJson(request);
        } catch (error) {
          return sendJson(response, bodyErrorStatus(error), {
            error: bodyErrorCode(error),
          });
        }
        const roleActions = new Set(["assign_role", "revoke_role"]);
        if (
          !isRecord(body) ||
          ![
            "accept",
            "suspend",
            "reactivate",
            "revoke",
            ...roleActions,
          ].includes(body.action) ||
          (roleActions.has(body.action) && !isRoleKey(body.role_key)) ||
          (!roleActions.has(body.action) && body.role_key !== undefined)
        )
          return sendJson(response, 400, {
            error: "INVALID_MEMBERSHIP_ACTION",
          });
        return manageMembership(
          response,
          restBase,
          publishableKey,
          auth.session,
          {
            p_company_id: companyId,
            p_user_id: null,
            p_membership_id: membershipId,
            p_action: body.action,
            p_role_key: body.role_key ?? null,
          },
          fetchImpl,
        );
      }
      return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    }

    if (
      request.method === "GET" &&
      /^\/v1\/companies\/([0-9a-f-]+)\/operational-catalog$/i.test(
        request.url ?? "",
      )
    ) {
      const result = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!result.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      if (result.session.passwordChangeRequired)
        return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });

      const [, companyId] = request.url.match(
        /^\/v1\/companies\/([0-9a-f-]+)\/operational-catalog$/i,
      );
      if (!isUuid(companyId))
        return sendJson(response, 400, { error: "INVALID_COMPANY_ID" });

      try {
        const company = await fetchScopedRows(
          "companies",
          "id,code,legal_name,status",
          { id: `eq.${companyId}` },
          result.session.accessToken,
          restBase,
          publishableKey,
          fetchImpl,
        );
        if (!company.ok)
          return sendJson(response, 503, {
            error: "OPERATIONAL_CATALOG_UNAVAILABLE",
          });
        if (company.rows.length === 0)
          return sendJson(response, 404, { error: "COMPANY_NOT_FOUND" });

        const [sites, houses, lots] = await Promise.all([
          fetchScopedRows(
            "sites",
            "id,code,name,status",
            { company_id: `eq.${companyId}`, status: "eq.active" },
            result.session.accessToken,
            restBase,
            publishableKey,
            fetchImpl,
          ),
          fetchScopedRows(
            "houses",
            "id,site_id,code,name,status",
            { company_id: `eq.${companyId}`, status: "eq.active" },
            result.session.accessToken,
            restBase,
            publishableKey,
            fetchImpl,
          ),
          fetchScopedRows(
            "lots",
            "id,site_id,house_id,code,status",
            {
              company_id: `eq.${companyId}`,
              status: "eq.active",
            },
            result.session.accessToken,
            restBase,
            publishableKey,
            fetchImpl,
          ),
        ]);
        if (![sites, houses, lots].every((table) => table.ok))
          return sendJson(response, 503, {
            error: "OPERATIONAL_CATALOG_UNAVAILABLE",
          });

        return sendJson(response, 200, {
          company: company.rows[0],
          sites: sites.rows,
          houses: houses.rows,
          lots: lots.rows,
        });
      } catch {
        return sendJson(response, 503, {
          error: "OPERATIONAL_CATALOG_UNAVAILABLE",
        });
      }
    }

    if (
      request.method === "GET" &&
      /^\/v1\/companies(?:\/[0-9a-f-]+)?$/i.test(request.url ?? "")
    ) {
      const result = await getAuthenticatedSession(
        request,
        authBase,
        publishableKey,
        sessions,
        fetchImpl,
        now,
      );
      if (!result.session)
        return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
      if (result.session.passwordChangeRequired)
        return sendJson(response, 403, { error: "PASSWORD_CHANGE_REQUIRED" });

      const route = new URL(request.url, "http://local.invalid");
      const companyId = route.pathname.split("/")[3];
      if (
        companyId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          companyId,
        )
      )
        return sendJson(response, 400, { error: "INVALID_COMPANY_ID" });

      const target = new URL("companies", restBase);
      target.searchParams.set("select", "id,code,legal_name,status");
      if (companyId) target.searchParams.set("id", `eq.${companyId}`);

      try {
        const companyResponse = await fetchImpl(target, {
          headers: {
            apikey: publishableKey,
            authorization: `Bearer ${result.session.accessToken}`,
            accept: "application/json",
          },
        });
        if (!companyResponse.ok)
          return sendJson(response, 503, {
            error: "COMPANY_DIRECTORY_UNAVAILABLE",
          });
        const companies = await companyResponse.json();
        if (companyId && companies.length === 0)
          return sendJson(response, 404, { error: "COMPANY_NOT_FOUND" });
        return sendJson(response, 200, companies);
      } catch {
        return sendJson(response, 503, {
          error: "COMPANY_DIRECTORY_UNAVAILABLE",
        });
      }
    }

    return sendJson(response, 404, { error: "NOT_FOUND" });
  });
  server.once("close", () => sessions.close());
  sessions.pruneExpired();
  return server;
}

async function getAuthenticatedSession(
  request,
  authBase,
  publishableKey,
  sessions,
  fetchImpl,
  now,
) {
  const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (!sessionId) return {};
  const key = hashSessionId(sessionId);
  let session = safeGetSession(sessions, key);
  if (!session) return {};
  session.sessionHash = key;
  session.store = sessions;
  if (now() >= session.expiresAt) {
    sessions.revoke(key);
    return {};
  }

  if (session.accessExpiresAt - now() <= ACCESS_TOKEN_REFRESH_MARGIN_MS) {
    try {
      let refreshPromise = sessions.refreshing.get(key);
      if (!refreshPromise) {
        refreshPromise = refreshSession(
          session,
          authBase,
          publishableKey,
          fetchImpl,
          now,
        );
        sessions.refreshing.set(key, refreshPromise);
        refreshPromise
          .finally(() => sessions.refreshing.delete(key))
          .catch(() => {});
      }
      await refreshPromise;
      session = safeGetSession(sessions, key);
      if (!session) return {};
      session.sessionHash = key;
      session.store = sessions;
    } catch {
      sessions.revoke(key);
      return {};
    }
  }

  try {
    const userResponse = await fetchImpl(new URL("user", authBase), {
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${session.accessToken}`,
      },
    });
    if (!userResponse.ok) {
      sessions.revoke(key);
      return {};
    }
    const user = await userResponse.json();
    if (user.id !== session.userId) {
      sessions.revoke(key);
      return {};
    }
    session.email = user.email;
    const appMetadata = isRecord(user.app_metadata) ? user.app_metadata : {};
    session.appMetadata = appMetadata;
    session.passwordChangeRequired =
      appMetadata.tamago_initial_access_state === "pending";
    session.temporaryPasswordDigest =
      typeof appMetadata.tamago_initial_password_sha256 === "string"
        ? appMetadata.tamago_initial_password_sha256
        : null;
    return { session };
  } catch {
    return {};
  }
}

async function refreshSession(
  session,
  authBase,
  publishableKey,
  fetchImpl,
  now,
) {
  const response = await fetchImpl(
    new URL("token?grant_type=refresh_token", authBase),
    {
      method: "POST",
      headers: {
        apikey: publishableKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    },
  );
  if (!response.ok) throw new Error("session refresh failed");
  const refreshed = await response.json();
  if (
    typeof refreshed.access_token !== "string" ||
    typeof refreshed.refresh_token !== "string"
  )
    throw new Error("invalid refresh response");
  session.accessToken = refreshed.access_token;
  session.refreshToken = refreshed.refresh_token;
  session.accessExpiresAt = now() + Number(refreshed.expires_in ?? 3600) * 1000;
  session.store.saveTokens(session);
}

async function fetchScopedRows(
  table,
  select,
  filters,
  accessToken,
  restBase,
  publishableKey,
  fetchImpl,
) {
  const target = new URL(table, restBase);
  target.searchParams.set("select", select);
  for (const [key, value] of Object.entries(filters))
    target.searchParams.set(key, value);
  const response = await fetchImpl(target, {
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (!response.ok) return { ok: false, rows: [] };
  const rows = await response.json();
  return { ok: Array.isArray(rows), rows: Array.isArray(rows) ? rows : [] };
}

async function provisionIdentity({
  operationId,
  actorUserId,
  companyId,
  email,
  roleKey,
  actorAccessToken,
  restBase,
  authBase,
  publishableKey,
  serviceRoleKey,
  sessions,
  fetchImpl,
  now,
}) {
  let provisioning;
  try {
    provisioning = sessions.getProvisioning(operationId, actorUserId);
  } catch {
    return { status: 503, body: { error: "PROVISIONING_STORE_UNAVAILABLE" } };
  }
  if (provisioning) {
    if (
      provisioning.companyId !== companyId ||
      provisioning.email !== email ||
      provisioning.roleKey !== roleKey
    )
      return { status: 409, body: { error: "IDEMPOTENCY_KEY_REUSED" } };
    if (provisioning.status === "complete")
      return {
        status: 200,
        body: {
          operation_id: operationId,
          user_id: provisioning.userId,
          membership_id: provisioning.membershipId,
          temporary_password: provisioning.temporaryPassword,
          credential_recoverable: Boolean(provisioning.temporaryPassword),
        },
      };
    if (provisioning.status === "acknowledged")
      return {
        status: 200,
        body: {
          operation_id: operationId,
          user_id: provisioning.userId,
          membership_id: provisioning.membershipId,
          credential_recoverable: false,
        },
      };
    if (provisioning.status !== "prepared")
      return {
        status: 409,
        body: { error: "PROVISIONING_REQUIRES_RECOVERY" },
      };
  } else {
    let password;
    try {
      password = randomBytes(24).toString("base64url");
      sessions.createProvisioning({
        operationId,
        actorUserId,
        companyId,
        email,
        roleKey,
        temporaryPassword: password,
        now: now(),
      });
      provisioning = sessions.getProvisioning(operationId, actorUserId);
    } catch {
      return { status: 503, body: { error: "PROVISIONING_STORE_UNAVAILABLE" } };
    }
  }

  try {
    const authorization = await fetchImpl(
      new URL("rpc/authorize_company_identity_creation", restBase),
      {
        method: "POST",
        headers: {
          apikey: publishableKey,
          authorization: `Bearer ${actorAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ p_company_id: companyId, p_role_key: roleKey }),
      },
    );
    if (!authorization.ok)
      return { status: 403, body: { error: "IDENTITY_CREATION_FORBIDDEN" } };
    const authorized = await authorization.json();
    if (authorized !== true)
      return { status: 403, body: { error: "IDENTITY_CREATION_FORBIDDEN" } };
  } catch {
    return {
      status: 503,
      body: { error: "IDENTITY_AUTHORIZATION_UNAVAILABLE" },
    };
  }

  return createIdentityAndMembership({
    operationId,
    companyId,
    email,
    roleKey,
    actorAccessToken,
    provisioning,
    authBase,
    restBase,
    publishableKey,
    serviceRoleKey,
    sessions,
    fetchImpl,
    now,
  });
}

async function createIdentityAndMembership({
  operationId,
  companyId,
  email,
  roleKey,
  actorAccessToken,
  provisioning,
  authBase,
  restBase,
  publishableKey,
  serviceRoleKey,
  sessions,
  fetchImpl,
  now,
}) {
  if (provisioning.status !== "prepared")
    return { status: 409, body: { error: "PROVISIONING_REQUIRES_RECOVERY" } };
  let createdUser;
  try {
    const response = await fetchImpl(new URL("admin/users", authBase), {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email,
        password: provisioning.temporaryPassword,
        email_confirm: true,
        app_metadata: {
          tamago_initial_access_state: "pending",
          tamago_initial_password_sha256: createHash("sha256")
            .update(provisioning.temporaryPassword)
            .digest("hex"),
        },
      }),
    });
    if (!response.ok) {
      sessions.markProvisioningFailed(operationId, "recovery_required");
      return {
        status: response.status === 422 ? 409 : 503,
        body: {
          error:
            response.status === 422
              ? "IDENTITY_EMAIL_ALREADY_EXISTS_OR_REJECTED"
              : "IDENTITY_CREATION_UNAVAILABLE",
        },
      };
    }
    const result = await response.json();
    createdUser = result.user ?? result;
    if (!isUuid(createdUser.id)) {
      sessions.markProvisioningFailed(operationId, "recovery_required");
      return { status: 503, body: { error: "AUTH_PROVIDER_RESPONSE_INVALID" } };
    }
  } catch {
    sessions.markProvisioningFailed(operationId, "recovery_required");
    return { status: 503, body: { error: "IDENTITY_CREATION_UNCERTAIN" } };
  }

  try {
    sessions.updateProvisioning(operationId, {
      status: "identity_created",
      userId: createdUser.id,
      now: now(),
    });
  } catch {
    sessions.markProvisioningFailed(operationId, "recovery_required");
    return { status: 503, body: { error: "PROVISIONING_RECOVERY_REQUIRED" } };
  }

  let membership;
  try {
    const response = await fetchImpl(
      new URL("rpc/manage_company_membership", restBase),
      {
        method: "POST",
        headers: {
          apikey: publishableKey,
          authorization: `Bearer ${actorAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_company_id: companyId,
          p_user_id: createdUser.id,
          p_membership_id: null,
          p_action: "invite",
          p_role_key: roleKey,
        }),
      },
    );
    if (!response.ok) {
      const cleaned = await deleteCreatedIdentity(
        authBase,
        serviceRoleKey,
        createdUser.id,
        fetchImpl,
      );
      sessions.markProvisioningFailed(
        operationId,
        cleaned ? "failed" : "recovery_required",
      );
      return {
        status: response.status === 403 ? 403 : 503,
        body: {
          error: cleaned
            ? "MEMBERSHIP_CREATION_FAILED"
            : "PROVISIONING_RECOVERY_REQUIRED",
        },
      };
    }
    membership = await response.json();
    if (!isUuid(membership.membership_id))
      throw new Error("membership response invalid");
  } catch {
    const cleaned = await deleteCreatedIdentity(
      authBase,
      serviceRoleKey,
      createdUser.id,
      fetchImpl,
    );
    sessions.markProvisioningFailed(
      operationId,
      cleaned ? "failed" : "recovery_required",
    );
    return {
      status: 503,
      body: {
        error: cleaned
          ? "MEMBERSHIP_CREATION_FAILED"
          : "PROVISIONING_RECOVERY_REQUIRED",
      },
    };
  }

  try {
    sessions.updateProvisioning(operationId, {
      status: "complete",
      userId: createdUser.id,
      membershipId: membership.membership_id,
      now: now(),
    });
  } catch {
    return { status: 503, body: { error: "PROVISIONING_RECOVERY_REQUIRED" } };
  }
  return {
    status: 201,
    body: {
      operation_id: operationId,
      user_id: createdUser.id,
      membership_id: membership.membership_id,
      temporary_password: provisioning.temporaryPassword,
      credential_recoverable: true,
      email_confirmed_by_prototype: true,
    },
  };
}

async function deleteCreatedIdentity(
  authBase,
  serviceRoleKey,
  userId,
  fetchImpl,
) {
  try {
    const response = await fetchImpl(
      new URL(`admin/users/${userId}`, authBase),
      {
        method: "DELETE",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
        },
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function listCompanyMemberships(
  response,
  restBase,
  publishableKey,
  session,
  companyId,
  fetchImpl,
) {
  try {
    const membershipsUrl = new URL("company_memberships", restBase);
    membershipsUrl.searchParams.set(
      "select",
      "id,user_id,status,valid_from,valid_until,created_at",
    );
    membershipsUrl.searchParams.set("company_id", `eq.${companyId}`);
    membershipsUrl.searchParams.set("order", "created_at.asc");
    const membershipsResponse = await fetchImpl(
      membershipsUrl,
      userHeaders(publishableKey, session),
    );
    if (!membershipsResponse.ok)
      return sendJson(response, 403, { error: "MEMBERSHIP_ACCESS_DENIED" });
    const memberships = await membershipsResponse.json();
    if (!memberships.length) return sendJson(response, 200, []);

    const rolesUrl = new URL("role_assignments", restBase);
    rolesUrl.searchParams.set(
      "select",
      "id,membership_id,role_key,site_id,house_id,lot_id,granted_at,valid_until,revoked_at",
    );
    rolesUrl.searchParams.set("company_id", `eq.${companyId}`);
    rolesUrl.searchParams.set(
      "membership_id",
      `in.(${memberships.map(({ id }) => id).join(",")})`,
    );
    const rolesResponse = await fetchImpl(
      rolesUrl,
      userHeaders(publishableKey, session),
    );
    if (!rolesResponse.ok)
      return sendJson(response, 403, { error: "MEMBERSHIP_ACCESS_DENIED" });
    const roles = await rolesResponse.json();
    const rolesByMembership = new Map();
    for (const role of roles) {
      const current = rolesByMembership.get(role.membership_id) ?? [];
      current.push(role);
      rolesByMembership.set(role.membership_id, current);
    }
    return sendJson(
      response,
      200,
      memberships.map((membership) => ({
        ...membership,
        roles: rolesByMembership.get(membership.id) ?? [],
      })),
    );
  } catch {
    return sendJson(response, 503, {
      error: "MEMBERSHIP_DIRECTORY_UNAVAILABLE",
    });
  }
}

async function manageMembership(
  response,
  restBase,
  publishableKey,
  session,
  payload,
  fetchImpl,
) {
  try {
    const rpcUrl = new URL("rpc/manage_company_membership", restBase);
    const headers = {
      ...userHeaders(publishableKey, session).headers,
      "content-type": "application/json",
    };
    const rpcResponse = await fetchImpl(rpcUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (rpcResponse.ok)
      return sendJson(response, 200, await rpcResponse.json());
    const error = await rpcResponse.json().catch(() => ({}));
    if (error.code === "42501")
      return sendJson(response, 403, { error: "MEMBERSHIP_ACTION_FORBIDDEN" });
    if (error.code === "23505")
      return sendJson(response, 409, { error: "MEMBERSHIP_ALREADY_EXISTS" });
    if (error.code === "23503")
      return sendJson(response, 404, { error: "MEMBERSHIP_TARGET_NOT_FOUND" });
    if (error.code === "22023" || error.code === "P0001")
      return sendJson(response, 400, { error: "MEMBERSHIP_ACTION_INVALID" });
    return sendJson(response, 503, {
      error: "MEMBERSHIP_DIRECTORY_UNAVAILABLE",
    });
  } catch {
    return sendJson(response, 503, {
      error: "MEMBERSHIP_DIRECTORY_UNAVAILABLE",
    });
  }
}

function userHeaders(publishableKey, session) {
  return {
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${session.accessToken}`,
      accept: "application/json",
    },
  };
}

async function receiveCollectionEvent(
  response,
  restBase,
  publishableKey,
  session,
  event,
  fetchImpl,
) {
  try {
    const rpcResponse = await fetchImpl(
      new URL("rpc/receive_collection_event", restBase),
      {
        method: "POST",
        headers: {
          ...userHeaders(publishableKey, session).headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ p_event: event }),
      },
    );
    if (rpcResponse.ok)
      return sendJson(response, 200, await rpcResponse.json());
    const error = await rpcResponse.json().catch(() => ({}));
    if (error.code === "42501")
      return sendJson(response, 403, { error: "COLLECTION_CAPTURE_FORBIDDEN" });
    if (error.code === "23505")
      return sendJson(response, 409, {
        error: "COLLECTION_OCCURRENCE_CONFLICT",
      });
    if (error.code === "22023")
      return sendJson(response, 409, { error: "COLLECTION_EVENT_CONFLICT" });
    if (error.code === "23503")
      return sendJson(response, 404, { error: "COLLECTION_TARGET_NOT_FOUND" });
    return sendJson(response, 503, { error: "COLLECTION_RECEIPT_UNAVAILABLE" });
  } catch {
    return sendJson(response, 503, { error: "COLLECTION_RECEIPT_UNAVAILABLE" });
  }
}

function validateSingleOfflineBundleRecord(bundle, companyId) {
  if (
    !isRecord(bundle) ||
    Object.keys(bundle).sort().join(",") !== "format,records,schema_version" ||
    bundle.format !== "tamago.offline-collection-bundle" ||
    bundle.schema_version !== 1 ||
    !Array.isArray(bundle.records) ||
    bundle.records.length !== 1
  )
    return null;
  const [record] = bundle.records;
  if (
    !isRecord(record) ||
    Object.keys(record).sort().join(",") !==
      "delivery,device_proof,event,identity_binding" ||
    !isRecord(record.identity_binding) ||
    Object.keys(record.identity_binding).sort().join(",") !==
      "attribution_status,grant_id,subject_user_id" ||
    !isRecord(record.device_proof) ||
    Object.keys(record.device_proof).sort().join(",") !==
      "format,jws,schema_version" ||
    record.device_proof.format !== "tamago.offline-device-event-proof" ||
    record.device_proof.schema_version !== 1 ||
    typeof record.device_proof.jws !== "string" ||
    record.device_proof.jws.length < 1 ||
    record.device_proof.jws.length > 8192 ||
    !isRecord(record.delivery) ||
    Object.keys(record.delivery).join(",") !== "status" ||
    record.delivery.status !== "pending" ||
    !validateCollectionEventV2(record.event, companyId)
  )
    return null;
  return record;
}

function grantFromRegistryResolution(resolution, nowMilliseconds) {
  const expiresAt = Date.parse(resolution.expires_at);
  return {
    grant_id: resolution.grant_id,
    subject_user_id: resolution.subject_user_id,
    company_id: resolution.company_id,
    device_id: resolution.device_id,
    site_id: resolution.site_id,
    house_id: resolution.house_id,
    lot_id: resolution.lot_id,
    permission: resolution.permission,
    device_key_thumbprint: resolution.device_key_thumbprint,
    grant_state:
      Number.isFinite(expiresAt) && nowMilliseconds >= expiresAt
        ? "expired"
        : "current",
    signature_verified: true,
  };
}

function quarantineReason(registryStatus, proofStatus, proofErrorCode) {
  if (proofErrorCode === "OFFLINE_DEVICE_PROOF_SCOPE_MISMATCH")
    return "proof_scope_mismatch";
  if (proofStatus === "invalid") return "proof_invalid";
  if (registryStatus === "not_found") return "grant_missing";
  if (registryStatus === "scope_mismatch") return "proof_scope_mismatch";
  if (registryStatus === "revoked") return "grant_revoked";
  if (registryStatus === "expired") return "grant_expired";
  if (registryStatus === "not_yet_valid") return "grant_not_yet_valid";
  if (registryStatus === "authorization_no_longer_current")
    return "authorization_no_longer_current";
  return "proof_invalid";
}

async function quarantineOfflineCollectionEvent({
  response,
  restBase,
  serviceRoleKey,
  authSession,
  event,
  binding,
  proof,
  proofStatus,
  grantStatus,
  reason,
  fetchImpl,
  authBase,
}) {
  if (!serviceRoleKey || !isLoopbackApi(authBase))
    return sendJson(response, 503, { error: "OFFLINE_QUARANTINE_UNAVAILABLE" });
  try {
    const rpcResponse = await fetchImpl(
      new URL("rpc/quarantine_offline_collection_event", restBase),
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          p_event: event,
          p_identity_binding: binding,
          p_device_proof: proof,
          p_received_by_user_id: authSession.userId,
          p_proof_status: proofStatus,
          p_grant_status: grantStatus,
          p_quarantine_reason: reason,
        }),
      },
    );
    if (rpcResponse.ok) {
      const receipt = await rpcResponse.json();
      return sendJson(
        response,
        202,
        await bindCollectionReceipt(
          receipt,
          {
            event,
            identity_binding: binding,
            device_proof: proof,
            delivery: { status: "pending" },
          },
          authSession.userId,
          { identity_status: proofStatus },
        ),
      );
    }
    const error = await rpcResponse.json().catch(() => ({}));
    if (error.code === "42501")
      return sendJson(response, 403, { error: "OFFLINE_QUARANTINE_FORBIDDEN" });
    if (error.code === "22023")
      return sendJson(response, 409, { error: "OFFLINE_QUARANTINE_CONFLICT" });
    return sendJson(response, 503, { error: "OFFLINE_QUARANTINE_UNAVAILABLE" });
  } catch {
    return sendJson(response, 503, { error: "OFFLINE_QUARANTINE_UNAVAILABLE" });
  }
}

function safeGetSession(store, key) {
  try {
    return store.get(key);
  } catch {
    store.revoke(key);
    return null;
  }
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isRoleKey(value) {
  return [
    "capture",
    "warehouse",
    "director",
    "admin",
    "billing",
    "transport",
  ].includes(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  )
    return null;
  return email;
}

function isLoopbackApi(url) {
  return (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  );
}

function bodyErrorStatus(error) {
  return error.code === "BODY_TOO_LARGE"
    ? 413
    : error.code === "UNSUPPORTED_MEDIA_TYPE"
      ? 415
      : 400;
}

function bodyErrorCode(error) {
  return error.code === "BODY_TOO_LARGE"
    ? "BODY_TOO_LARGE"
    : error.code === "UNSUPPORTED_MEDIA_TYPE"
      ? "UNSUPPORTED_MEDIA_TYPE"
      : "INVALID_REQUEST";
}

function hasAllowedOrigin(request, origins) {
  return (
    typeof request.headers.origin === "string" &&
    origins.has(request.headers.origin)
  );
}

function sessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function hashSessionId(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readCookie(header = "", name) {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
  ) {
    const error = new Error("unsupported media type");
    error.code = "UNSUPPORTED_MEDIA_TYPE";
    throw error;
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      const error = new Error("body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("invalid JSON");
  }
}

function setBaseHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  response.setHeader("vary", "cookie, origin");
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}
