import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { TaskWorkspaceManager } from "./task_workspace.mjs";

export const PUBLISH_ARTIFACT_FILE_SPEC = {
  type: "function",
  name: "publish_artifact_file",
  description:
    "Publish one task-local file as an immutable Nuanu Flow Artifact. Use output_path for a declared Process output; omit it and provide role/kind for an optional Flow-item attachment such as QA evidence.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "name", "media_type"],
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "Path relative to NUANU_TASK_DIR, for example report.pdf. Absolute paths are rejected.",
      },
      name: { type: "string", minLength: 1, maxLength: 500 },
      output_path: { type: "string", minLength: 1, maxLength: 500 },
      media_type: { type: "string", minLength: 1, maxLength: 255 },
      role: { type: "string", enum: ["output", "implementation", "evidence", "source"] },
      kind: { type: "string", minLength: 1, maxLength: 50 },
    },
  },
  deferLoading: false,
};

const MIME_BY_EXTENSION = new Map([
  [".pdf", new Set(["application/pdf"])],
  [".png", new Set(["image/png"])],
  [".jpg", new Set(["image/jpeg"])],
  [".jpeg", new Set(["image/jpeg"])],
  [".gif", new Set(["image/gif"])],
  [".webp", new Set(["image/webp"])],
  [".svg", new Set(["image/svg+xml"])],
  [".mp3", new Set(["audio/mpeg"])],
  [".wav", new Set(["audio/wav", "audio/x-wav"])],
  [".ogg", new Set(["audio/ogg", "application/ogg"])],
  [".m4a", new Set(["audio/mp4", "audio/x-m4a"])],
  [".flac", new Set(["audio/flac", "audio/x-flac"])],
  [".txt", new Set(["text/plain"])],
  [".md", new Set(["text/markdown", "text/plain"])],
  [".json", new Set(["application/json"])],
  [".csv", new Set(["text/csv"])],
  [".zip", new Set(["application/zip"])],
]);

function fail(message, code = "artifact_verification_failed") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function declaredArtifactKind(task, outputPath) {
  const definition = task?.request?.output_definition || {};
  const direct = String(outputPath || "").match(/^item\.artifacts\.([a-z][a-z0-9_]*)$/);
  if (direct) return definition?.artifacts?.[direct[1]]?.kind || null;
  const nested = String(outputPath || "").match(
    /^item\.data\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\.artifacts\.([a-z][a-z0-9_]*)$/
  );
  if (!nested) return null;
  const field = definition?.data?.[nested[1]];
  if (field?.type !== "choices") return null;
  return field?.item?.artifacts?.[nested[3]]?.kind || null;
}

function refinementTarget(task, input) {
  const targets = task?.runtime_binding?.decision_refine?.artifact_targets;
  if (!Array.isArray(targets)) return null;
  const matches = targets.filter(
    (target) => target?.kind === input.kind && (!target?.role || target.role === input.role)
  );
  if (matches.length > 1) {
    throw fail("Artifact refinement target is ambiguous", "invalid_output");
  }
  return matches[0] || null;
}

function validateInput(task, input) {
  for (const key of ["path", "name", "media_type"]) {
    if (typeof input?.[key] !== "string" || !input[key].trim()) {
      throw fail(`publish_artifact_file requires ${key}`, "invalid_input");
    }
  }
  if (input.name !== path.basename(input.name) || input.name.length > 500) {
    throw fail("Artifact name must be a plain filename", "invalid_input");
  }
  const outputPath = String(input.output_path || "").trim();
  const requestedRole = String(input.role || "").trim();
  const requestedKind = String(input.kind || "").trim();
  let kind;
  let role;
  let links = [];
  let scope;
  if (outputPath) {
    kind = declaredArtifactKind(task, outputPath);
    if (!kind) throw fail(`Artifact output path ${outputPath} is not declared by this task`, "invalid_output");
    if (requestedRole && requestedRole !== "output") {
      throw fail("Declared Process Artifact outputs must use role output", "invalid_output");
    }
    if (requestedKind && requestedKind !== kind) {
      throw fail(`Artifact kind must match the declared kind ${kind}`, "invalid_output");
    }
    role = "output";
    scope = "run";
  } else {
    const workItemId = String(task?.runtime_binding?.source_work_item_id || "").trim();
    if (!workItemId) {
      throw fail("Optional Artifact attachments require a source Flow item", "invalid_output");
    }
    if (!["implementation", "evidence", "source"].includes(requestedRole) || !requestedKind) {
      throw fail("Optional Artifact attachments require an explicit role and kind", "invalid_input");
    }
    kind = requestedKind;
    role = requestedRole;
    scope = "project";
    links = [{ entity_type: "work_item", entity_id: workItemId, relation: "about" }];
  }
  const mediaType = input.media_type.toLowerCase();
  const expected = MIME_BY_EXTENSION.get(path.extname(input.name).toLowerCase());
  if (expected && !expected.has(mediaType)) {
    throw fail(`Artifact media type does not match filename extension`, "invalid_input");
  }
  if (role === "evidence" && kind === "screenshot" && !["image/png", "image/jpeg", "image/webp"].includes(mediaType)) {
    throw fail("Screenshot evidence must be PNG, JPEG, or WebP", "invalid_input");
  }
  return { kind, role, outputPath, links, scope };
}

