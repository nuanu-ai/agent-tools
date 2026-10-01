/** Strict Codex output schemas derived from the authored ProcessItem contract. */

export function codexOutputSchema(schema) {
  let value = schema;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) {
    return value && typeof value === "object" ? value : null;
  }
  const properties = {};
  const required = [];
  for (const field of value) {
    if (!field || typeof field !== "object") continue;
    const key = String(field.key || field.name || "").trim();
    if (!key) continue;
    let property;
    if (field.type === "array") property = { type: "array", items: {} };
    else if (field.type === "object") property = { type: "object", additionalProperties: true };
    else if (field.type === "number") property = { type: "number" };
    else if (field.type === "boolean") property = { type: "boolean" };
    else property = { type: "string" };
    if (Array.isArray(field.enumValues) && field.enumValues.length > 0) property.enum = field.enumValues;
    if (field.description) property.description = String(field.description);
    properties[key] = property;
    required.push(key);
  }
  return required.length > 0 ? { type: "object", properties, required, additionalProperties: false } : null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function supportsStrictOutput(definition) {
  return Object.values(definition?.data || {}).every((field) => {
    if (field?.type === "choices") return false;
    if (field?.type !== "json") return true;
    return field.schema && typeof field.schema === "object" && !Array.isArray(field.schema);
  });
}

function authoredDataSchema(definition) {
  const properties = {};
  for (const [key, field] of Object.entries(definition?.data || {})) {
    if (field?.type === "string") properties[key] = { type: "string" };
    else if (field?.type === "number") properties[key] = { type: "number" };
    else if (field?.type === "boolean") properties[key] = { type: "boolean" };
    else if (field?.type === "choices") {
      properties[key] = {
        type: "object",
        propertyNames: { pattern: "^[a-z][a-z0-9_]{0,63}$" },
        additionalProperties: processItemDraftSchema(field.item || {}, null),
      };
    } else if (field?.type === "json" && field.schema) properties[key] = cloneJson(field.schema);
    else return null;
    if (field?.description) properties[key].description = String(field.description);
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function processItemDraftSchema(definition, expectedKey) {
  const data = authoredDataSchema(definition);
  if (!data) return null;
  return {
    type: "object",
    properties: {
      key: expectedKey ? { type: "string", const: expectedKey } : { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
      description: { type: "string" },
      data,
      artifacts: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    required: ["key", "description", "data", "artifacts"],
    additionalProperties: false,
  };
}

function strictObject(properties) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function artifactReferenceSchema(kind) {
  return strictObject({
    mode: { type: "string", const: "reference" },
    artifact: strictObject({
      artifact_id: { type: "string" },
      version_id: { type: "string" },
      kind: { type: "string", const: kind },
      role: { type: "string", const: "output" },
    }),
  });
}

function artifactCandidateSchema(kind) {
  let locator = null;
  if (kind === "git.commit") locator = strictObject({ sha: { type: "string" } });
  else if (kind === "git.branch") locator = strictObject({ branch: { type: "string" } });
  else if (kind === "git.pull_request") locator = strictObject({ number: { type: "integer" } });
  else if (kind === "external.link") locator = strictObject({ url: { type: "string" } });
  if (!locator) return null;
  return strictObject({
    mode: { type: "string", const: "candidate" },
    candidate: strictObject({
      client_id: { type: "string" },
      name: { type: "string" },
      locator,
    }),
  });
}

function artifactOutputSchema(definition) {
  const kind = String(definition?.kind || "");
  const alternatives = [artifactReferenceSchema(kind)];
  const candidate = artifactCandidateSchema(kind);
  if (candidate) alternatives.push(candidate);
  // Dynamic publication and repository verification may fill a declared output
  // after the model returns. Null keeps that placeholder explicit and required.
  alternatives.push({ type: "null" });
  return { anyOf: alternatives };
}

export function processItemCompletionOutputSchema(task) {
  const definition = task?.request?.output_definition || { data: {}, artifacts: {} };
  if (!supportsStrictOutput(definition)) return null;
  const itemSchema = processItemDraftSchema(definition, String(task?.request?.process?.step_key || ""));
  if (!itemSchema) return null;
  const artifactProperties = Object.fromEntries(
    Object.entries(definition.artifacts || {}).map(([key, artifactDefinition]) => [
      `item.artifacts.${key}`,
      artifactOutputSchema(artifactDefinition),
    ])
  );
  return {
    type: "object",
    properties: {
      item: itemSchema,
      artifact_outputs: {
        type: "object",
        properties: artifactProperties,
        required: Object.keys(artifactProperties),
        additionalProperties: false,
      },
    },
    required: ["item", "artifact_outputs"],
    additionalProperties: false,
  };
}
