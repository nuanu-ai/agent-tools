import { writeFile } from "node:fs/promises";
import path from "node:path";

const TEXT_ARTIFACT_KINDS = new Set(["markdown", "document", "spec"]);

function parsedResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function title(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function markdownValue(value, depth = 3) {
  if (Array.isArray(value)) {
    if (!value.length) return "_None._";
    return value
      .map((entry) => {
        if (entry && typeof entry === "object") {
          return `- ${Object.entries(entry)
            .map(([key, item]) => `**${title(key)}:** ${Array.isArray(item) ? item.join(", ") : String(item)}`)
            .join("; ")}`;
        }
        return `- ${String(entry)}`;
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${"#".repeat(Math.min(depth, 6))} ${title(key)}\n\n${markdownValue(item, depth + 1)}`)
      .join("\n\n");
  }
  if (value === null || value === undefined || value === "") return "_Not specified._";
  return String(value);
}

export function renderProcessItemMarkdown(task, item, artifactKey) {
  const heading =
    String(item?.data?.summary || "").trim() ||
    String(item?.description || "").trim() ||
    `${title(task?.request?.process?.step_name || task?.step_name || artifactKey)} output`;
  const sections = Object.entries(item?.data || {}).map(
    ([key, value]) => `## ${title(key)}\n\n${markdownValue(value)}`
  );
  return [`# ${heading}`, String(item?.description || "").trim(), ...sections]
    .filter(Boolean)
    .join("\n\n")
    .trim()
    .concat("\n");
}

async function exactReferenceExists(client, task, output, expectedKind) {
  if (output?.mode !== "reference") return false;
  const reference = output.artifact;
  if (!reference?.artifact_id || !reference?.version_id) return false;
  try {
    const artifact = await client.getArtifact(task.workspace, reference.artifact_id);
    return (
      String(artifact?.id) === String(reference.artifact_id) &&
      artifact?.status === "stored" &&
      artifact?.kind === expectedKind &&
      (artifact?.versions || []).some((version) => String(version?.id) === String(reference.version_id))
    );
  } catch {
    return false;
  }
}

function filenameFor(task, key) {
  const prefix =
    String(task?.request?.process?.step_key || "agent-output")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent-output";
  const suffix =
    String(key || "document")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "document";
  return `${prefix}-${suffix}.md`;
}

/**
 * Materialize structured text output when a model omitted publication or tried
 * to reuse an input Artifact. The model remains responsible for the authored
 * data; the worker only renders that already-declared ProcessItem deterministically.
 */
export async function ensureStructuredTextArtifacts({ task, result, publisher, client, taskRoot }) {
  if (!publisher || result?.status !== "ok") return result;
  const parsed = parsedResult(result.output);
  if (!parsed?.item || !parsed?.artifact_outputs) return result;
  const publications = Array.isArray(result.publishedArtifacts) ? [...result.publishedArtifacts] : [];
  const publishedPaths = new Set(publications.map((entry) => entry?.output_path).filter(Boolean));

  for (const [key, descriptor] of Object.entries(task?.request?.output_definition?.artifacts || {})) {
    const kind = String(descriptor?.kind || "");
    if (!TEXT_ARTIFACT_KINDS.has(kind)) continue;
    const outputPath = `item.artifacts.${key}`;
    if (publishedPaths.has(outputPath)) continue;
    const output = parsed.artifact_outputs[outputPath];
    if (await exactReferenceExists(client, task, output, kind)) continue;

    const name = filenameFor(task, key);
    await writeFile(path.join(taskRoot, name), renderProcessItemMarkdown(task, parsed.item, key), {
      encoding: "utf8",
      mode: 0o600,
    });
    const published = await publisher.call({
      path: name,
      name,
      output_path: outputPath,
      media_type: "text/markdown",
    });
    publications.push(published);
    publishedPaths.add(outputPath);
  }
  result.publishedArtifacts = publications;
  return result;
}
