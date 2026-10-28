// Child-process probe for a fictitious local store. Configuration arrives only
// through stdin; stdout contains no token, key, cookie or provider credential.
import { createHash } from "node:crypto";
import { SharedSessionStore } from "../../src/auth-prototype/shared-session-store.mjs";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 32768) throw new Error("Probe input too large");
}
const { configuration, sessionHash, accessDigest } = JSON.parse(input);
const store = new SharedSessionStore({
  ...configuration,
  encryptionKeys: Object.fromEntries(
    Object.entries(configuration.encryptionKeys).map(([id, key]) => [
      id,
      Buffer.from(key, "base64"),
    ]),
  ),
});
try {
  const session = await store.get(sessionHash);
  process.stdout.write(
    JSON.stringify({
      userId: session?.userId,
      revision: session?.revision,
      contentMatches: session
        ? createHash("sha256").update(session.accessToken).digest("hex") ===
          accessDigest
        : false,
    }),
  );
} finally {
  store.close();
}
