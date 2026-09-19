/**
 * Deterministic entity IDs — RFC 4122 version 5 UUIDs over the source keys.
 *
 * `source-keys.mts` gives every planned entity a key derived only from the
 * workbook hash and where in that workbook the entity sits. This module turns
 * such a key into the primary key the row is actually inserted under.
 *
 * Why this rather than `gen_random_uuid()`:
 *
 *   * **Retry safety.** A transport failure halfway through 1,013 payment
 *     inserts leaves an unknown number of rows behind. With random IDs the only
 *     honest recovery is to work out which rows landed and hand-repair; with
 *     derived IDs the same row is the same primary key, so re-running inserts
 *     it `on conflict do nothing` and converges on exactly one copy.
 *
 *   * **Relationships before insertion.** A payment needs its finance record's
 *     ID, which needs its student's. Deriving all three from source keys lets
 *     the whole graph be built in memory, in one pass, without reading back a
 *     generated ID per row.
 *
 * Version 5 (SHA-1) rather than version 4: v5 is *defined* as a hash of a
 * namespace and a name, which is precisely the mapping wanted here, and the
 * result is a valid, correctly versioned PostgreSQL `uuid` that a reader can
 * recompute from the source key to check it. SHA-1 is used here as RFC 4122
 * specifies it — as a name-to-identifier mapping, not as a security primitive.
 *
 * The namespace is derived from the standard DNS namespace so it is auditable
 * rather than a magic constant, and `deterministic-ids.test.mts` pins the
 * literal value: if this derivation ever changes, every ID in the database
 * would change with it, and the test fails rather than letting that happen
 * quietly.
 *
 * Nothing here logs. A source key can contain a student number, so keys go in
 * and UUIDs come out with no I/O in between.
 */

import { createHash } from 'node:crypto'

/** The RFC 4122 DNS namespace, used only to derive this project's namespace. */
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

/**
 * The name this project's namespace is derived from.
 *
 * Changing this string re-keys every entity the importer has ever created. It
 * is a permanent part of the data's identity, not a label.
 */
export const NAMESPACE_NAME = 'finance-import.toronto-academy-of-education'

function parseUuid(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  const bytes = new Uint8Array(16)
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * RFC 4122 §4.3 version 5 UUID.
 *
 * SHA-1 of the namespace bytes followed by the UTF-8 name; the first 16 bytes
 * of the digest, with the version and variant fields overwritten as the spec
 * requires. Overwriting those six bits is what makes the result a *valid* v5
 * UUID rather than a truncated hash that merely looks like one.
 */
export function uuidV5(name: string, namespace: string): string {
  const digest = createHash('sha1')
    .update(parseUuid(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest()

  const bytes = new Uint8Array(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant

  return formatUuid(bytes)
}

/**
 * This project's namespace: `uuidV5(NAMESPACE_NAME, DNS_NAMESPACE)`.
 *
 * Computed rather than pasted so the derivation is visible in the code that
 * depends on it.
 */
export const IMPORT_NAMESPACE = uuidV5(NAMESPACE_NAME, DNS_NAMESPACE)

/**
 * The database ID for a planned entity, from its deterministic source key.
 *
 * The source key already carries the workbook hash and the entity kind, so no
 * further namespacing is needed here: distinct source keys give distinct IDs,
 * and the same source key always gives the same ID.
 */
export function entityId(sourceKey: string): string {
  return uuidV5(sourceKey, IMPORT_NAMESPACE)
}

/** Matches a canonical lower-case v5 UUID with the RFC 4122 variant. */
export const UUID_V5_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
