# Azeri Energy Dashboard v2

React (Vite) frontend with a Python detection and thermal-analysis backend. The UI talks to the API on port **8000**; Vite dev server proxies `/api`, `/results`, `/socket.io`, and `/health` to that backend.

## Prerequisites

- **Node.js** 18+ (for `npm` / Vite)
- **Python** 3.10+ (3.12 recommended)
- **NVIDIA GPU + CUDA PyTorch** (optional, for faster YOLO inference; CPU works but is slower)
- **Git** (optional)

## Project layout

| Path | Role |
|------|------|
| `frontend/` | React app, `npm run dev` / `npm run build` |
| `backend/` | FastAPI + Socket.IO server (`server.py`), thermal SDK helpers, YOLO weights under `backend/models/` |

## Backend setup

1. Open a terminal in `backend/`.

2. Create and activate a virtual environment (Windows PowerShell):

   ```powershell
   python -m venv venv
   .\venv\Scripts\Activate.ps1
   ```

3. Install PyTorch (pick [CPU or CUDA](https://pytorch.org/get-started/locally/) to match your machine).

4. Install Python dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

   If `server.py` fails on import, install the missing packages (typical stack includes `fastapi`, `uvicorn[standard]`, `python-socketio`, `opencv-python-headless`, `pillow`, `numpy`, `torch`, etc.).

5. Ensure YOLO weights exist where `server.py` expects them (default: `backend/models/tl_defect_industrial 55.5 hours copy/weights/best.pt`). Adjust paths in `server.py` only if your folder name differs.

6. Run the API:

   ```powershell
   python server.py
   ```

   The server listens on **http://0.0.0.0:8000** (override with env var `PORT` if needed).

## Frontend setup

1. Open a terminal in `frontend/`.

2. Install dependencies:

   ```powershell
   npm install
   ```

## Run everything (recommended)

From **`frontend/`**:

```powershell
npm run dev
```

This starts the **backend** (`../backend/venv/Scripts/python.exe server.py`) and then **Vite** after port **8000** is accepting connections. Stop both with one **Ctrl+C**.

- App URL: **http://localhost:5173** (Vite may use another port if 5173 is busy)
- API: **http://localhost:8000**

## Production build (frontend only)

```powershell
cd frontend
npm run build
```

Serve the contents of `frontend/dist/` with your static host; configure it to reverse-proxy API traffic to the same backend origin or to your deployed API.

## Troubleshooting

- **Port 8000 in use** — Stop other processes using that port, or set `PORT` (e.g. `8001`) and align any proxy / client URLs.
- **CUDA not available** — Backend falls back to CPU; install a CUDA-enabled `torch` build if you need the GPU.
- **`npm run dev` backend path** — Scripts assume `backend/venv` exists on Windows. On macOS/Linux, point `dev:backend` in `package.json` to `venv/bin/python` or run backend manually in a second terminal.
''''''''''
now see here analise the both box that you are genrating inside the report , now imgs should reiam same as you aere doing now juts rmeove the annotation boxes inisde the corpped imgs  here i want only to show imgs dont show the annotaion boxes here inside the img isnide the erepot that uyou genrate in pdf make sure it work porpelry and be profesional and dont be sugar coated and also make sure to dont make code rudendency and also make check to show the defect img without annotion insid ethe repot make sure ot dont make any other hcnage  and code should not be rudendnt and dont make any other hcnage 
''''''''''
on top of current state make sure that now see make sure to take the annotaion from model and name of that img then search for that same img that is non annotated and then mapp the annotation to crop that aprt of img from non annotated img and sho it in defective part make sure to dont make naty otehr chnage and rudendncy 
'''''''''''''