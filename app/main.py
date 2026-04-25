from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .data import SessionValidationError
from .service import PunchModelService


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
ARTIFACT_DIR = ROOT_DIR / "artifacts" / "current"
STATIC_DIR = ROOT_DIR / "app" / "static"

app = FastAPI(title="PerfectPunch Timeline", version="1.0.0")
service = PunchModelService(data_dir=DATA_DIR, artifact_dir=ARTIFACT_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/model")
async def get_model_info() -> dict:
    return service.model_info()


@app.post("/api/analyse")
@app.post("/api/analyze")
async def analyse_zip(
    file: UploadFile = File(...),
    session_date_override: str | None = Form(default=None),
) -> dict:
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Please upload a ZIP file.")
    try:
        payload = await file.read()
        return service.analyse_zip(payload, session_date_override=session_date_override or None)
    except SessionValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc
