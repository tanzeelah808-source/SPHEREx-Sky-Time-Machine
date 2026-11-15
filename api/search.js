export const access = "public";
export const methods = ["POST"];

const SIA_ENDPOINT = "https://irsa.ipac.caltech.edu/SIA";
const COLLECTIONS = {
  wide: ["spherex_dr1", "spherex_qr3"],
  deep: ["spherex_dr1_deep", "spherex_qr3_deep"],
  all: ["spherex_dr1", "spherex_dr1_deep", "spherex_dr1_cube", "spherex_qr3", "spherex_qr3_deep"]
};

function xmlDecode(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function attr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp("\\b" + escaped + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
  return match ? xmlDecode(match[2]) : "";
}

function parseVOTable(xml, collection) {
  const statusTag = xml.match(/<INFO\b[^>]*name=["']QUERY_STATUS["'][^>]*>/i);
  const statusValue = statusTag ? attr(statusTag[0], "value").toUpperCase() : "";
  const statusBody = xml.match(/<INFO\b[^>]*name=["']QUERY_STATUS["'][^>]*>([\s\S]*?)<\/INFO>/i);
  if (statusValue === "ERROR") {
    const message = statusBody ? xmlDecode(statusBody[1].replace(/<[^>]+>/g, "").trim()) : "Unspecified SIA2 query error";
    throw new Error("IRSA SIA2 error (" + collection + "): " + message);
  }

  const fieldTags = [...xml.matchAll(/<FIELD\b[^>]*>/gi)].map(m => m[0]);
  const names = fieldTags.map((tag, i) => (attr(tag, "name") || attr(tag, "ID") || "column_" + i).toLowerCase());
  const table = xml.match(/<TABLEDATA>([\s\S]*?)<\/TABLEDATA>/i);
  if (!table) {
    const lower = xml.toLowerCase();
    if (lower.includes("no table") || lower.includes("no results")) return [];
    throw new Error("IRSA returned VOTable without TABLEDATA. Response may use an unsupported serialization.");
  }

  const rowMatches = [...table[1].matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)];
  return rowMatches.map(match => {
    const cells = [...match[1].matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)]
      .map(cell => xmlDecode(cell[1].replace(/<[^>]+>/g, "").trim()));
    const row = { collection };
    names.forEach((name, i) => { row[name] = cells[i] ?? ""; });
    return row;
  });
}

function normalizeCollections(value) {
  if (Array.isArray(value)) {
    const allowed = new Set(Object.values(COLLECTIONS).flat());
    const selected = [...new Set(value.filter(v => allowed.has(v)))];
    if (!selected.length) throw new Error("No valid SPHEREx collections were selected.");
    return selected;
  }
  if (value === "all") return COLLECTIONS.all;
  if (value === "deep") return COLLECTIONS.deep;
  if (value === "wide" || value === "both" || value == null || value === "") return COLLECTIONS.wide;
  if (value === "spherex_dr1") return ["spherex_dr1"];
  if (value === "spherex_qr3") return ["spherex_qr3"];
  if (value === "spherex_dr1_deep") return ["spherex_dr1_deep"];
  if (value === "spherex_qr3_deep") return ["spherex_qr3_deep"];
  if (value === "spherex_dr1_cube") return ["spherex_dr1_cube"];
  throw new Error("Unsupported collection selection.");
}

function validIsoDate(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(field + " must be a valid ISO-8601 date or datetime.");
  }
  return value;
}

async function queryCollection(collection, ra, dec, radius, filters) {
  const url = new URL(SIA_ENDPOINT);
  url.searchParams.set("COLLECTION", collection);
  url.searchParams.set("POS", "CIRCLE " + ra + " " + dec + " " + radius);
  url.searchParams.set("RESPONSEFORMAT", "VOTABLE");
  url.searchParams.set("MAXREC", "2000");

  if (filters.startDate || filters.endDate) {
    // IRSA SIA2 TIME is an MJD interval, not an ISO-8601 interval.
    const startMjd = filters.startDate == null ? "-Inf" : String(Date.parse(filters.startDate) / 86400000 + 40587);
    const endMjd = filters.endDate == null ? "+Inf" : String(Date.parse(filters.endDate) / 86400000 + 40587);
    url.searchParams.set("TIME", startMjd + " " + endMjd);
  }
  if (filters.wavelengthMin != null || filters.wavelengthMax != null) {
    // SIA2 BAND uses SI metres; the public app accepts microns.
    const minM = filters.wavelengthMin == null ? "-Inf" : String(filters.wavelengthMin * 1e-6);
    const maxM = filters.wavelengthMax == null ? "+Inf" : String(filters.wavelengthMax * 1e-6);
    url.searchParams.set("BAND", minM + " " + maxM);
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        headers: { Accept: "application/x-votable+xml, text/xml" }
      });
      const responseText = await response.text();
      if (!response.ok) {
        const error = new Error("IRSA HTTP " + response.status + " (" + collection + "): " +
          responseText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 220));
        error.retryable = [429, 502, 503, 504].includes(response.status);
        throw error;
      }
      if (responseText.trim().startsWith("{")) {
        const parsed = JSON.parse(responseText);
        const rows = Array.isArray(parsed) ? parsed : (parsed.data || parsed.rows || parsed.results || []);
        if (!Array.isArray(rows)) throw new Error("Unexpected JSON response structure for " + collection);
        return rows.map(row => ({ ...row, collection }));
      }
      return parseVOTable(responseText, collection);
    } catch (error) {
      lastError = error;
      const transient = error?.retryable === true ||
        (error?.retryable === undefined && !(error?.message || "").startsWith("IRSA HTTP "));
      if (!transient || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 600 : 1500));
    }
  }
  throw lastError || new Error("Unknown IRSA query failure.");
}

