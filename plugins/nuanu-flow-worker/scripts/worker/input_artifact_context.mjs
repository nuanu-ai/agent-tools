const MAX_REFERENCES = 12;
const MAX_CONTEXT_BYTES = 32 * 1024;
const SECRET_KEY = /(authorization|cookie|credential|password|secret|token)/i;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function artifactReference(value) {
  if (!isRecord(value)) return null;
  if (typeof value.artifact_id !== "string" || typeof value.version_id !== "string") return null;
  return {
    artifact_id: value.artifact_id,
    version_id: value.version_id,
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
}

export function collectInputArtifactReferences(value, limit = MAX_REFERENCES) {
  const found = [];
  const seen = new Set();
  const visit = (candidate) => {
    if (found.length >= limit) return;
    const reference = artifactReference(candidate);
    if (reference) {
      const key = `${reference.artifact_id}:${reference.version_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push(reference);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const entry of Object.values(candidate)) visit(entry);
  };
  visit(value);
  return found;
}

function safeValue(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 4000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => safeValue(entry, depth + 1));
  if (!isRecord(value)) return String(value || "").slice(0, 4000);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .slice(0, 100)
      .map(([key, entry]) => [key, safeValue(entry, depth + 1)])
  );
}

function exactVersion(artifact, versionId) {
  return (Array.isArray(artifact?.versions) ? artifact.versions : []).find(
    (version) => String(version?.id) === String(versionId)
  );
}

function structuredContext(reference, artifact) {
  const version = exactVersion(artifact, reference.version_id);
  const representation = version?.representation;
  if (!isRecord(representation) || representation.type !== "platform_entity") return null;
  return {
    reference,
    artifact: {
      name: String(artifact?.name || reference.name || "").slice(0, 500),
      kind: String(artifact?.kind || reference.kind || "").slice(0, 64),
      media_type: String(artifact?.mime_type || "").slice(0, 255),
    },
    representation: safeValue({
      type: representation.type,
      entityType: representation.entityType,
      entityId: representation.entityId,
      snapshot: representation.snapshot,
    }),
  };
}

/** Resolve immutable structured input Artifacts into a bounded prompt-side read model.
 *
 * File bodies and external URLs remain out of band. Only an exact referenced
 * platform-entity version is exposed, preserving the ProcessItem contract while
 * giving the agent the source record it was explicitly handed.
 */
export async function resolveStructuredInputArtifacts({ task, client }) {
  const references = collectInputArtifactReferences(task?.request?.input);
  const resolved = [];
  let bytes = 0;
  for (const reference of references) {
    try {
      const artifact = await client.getArtifact(task.workspace, reference.artifact_id);
      const context = structuredContext(reference, artifact);
      if (!context) continue;
      const size = Buffer.byteLength(JSON.stringify(context), "utf8");
      if (bytes + size > MAX_CONTEXT_BYTES) break;
      bytes += size;
      resolved.push(context);
    } catch {
      // The immutable reference remains in the declared Process inputs. Agents
      // can still use an authorized MCP reader; resolution is a safe convenience.
    }
  }
  return resolved;
}
