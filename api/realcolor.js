export const access = "public";
export const methods = ["POST"];

const PS1_LIST = "https://ps1images.stsci.edu/cgi-bin/ps1filenames.py";
const PS1_CUTCUT = "https://ps1images.stsci.edu/cgi-bin/fitscut.cgi";

function parseImageList(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].trim().split(/\s+/);
  const filenameIndex = header.indexOf("filename");
  const filterIndex = header.indexOf("filter");
  if (filenameIndex < 0 || filterIndex < 0) {
    throw new Error("Pan-STARRS returned an unexpected image-list format.");
  }
  return lines.slice(1).map(line => {
    const fields = line.trim().split(/\s+/);
    return { filename: fields[filenameIndex], filter: fields[filterIndex] };
  }).filter(row => row.filename && /^[gri]$/.test(row.filter));
}

export default async function (req, res) {
  const body = req.body || {};
  const ra = Number(body.ra);
  const dec = Number(body.dec);

  if (!Number.isFinite(ra) || ra < 0 || ra >= 360 ||
      !Number.isFinite(dec) || dec < -90 || dec > 90) {
    return res.status(400).json({ error: "Enter valid ICRS coordinates." });
  }

  try {
    const listUrl = new URL(PS1_LIST);
    listUrl.searchParams.set("ra", String(ra));
    listUrl.searchParams.set("dec", String(dec));
    listUrl.searchParams.set("filters", "gri");
    listUrl.searchParams.set("type", "stack");
    listUrl.searchParams.set("sep", "space");

    const listResponse = await fetch(listUrl.toString(), {
      headers: { Accept: "text/plain" },
      timeout_ms: 20000
    });
    if (!listResponse.ok) {
      throw new Error("Pan-STARRS image lookup returned HTTP " + listResponse.status + ".");
    }

    const images = parseImageList(await listResponse.text());
    const byFilter = new Map();
    for (const image of images) {
      if (!byFilter.has(image.filter)) byFilter.set(image.filter, image.filename);
    }
    const g = byFilter.get("g");
    const r = byFilter.get("r");
    const i = byFilter.get("i");
    if (!g || !r || !i) {
      return res.status(404).json({
        error: "Pan-STARRS1 does not have all three g, r and i stacked images at this position.",
        availableFilters: [...byFilter.keys()]
      });
    }

    // SPHEREx cutout is 0.2 degrees = 720 arcsec. PS1 stacks are
    // approximately 0.25 arcsec/pixel, so request ~2880 pixels and
    // render a 512-pixel JPEG preview of the same sky footprint.
    const cutoutUrl = new URL(PS1_CUTCUT);
    cutoutUrl.searchParams.set("ra", String(ra));
    cutoutUrl.searchParams.set("dec", String(dec));
    cutoutUrl.searchParams.set("size", "2880");
    cutoutUrl.searchParams.set("output_size", "512");
    cutoutUrl.searchParams.set("format", "jpg");
    cutoutUrl.searchParams.set("red", i);
    cutoutUrl.searchParams.set("green", r);
    cutoutUrl.searchParams.set("blue", g);

    let imageResponse;
    for (let attempt = 0; attempt < 2; attempt++) {
      imageResponse = await fetch(cutoutUrl.toString(), {
        headers: { Accept: "image/jpeg" },
        timeout_ms: 30000
      });
      if (imageResponse.ok) break;
      if (![502, 503, 504].includes(imageResponse.status) || attempt === 1) {
        throw new Error("Pan-STARRS colour cutout returned HTTP " + imageResponse.status + ".");
      }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
    if (imageBytes.length < 100 || imageBytes[0] !== 0xff || imageBytes[1] !== 0xd8) {
      throw new Error("Pan-STARRS did not return a valid JPEG colour image.");
    }

    return res.json({
      source: "Pan-STARRS1 3PI stacked g/r/i images via STScI MAST",
      filters: { red: "i", green: "r", blue: "g" },
      fieldOfViewDegrees: 0.2,
      width: 512,
      height: 512,
      imageDataUrl: "data:image/jpeg;base64," + imageBytes.toString("base64")
    });
  } catch (error) {
    console.error("Pan-STARRS colour image failed:", error?.message || error);
    return res.status(502).json({
      error: "Could not retrieve a Pan-STARRS real-colour image for this position.",
      detail: String(error?.message || error).slice(0, 220)
    });
  }
}