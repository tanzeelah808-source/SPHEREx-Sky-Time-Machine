export const access = "public";
export const methods = ["POST"];

const ALLOWED_HOST = "irsa.ipac.caltech.edu";
const ALLOWED_PATH = /^\/ibe\/data\/spherex\/(?:dr1|qr3)\//i;
const BLOCK = 2880;
const CARD = 80;

function parseCardValue(card) {
  const raw = card.slice(10).trim();
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return end >= 0 ? raw.slice(1, end).replace(/''/g, "'").trim() : raw.slice(1).trim();
  }
  const value = raw.split("/")[0].trim();
  if (value === "T") return true;
  if (value === "F") return false;
  const number = Number(value);
  return value !== "" && Number.isFinite(number) ? number : value;
}

function readHeader(bytes, offset) {
  const decoder = new TextDecoder("ascii");
  const cards = [];
  let position = offset;
  let foundEnd = false;

  while (position + CARD <= bytes.length) {
    const card = decoder.decode(bytes.subarray(position, position + CARD));
    cards.push(card);
    position += CARD;
    if (card.startsWith("END ")) {
      foundEnd = true;
      break;
    }
  }

  if (!foundEnd) throw new Error("FITS header is incomplete.");

  const values = {};
  for (const card of cards) {
    const key = card.slice(0, 8).trim();
    if (key && key !== "COMMENT" && key !== "HISTORY" && key !== "END") {
      values[key] = parseCardValue(card);
    }
  }

  return {
    values,
    dataStart: offset + Math.ceil((position - offset) / BLOCK) * BLOCK
  };
}

function hduDataBytes(header) {
  const h = header.values;
  const axes = Number(h.NAXIS || 0);
  let pixels = axes ? 1 : 0;
  for (let i = 1; i <= axes; i++) pixels *= Number(h["NAXIS" + i] || 0);
  const bitpixBytes = Math.abs(Number(h.BITPIX || 8)) / 8;
  const pcount = Number(h.PCOUNT || 0);
  const gcount = Number(h.GCOUNT || 1);
  return (pixels * bitpixBytes + pcount) * gcount;
}

function readImageData(bytes, header, dataStart) {
  const h = header;
  const width = Number(h.NAXIS1 || 0);
  const height = Number(h.NAXIS2 || 0);
  const bitpix = Number(h.BITPIX || 0);
  const count = width * height;

  if (!width || !height || count > 250000) {
    throw new Error("The FITS image dimensions are missing or too large for this viewer.");
  }

  const bytesPerPixel = Math.abs(bitpix) / 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, count * bytesPerPixel);
  const bscale = Number(h.BSCALE ?? 1);
  const bzero = Number(h.BZERO ?? 0);
  const values = new Array(count);

  for (let i = 0; i < count; i++) {
    const offset = i * bytesPerPixel;
    let value;
    if (bitpix === -32) value = view.getFloat32(offset, false);
    else if (bitpix === -64) value = view.getFloat64(offset, false);
    else if (bitpix === 32) value = view.getInt32(offset, false);
    else if (bitpix === 16) value = view.getInt16(offset, false);
    else if (bitpix === 8) value = view.getUint8(offset);
    else if (bitpix === 64) value = Number(view.getBigInt64(offset, false));
    else throw new Error("Unsupported FITS BITPIX value: " + bitpix);

    value = value * bscale + bzero;
    values[i] = Number.isFinite(value) ? value : null;
  }

  return { width, height, values };
}

function findWcs(header) {
  const result = {};
  for (const [key, value] of Object.entries(header)) {
    if (/^(CRPIX[12]|CRVAL[12]|CTYPE[12]|CUNIT[12]|CDELT[12]|PC[12]_[12]|CD[12]_[12]|A_ORDER|B_ORDER|A_\d+_\d+|B_\d+_\d+)$/.test(key)) {
      result[key] = value;
    }
  }
  return result;
}

