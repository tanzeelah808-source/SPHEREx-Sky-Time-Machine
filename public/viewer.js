(() => {
  const panel = document.getElementById("fits-viewer");
  if (!panel) return;

  const status = document.getElementById("viewer-status");
  const canvas = document.getElementById("fits-canvas");
  const layerSelect = document.getElementById("fits-layer");
  const displayModeSelect = document.getElementById("fits-display-mode");
  const resetButton = document.getElementById("fits-reset");
  const meta = document.getElementById("fits-meta");
  const ctx = canvas.getContext("2d");

  let current = null;
  let currentCoordinates = null;
  const realColorCache = new Map();
  let realColorRequest = 0;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let loadSequence = 0;
  let previewSequence = 0;

  const rad = Math.PI / 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function worldToPixel(wcs, ra, dec) {
    const a0 = Number(wcs.CRVAL1) * rad;
    const d0 = Number(wcs.CRVAL2) * rad;
    const a = ra * rad;
    const d = dec * rad;
    const da = ((a - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const denominator = Math.sin(d) * Math.sin(d0) +
      Math.cos(d) * Math.cos(d0) * Math.cos(da);

    if (!Number.isFinite(denominator) || denominator <= 0) return null;

    const xi = Math.cos(d) * Math.sin(da) / denominator / rad;
    const eta = (Math.sin(d) * Math.cos(d0) -
      Math.cos(d) * Math.sin(d0) * Math.cos(da)) / denominator / rad;

    const cd11 = Number(wcs.CD1_1 ?? (Number(wcs.PC1_1 ?? 1) * Number(wcs.CDELT1 ?? 1)));
    const cd12 = Number(wcs.CD1_2 ?? (Number(wcs.PC1_2 ?? 0) * Number(wcs.CDELT1 ?? 1)));
    const cd21 = Number(wcs.CD2_1 ?? (Number(wcs.PC2_1 ?? 0) * Number(wcs.CDELT2 ?? 1)));
    const cd22 = Number(wcs.CD2_2 ?? (Number(wcs.PC2_2 ?? 1) * Number(wcs.CDELT2 ?? 1)));
    const determinant = cd11 * cd22 - cd12 * cd21;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-20) return null;

    let u = (cd22 * xi - cd12 * eta) / determinant;
    let v = (-cd21 * xi + cd11 * eta) / determinant;

    const polynomial = (prefix, order) => {
      let sum = 0;
      const maxOrder = Number(wcs[prefix + "_ORDER"] || 0);
      for (let i = 0; i <= maxOrder; i++) {
        for (let j = 0; j <= maxOrder - i; j++) {
          const coefficient = Number(wcs[prefix + "_" + i + "_" + j] || 0);
          if (coefficient) sum += coefficient * Math.pow(u, i) * Math.pow(v, j);
        }
      }
      return sum;
    };

    u += polynomial("A");
    v += polynomial("B");

    return {
      x: Number(wcs.CRPIX1) - 1 + u,
      y: Number(wcs.CRPIX2) - 1 + v
    };
  }

  function percentile(sorted, fraction) {
    if (!sorted.length) return 0;
    return sorted[Math.floor((sorted.length - 1) * fraction)];
  }

  function samplePercentiles(values, limit = 20000) {
    const sample = [];
    const stride = Math.max(1, Math.ceil(values.length / limit));
    for (let i = 0; i < values.length; i += stride) {
      const value = values[i];
      if (Number.isFinite(value)) sample.push(value);
    }
    // Sparse/mostly-NaN layers need a fallback scan so the sample is not empty.
    if (sample.length < 1000) {
      sample.length = 0;
      for (let i = 0; i < values.length && sample.length < limit; i++) {
        const value = values[i];
        if (Number.isFinite(value)) sample.push(value);
      }
    }
    sample.sort((a, b) => a - b);
    return sample;
  }

  function makeLayerImage() {
    const width = current.metadata.width;
    const height = current.metadata.height;
    const key = layerSelect.value;
    if (!current.renderedLayers) current.renderedLayers = new Map();
    if (current.renderedLayers.has(key)) return current.renderedLayers.get(key);
    const values = current.layers[key] || current.layers.image;
    // Approximate robust display limits from at most 20k samples instead of
    // sorting every detector pixel. The original FITS values are never changed.
    const sample = key === "flags" ? [] : samplePercentiles(values);
    const low = key === "flags" ? 0 : percentile(sample, key === "image" ? 0.005 : 0.01);
    const high = key === "flags" ? 1 : percentile(sample, key === "image" ? 0.995 : 0.99);
    const range = high > low ? high - low : 1;
    const pixels = new ImageData(width, height);

    // False-colour display is a visualization only; the cached FITS values
    // remain unchanged. Robust percentile limits prevent a few extremes
    // from washing out the rest of the detector image.
    const scienceStops = [
      [0.00, 5, 8, 24],
      [0.18, 20, 35, 94],
      [0.38, 36, 112, 150],
      [0.60, 75, 190, 177],
      [0.82, 238, 190, 92],
      [1.00, 255, 248, 220]
    ];

    function scienceColour(t) {
      for (let i = 1; i < scienceStops.length; i++) {
        if (t <= scienceStops[i][0]) {
          const a = scienceStops[i - 1];
          const b = scienceStops[i];
          const f = (t - a[0]) / (b[0] - a[0]);
          return [
            Math.round(a[1] + (b[1] - a[1]) * f),
            Math.round(a[2] + (b[2] - a[2]) * f),
            Math.round(a[3] + (b[3] - a[3]) * f)
          ];
        }
      }
      return [255, 248, 220];
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sourceIndex = y * width + x;
        const destinationIndex = ((height - 1 - y) * width + x) * 4;
        const value = values[sourceIndex];

        if (!Number.isFinite(value)) {
          pixels.data[destinationIndex + 3] = 0;
          continue;
        }

        if (key === "flags") {
          const flagged = value !== 0;
          pixels.data[destinationIndex] = flagged ? 255 : 18;
          pixels.data[destinationIndex + 1] = flagged ? 92 : 22;
          pixels.data[destinationIndex + 2] = flagged ? 64 : 30;
        } else {
          let t = clamp((value - low) / range, 0, 1);
          if (key === "image") {
            // Asinh reveals faint structure while retaining bright peaks.
            t = Math.asinh(t * 6) / Math.asinh(6);
            const colour = scienceColour(t);
            pixels.data[destinationIndex] = colour[0];
            pixels.data[destinationIndex + 1] = colour[1];
            pixels.data[destinationIndex + 2] = colour[2];
          } else {
            t = Math.sqrt(t);
            const shade = Math.round(t * 255);
            pixels.data[destinationIndex] = shade;
            pixels.data[destinationIndex + 1] = shade;
            pixels.data[destinationIndex + 2] = shade;
          }
        }
        pixels.data[destinationIndex + 3] = 255;
      }
    }

    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;
    offscreen.getContext("2d").putImageData(pixels, 0, 0);
    current.renderedLayers.set(key, offscreen);
    return offscreen;
  }

  function draw() {
    if (!current) return;

    const isRealColor = displayModeSelect.value === "real-colour";
    let display;
    let width;
    let height;
    let targetPixel;

    if (isRealColor) {
      const key = currentCoordinates
        ? currentCoordinates.ra.toFixed(8) + "|" + currentCoordinates.dec.toFixed(8)
        : "";
      display = realColorCache.get(key);
      if (!display) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#050a12";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#a9c4dc";
        ctx.font = "13px ui-monospace, monospace";
        ctx.fillText("Loading Pan-STARRS visible-light colour image…", 18, 30);
        return;
      }
      width = display.naturalWidth;
      height = display.naturalHeight;
      targetPixel = { x: (width - 1) / 2, y: (height - 1) / 2 };
    } else {
      width = current.metadata.width;
      height = current.metadata.height;
      display = makeLayerImage();
      targetPixel = current.targetPixel;
    }

    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    const baseScale = Math.min(canvasWidth / width, canvasHeight / height);
    const scale = baseScale * zoom;
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    const originX = (canvasWidth - drawWidth) / 2 + panX;
    const originY = (canvasHeight - drawHeight) / 2 + panY;

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = "#050a12";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(display, originX, originY, drawWidth, drawHeight);

    if (targetPixel &&
        targetPixel.x >= 0 && targetPixel.x < width &&
        targetPixel.y >= 0 && targetPixel.y < height) {
      const x = originX + (targetPixel.x + 0.5) * scale;
      const y = originY + (height - 1 - targetPixel.y + 0.5) * scale;
      const arm = Math.max(7, Math.min(18, 10 * zoom));

      ctx.strokeStyle = "#ff554d";
      ctx.lineWidth = Math.max(1.5, 2 * Math.min(zoom, 2));
      ctx.beginPath();
      ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, arm * 0.75, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = "#d9e8fa";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText((isRealColor ? "Pan-STARRS1 real sky colour · " : "SPHEREx false colour · ") +
      "Zoom " + zoom.toFixed(1) + "× · " + width + " × " + height + " px", 12, 20);
  }

  async function loadRealColor() {
    if (!currentCoordinates) return false;
    const coordinates = { ...currentCoordinates };
    const key = coordinates.ra.toFixed(8) + "|" + coordinates.dec.toFixed(8);
    if (realColorCache.has(key)) {
      draw();
      return true;
    }

    const requestId = ++realColorRequest;
    status.className = "status";
    status.textContent = "Retrieving Pan-STARRS1 g/r/i visible-light colour image for the same sky position…";
    try {
      const response = await fetch("/api/realcolor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(coordinates)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "Pan-STARRS image unavailable.");

      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("The Pan-STARRS JPEG could not be decoded."));
        image.src = data.imageDataUrl;
      });
      realColorCache.set(key, image);
      while (realColorCache.size > 4) realColorCache.delete(realColorCache.keys().next().value);

      if (requestId === realColorRequest &&
          currentCoordinates &&
          key === currentCoordinates.ra.toFixed(8) + "|" + currentCoordinates.dec.toFixed(8)) {
        draw();
        status.className = "status good";
        status.textContent = "Loaded Pan-STARRS1 stacked visible-light reference (g/r/i mapped to blue/green/red). This image is static across epochs; it is not time-resolved SPHEREx data.";
      }
      return true;
    } catch (error) {
      if (requestId === realColorRequest) {
        status.className = "status bad";
        status.textContent = "Real sky colour unavailable: " + error.message;
        draw();
      }
      return false;
    }
  }

  function drawTemporaryPreview(image, token) {
    if (token !== previewSequence || current) return;
    const cw = canvas.width, ch = canvas.height;
    const scale = Math.min(cw / image.naturalWidth, ch / image.naturalHeight);
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#050a12";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(image, (cw - w) / 2, (ch - h) / 2, w, h);
    ctx.fillStyle = "rgba(4,12,24,.88)";
    ctx.fillRect(8, 8, Math.min(cw - 16, 430), 25);
    ctx.fillStyle = "#ffd18a";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText("TEMPORARY PAN-STARRS REFERENCE · LOADING SPHEREx FITS", 15, 25);
  }

  async function showTemporaryPreview(coordinates, token) {
    const key = coordinates.ra.toFixed(8) + "|" + coordinates.dec.toFixed(8);
    if (realColorCache.has(key)) {
      drawTemporaryPreview(realColorCache.get(key), token);
      return;
    }
    try {
      const response = await fetch("/api/realcolor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(coordinates),
        signal: AbortSignal.timeout(12000)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "Preview unavailable");
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("Preview image could not be decoded"));
        image.src = data.imageDataUrl;
      });
      realColorCache.set(key, image);
      while (realColorCache.size > 4) realColorCache.delete(realColorCache.keys().next().value);
      drawTemporaryPreview(image, token);
    } catch (error) {
      // The scientific FITS request continues independently if no preview is available.
      console.info("Temporary sky preview unavailable:", error?.message || error);
    }
  }

  function resizeCanvas() {
    const width = Math.max(320, canvas.clientWidth);
    const height = Math.max(320, Math.min(560, Math.round(width * 0.68)));
    canvas.width = width;
    canvas.height = height;
    canvas.style.height = height + "px";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (current) draw();
  }

  function showMetadata(data) {
    const m = data.metadata;
    const items = [
      ["Observation", m.observationId || "Not supplied"],
      ["Observed", m.dateObs || "Not supplied"],
      ["MJD", m.mjdObs ?? "Not supplied"],
      ["Pixel unit", m.unit || "Not supplied"],
      ["PSF FWHM", m.psfFwhm == null ? "Not supplied" : m.psfFwhm]
    ];
    meta.innerHTML = items.map(([k, v]) =>
      '<div><span>' + k + '</span><strong>' + String(v).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])) + '</strong></div>'
    ).join("");
  }

  const cutoutCache = new Map();
  const pendingCutouts = new Map();
  const MAX_CACHED_CUTOUTS = 12;

  function cutoutCacheKey(record, coordinates) {
    const ra = Number(coordinates?.ra ?? document.getElementById("ra").value);
    const dec = Number(coordinates?.dec ?? document.getElementById("dec").value);
    return [record.access_url, ra.toFixed(8), dec.toFixed(8), "0.05"].join("|");
  }

  async function fetchCutoutData(record, coordinates = null) {
    const key = cutoutCacheKey(record, coordinates);

    if (cutoutCache.has(key)) {
      const cached = cutoutCache.get(key);
      cutoutCache.delete(key);
      cutoutCache.set(key, cached);
      return cached;
    }

    if (pendingCutouts.has(key)) return pendingCutouts.get(key);

    const request = (async () => {
      const ra = Number(coordinates?.ra ?? document.getElementById("ra").value);
      const dec = Number(coordinates?.dec ?? document.getElementById("dec").value);
      const response = await fetch("/api/cutout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(22000),
        body: JSON.stringify({ accessUrl: record.access_url, ra, dec, size: 0.05 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "Cutout request failed.");

      cutoutCache.set(key, data);
      while (cutoutCache.size > MAX_CACHED_CUTOUTS) {
        cutoutCache.delete(cutoutCache.keys().next().value);
      }
      return data;
    })();

    pendingCutouts.set(key, request);
    try {
      return await request;
    } finally {
      pendingCutouts.delete(key);
    }
  }

  async function openCutout(button, coordinates = null, options = {}) {
    const thisLoad = ++loadSequence;
    const accessUrl = button.dataset.accessUrl;
    const ra = Number(coordinates?.ra ?? document.getElementById("ra").value);
    const dec = Number(coordinates?.dec ?? document.getElementById("dec").value);

    if (!accessUrl || !Number.isFinite(ra) || !Number.isFinite(dec)) {
      status.textContent = "The archive product or search coordinates are missing.";
      status.className = "status bad";
      return false;
    }

    // Timeline playback changes observations repeatedly; do not force the
    // page to scroll back to the viewer on every epoch.
    if (!options.quiet) {
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    status.className = "status";
    status.textContent = "Requesting a real FITS cutout from NASA/IPAC IRSA…";
    meta.innerHTML = "";
    current = null;
    zoom = 1; panX = 0; panY = 0;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#050a12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#8faac2";
    ctx.font = "14px ui-monospace, monospace";
    ctx.fillText("Loading selected SPHEREx observation…", 18, 30);
    currentCoordinates = { ra, dec };
    // Do not paint a Pan-STARRS placeholder over the selected SPHEREx
    // display mode during timeline playback. It is a static survey image,
    // not an epoch-specific observation.
    previewSequence++;

    try {
      const data = await fetchCutoutData({ access_url: accessUrl }, { ra, dec });
      if (thisLoad !== loadSequence) return false;

      const pixel = worldToPixel(data.metadata.wcs || {}, ra, dec);
      current = {
        metadata: data.metadata,
        layers: data.layers,
        targetPixel: pixel,
        renderedLayers: new Map()
      };
      currentCoordinates = { ra, dec };
      displayModeSelect.disabled = false;

      const previouslySelectedLayer = layerSelect.value;
      const layerNames = ["image", "variance", "flags", "zodi"]
        .filter(name => Array.isArray(data.layers[name]));
      layerSelect.innerHTML = layerNames.map(name =>
        '<option value="' + name + '">' +
        ({image:"Science image · false colour",variance:"Variance",flags:"Quality flags",zodi:"Zodiacal foreground"}[name] || name) +
        '</option>'
      ).join("");
      layerSelect.value = layerNames.includes(previouslySelectedLayer)
        ? previouslySelectedLayer
        : (layerNames.includes("image") ? "image" : (layerNames[0] || ""));
      layerSelect.disabled = layerNames.length < 2 || displayModeSelect.value === "real-colour";
      zoom = 1; panX = 0; panY = 0;
      resizeCanvas();
      if (displayModeSelect.value === "real-colour") loadRealColor();
      else draw();
      showMetadata(data);
      const inside = pixel && pixel.x >= 0 && pixel.x < data.metadata.width &&
        pixel.y >= 0 && pixel.y < data.metadata.height;
      status.className = "status good";
      status.textContent = "Loaded real SPHEREx FITS cutout · " +
        data.metadata.width + " × " + data.metadata.height + " pixels" +
        (inside ? " · searched coordinate marked in red." : " · searched coordinate falls outside this cutout.");
      return true;
    } catch (error) {
      if (thisLoad !== loadSequence) return false;
      if (!options.quiet) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#050a12";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#ffb18b";
        ctx.font = "13px ui-monospace, monospace";
        ctx.fillText("Observation could not be loaded. Try again or skip to the next epoch.", 18, 30);
        status.className = "status bad";
        status.textContent = "FITS viewer error: " + error.message;
      }
      return false;
    }
  }

  window.SpherexViewer = {
    loadRecord(record, coordinates, options = {}) {
      if (!record || typeof record.access_url !== "string") return Promise.resolve(false);
      return openCutout({ dataset: { accessUrl: record.access_url } }, coordinates, options);
    },
    async preloadRecord(record, coordinates) {
      if (!record || typeof record.access_url !== "string") return false;
      try {
        await fetchCutoutData(record, coordinates);
        return true;
      } catch (error) {
        console.warn("SPHEREx background preload failed:", error?.message || error);
        return false;
      }
    }
  };

  document.addEventListener("click", event => {
    const button = event.target.closest(".view-cutout");
    if (button) openCutout(button);
  });

  layerSelect.addEventListener("change", draw);
  displayModeSelect.addEventListener("change", () => {
    const realColorMode = displayModeSelect.value === "real-colour";
    layerSelect.disabled = realColorMode || !current ||
      (!Array.isArray(current.layers.variance) &&
       !Array.isArray(current.layers.flags) &&
       !Array.isArray(current.layers.zodi));
    if (realColorMode) loadRealColor();
    else draw();
  });
  resetButton.addEventListener("click", () => {
    zoom = 1; panX = 0; panY = 0; draw();
  });

  canvas.addEventListener("wheel", event => {
    if (!current) return;
    event.preventDefault();
    zoom = clamp(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), 0.5, 18);
    draw();
  }, { passive: false });

  canvas.addEventListener("pointerdown", event => {
    if (!current) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!dragging) return;
    panX += event.clientX - lastX;
    panY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    draw();
  });
  canvas.addEventListener("pointerup", () => { dragging = false; });
  canvas.addEventListener("pointercancel", () => { dragging = false; });
  window.addEventListener("resize", resizeCanvas);

  resizeCanvas();
})();