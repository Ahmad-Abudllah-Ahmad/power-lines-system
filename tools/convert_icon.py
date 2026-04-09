import sys
from PIL import Image

png_path = sys.argv[1]
ico_path = sys.argv[2]

img = Image.open(png_path).convert("RGBA")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(ico_path, format="ICO", sizes=sizes)
print(f"Icon saved: {ico_path}")