function versionFromReadback(artifact, versionId) {
  return (Array.isArray(artifact?.versions) ? artifact.versions : []).find(
    (version) => String(version?.id) === String(versionId)
  );
}

function verifyReadback({ artifact, artifactId, versionId, size, checksum, input }) {
  const version = versionFromReadback(artifact, versionId);
  const valid =
    String(artifact?.id) === String(artifactId) &&
    artifact?.status === "stored" &&
    String(artifact?.current_version) === String(versionId) &&
    artifact?.kind === input.kind &&
    artifact?.name === input.name &&
    artifact?.mime_type === input.media_type &&
    version?.file_asset &&
    Number(version?.size) === size &&
    version?.checksum === checksum;
  if (!valid) throw fail("Artifact read-back verification failed");
}

export function createArtifactPublisher({
  task,
  taskRoot,
  client,
  maxBytes = 5 * 1024 * 1024,
  workspaces = new TaskWorkspaceManager({ root: path.dirname(taskRoot) }),
  onPhase = () => {},
}) {
  if (!taskRoot || !client) throw new Error("Artifact publisher requires taskRoot and client");
  const verifiedPublications = new Map();
  return {
    spec: PUBLISH_ARTIFACT_FILE_SPEC,
    async call(input) {
      const { kind, role, outputPath, links, scope } = validateInput(task, input);
      const artifactInput = { ...input, output_path: outputPath, kind, role };
      let resolved;
      try {
        resolved = await workspaces.resolveFile(taskRoot, input.path);
      } catch (error) {
        throw fail(error.message, "invalid_input");
      }
      const fileStat = await stat(resolved);
      if (fileStat.size <= 0) throw fail("Artifact file is empty", "invalid_input");
      if (fileStat.size > maxBytes) throw fail(`Artifact file exceeds the configured maximum of ${maxBytes} bytes`);
      const bytes = await readFile(resolved);
      if (bytes.byteLength !== fileStat.size) throw fail("Artifact file changed while it was being read");
      const checksum = createHash("sha256").update(bytes).digest("hex");
      const publicationKey = JSON.stringify([resolved, input.name, outputPath, kind, role, input.media_type, checksum]);
      const verifiedReplay = verifiedPublications.get(publicationKey);
      if (verifiedReplay) return { ...verifiedReplay };

      onPhase("artifact_upload_started", {
        size: bytes.byteLength,
        kind,
        role,
      });
      const target = refinementTarget(task, artifactInput);
      const created = target
        ? await client.createArtifactVersion(task.workspace, target.artifact_id, {
            name: input.name,
            type: input.media_type,
            size: bytes.byteLength,
            kind,
            role,
            output_path: outputPath,
            previous_version_id: target.version_id,
            change_summary: `Decision refinement revision ${task.runtime_binding.decision_refine.revision}`,
          })
        : await client.createArtifact(task.workspace, {
            name: input.name,
            type: input.media_type,
            size: bytes.byteLength,
            kind,
            role,
            ...(outputPath ? { output_path: outputPath } : {}),
            ...(links.length ? { links } : {}),
            temp: true,
          });
      const artifactId = target?.artifact_id || created?.artifact?.id;
      const versionId = target ? created?.version?.id || created?.version_id : created?.version_id;
      if (!artifactId || !versionId || !created?.upload_data) {
        throw fail("Artifact registration did not return an upload contract");
      }
      await client.uploadArtifactBytes(created.upload_data, bytes, input.name, input.media_type);
      await client.completeArtifactVersion(task.workspace, artifactId, versionId, { checksum });
      if (!target) await client.commitArtifact(task.workspace, artifactId, { scope });
      const artifact = await client.getArtifact(task.workspace, artifactId);
      verifyReadback({ artifact, artifactId, versionId, size: bytes.byteLength, checksum, input: artifactInput });
      onPhase("artifact_upload_verified", {
        size: bytes.byteLength,
        kind,
        role,
      });
      const result = {
        ...(outputPath ? { output_path: outputPath } : {}),
        mode: "reference",
        artifact: {
          artifact_id: String(artifactId),
          version_id: String(versionId),
          kind,
          role,
          name: artifact.name,
          media_type: artifact.mime_type,
        },
      };
      verifiedPublications.set(publicationKey, result);
      return { ...result };
    },
  };
}