async function fetchCutout(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/fits, application/octet-stream" },
        timeout_ms: 25000
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 180);
        const error = new Error("IRSA returned HTTP " + response.status + (body ? ": " + body : ""));
        error.retryable = [502, 503, 504].includes(response.status);
        throw error;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < BLOCK || new TextDecoder("ascii").decode(bytes.subarray(0, 8)) !== "SIMPLE  ") {
        throw new Error("IRSA did not return a valid FITS file.");
      }
      return bytes;
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable === true ||
        (!error?.message?.startsWith("IRSA returned HTTP ") && !error?.message?.includes("valid FITS"));
      if (!retryable || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 700 : 1500));
    }
  }
  throw lastError || new Error("Could not retrieve the FITS cutout.");
}

export default async function (req, res) {
  const body = req.body || {};
  const ra = Number(body.ra);
  const dec = Number(body.dec);
  const size = body.size == null ? 0.05 : Number(body.size);

  if (!Number.isFinite(ra) || ra < 0 || ra >= 360 ||
      !Number.isFinite(dec) || dec < -90 || dec > 90) {
    return res.status(400).json({ error: "Enter valid ICRS coordinates." });
  }
  if (!Number.isFinite(size) || size < 0.01 || size > 0.2) {
    return res.status(400).json({ error: "Cutout size must be between 0.01 and 0.2 degrees." });
  }

  let source;
  try {
    source = new URL(String(body.accessUrl || ""));
  } catch {
    return res.status(400).json({ error: "A valid archive FITS access URL is required." });
  }

  if (source.protocol !== "https:" || source.hostname !== ALLOWED_HOST ||
      !ALLOWED_PATH.test(source.pathname) || !source.pathname.toLowerCase().endsWith(".fits")) {
    return res.status(400).json({ error: "Only official IRSA SPHEREx FITS product URLs are accepted." });
  }

  source.search = "";
  source.searchParams.set("center", ra + "," + dec);
  source.searchParams.set("size", String(size));

  try {
    const bytes = await fetchCutout(source.toString());
    const layers = {};
    let metadata = null;
    let offset = 0;
    let hduCount = 0;

    while (offset + BLOCK <= bytes.length && hduCount < 30) {
      const parsed = readHeader(bytes, offset);
      const header = parsed.values;
      const dataStart = parsed.dataStart;
      const dataBytes = hduDataBytes(parsed);
      const name = String(header.EXTNAME || "PRIMARY").trim().toUpperCase();

      if (["IMAGE", "FLAGS", "VARIANCE", "ZODI"].includes(name) && Number(header.NAXIS || 0) >= 2) {
        const image = readImageData(bytes, header, dataStart);
        layers[name.toLowerCase()] = image.values;

        if (name === "IMAGE") {
          const finite = image.values.filter(Number.isFinite).sort((a, b) => a - b);
          metadata = {
            width: image.width,
            height: image.height,
            observationId: header.OBSID || null,
            dateObs: header["DATE-OBS"] || null,
            mjdObs: header["MJD-OBS"] || null,
            unit: header.BUNIT || null,
            psfFwhm: header.PSF_FWHM ?? null,
            imageMin: finite.length ? finite[0] : null,
            imageMax: finite.length ? finite[finite.length - 1] : null,
            wcs: findWcs(header)
          };
        }
      }

      offset = dataStart + Math.ceil(dataBytes / BLOCK) * BLOCK;
      hduCount++;
    }

    if (!layers.image || !metadata) {
      throw new Error("The returned FITS file did not contain a readable IMAGE extension.");
    }

    return res.json({
      source: "NASA/IPAC IRSA SPHEREx IBE FITS cutout",
      cutoutSizeDegrees: size,
      requestedCoordinates: { ra, dec, frame: "ICRS" },
      metadata,
      layers
    });
  } catch (error) {
    console.error("SPHEREx FITS cutout failed:", error?.message || error);
    return res.status(502).json({
      error: "Could not retrieve or decode this SPHEREx FITS cutout.",
      detail: String(error?.message || error).slice(0, 240)
    });
  }
}