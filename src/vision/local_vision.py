"""Local vision server - persists model in memory, reads JSON from stdin."""
import sys, json, base64, io, time, torch, warnings
warnings.filterwarnings('ignore')
from PIL import Image
from transformers import AutoProcessor, AutoModelForCausalLM, PretrainedConfig

MODEL_ID = "microsoft/Florence-2-base"

if not hasattr(PretrainedConfig, 'forced_bos_token_id'):
    PretrainedConfig.forced_bos_token_id = None

def main():
    print("Loading Florence-2-base...", file=sys.stderr, flush=True)
    t0 = time.time()
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, trust_remote_code=True, local_files_only=True)
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
