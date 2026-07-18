"""Local vision server - persists model in memory, reads JSON from stdin."""
import os
import sys
import json
import base64
import io
import time
import torch
import warnings

# Force fully-offline loading: the Florence-2 snapshot is cached locally and the
# installed transformers is newer than the snapshot's training version, so any
# network probe for "newer" config files only adds ~3min of timeouts for nothing.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

warnings.filterwarnings('ignore')
from PIL import Image
from transformers import AutoProcessor, AutoModelForCausalLM, PretrainedConfig

import huggingface_hub

MODEL_ID = "microsoft/Florence-2-base"

# Files that must be present in the local snapshot for offline loading to work.
REQUIRED_SNAPSHOT_FILES = [
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "processing_florence2.py",
    "modeling_florence2.py",
    "tokenizer.json",
    "tokenizer_config.json",
]


def verify_local_cache(model_id: str = MODEL_ID) -> None:
    """Validate that the Florence-2 snapshot is fully cached and loadable offline.

    Catches the two failure modes seen in the field:
      1. A stale `.no_exist` marker in the HF cache makes `local_files_only=True`
         refuse the (actually present) cached weights and fall back to a network
         fetch that times out.
      2. A genuinely incomplete download (missing weight/config files).

    Raises FileNotFoundError with an actionable message if the cache is broken,
    so the failure is obvious instead of a confusing huggingface.co timeout.
    """
    # 1. Ensure no stale .no_exist marker blocks offline loading.
    try:
        repo_dir = huggingface_hub.snapshot_download(model_id, local_files_only=True)
    except Exception as e:  # pragma: no cover - network/path issues
        raise FileNotFoundError(
            f"Florence-2 cache unavailable for offline load: {e}\n"
            f"Fix: ensure '{model_id}' is downloaded (e.g. with network access once), "
            f"or remove any stale '.no_exist' marker under your HF cache."
        )
    no_exist = os.path.join(repo_dir, "..", "..", ".no_exist")
    if os.path.exists(no_exist):
        raise FileNotFoundError(
            "Stale '.no_exist' marker found in the Florence-2 HF cache, which blocks "
            "offline loading. Delete it:\n"
            f"  {os.path.abspath(no_exist)}\n"
            "Then retry — the cached weights are actually present."
        )

    # 2. Ensure every required file exists in the resolved snapshot (no network needed).
    missing = []
    for fname in REQUIRED_SNAPSHOT_FILES:
        candidate = os.path.join(repo_dir, fname)
        if not os.path.exists(candidate):
            missing.append(fname)
    if missing:
        raise FileNotFoundError(
            "Florence-2 local cache is incomplete (missing files: "
            + ", ".join(missing)
            + "). Re-download the model with network access, or the local vision "
              "feature will fall back to cloud."
        )


if not hasattr(PretrainedConfig, 'forced_bos_token_id'):
    PretrainedConfig.forced_bos_token_id = None


def _patch_florence_generation(model):
    """Patch the custom Florence-2 language model's prepare_inputs_for_generation.

    The vendored modeling_florence2.py was written for transformers ~4.41. Under
    newer transformers (>=4.5) the generation loop may call
    prepare_inputs_for_generation with past_key_values being a tuple that contains
    None entries, which made `past_key_values[0][0].shape[2]` raise
    "NoneType object has no attribute 'shape'". Guard against that so local
    vision inference works on the currently installed transformers.
    """
    lm = getattr(model, "language_model", None)
    if lm is None or not hasattr(lm, "prepare_inputs_for_generation"):
        return

    def safe_prepare_inputs_for_generation(
        self,
        decoder_input_ids=None,
        past_key_values=None,
        attention_mask=None,
        decoder_attention_mask=None,
        head_mask=None,
        decoder_head_mask=None,
        cross_attn_head_mask=None,
        use_cache=None,
        encoder_outputs=None,
        **kwargs,
    ):
        pk = past_key_values
        if pk is not None:
            try:
                _ = pk[0][0].shape[2]
            except (TypeError, IndexError, AttributeError):
                pk = None
        if pk is not None and decoder_input_ids is not None:
            past_length = pk[0][0].shape[2]
            remove_prefix = (
                past_length if decoder_input_ids.shape[1] > past_length
                else decoder_input_ids.shape[1] - 1
            )
            decoder_input_ids = decoder_input_ids[:, remove_prefix:]
        return {
            "input_ids": None,
            "encoder_outputs": encoder_outputs,
            "past_key_values": past_key_values,
            "decoder_input_ids": decoder_input_ids,
            "attention_mask": attention_mask,
            "decoder_attention_mask": decoder_attention_mask,
            "head_mask": head_mask,
            "decoder_head_mask": decoder_head_mask,
            "cross_attn_head_mask": cross_attn_head_mask,
            "use_cache": use_cache,
        }

    lm.prepare_inputs_for_generation = safe_prepare_inputs_for_generation.__get__(lm)


def main():
    verify_local_cache()
    print("Loading Florence-2-base...", file=sys.stderr, flush=True)
    t0 = time.time()
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, trust_remote_code=True, local_files_only=True, attn_implementation='eager')
    _patch_florence_generation(model)
    processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True, local_files_only=True)
    t1 = time.time()
    print(f"Model loaded in {t1-t0:.1f}s", file=sys.stderr, flush=True)
    print("ready", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            image_b64 = req.get("image", "")
            question = req.get("question", "")
            if not image_b64:
                sys.stdout.write(json.dumps({"error": "No image data"}) + "\n")
                sys.stdout.flush()
                continue

            image_data = base64.b64decode(image_b64)
            image = Image.open(io.BytesIO(image_data)).convert("RGB")
            t2 = time.time()

            prompt = "<DETAILED_CAPTION>"
            inputs = processor(text=prompt, images=image, return_tensors="pt")
            with torch.no_grad():
                generated_ids = model.generate(
                    input_ids=inputs["input_ids"],
                    pixel_values=inputs["pixel_values"],
                    max_new_tokens=256,
                    num_beams=1,
                    do_sample=False,
                    use_cache=False,
                )
            result = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
            result = result.replace(prompt, "").strip()
            t3 = time.time()
            print(f"Analysis in {t3-t2:.1f}s", file=sys.stderr, flush=True)
            sys.stdout.write(json.dumps({"content": result}) + "\n")
            sys.stdout.flush()
        except Exception as e:
            import traceback
            sys.stdout.write(json.dumps({"error": str(e), "traceback": traceback.format_exc()}) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
