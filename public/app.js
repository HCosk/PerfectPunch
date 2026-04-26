function toggleUploadMode(form) {
  const mode = form.querySelector('input[name="mode"]:checked')?.value || "single";
  for (const pane of form.querySelectorAll("[data-mode-pane]")) {
    pane.hidden = pane.getAttribute("data-mode-pane") !== mode;
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
  const payload = {
    title: form.elements.title.value.trim(),
    notes: form.elements.notes.value.trim(),
    mode,
    sessionDateOverride: form.elements.sessionDateOverride.value.trim(),
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
  const basePath = document.body?.dataset.basePath || "";
  const apiSessionsUrl = `${basePath}/api/sessions`;
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
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "The session could not be saved.");
      }
      window.location.assign(result.redirectTo);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupUploadForm();
});
