export const access = "public";
export const methods = ["POST"];

const S3_ENDPOINT = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/";
const ROOT_PREFIX = "qr2/level2/";
const MAX_KEYS = 1000;

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function tagValues(xml, tag) {
  return [...xml.matchAll(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "g"))]
    .map(match => decodeXml(match[1]));
}

export default async function (req, res) {
  const requestedPrefix = String(req.body?.prefix || ROOT_PREFIX);
  const continuationToken = req.body?.continuationToken == null
    ? ""
    : String(req.body.continuationToken);

  if (!requestedPrefix.startsWith(ROOT_PREFIX) ||
      requestedPrefix.includes("..") ||
      requestedPrefix.includes("\\") ||
      requestedPrefix.length > 240 ||
      continuationToken.length > 4096) {
    return res.status(400).json({ error: "Prefix must be within the public QR2 level2 archive." });
  }

  const url = new URL(S3_ENDPOINT);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("delimiter", "/");
  url.searchParams.set("prefix", requestedPrefix);
  url.searchParams.set("max-keys", String(MAX_KEYS));
  if (continuationToken) url.searchParams.set("continuation-token", continuationToken);

  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/xml" }
    });
    const xml = await response.text();
    if (!response.ok) {
      return res.status(502).json({
        error: "AWS public archive listing failed.",
        upstreamStatus: response.status,
        detail: xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)
      });
    }
    if (!/<ListBucketResult\b/.test(xml)) {
      throw new Error("AWS returned an unexpected listing format.");
    }

    const prefixes = tagValues(xml, "Prefix");
    const keys = tagValues(xml, "Key");
    return res.json({
      source: "NASA/IPAC SPHEREx public AWS S3 archive",
      bucket: "nasa-irsa-spherex",
      prefix: requestedPrefix,
      commonPrefixes: prefixes.filter(value => value !== requestedPrefix),
      keys,
      keyCount: keys.length,
      truncated: xml.includes("<IsTruncated>true</IsTruncated>"),
      nextContinuationToken: tagValues(xml, "NextContinuationToken")[0] || null,
      note: "This endpoint lists real archive object names only. It does not claim that a file covers the selected target; FITS WCS verification is still required."
    });
  } catch (error) {
    return res.status(502).json({
      error: "Could not inspect the public SPHEREx AWS archive.",
      detail: String(error?.message || error).slice(0, 240)
    });
  }
}
