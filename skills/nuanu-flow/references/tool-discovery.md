# Tool discovery and descriptor provenance

Read this for truncated searches or when implementing/debugging a connector's
descriptor cache. Normal execution follows the calling convention in the
`nuanu-flow` skill.

`search_tools` reports `totalMatches` before the requested limit and sets
`hasMore` when candidates were omitted. The maximum limit is 20; `hasMore` is
not a pagination cursor. Refine the action and entity query, preferably using
the canonical operation name. Summary candidates are not executable cached
descriptors; request `detail: "full"` to obtain the schema and `schemaDigest`.

Client and connector hosts isolate cached descriptors by connector ID,
endpoint origin, non-secret workspace/tenant selector digest, catalog
revision, schema digest, and operation name. A descriptor is current only
when those connection fields, `catalogRevision`, `schemaDigest`, and operation
name match. Never store or hash tokens or secret headers as cache identity.

A host may trust a release-bound plugin descriptor only when its connection
compatibility ID and all provenance fields above match. A skill's prose name
or example is not such a descriptor. Storage, lookup, invalidation, and
provenance enforcement belong to the client or connector host; the plugin
provides guidance and does not implement a second cache.

Search when a descriptor is absent or stale, or the caller explicitly requests
a refresh. After `catalog_revision_mismatch` or `unknown_operation`, refresh
once and retry at most once. Do not refresh for `validation_error`, business
or auth errors, transport failures, timeouts, or ambiguous post-dispatch
failures. Keep read operations on the read-only executor after refresh.