export default async function (req, res) {
  const body = req.body || {};
  const ra = Number(body.ra);
  const dec = Number(body.dec);
  const radius = Number(body.radius);

  if (!Number.isFinite(ra) || ra < 0 || ra >= 360 ||
      !Number.isFinite(dec) || dec < -90 || dec > 90 ||
      !Number.isFinite(radius) || radius <= 0 || radius > 1) {
    return res.status(400).json({
      error: "Invalid RA, Dec or search radius. RA must be 0–360°, Dec −90–90°, and radius greater than 0 and at most 1°."
    });
  }

  let requested;
  let startDate;
  let endDate;
  let wavelengthMin;
  let wavelengthMax;
  try {
    requested = normalizeCollections(body.collections);
    startDate = validIsoDate(body.startDate, "startDate");
    endDate = validIsoDate(body.endDate, "endDate");
    if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) {
      throw new Error("startDate must be earlier than or equal to endDate.");
    }

    wavelengthMin = body.wavelengthMin == null || body.wavelengthMin === "" ? null : Number(body.wavelengthMin);
    wavelengthMax = body.wavelengthMax == null || body.wavelengthMax === "" ? null : Number(body.wavelengthMax);
    if ((wavelengthMin !== null && (!Number.isFinite(wavelengthMin) || wavelengthMin <= 0 || wavelengthMin > 100)) ||
        (wavelengthMax !== null && (!Number.isFinite(wavelengthMax) || wavelengthMax <= 0 || wavelengthMax > 100))) {
      throw new Error("Wavelength limits must be positive numbers in microns, no greater than 100.");
    }
    if (wavelengthMin !== null && wavelengthMax !== null && wavelengthMin > wavelengthMax) {
      throw new Error("wavelengthMin must be less than or equal to wavelengthMax.");
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const filters = { startDate, endDate, wavelengthMin, wavelengthMax };
  const settled = await Promise.allSettled(
    requested.map(collection => queryCollection(collection, ra, dec, radius, filters))
  );
  const records = settled.flatMap(item => item.status === "fulfilled" ? item.value : []);
  const failures = settled.map((item, index) => item.status === "rejected"
    ? { collection: requested[index], error: String(item.reason?.message || item.reason) }
    : null).filter(Boolean);

  records.sort((a, b) => {
    const ta = Number(a.t_min ?? a.mjd_obs ?? a.mjd ?? Infinity);
    const tb = Number(b.t_min ?? b.mjd_obs ?? b.mjd ?? Infinity);
    return ta - tb;
  });

  return res.json({
    source: "NASA/IPAC Infrared Science Archive (IRSA) SPHEREx SIA2",
    endpoint: SIA_ENDPOINT,
    coordinates: { ra, dec, radius_deg: radius, frame: "ICRS/J2000" },
    filters: {
      start_date: startDate,
      end_date: endDate,
      wavelength_min_microns: wavelengthMin,
      wavelength_max_microns: wavelengthMax
    },
    collections_requested: requested,
    collections_queried: requested.length,
    collections_succeeded: settled.filter(item => item.status === "fulfilled").length,
    records,
    failures,
    partial: failures.length > 0 && records.length > 0,
    message: records.length
      ? (failures.length ? "Some collections returned records while others failed. See failures." : null)
      : (failures.length
        ? "No collection returned usable records. See per-collection errors; this is not evidence of no observations."
        : "IRSA returned no matching records for the requested position and filters.")
  });
}