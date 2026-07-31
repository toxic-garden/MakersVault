"""Server-side 3D thumbnail generation for STL / OBJ / 3MF files.

Uses ``trimesh`` to load the mesh and ``matplotlib`` (Agg backend, no display)
to render a smooth-shaded preview that is saved as a 512x512 PNG in the
existing ``THUMBS`` directory — the same location image thumbnails use.

The renderer uses ``Axes3D.plot_trisurf`` which gives Gouraud-like smooth
shading and a built-in light source.  This is a significant visual upgrade
over the previous ``Poly3DCollection`` flat-shading approach and avoids the
need for OpenGL/OSMesa in Docker deployments.

STEP / STP support is deferred to a follow-up because it requires
OpenCASCADE bindings (``python-occt`` / ``cadquery-ocp``) to convert the
B-rep to a mesh first.
"""

from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Optional

# Force the headless Agg backend *before* importing pyplot so matplotlib
# never tries to open a display.
import matplotlib

matplotlib.use("Agg", force=True)
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import trimesh  # noqa: E402

from db import THUMBS

logger = logging.getLogger("thumb_3d")

#: Extensions this module can handle (lowercase, with leading dot).
THUMB_3D_EXTS = {".stl", ".obj", ".3mf"}

#: Final thumbnail edge length in pixels.
THUMB_SIZE = 512

#: Render at 2x final size and downsample with a high-quality filter to
#: reduce triangulation artifacts and give a cleaner, anti-aliased result.
RENDER_SIZE = 1024

#: Camera angle matching the modal preview for a consistent look.
CAMERA_ELEV = 25
CAMERA_AZIM = -55


def generate_3d_thumbnail(asset_id: str, file_path: Path, ext: str) -> Optional[str]:
    """Render a 3D mesh file to a PNG thumbnail.

    Parameters
    ----------
    asset_id:
        The asset's database id — used to name the output file.
    file_path:
        Absolute path to the source mesh file on disk.
    ext:
        Lowercase extension *without* the leading dot (e.g. ``"stl"``).

    Returns
    -------
    str | None
        The URL path (``/thumb/<asset_id>.png``) on success, or ``None``
        if rendering failed for any reason.
    """
    try:
        loaded = trimesh.load(str(file_path), file_type=ext, force="scene")
    except Exception as exc:  # noqa: BLE001
        logger.warning("trimesh.load failed for %s: %s", file_path.name, exc)
        return None

    if isinstance(loaded, trimesh.Scene):
        scene = loaded
    else:
        # Single mesh — wrap it in a Scene so we get camera helpers.
        scene = trimesh.Scene(loaded)

    if not scene.geometry:
        logger.warning("No geometry in %s", file_path.name)
        return None

    try:
        return _render_scene_to_png(asset_id, scene)
    except Exception as exc:  # noqa: BLE001
        logger.warning("3D thumbnail render failed for %s: %s", file_path.name, exc)
        return None


def _render_scene_to_png(asset_id: str, scene: trimesh.Scene) -> Optional[str]:
    """Render a trimesh Scene to a transparent PNG using matplotlib."""
    # --- Collect all triangles across geometries ---------------------------
    vertices_list = []
    faces_list = []
    offset = 0
    for _name, geom in scene.geometry.items():
        if not hasattr(geom, "vertices") or not hasattr(geom, "faces"):
            continue
        if len(geom.vertices) == 0 or len(geom.faces) == 0:
            continue
        vertices_list.append(geom.vertices)
        faces_list.append(geom.faces + offset)
        offset += len(geom.vertices)

    if not vertices_list:
        return None

    vertices = np.vstack(vertices_list)
    faces = np.vstack(faces_list)

    # --- Centre and scale to fit a unit cube ---------------------------------
    bbox_min = vertices.min(axis=0)
    bbox_max = vertices.max(axis=0)
    centre = (bbox_min + bbox_max) / 2.0
    extents = bbox_max - bbox_min
    max_extent = float(extents.max()) or 1.0
    scale = 1.0 / max_extent

    v = (vertices - centre) * scale

    # --- Matplotlib smooth-shaded render ------------------------------------
    # plot_trisurf uses a built-in LightSource and interpolates shading
    # across triangles, giving a much smoother result than Poly3DCollection.
    from PIL import Image

    fig = plt.figure(figsize=(RENDER_SIZE / 100, RENDER_SIZE / 100), dpi=100)
    fig.patch.set_alpha(0.0)
    ax = fig.add_subplot(111, projection="3d")
    ax.set_axis_off()
    ax.patch.set_alpha(0.0)

    # A bright cyan/blue that matches the modal preview's default blue theme.
    # plot_trisurf applies its own directional shading on top.
    surf = ax.plot_trisurf(
        v[:, 0],
        v[:, 1],
        v[:, 2],
        triangles=faces,
        color="#87ceeb",
        shade=True,
        antialiased=True,
        linewidth=0,
    )

    # Tight framing; leave a little padding so the model isn't clipped.
    pad = 0.75
    ax.set_xlim(-pad, pad)
    ax.set_ylim(-pad, pad)
    ax.set_zlim(-pad, pad)
    try:
        ax.set_box_aspect((1, 1, 1))
    except Exception:  # older matplotlib
        pass

    ax.view_init(elev=CAMERA_ELEV, azim=CAMERA_AZIM)

    fig.subplots_adjust(left=0, right=1, bottom=0, top=1)
    fig.canvas.draw()

    buf = io.BytesIO()
    # Save as PNG to preserve the transparent background.
    fig.savefig(buf, format="png", dpi=100, transparent=True)
    plt.close(fig)

    buf.seek(0)
    with Image.open(buf) as im:
        # Keep RGBA for transparency.
        im = im.convert("RGBA")
        # Downsample from RENDER_SIZE to THUMB_SIZE to smooth edges.
        im = im.resize((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)
        thumb = THUMBS / f"{asset_id}.png"
        im.save(thumb, "PNG")

    return f"/thumb/{asset_id}.png"
