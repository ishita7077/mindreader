FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV HF_HUB_DISABLE_XET=1
ENV HF_HOME=/root/.cache/huggingface
ENV TRANSFORMERS_CACHE=/root/.cache/huggingface/transformers

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ── uv / uvx ──────────────────────────────────────────────────────────────────
# tribev2's text pipeline calls `uvx` as a subprocess (eventstransforms.py).
# Install uv via its official installer so both `uv` and `uvx` land at
# /root/.local/bin and are available system-wide.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

RUN pip install --upgrade pip

# ── Single combined pip install ────────────────────────────────────────────────
# WHY one RUN command?
#   If we split into separate RUN steps, pip installs torch once for whisperx
#   (~3 GB), again for frozen requirements (~3 GB upgrade), and the GitHub
#   Actions runner runs out of disk space (Errno 28).  By doing all installs in
#   ONE step the pip resolver sees every constraint at once and only ever
#   downloads each wheel once.
#
# Install order:
#   1. whisperx — establishes its torch/torchaudio lower bounds first
#   2. frozen requirements — pins most backend deps (including torch 2.6.0),
#      overriding what whisperx just pulled; pip upgrades in-place so the wheel
#      is only on disk once at the end.
#   3. tribev2 git install — its deps are already satisfied by the frozen reqs
#   4. runpod + accelerate — small runtime packages, installed last. accelerate
#      is installed with --no-deps so it cannot perturb the frozen stack.
#   5. PyTorch CUDA 12.8 — overrides the frozen torch 2.6.0 wheel so RunPod
#      workers can pass fitness checks on NVIDIA Blackwell (sm_120) GPUs.
#
# The editable (-e) line for tribev2 is removed from frozen reqs with grep
# because we install it properly via git+ in step 3.

COPY backend/requirements_frozen.txt /app/requirements_frozen.txt

RUN pip install whisperx && \
    grep -v "^-e " /app/requirements_frozen.txt | pip install --upgrade -r /dev/stdin && \
    pip install "https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl" && \
    python -c "import spacy; spacy.load('en_core_web_lg')" && \
    pip install \
        "git+https://github.com/facebookresearch/tribev2.git@72399081ed3f1040c4d996cefb2864a4c46f5b8e#egg=tribev2" && \
    pip install runpod && \
    pip install --no-deps accelerate==1.10.1 && \
    pip install --upgrade --force-reinstall \
        torch==2.7.0+cu128 torchvision==0.22.0+cu128 torchaudio==2.7.0+cu128 \
        --index-url https://download.pytorch.org/whl/cu128 && \
    python -c "import torch; assert torch.__version__.startswith('2.7.0'), torch.__version__; assert torch.version.cuda == '12.8', torch.version.cuda; print('PyTorch Blackwell-ready wheel:', torch.__version__, 'CUDA', torch.version.cuda)"

# ── Application code ──────────────────────────────────────────────────────────
COPY backend /app/backend
COPY atlases /app/atlases
COPY runpod_worker /app/runpod_worker

ENV BRAIN_DIFF_ATLAS_DIR=/app/atlases
ENV PYTHONPATH=/app

CMD ["sh", "-c", "if [ \"$BRAIN_DIFF_RUNPOD_STUB_RESULT\" = \"1\" ]; then python -u runpod_worker/stub_handler.py; else python -u runpod_worker/handler.py; fi"]
