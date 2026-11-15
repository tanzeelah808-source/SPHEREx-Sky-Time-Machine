(() => {
  const root = document.getElementById("time-machine");
  if (!root) return;

  const style = document.createElement("style");
  style.textContent = `
    .timeline-panel{margin:14px 0 16px;padding:15px;background:linear-gradient(120deg,#0b1d2a,#11182b);border:1px solid #31516b;border-radius:12px}
    .timeline-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
    .timeline-heading strong{display:block;color:#dff8ff;font-size:14px;letter-spacing:.02em}
    .timeline-heading span{display:block;color:#8faac2;font-size:11px}
    .timeline-index{font:700 12px ui-monospace,monospace!important;color:#67e8f9!important;white-space:nowrap}
    .timeline-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .timeline-actions button{border:1px solid #34546a;border-radius:7px;padding:8px 11px;background:#10283a;color:#d9f5ff;font:700 12px inherit;cursor:pointer}
    .timeline-actions button:disabled{opacity:.4;cursor:not-allowed}
    .timeline-actions label{margin:0 0 0 6px;color:#9db4c9;font-size:11px}
    .timeline-actions select{width:auto;min-width:210px;max-width:100%;padding:8px;background:#081221;border:1px solid #30445f;border-radius:7px;color:#edf4ff;font-size:12px}
    #timeline-range{display:block;width:100%;margin:14px 0 7px;accent-color:#67e8f9;cursor:pointer}
    .timeline-caption{color:#d5e3f6;font:12px ui-monospace,monospace;overflow-wrap:anywhere}
    .timeline-caption[data-state="loading"]{color:#ffd18a}
    .timeline-caption[data-state="error"]{color:#ffb18b}
    .epoch-data{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin-top:12px}
    .epoch-data div{padding:10px;background:#081522;border:1px solid #29445c;border-radius:9px;min-width:0}
    .epoch-data span{display:block;color:#8faac2;font-size:10px;text-transform:uppercase;letter-spacing:.07em}
    .epoch-data strong{display:block;margin-top:3px;color:#e4f5ff;font-size:12px;overflow-wrap:anywhere}
    .epoch-data .wide{grid-column:1/-1}
    .timeline-note{margin-top:8px;color:#819bb4;font-size:10px;line-height:1.45}
    @media(max-width:600px){.timeline-actions label{margin-left:0}.timeline-actions select{flex:1;min-width:150px}}
  `;
  document.head.appendChild(style);

  const range = document.getElementById("timeline-range");
  const previous = document.getElementById("timeline-prev");
  const play = document.getElementById("timeline-play");
  const next = document.getElementById("timeline-next");
  const productSelect = document.getElementById("timeline-product");
  const modeSelect = document.getElementById("timeline-mode");
  const summary = document.getElementById("timeline-summary");
  const indexLabel = document.getElementById("timeline-index");
  const caption = document.getElementById("timeline-caption");
  const targetData = document.getElementById("epoch-target-data");
  if (targetData) targetData.setAttribute("aria-live", "polite");
  let targetKey = "custom";
  let properMotionModel = null;
  let epochs = [];
  let allEpochs = [];
  let activeIndex = 0;
  let activeProduct = 0;
  let searchCoordinates = null;
  let playing = false;
  let playbackToken = 0;
  let selectionToken = 0;
  const number = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  function productLabel(record, position) {
    const band = record.energy_bandpassname || record.band || record.instrument_name || ("Product " + (position + 1));
    const low = number(record.em_min);
    const high = number(record.em_max);
    if (low !== null && high !== null && low > 0 && high > 0) {
      return band + " · " + (low * 1e6).toFixed(3) + "–" + (high * 1e6).toFixed(3) + " μm";
    }
    return String(band);
  }

  function utcFromMjd(mjd) {
    if (mjd === null) return "UTC time unavailable";
    const date = new Date((mjd - 40587) * 86400000);
    return Number.isNaN(date.getTime())
      ? "UTC time unavailable"
      : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  }

  function julianYearFromMjd(mjd) {
    return 2000 + (mjd - 51544.5) / 365.25;
  }

  // SIMBAD-style proper motion: pmRA is mu_alpha*cos(dec), in mas/year.
  // Barnard's Star catalog reference position is ICRS at J2000.0.
  const TARGET_MODELS = {
    epsilon: {
      name: "Epsilon Indi B (Ba/Bb; systemic PM)",
      // SIMBAD J2000 position for Epsilon Indi B. Its component page does
      // not publish a separate PM here, so use the Gaia DR3 primary's
      // systemic proper motion as an explicitly approximate bound-system proxy.
      ra0: 331.0441465885,
      dec0: -56.7828441951,
      pmRa: 3966.661,
      pmDec: -2536.192,
      referenceEpoch: 2000.0,
      searchEpoch: 2026.0,
      searchRa: 331.0964419304,
      searchDec: -56.8011611373
    },
    rwaur: {
      name: "RW Aurigae",
      // SIMBAD J2000 ICRS position and proper motion, from
      // 2007A&A...474..653V; pmRA = mu_alpha*cos(dec), mas/year.
      ra0: 76.9565260346,
      dec0: 30.4014381739,
      pmRa: 7.23,
      pmDec: -20.33,
      referenceEpoch: 2000.0,
      searchEpoch: 2026.0,
      searchRa: 76.9565865756,
      searchDec: 30.4012913461
    },
    rdraco: {
      name: "R Draconis",
      // SIMBAD/Gaia DR3 J2000 ICRS position and proper motion;
      // pmRA = mu_alpha*cos(dec), mas/year.
      ra0: 248.1676108330,
      dec0: 66.7549794172,
      pmRa: -20.643,
      pmDec: 6.149,
      referenceEpoch: 2000.0,
      searchEpoch: 2026.0,
      searchRa: 248.1672330728,
      searchDec: 66.7550238267
    },
    wise: {
      name: "WISE 0855−0714",
      // SIMBAD/Kirkpatrick et al. 2021: ICRS J2000 position and
      // proper motion (mu_alpha*cos(dec), mu_delta), in mas/year.
      ra0: 133.795132,
      dec0: -7.245146,
      pmRa: -8123.7,
      pmDec: 673.2,
      referenceEpoch: 2000.0,
      searchEpoch: 2026.0,
      searchRa: 133.795129,
      searchDec: -7.245147
    },
    barnard: {
      name: "Barnard's Star",
      ra0: 269.452077,
      dec0: 4.693365,
      pmRa: -801.551,
      pmDec: 10362.394,
      referenceEpoch: 2000.0,
      searchEpoch: 2026.0,
      searchRa: 269.446269,
      searchDec: 4.768204
    }
  };

  function positionForEpoch(mjd) {
    const year = julianYearFromMjd(mjd);
    if (!properMotionModel) {
      return {
        year,
        ra: searchCoordinates.ra,
        dec: searchCoordinates.dec,
        shiftArcsec: null,
        propagated: false
      };
    }
    const model = properMotionModel;
    const dt = year - model.referenceEpoch;
    const dec = model.dec0 + model.pmDec * dt / 3600000;
    const ra = ((model.ra0 + model.pmRa * dt /
      (3600000 * Math.cos(model.dec0 * Math.PI / 180))) % 360 + 360) % 360;
    const shiftYears = year - model.searchEpoch;
    const shiftArcsec = Math.hypot(model.pmRa * shiftYears, model.pmDec * shiftYears) / 1000;
    return { year, ra, dec, shiftArcsec, propagated: true };
  }

  function renderEpochData(epoch, record, position) {
    const band = record?.energy_bandpassname || record?.band || record?.instrument_name || "Not supplied";
    const wavelength = number(record?.em_min) !== null && number(record?.em_max) !== null
      ? (Number(record.em_min) * 1e6).toFixed(3) + "–" + (Number(record.em_max) * 1e6).toFixed(3) + " μm"
      : "Not supplied";
    const displacement = position.propagated
      ? position.shiftArcsec.toFixed(3) + " arcsec from 2026.0"
      : "Not calculated · no verified motion model";
    const properMotion = properMotionModel
      ? "μα cos δ " + properMotionModel.pmRa.toFixed(3) + " · μδ " + properMotionModel.pmDec.toFixed(3) + " mas/yr"
      : "Not configured for this target";
    const cells = [
      ["Target", properMotionModel ? properMotionModel.name : targetKey],
      ["Right Ascension (ICRS)", position.ra.toFixed(8) + "°"],
      ["Declination (ICRS)", (position.dec >= 0 ? "+" : "") + position.dec.toFixed(8) + "°"],
      ["Motion model", position.propagated ? "Active · linear proper-motion propagation" : "Inactive · fixed search coordinates"],
      ["Observation epoch", "J" + position.year.toFixed(6)],
      ["Observation date (UTC)", utcFromMjd(epoch.mjd)],
      ["MJD", Number(epoch.mjd).toFixed(6)],
      ["Collection", record?.collection || "Not supplied"],
      ["Spectral band", band],
      ["Wavelength range", wavelength],
      ["Observation ID", epoch.observationId || "Not supplied"],
      ["Position shift", displacement],
      ["Proper motion", properMotion]
    ];
    targetData.innerHTML = cells.map(([label, value]) =>
      '<div class="' + (label === "Right Ascension (ICRS)" || label === "Declination (ICRS)" ? "coordinate-cell" : "") + '"><span>' + label + '</span><strong>' +
      String(value).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])) +
      '</strong></div>'
    ).join("");
  }

  function stopPlayback() {
    playing = false;
    playbackToken++;
    play.textContent = "▶ Play";
  }

  function buildEpochs(rows) {
    const usable = rows.filter(row =>
      row && typeof row.access_url === "string" &&
      /^https:\/\/irsa\.ipac\.caltech\.edu\/ibe\/data\/spherex\//i.test(row.access_url) &&
      number(row.t_min ?? row.mjd_obs ?? row.mjd) !== null
    );

    const groups = new Map();
    for (const row of usable) {
      const mjd = number(row.t_min ?? row.mjd_obs ?? row.mjd);
      const observationId = row.obs_id || row.obs_publisher_did || null;
      const key = observationId ? "obs:" + observationId : "mjd:" + mjd.toFixed(8);
      if (!groups.has(key)) groups.set(key, { observationId, mjd, products: [] });
      const group = groups.get(key);
      group.mjd = Math.min(group.mjd, mjd);
      group.products.push(row);
    }

    return [...groups.values()]
      .map(epoch => ({
        ...epoch,
        products: epoch.products.sort((a, b) =>
          (number(a.em_min) ?? Infinity) - (number(b.em_min) ?? Infinity)
        )
      }))
      .sort((a, b) => a.mjd - b.mjd);
  }

  const preloadQueue = [];
  const queuedPreloads = new Set();
  let preloadWorkersRunning = 0;
  const PRELOAD_WORKERS = 1;

  function runPreloadWorkers() {
    while (preloadWorkersRunning < PRELOAD_WORKERS && preloadQueue.length) {
      const job = preloadQueue.shift();
      preloadWorkersRunning++;
      Promise.resolve(window.SpherexViewer.preloadRecord(job.record, job.coordinates))
        .catch(error => console.warn("Timeline preload failed:", error))
        .finally(() => {
          preloadWorkersRunning--;
          runPreloadWorkers();
        });
    }
  }

  function preloadUpcoming(index) {
    if (!window.SpherexViewer?.preloadRecord || epochs.length < 2) return;

    // Keep only a short look-ahead. Preloading the entire timeline can
    // launch more than a hundred archive requests for a single search.
    const lookAhead = Math.min(1, epochs.length - 1);
    const currentRecord = epochs[index]?.products?.[activeProduct];
    const preferredIdentity = productIdentity(currentRecord);
    for (let offset = 1; offset <= lookAhead; offset++) {
      const epoch = epochs[index + offset];
      if (!epoch) continue;
      // Preload the same spectral product the viewer will preserve on the
      // next epoch, rather than blindly warming products[0].
      const matchingIndex = preferredIdentity
        ? epoch.products.findIndex(item => productIdentity(item) === preferredIdentity)
        : -1;
      const record = epoch.products?.[matchingIndex >= 0 ? matchingIndex : 0];
      const coordinates = positionForEpoch(epoch.mjd);
      const key = record?.access_url + "|" + coordinates.ra + "|" + coordinates.dec;
      if (record && record.access_url && !queuedPreloads.has(key)) {
        queuedPreloads.add(key);
        preloadQueue.push({ record, key, coordinates: { ra: coordinates.ra, dec: coordinates.dec } });
      }
    }
    runPreloadWorkers();
  }

  function chooseSequence(source, mode) {
    if (mode === "all" || source.length <= 12) return source.slice();
    const count = 12;
    const chosen = [];
    for (let i = 0; i < count; i++) {
      const index = Math.round(i * (source.length - 1) / (count - 1));
      if (!chosen.length || chosen[chosen.length - 1] !== source[index]) chosen.push(source[index]);
    }
    return chosen;
  }

  function productIdentity(record) {
    return String(record.energy_bandpassname || record.band || record.instrument_name || "")
      .trim().toLowerCase();
  }

  async function selectEpoch(index, productIndex = null, direction = 1) {
    if (!epochs.length) return false;
    const previousEpoch = epochs[activeIndex];
    const previousRecord = previousEpoch?.products?.[activeProduct];
    const preferredProduct = productIdentity(previousRecord);
    const token = ++selectionToken;
    const step = direction < 0 ? -1 : 1;
    const firstIndex = (index + epochs.length) % epochs.length;

    summary.textContent = epochs.length + " playback epochs · " + allEpochs.length +
      " total archive epochs · " + allEpochs.reduce((total, item) => total + item.products.length, 0) + " FITS products";

    for (let offset = 0; offset < epochs.length; offset++) {
      const epochIndex = (firstIndex + step * offset + epochs.length * 2) % epochs.length;
      const epoch = epochs[epochIndex];
      if (!epoch?.products?.length) continue;

      activeIndex = epochIndex;
      const matchingProduct = preferredProduct
        ? epoch.products.findIndex(item => productIdentity(item) === preferredProduct)
        : -1;
      const requestedProduct = offset === 0 && productIndex !== null && productIndex !== undefined
        ? Math.max(0, Math.min(epoch.products.length - 1, productIndex))
        : (matchingProduct >= 0 ? matchingProduct : 0);
      // Refresh the epoch readout immediately on selection, not only after
      // the FITS request finishes. This keeps the UI synchronized during loading.
      const selectedEpochPosition = positionForEpoch(epoch.mjd);
      renderEpochData(epoch, epoch.products[requestedProduct], selectedEpochPosition);

      const productOrder = [
        requestedProduct,
        ...epoch.products.map((_, i) => i).filter(i => i !== requestedProduct)
      ];

      range.value = String(activeIndex);
      indexLabel.textContent = (activeIndex + 1) + " / " + epochs.length;
      caption.textContent =
        utcFromMjd(epoch.mjd) + " · MJD " + epoch.mjd.toFixed(6) +
        (epoch.observationId ? " · " + epoch.observationId : "");
      productSelect.innerHTML = "";
      epoch.products.forEach((item, i) => {
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = productLabel(item, i);
        productSelect.appendChild(option);
      });

      root.dataset.loading = "true";
      caption.dataset.state = "loading";
      let loaded = false;
      let loadedProduct = -1;
      for (const candidate of productOrder) {
        if (token !== selectionToken) return false;
        activeProduct = candidate;
        productSelect.value = String(candidate);
        const epochPosition = positionForEpoch(epoch.mjd);
        loaded = await window.SpherexViewer.loadRecord(epoch.products[candidate], {
          ra: epochPosition.ra,
          dec: epochPosition.dec
        }, { quiet: true });
        if (token !== selectionToken) return false;
        if (loaded) {
          loadedProduct = candidate;
          renderEpochData(epoch, epoch.products[candidate], epochPosition);
          break;
        }
      }

      root.dataset.loading = "false";
      if (loaded) {
        caption.dataset.state = "loaded";
        if (loadedProduct !== requestedProduct) {
          caption.textContent += " · preferred product unavailable; loaded another product.";
        }
        if (offset > 0) {
          caption.textContent += " · skipped " + offset + " unavailable epoch" + (offset === 1 ? "" : "s") + ".";
        }
        preloadUpcoming(activeIndex);
        return true;
      }

      // Keep failed records in the archive, but do not present their error
      // frames as playable observations. Continue to the next candidate.
    }

    root.dataset.loading = "false";
    caption.dataset.state = "error";
    caption.textContent = "No loadable FITS observations were found in this sequence. The archive records remain available in the results table.";
    return false;
  }

  const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));

  async function advance(token) {
    // A single controlled loop avoids recursive playback races and continues
    // only after the current FITS request has settled.
    while (playing && token === playbackToken && epochs.length > 1) {
      const nextIndex = (activeIndex + 1) % epochs.length;
      const loaded = await selectEpoch(nextIndex, null, 1);
      if (!playing || token !== playbackToken) return;
      if (!loaded) {
        stopPlayback();
        caption.dataset.state = "error";
        caption.textContent = "Playback stopped: no loadable FITS observations remain.";
        return;
      }
      await wait(1100);
    }
  }

  function setTimeline(rows, ra, dec, selectedTarget = "custom") {
    stopPlayback();
    selectionToken++;
    preloadQueue.length = 0;
    queuedPreloads.clear();
    allEpochs = buildEpochs(Array.isArray(rows) ? rows : []);
    modeSelect.value = "highlights";
    epochs = chooseSequence(allEpochs, "highlights");
    searchCoordinates = { ra, dec };
    // Prefer the explicit preset selection. If the user entered a known
    // preset's coordinates manually while the selector still says Custom,
    // recover the identity from a tight catalog-position match.
    const selectedModel = TARGET_MODELS[selectedTarget];
    const inferredKey = !selectedModel && selectedTarget === "custom"
      ? Object.keys(TARGET_MODELS).find(key =>
          Math.abs(ra - TARGET_MODELS[key].searchRa) < 0.001 &&
          Math.abs(dec - TARGET_MODELS[key].searchDec) < 0.001)
      : null;
    targetKey = selectedModel ? selectedTarget : (inferredKey || selectedTarget || "custom");
    const model = TARGET_MODELS[targetKey];
    // Allow tiny input rounding, but don't activate a model for a nearby
    // unrelated coordinate.
    properMotionModel = model &&
      Math.abs(ra - model.searchRa) < 0.001 &&
      Math.abs(dec - model.searchDec) < 0.001
        ? model
        : null;
    targetData.innerHTML = "";
    activeIndex = 0;
    activeProduct = 0;

    if (!allEpochs.length) {
      root.hidden = true;
      return;
    }

    root.hidden = false;
    modeSelect.disabled = allEpochs.length <= 1;
    range.min = "0";
    range.max = String(epochs.length - 1);
    range.value = "0";
    range.disabled = epochs.length < 2;
    previous.disabled = epochs.length < 2;
    next.disabled = epochs.length < 2;
    play.disabled = epochs.length < 2;
    productSelect.disabled = false;
    selectEpoch(0, 0, 1);
  }

  modeSelect.addEventListener("change", () => {
    stopPlayback();
    epochs = chooseSequence(allEpochs, modeSelect.value);
    activeIndex = 0;
    range.max = String(epochs.length - 1);
    range.value = "0";
    range.disabled = epochs.length < 2;
    previous.disabled = epochs.length < 2;
    next.disabled = epochs.length < 2;
    play.disabled = epochs.length < 2;
    selectEpoch(0, 0, 1);
  });

  previous.addEventListener("click", () => {
    stopPlayback();
    selectEpoch((activeIndex - 1 + epochs.length) % epochs.length, null, -1);
  });

  next.addEventListener("click", () => {
    stopPlayback();
    selectEpoch((activeIndex + 1) % epochs.length, null, 1);
  });

  range.addEventListener("change", () => {
    stopPlayback();
    selectEpoch(Number(range.value), null, 1);
  });

  productSelect.addEventListener("change", () => {
    stopPlayback();
    selectEpoch(activeIndex, Number(productSelect.value), 1);
  });

  play.addEventListener("click", () => {
    if (playing) {
      stopPlayback();
      return;
    }
    if (epochs.length < 2) return;
    playing = true;
    play.textContent = "Ⅱ Pause";
    const token = ++playbackToken;
    advance(token);
  });

  window.addEventListener("spherex:search-results", event => {
    const detail = event.detail || {};
    setTimeline(detail.rows, detail.ra, detail.dec, detail.target);
  });
})();