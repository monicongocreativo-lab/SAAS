import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixtureUsers,
  startPasswordIdentityFixture,
} from "./fixtures/password-identity-server.mjs";

test("password confirmation requires same authenticated account, origin and password, is rate-limited and cannot revive logout", async () => {
  const fixture = await startPasswordIdentityFixture();
  const user = fixtureUsers[0];
  const send = (path, body, cookie = "", origin = fixture.origin) =>
    fetch(`${fixture.gatewayUrl}${path}`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const login = await send("/v1/auth/login", {
      email: user.email,
      password: user.password,
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (await send("/v1/auth/confirm-password", { password: user.password }))
        .status,
      401,
    );
    assert.equal(
      (
        await send(
          "/v1/auth/confirm-password",
          { password: user.password },
          cookie,
          "https://other.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await send(
          "/v1/auth/confirm-password",
          { password: user.password, user_id: fixtureUsers[1].id },
          cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await send(
          "/v1/auth/confirm-password",
          { password: "incorrect-password" },
          cookie,
        )
      ).status,
      401,
    );
    const valid = await send(
      "/v1/auth/confirm-password",
      { password: user.password },
      cookie,
    );
    assert.deepEqual(await valid.json(), {
      user_id: user.id,
      password_confirmed: true,
    });
    assert.equal(
      fixture.state.providerEmails.every((email) => email === user.email),
      true,
    );
    fixture.state.mismatch = true;
    assert.equal(
      (
        await send(
          "/v1/auth/confirm-password",
          { password: user.password },
          cookie,
        )
      ).status,
      403,
    );
    fixture.state.mismatch = false;
    fixture.state.pending = true;
    assert.equal(
      (
        await send(
          "/v1/auth/confirm-password",
          { password: user.password },
          cookie,
        )
      ).status,
      403,
    );
    fixture.state.pending = false;
    fixture.state.now += 60_001;
    for (let count = 0; count < 5; count++)
      assert.equal(
        (
          await send(
            "/v1/auth/confirm-password",
            { password: "incorrect-password" },
            cookie,
          )
        ).status,
        401,
      );
    const limited = await send(
      "/v1/auth/confirm-password",
      { password: user.password },
      cookie,
    );
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    fixture.state.now += 60_001;
    let entered;
    let release;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    fixture.state.hold = () =>
      new Promise((resolve) => {
        release = resolve;
        entered();
      });
    const delayed = send(
      "/v1/auth/confirm-password",
      { password: user.password },
      cookie,
    );
    await started;
    assert.equal((await send("/v1/auth/logout", {}, cookie)).status, 204);
    release();
    assert.equal((await delayed).status, 401);
  } finally {
    await fixture.close();
  }
});
