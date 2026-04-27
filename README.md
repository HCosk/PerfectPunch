# PerfectPunch

PerfectPunch is a boxing session analysis app with:

- user signup/login
- single-arm or dual-arm ZIP uploads
- punch event analysis using a trained Python model
- saved session history and progress-over-time stats
- session compare, favorites, edit, delete, and CSV export tools
- per-session event explorer for filtering punches by arm and label

The web app is built with Node.js + Express + MySQL, and the model is run through a Python CLI bridge.

## Stack

- Node.js / Express
- MySQL
- Python (FastAPI-compatible model code, CLI-driven for training + inference)
- Plain HTML/CSS/JS frontend

## Project Structure

- `src/` - Express server logic (auth, DB, sessions, templates)
- `public/` - frontend assets (`styles.css`, `app.js`)
- `app/` - Python model pipeline and CLI
- `database/schema.sql` - MySQL schema
- `artifacts/current/` - trained model artifacts used at runtime

## Current App Features

- `Dashboard` with recent sessions, punch mix, and progress trend
- `History` with search, filters, compare entry points, and CSV export
- `Session detail` with arm breakdowns and event explorer
- `Session actions` for favorite, edit, delete, and per-session CSV export
- `Compare` view for side-by-side session summaries

## Prerequisites

- Node.js 18+
- Python 3.10+
- MySQL 8+

## Local Setup

```bash
git clone https://github.com/HCosk/PerfectPunch.git
cd PerfectPunch

npm install

python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt

cp .env.example .env
```

## Database Setup (Local)

1. Create DB + user in MySQL:

```sql
CREATE DATABASE perfectpunch;
CREATE USER 'perfectpunch'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON perfectpunch.* TO 'perfectpunch'@'localhost';
FLUSH PRIVILEGES;
```

2. Import schema:

```bash
mysql -u perfectpunch -p perfectpunch < database/schema.sql
```

If `mysql: command not found` appears, use your installed MySQL client path (example on macOS):

```bash
/usr/local/mysql-8.4.7-macos15-arm64/bin/mysql -u perfectpunch -p perfectpunch < database/schema.sql
```

## Environment Variables

Edit `.env` with your local credentials:

```env
PORT=3000
APP_BASE_PATH=
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=perfectpunch
DB_PASSWORD=your_password
DB_NAME=perfectpunch
SESSION_COOKIE_NAME=perfectpunch_session
SESSION_COOKIE_SECURE=0
SESSION_DAYS=30
UPLOAD_PAYLOAD_LIMIT_MB=80
PYTHON_BIN=python3
```

## Train Model (Terminal Only)

Training is intentionally terminal-only (no admin training UI in the web app):

```bash
python3 app/cli.py train
```

Training data is read from the repo `data/` folder. Each training session should live in its
own directory named like:

```text
data/
  cross-2026-04-27_06-03-08/
  jab-2026-04-27_06-05-19/
  left_hook-2026-04-27_06-05-51/
```

Each session directory must contain at least:

- `Accelerometer.csv`
- `Gyroscope.csv`
- `Orientation.csv`

Optional files such as `Metadata.csv` and `Annotation.csv` can also be present.

The label is derived from the directory name prefix before the timestamp, so directory naming
matters.

Check currently loaded model:

```bash
python3 app/cli.py info
```

Artifacts are written to:

- `artifacts/current/model.pt`
- `artifacts/current/metrics.json`
- `artifacts/current/label_map.json`
- `artifacts/current/normalization.json`
- `artifacts/current/thresholds.json`

Inference in the web app now saves punch labels and event times directly. The user-facing UI no
longer uses confidence/needs-review states.

## Run the App Locally

```bash
npm start
```

Open:

`http://localhost:3000`

## Validation / Checks

```bash
npm run check
```

Optional targeted pipeline tests:

```bash
python3 -m pytest tests/test_pipeline.py
```

## Local Deployment

Use this when you want to run PerfectPunch as a normal local service on your own machine.

1. Clone and install:

```bash
git clone https://github.com/HCosk/PerfectPunch.git
cd PerfectPunch

npm install
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
cp .env.example .env
```

2. Set local `.env` values:

```env
PORT=3000
APP_BASE_PATH=
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=perfectpunch
DB_PASSWORD=your_password
DB_NAME=perfectpunch
PYTHON_BIN=/absolute/path/to/PerfectPunch/.venv/bin/python3
```

Leave `APP_BASE_PATH` empty for normal local use. Only set it if you are mounting the app behind a reverse proxy under a sub-path.

3. Create/import the database:

```bash
mysql -u root -p
```

```sql
CREATE DATABASE perfectpunch;
CREATE USER 'perfectpunch'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON perfectpunch.* TO 'perfectpunch'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

```bash
mysql -u perfectpunch -p perfectpunch < database/schema.sql
```

4. Start the app:

```bash
npm start
```

5. Open it in your browser:

`http://localhost:3000`

If you want to access it from another device on the same network, use your machine's local IP address instead of `localhost`.

### Optional Background Run

If you want the app to keep running after you close the terminal:

```bash
nohup npm start > perfectpunch.log 2>&1 &
```

Then check it with:

```bash
tail -f perfectpunch.log
```

## Common Issues

- `Repository not found`: check exact repo URL spelling and remote with `git remote -v`.
- `Access denied for user ...`: update DB credentials in `.env`.
- `mysql: command not found`: use full MySQL client path or add it to `PATH`.
- `No module named pip`: install `python3-pip` and `python3-venv`, then recreate `.venv`.
- `EADDRINUSE`: another process is already using the configured port. Stop the old process or change `PORT` in `.env`.

## Notes

- `data/`, `storage/`, `node_modules/`, and `.env` are ignored by Git.
- `artifacts/current` is committed so inference works after local deployment without retraining first.
- If you retrain the model, restart the Node app so new artifacts are picked up cleanly.
