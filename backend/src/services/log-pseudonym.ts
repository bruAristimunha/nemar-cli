/**
 * A keyed pseudonym for a value a log line must not carry in the clear (#1713).
 *
 * The rate limiter's observe-only warning used to log `hashIp(key)`, a plain SHA-256.
 * An IPv4 address hashed that way is recovered by hashing all 2^32 of them, so the
 * field kept nothing private; a `site:<address>` key (ADR 0098) is no harder. A log
 * line needs only to tell one caller from another, so it gets an HMAC-SHA-256 of the
 * value under a key nobody reading the log holds.
 *
 * The key is derived from `ENCRYPTION_KEY`, an existing Worker secret, with
 * HKDF-SHA-256 (RFC 5869: empty salt, info {@link LOG_PSEUDONYM_INFO}). No new secret
 * is needed, and the derivation keeps this use apart from the secret's others: it
 * also keys the emailed sign-in codes' HMAC, signs the ORCID state and pending-signup
 * tokens, and is the passphrase the stored AWS credentials are encrypted under. HKDF's
 * output is independent of the secret as far as anyone without it can tell, so a log
 * pseudonym is never a signature, a code hash or a key any of those uses would accept,
 * and nothing that computes one of them can be made to compute a pseudonym. The label
 * carries a version so a change of construction is a change of label.
 *
 * The same value under the same secret gives the same pseudonym, so lines about one
 * caller can be put together, across deploys too for as long as the secret is
 * unchanged. Someone holding the secret can still enumerate addresses; the secret is
 * the boundary, as it is for the code hashes.
 *
 * With no secret (a test, or a Worker that was never given one) there is no pseudonym:
 * the caller leaves the field out. An unkeyed hash in its place would be the reversible value this exists
 * to remove, under a name that suggests otherwise.
 */

/** The HKDF `info` label. Never shared with another use of the secret. */
export const LOG_PSEUDONYM_INFO = "nemar/log-pseudonym/v1";

// One derived key per isolate. Deriving costs an import and an HKDF on every call
// otherwise, and the secret does not change for the life of a deploy. A derivation
// that fails is forgotten, so the next call tries again.
let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

function derivedKey(secret: string): Promise<CryptoKey> {
  if (cached?.secret === secret) return cached.key;
  const encoder = new TextEncoder();
  const key = crypto.subtle
    .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
    .then((base) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: encoder.encode(LOG_PSEUDONYM_INFO),
        },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      ),
    );
  const entry = { secret, key };
  cached = entry;
  key.catch(() => {
    if (cached === entry) cached = null;
  });
  return key;
}

/**
 * The pseudonym of `value` as 64 hex characters, or null when there is no secret to
 * key it with. Throws when the platform cannot derive or sign, like any other crypto
 * failure; the caller decides what that costs.
 */
export async function logPseudonym(
  secret: string | undefined,
  value: string,
): Promise<string | null> {
  if (!secret) return null;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await derivedKey(secret),
    new TextEncoder().encode(value),
  );
  const bytes = new Uint8Array(signature);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] as number).toString(16).padStart(2, "0");
  return out;
}
