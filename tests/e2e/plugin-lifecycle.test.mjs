import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentAction,
  createPluginLifecycle,
} from "../../scripts/plugin-lifecycle.mjs";

test("plugin lifecycle keeps installation, authentication, and attachment distinct", () => {
  const lifecycle = createPluginLifecycle({
    surface: "codex-cli",
    authentication: "connected",
    attachment: "verification_required",
    continuation: "verify_in_current_thread",
  });

  assert.deepEqual(lifecycle, {
    surface: "codex-cli",
    installation: "installed",
    authentication: "connected",
    attachment: "verification_required",
    continuation: "verify_in_current_thread",
  });
  assert.equal(attachmentAction(lifecycle), "verify");
});

test("plugin lifecycle rejects unsupported or ambiguous states", () => {
  assert.throws(
    () =>
      createPluginLifecycle({
        surface: "codex-app",
        authentication: "connected",
        attachment: "probably_ready",
        continuation: "automatic",
      }),
    /Invalid plugin lifecycle attachment/,
  );
  assert.throws(
    () => attachmentAction({ attachment: "probably_ready" }),
    /Unknown plugin attachment state/,
  );
  assert.throws(
    () =>
      createPluginLifecycle({
        surface: "codex-app",
        authentication: "connected",
        attachment: "attached",
        continuation: "same_thread_resume",
      }),
    /attached requires continuation automatic/,
  );
});
