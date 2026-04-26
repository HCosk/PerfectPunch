function toggleUploadMode(form) {
  const mode = form.querySelector('input[name="mode"]:checked')?.value || "single";
  for (const pane of form.querySelectorAll("[data-mode-pane]")) {
    pane.hidden = pane.getAttribute("data-mode-pane") !== mode;
  }
}

function validateSessionDateOverride(value) {
  if (!value) {
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Session date override must look like YYYY-MM-DD_HH-MM-SS.");
  }
}

function resolveApiSessionsUrl() {
  const current = new URL(window.location.href);
  const pathname = current.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/sessions/new")) {
    return `${current.origin}${pathname.slice(0, -"/sessions/new".length)}/api/sessions`;
  }
  return `${current.origin}/api/sessions`;
}

function resolveRedirectTarget(target) {
  try {
    return new URL(String(target || ""), window.location.href).toString();
  } catch (_error) {
    return null;
  }
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function buildUploadPayload(form) {
  const mode = form.querySelector('input[name="mode"]:checked')?.value || "single";
  const sessionDateOverride = form.elements.sessionDateOverride.value.trim();
  validateSessionDateOverride(sessionDateOverride);

  const payload = {
    title: form.elements.title.value.trim(),
    notes: form.elements.notes.value.trim(),
    mode,
    sessionDateOverride,
    uploads: []
  };

  if (mode === "single") {
    const singleFile = form.elements.singleFile.files[0];
    if (!singleFile) {
      throw new Error("Choose a ZIP file for the selected arm.");
    }
    payload.uploads.push({
      arm: form.elements.singleArm.value,
      name: singleFile.name,
      data: await fileToBase64(singleFile)
    });
    return payload;
  }

  const leftFile = form.elements.leftFile.files[0];
  const rightFile = form.elements.rightFile.files[0];
  if (!leftFile || !rightFile) {
    throw new Error("Dual-arm mode needs both a left and right ZIP file.");
  }
  payload.uploads.push({
    arm: "left",
    name: leftFile.name,
    data: await fileToBase64(leftFile)
  });
  payload.uploads.push({
    arm: "right",
    name: rightFile.name,
    data: await fileToBase64(rightFile)
  });
  return payload;
}

function setupUploadForm() {
  const form = document.querySelector("[data-upload-form]");
  if (!form) {
    return;
  }
  const apiSessionsUrl = resolveApiSessionsUrl();
  const status = form.querySelector("[data-upload-status]");

  toggleUploadMode(form);
  for (const modeInput of form.querySelectorAll('input[name="mode"]')) {
    modeInput.addEventListener("change", () => toggleUploadMode(form));
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "Reading files and sending them for analysis...";
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;

    try {
      const payload = await buildUploadPayload(form);
      const response = await fetch(apiSessionsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const bodyText = await response.text();
      let result = {};
      if (bodyText) {
        try {
          result = JSON.parse(bodyText);
        } catch (_error) {
          throw new Error("Server returned an unexpected response while saving the session.");
        }
      }
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "The session could not be saved.");
      }
      const redirectTarget = resolveRedirectTarget(result.redirectTo);
      if (!redirectTarget) {
        throw new Error("Session saved but redirect target was invalid.");
      }
      window.location.assign(redirectTarget);
    } catch (error) {
      const rawMessage = String(error?.message || "Unexpected error.");
      status.textContent = rawMessage === "The string did not match the expected pattern."
        ? "Browser rejected the request format. Refresh the page and try again."
        : rawMessage;
    } finally {
      button.disabled = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupUploadForm();
});
