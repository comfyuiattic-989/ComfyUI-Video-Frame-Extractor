from .video_frame_extractor import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
import os

# Tell ComfyUI to serve the JS files in web/js/ at /extensions/video_frame_extractor/
WEB_DIRECTORY = os.path.join(os.path.dirname(__file__), "web")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
