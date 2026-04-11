import os
import io
import hashlib
import folder_paths
import numpy as np
import torch
from PIL import Image
import cv2


# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------

def get_video_info(video_path: str) -> dict:
    """Return basic metadata for a video file."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Cannot open video: {video_path}")

    fps      = cap.get(cv2.CAP_PROP_FPS)
    total    = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width    = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    return {
        "fps":          fps,
        "total_frames": total,
        "width":        width,
        "height":       height,
        "duration_seconds": total / fps if fps > 0 else 0,
    }


def read_single_frame(cap: cv2.VideoCapture, frame_index: int,
                      width: int, height: int) -> np.ndarray:
    """Read one frame; return a black frame on failure."""
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
    ret, frame = cap.read()
    if not ret:
        return np.zeros((height, width, 3), dtype=np.uint8)
    return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)


def extract_frames(video_path: str, start_frame: int, end_frame: int,
                   num_frames: int) -> torch.Tensor:
    """
    Extract *num_frames* evenly-spaced frames from [start_frame, end_frame].
    Returns a BHWC float32 tensor in [0, 1].
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Cannot open video: {video_path}")

    total       = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w           = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h           = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    start_frame = max(0, min(start_frame, total - 1))
    end_frame   = max(start_frame, min(end_frame, total - 1))
    num_frames  = max(1, num_frames)

    if start_frame == end_frame:
        indices = [start_frame]
    else:
        indices = [
            int(round(start_frame + i * (end_frame - start_frame) / (num_frames - 1)))
            for i in range(num_frames)
        ]

    arr = np.empty((len(indices), h, w, 3), dtype=np.uint8)
    for i, idx in enumerate(indices):
        arr[i] = read_single_frame(cap, idx, w, h)
    cap.release()

    float_arr = arr.astype(np.float32) / 255.0
    del arr
    return torch.from_numpy(float_arr)   # BHWC


def frame_as_tensor(video_path: str, frame_index: int) -> torch.Tensor:
    """Return a single frame as a (1, H, W, 3) float32 tensor."""
    cap   = cv2.VideoCapture(video_path)
    w     = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h     = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame = read_single_frame(cap, frame_index, w, h)
    cap.release()
    arr   = frame.astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)   # 1HWC


# ---------------------------------------------------------------------------
# Node definition
# ---------------------------------------------------------------------------

class VideoFrameExtractor:
    """
    ComfyUI node: VideoFrameExtractor
    ─────────────────────────────────
    Outputs based on the loop region selected in the timeline widget:
      • first_frame   — single IMAGE of the loop start frame
      • last_frame    — single IMAGE of the loop end frame
      • frames        — all extracted frames in forward order (BHWC)
      • frames_reversed — same frames in reverse order (BHWC)
      • filename      — video filename (STRING)
      • width         — video width in pixels (INT)
      • height        — video height in pixels (INT)
      • fps           — source frame rate (FLOAT)
    """

    @classmethod
    def INPUT_TYPES(cls):
        video_files = []
        input_dir = folder_paths.get_input_directory()
        for fname in sorted(os.listdir(input_dir)):
            if fname.lower().endswith((".mp4", ".avi", ".mov", ".mkv", ".webm")):
                video_files.append(fname)
        if not video_files:
            video_files = [""]

        return {
            "required": {
                "video": (video_files, {
                    "video_upload": True,
                }),
                "start_frame": ("INT", {
                    "default": 0, "min": 0, "max": 999999, "step": 1,
                    "display": "number",
                }),
                "end_frame": ("INT", {
                    "default": 0, "min": 0, "max": 999999, "step": 1,
                    "display": "number",
                }),
                "num_frames": ("INT", {
                    "default": 0, "min": 0, "max": 999999, "step": 1,
                    "display": "number",
                }),
            },
        }

    RETURN_TYPES  = ("IMAGE", "IMAGE", "IMAGE", "IMAGE", "STRING", "INT", "INT", "FLOAT")
    RETURN_NAMES  = ("frames", "frames_reversed", "first_frame", "last_frame",
                     "filename_prefix", "width", "height", "fps")
    FUNCTION      = "extract"
    CATEGORY      = "video"
    OUTPUT_NODE   = False

    @classmethod
    def IS_CHANGED(cls, video, start_frame, end_frame, num_frames):
        video_path = folder_paths.get_annotated_filepath(video)
        if not os.path.exists(video_path):
            return float("nan")
        m = hashlib.md5()
        m.update(f"{video}{start_frame}{end_frame}{num_frames}".encode())
        return m.hexdigest()

    def extract(self, video: str, start_frame: int, end_frame: int,
                num_frames: int):
        video_path = folder_paths.get_annotated_filepath(video)
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video not found: {video_path}")

        info   = get_video_info(video_path)
        total  = info["total_frames"]
        width  = info["width"]
        height = info["height"]
        fps    = info["fps"]

        # Clamp loop region
        start_frame = max(0, min(start_frame, total - 1))
        end_frame   = max(start_frame, min(end_frame, total - 1))
        if end_frame == 0 and start_frame == 0:
            end_frame = total - 1

        # num_frames == 0 → auto (JS widget sets this to loop span)
        if num_frames <= 0:
            num_frames = end_frame - start_frame + 1

        # Extract the frame batch
        frames          = extract_frames(video_path, start_frame, end_frame, num_frames)
        frames_reversed = torch.flip(frames, dims=[0])

        # Single-frame outputs for the loop boundaries — slice from already-loaded batch
        first_frame = frames[0:1]
        last_frame  = frames[-1:]

        # Filename prefix — basename without extension
        filename_prefix = os.path.splitext(os.path.basename(video_path))[0]

        return (frames, frames_reversed, first_frame, last_frame,
                filename_prefix, width, height, fps)


# ─── API routes ──────────────────────────────────────────────────────────────
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/video_frame_extractor/info")
    async def video_info_handler(request):
        video_name = request.rel_url.query.get("video", "")
        if not video_name:
            return web.json_response({"error": "no video specified"}, status=400)
        try:
            video_path = folder_paths.get_annotated_filepath(video_name)
            info = get_video_info(video_path)
            return web.json_response(info)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/video_frame_extractor/thumbnail")
    async def video_thumbnail_handler(request):
        """Return a single JPEG frame at the requested position."""
        video_name  = request.rel_url.query.get("video", "")
        frame_index = int(request.rel_url.query.get("frame", 0))
        if not video_name:
            return web.Response(status=400)
        try:
            video_path = folder_paths.get_annotated_filepath(video_name)
            cap = cv2.VideoCapture(video_path)
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ret, frame = cap.read()
            cap.release()
            if not ret:
                return web.Response(status=404)
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img = Image.fromarray(frame_rgb)
            img.thumbnail((640, 360))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            body = buf.getvalue()
            buf.close()
            return web.Response(body=body, content_type="image/jpeg")
        except Exception as exc:
            return web.Response(status=500, text=str(exc))

except Exception:
    pass


# ─── Exports ─────────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS        = {"VideoFrameExtractor": VideoFrameExtractor}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoFrameExtractor": "Video Frame Extractor 🎞️"}
