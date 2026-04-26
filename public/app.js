function toggleUploadMode(form) {
  const mode = form.querySelector('input[name="mode"]:checked')?.value || "single";
  for (const pane of form.querySelectorAll("[data-mode-pane]")) {
    pane.hidden = pane.getAttribute("data-mode-pane") !== mode;
  }
}

function buildSessionDateOverride(dateValue, timeValue) {
  if (!dateValue && !timeValue) {
    return "";
  }
  if (!dateValue) {
    throw new Error("Choose a date when setting an override time.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    throw new Error("Session date is invalid.");
  }
  if (!timeValue) {
    return `${dateValue}_00-00-00`;
  }
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(timeValue)) {
    throw new Error("Session time is invalid.");
  }
  const fullTime = timeValue.length === 5 ? `${timeValue}:00` : timeValue;
  return `${dateValue}_${fullTime.replace(/:/g, "-")}`;
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
  const sessionDateValue = String(form.elements.sessionDate?.value || "").trim();
  const sessionTimeValue = String(form.elements.sessionTime?.value || "").trim();
  const sessionDateOverride = buildSessionDateOverride(sessionDateValue, sessionTimeValue);

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
