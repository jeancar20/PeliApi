const cheerio = require("cheerio");
const { URL } = require("node:url");
const { ApiError } = require("./api-error");
const {
  fetchHtmlWithHeaders,
  findFirstUrl,
  isLikelyVideoUrl,
  normalizeExtractedUrl,
  DEFAULT_HEADERS,
} = require("./http");

// Shared browser instance
const { getBrowser } = require("./browser");

// yt-dlp high-speed resolver
const ytdlpResolver = require("./resolvers/ytdlp.resolver");

// Hosts como Mixdrop/Dropload entregan el player con JS empaquetado (P.A.C.K.E.R.)
const { unpackAll } = require("./unpacker");

// Modular high-performance resolvers
const { extractVoe } = require("./resolvers/voe.resolver");
const { extractStreamwish } = require("./resolvers/streamwish.resolver");
const { extractStreamtape } = require("./resolvers/streamtape.resolver");
const { extractUqload } = require("./resolvers/uqload.resolver");

const DEBUG_MODE = process.env.DEBUG_RESOLVER === "true" || process.env.DEBUG_DOWNLOAD === "true";

function debugLog(server, message, data) {
  if (!DEBUG_MODE) {
    return;
  }
  const timestamp = new Date().toISOString();
  const header = `[${timestamp}] [${server}] ${message}`;
  if (data) {
    console.log(header, typeof data === "string" ? data.slice(0, 500) : data);
  } else {
    console.log(header);
  }
}

// Los resolvers "rapidos" (axios, sin navegador) encuentran la URL del
// manifiesto correctamente, pero varios hosts (streamwish/vidhide comparten
// backend) le sirven a peticiones sin sesion de navegador real un manifiesto
// con forma valida pero segmentos falsos (pixeles de tracking de un CDN de
// ads), o directamente un bloqueo de Cloudflare con content-type text/html.
// Antes esto se contaba como "resuelto" y nunca se le daba la oportunidad
// al fallback de Puppeteer (que sí carga la pagina real e intercepta la
// peticion de red real, con mucha mas chance de conseguir un link valido).
// Esta validacion evita esa falsa confianza.
const DECOY_HOST_RE = /tiktokcdn\.com$/i;
const DECOY_PATH_RE = /\/ad-site-i18n-sg\//i;

function looksLikeDecoySegment(uri) {
  try {
    const u = new URL(uri);
    if (DECOY_HOST_RE.test(u.hostname)) return true;
    if (DECOY_PATH_RE.test(u.pathname)) return true;
    if (/\.image(\?|$)/i.test(u.pathname)) return true;
  } catch (_e) {
    return false;
  }
  return false;
}

function firstUriAfter(playlistText, marker, baseUrl) {
  const lines = playlistText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(marker)) {
      const uri = lines[i + 1]?.trim();
      if (uri && !uri.startsWith("#")) {
        try {
          return new URL(uri, baseUrl).toString();
        } catch (_e) {
          return null;
        }
      }
    }
  }
  return null;
}

async function isUrlActuallyServing(url, referer = "") {
  // Muchos CDNs de video (mixdrop, dropload…) solo sirven con el Referer/Origin de
  // su propio embed; validar sin él descartaba URLs que sí reproducen.
  const headers = { "User-Agent": DEFAULT_HEADERS["User-Agent"] };
  if (referer) {
    headers.Referer = referer;
    headers.Origin = referer.replace(/\/$/, "");
  }
  try {
    if (/\.m3u8(\?|$)/i.test(url)) {
      const res = await fetch(url, { headers });
      if (!res.ok) return false;
      const text = await res.text();
      if (!/^#EXTM3U/.test(text.trim())) return false;
      const variant = firstUriAfter(text, "#EXT-X-STREAM-INF", url);
      const playlistText = variant ? await (await fetch(variant, { headers })).text() : text;
      const playlistBase = variant || url;
      const segment = firstUriAfter(playlistText, "#EXTINF", playlistBase);
      if (!segment) return true;
      return !looksLikeDecoySegment(segment);
    }
    if (/\.mp4(\?|$)/i.test(url)) {
      const head = await fetch(url, { method: "HEAD", headers });
      if (head.ok) return true;
      // Algunos CDNs no aceptan HEAD (403/405): probar con un GET de 1 byte
      const probe = await fetch(url, { headers: { ...headers, Range: "bytes=0-0" } });
      return probe.ok || probe.status === 206;
    }
    // Extension desconocida (ej. un ".txt" disfrazado de manifiesto) — suele
    // ser una pagina de bloqueo; solo aceptamos si no parece HTML de error.
    const res = await fetch(url, { headers });
    if (!res.ok) return false;
    const contentType = res.headers.get("content-type") || "";
    return !contentType.includes("text/html");
  } catch (_e) {
    return false;
  }
}

async function validateAndReturn(url, referer = "") {
  if (!url) return null;
  return (await isUrlActuallyServing(url, referer)) ? url : null;
}

function getRefererForUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/`;
  } catch (_error) {
    return "https://www.pelisplushd.la/";
  }
}

async function resolveEmbedWithPuppeteer(url, referer) {
  debugLog("Puppeteer", "Resolving URL", url);
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    if (referer) {
      await page.setExtraHTTPHeaders({ Referer: referer });
    }

    // 1. Activar interceptación de peticiones de red
    await page.setRequestInterception(true);

    let interceptedUrl = null;
    page.on("request", (req) => {
      const rUrl = req.url();
      const type = req.resourceType();
      
      // Capturar la URL del stream de video objetivo
      const isMedia = /\.(?:m3u8|mp4)(?:\?|#|$)/i.test(rUrl);
      if (
        !interceptedUrl &&
        type !== "document" &&
        isMedia &&
        !rUrl.startsWith("blob:") &&
        !rUrl.includes("blank")
      ) {
        interceptedUrl = rUrl;
      }

      // 2. Bloquear elementos pesados que no aportan a la extracción
      const blockTypes = ["image", "stylesheet", "font"];
      if (blockTypes.includes(type)) {
        req.abort();
        return;
      }

      // 3. Bloquear dominios y scripts de redes de publicidad invasivas
      const isAd = /(google-analytics|doubleclick|adsterra|exoclick|popads|propellerads|clickadu|popcash|adnxs|mgid|outbrain|taboola|histats|amung|jads|ero-advertising|realsrv|admaven|coinhive|monetize|track|adshost|adsrv|a.bestcontent|a.shorte)/i.test(rUrl);
      if (isAd || (type === "script" && !rUrl.includes("player") && !rUrl.includes("video") && !rUrl.includes("jwplatform") && !rUrl.includes("plyr"))) {
        req.abort();
        return;
      }

      req.continue();
    });

    // Wait for page to load
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });

    // Attempt to click play buttons to trigger video load
    try {
      const playBtnSelectors =
        ".play-button, button, .vjs-big-play-button, [role='button'], .jw-icon-display, .plyr__control--overlaid";
      const playBtn = await page.$(playBtnSelectors);
      if (playBtn) await playBtn.click();
    } catch (e) {}

    // Wait for potential JS to execute and requests to fire
    await new Promise((r) => setTimeout(r, 4000));

    // Try clicking inside iframes (common in SPAs like new Filemoon)
    if (!interceptedUrl) {
      for (const frame of page.frames()) {
        try {
          const playBtn = await frame.$(
            ".play-button, button, .vjs-big-play-button, [role='button'], .jw-icon-display, .plyr__control--overlaid"
          );
          if (playBtn) await playBtn.click();
        } catch (e) {}
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (interceptedUrl) {
      debugLog("Puppeteer", "Intercepted media URL", interceptedUrl);
      await page.close();
      return interceptedUrl;
    }

    const html = await page.content();
    await page.close();

    debugLog("Puppeteer", "Fetched HTML length", html.length);

    const $ = cheerio.load(html);

    // Try many patterns
    const patterns = [
      /sources?\s*:\s*\[\s*\{[^}]*(?:file|src)\s*:\s*['"]([^'"]+)['"]/i,
      /"file"\s*:\s*"([^"]+)"/i,
      /"source"\s*:\s*"([^"]+)"/i,
      /"video"\s*:\s*"([^"]+)"/i,
      /(https?:\/\/[^\s"'>]+\.(?:mp4|m3u8)[^\s"'>]*)/i,
      /video\s*src\s*=\s*["']([^"']+)["']/i,
      /source\s+src\s*=\s*["']([^"']+)["']/i,
      /data-src\s*=\s*["']([^"']+)["']/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1] && isLikelyVideoUrl(match[1])) {
        debugLog("Puppeteer", "Found URL", match[1]);
        return match[1];
      }
    }

    // Try video element
    const videoSrc = $("video").attr("src");
    if (videoSrc && isLikelyVideoUrl(videoSrc)) {
      return videoSrc;
    }

    // Try data attributes
    const dataElements = $("[data-src], [data-source], [data-video], [data-file]");
    for (let i = 0; i < dataElements.length; i++) {
      const dataSrc =
        $(dataElements[i]).attr("data-src") || $(dataElements[i]).attr("data-source");
      if (dataSrc && isLikelyVideoUrl(dataSrc)) {
        return dataSrc;
      }
    }

    return null;
  } catch (err) {
    debugLog("Puppeteer", "Error", err.message);
    return null;
  }
}

async function resolveVidhideUrl(url, referer) {
  debugLog("Vidhide", "Resolving URL", url);
  try {
    const { html, headers } = await fetchHtmlWithHeaders(url, referer);
    debugLog("Vidhide", "Fetched HTML length", html.length);

    const extracted = findFirstUrl(html, [
      /sources?\s*:\s*\[\s*\{[^}]*(?:file|src)\s*:\s*["'](https?:\/\/[^"']+)["']/i,
      /"file"\s*:\s*"([^"]+)"/i,
      /"source"\s*:\s*"([^"]+)"/i,
      /file\s*:\s*'([^']+)'/i,
      /setup\([^)]*file[^)]*\)/i,
    ]);

    if (extracted) {
      debugLog("Vidhide", "Found URL", extracted);
      return extracted;
    }

    debugLog("Vidhide", "No URL found");
    return null;
  } catch (err) {
    debugLog("Vidhide", "Error", err.message);
    return null;
  }
}

async function resolveHqqUrl(url, referer) {
  debugLog("Hqq/Netu", "Resolving URL", url);
  try {
    const { html, headers } = await fetchHtmlWithHeaders(url, referer);
    debugLog("Hqq/Netu", "Fetched HTML length", html.length);

    const extracted = findFirstUrl(html, [
      /sources?\s*:\s*\[\s*\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+)["']/i,
      /file\s*:\s*"([^"]+\.mp4[^"]*)"/i,
      /video(?:\d+)?\s*=\s*["']([^"']+\.mp4[^"']+)["']/i,
    ]);

    if (extracted) {
      debugLog("Hqq/Netu", "Found URL", extracted);
      return extracted;
    }

    debugLog("Hqq/Netu", "No URL found");
    return null;
  } catch (err) {
    debugLog("Hqq/Netu", "Error", err.message);
    return null;
  }
}

async function resolveMixdropUrl(url, referer) {
  debugLog("Mixdrop", "Resolving URL", url);
  try {
    const { html: rawHtml } = await fetchHtmlWithHeaders(url, referer);
    debugLog("Mixdrop", "Fetched HTML length", rawHtml.length);
    // La URL (MDCore.wurl = "...") va dentro de un eval(function(p,a,c,k,e,d)...) empaquetado
    const html = [rawHtml, ...unpackAll(rawHtml)].join("\n");

    const patterns = [
      /MDCore\.wurl\s*=\s*"([^"]+)"/i,
      /MDCore\.vsrc\s*=\s*"([^"]+)"/i,
      /MDCore\.source\s*=\s*"([^"]+)"/i,
      /\|MDCore\|[^|]*\|wurl\|[^|]*\|(https?[^|]+)/i,
      /(https?:\/\/[a-z0-9]+\.mixdrop\.[a-z]+\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i,
      /(https?:\/\/[a-z0-9]+\.mxdcontent\.[a-z]+\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i,
      /"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
      /\/\/(s-delivery\d+[^\s"']+\.mp4[^\s"']*)/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        let candidate = match[1];
        if (candidate.startsWith("//")) {
          candidate = `https:${candidate}`;
        }
        if (isLikelyVideoUrl(candidate)) {
          debugLog("Mixdrop", "Found URL", candidate);
          return normalizeExtractedUrl(candidate);
        }
      }
    }

    debugLog("Mixdrop", "No URL found in HTML");
    return null;
  } catch (err) {
    debugLog("Mixdrop", "Error", err.message);
    return null;
  }
}

async function resolveDoodstreamUrl(url, referer) {
  debugLog("Doodstream", "Resolving URL", url);
  try {
    let embedUrl = url.replace(/\/d\//, "/e/");
    const { html } = await fetchHtmlWithHeaders(embedUrl, referer);
    debugLog("Doodstream", "Fetched HTML length", html.length);

    const passMatch = html.match(/\/pass_md5\/[^'"\s]+/i);
    if (passMatch) {
      const passUrl = `https://${new URL(embedUrl).hostname}${passMatch[0]}`;
      debugLog("Doodstream", "Fetching pass_md5 token", passUrl);

      const tokenResponse = await fetchHtmlWithHeaders(passUrl, embedUrl);
      const tokenUrl = tokenResponse.html.trim();

      if (tokenUrl && (tokenUrl.startsWith("http") || tokenUrl.startsWith("//"))) {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let randomStr = "";
        for (let i = 0; i < 10; i++) {
          randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const expiry = Date.now();
        const directUrl = `${tokenUrl}${randomStr}?token=${passMatch[0].split("/").pop()}&expiry=${expiry}`;
        debugLog("Doodstream", "Constructed direct URL", directUrl);
        return directUrl;
      }
    }

    const extracted = findFirstUrl(html, [
      /(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i,
      /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i,
      /"file"\s*:\s*"([^"]+)"/i,
      /source\s*src\s*=\s*["']([^"']+)["']/i,
    ]);

    if (extracted) {
      debugLog("Doodstream", "Found fallback URL", extracted);
      return extracted;
    }

    debugLog("Doodstream", "No URL found");
    return null;
  } catch (err) {
    debugLog("Doodstream", "Error", err.message);
    return null;
  }
}

async function resolveDroploadUrl(url, referer) {
  debugLog("Dropload", "Resolving URL", url);
  try {
    const { html: rawHtml } = await fetchHtmlWithHeaders(url, referer);
    debugLog("Dropload", "Fetched HTML length", rawHtml.length);
    // El player (jwplayer.setup({sources:[{file:...}]})) viene empaquetado con P.A.C.K.E.R.
    const html = [rawHtml, ...unpackAll(rawHtml)].join("\n");

    const extracted = findFirstUrl(html, [
      /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i,
      /sources?\s*:\s*\[\s*\{[^}]*(?:file|src)\s*:\s*["'](https?:\/\/[^"']+)["']/i,
      /file\s*:\s*["'](https?:[^\s"']+)["']/i,
      /"file"\s*:\s*"([^"]+)"/i,
      /"source"\s*:\s*"([^"]+)"/i,
      /player\.config\s*=\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i,
      /player\.setup\(\{[^}]*file\s*:\s*["']([^"']+)["']/i,
      /(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i,
    ]);

    if (extracted && !extracted.startsWith("blob:")) {
      debugLog("Dropload", "Found URL", extracted);
      return extracted;
    }

    const dataMatch = html.match(/data-src=["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
    if (dataMatch && dataMatch[1] && !dataMatch[1].startsWith("blob:")) {
      debugLog("Dropload", "Found data-src URL", dataMatch[1]);
      return normalizeExtractedUrl(dataMatch[1]);
    }

    debugLog("Dropload", "No URL found in HTML");
    return null;
  } catch (err) {
    debugLog("Dropload", "Error", err.message);
    return null;
  }
}

async function resolveEmbedUrl(url, parentUrl = null) {
  if (!url) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_error) {
    return url;
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const referer = getRefererForUrl(parentUrl || url);
  const embedReferer = `${parsed.origin}/`; // Referer con el que el CDN espera ver al player

  debugLog("resolveEmbed", `Host: ${host}, Path: ${pathname}`, url);

  // 1. High Performance Modular Resolvers
  // Cada resultado pasa por validateAndReturn() antes de aceptarse: estos
  // resolvers "rapidos" (sin navegador) a veces encuentran una URL con forma
  // correcta pero que el host no sirve de verdad a una peticion sin sesion
  // de navegador (señuelo o bloqueo). Si no valida, seguimos probando el
  // resto de la cascada en vez de darla por buena.
  if (/wish|awish|playnix|medix|niramirus|kravaxxa|davioad|haxlopp|tryzendm|dumbalag|dhcplay|hglink/i.test(host)) {
    const resolved = await validateAndReturn(await extractStreamwish(url), embedReferer);
    if (resolved) return resolved;
  }

  if (/streamtape/i.test(host)) {
    const resolved = await validateAndReturn(await extractStreamtape(url), embedReferer);
    if (resolved) return resolved;
  }

  if (/voe/i.test(host) || /\/e\//.test(pathname)) {
    const resolved = await validateAndReturn(await extractVoe(url), embedReferer);
    if (resolved) return resolved;
  }

  // uqload.com/uqload.vc: confirmado en pruebas manuales sin proteccion de
  // Cloudflare — segmentos reales servidos sin bloqueo. Mismo empaquetado
  // JWPlayer que streamwish, sin la indireccion de dominio espejo.
  if (/uqload/i.test(host)) {
    const resolved = await validateAndReturn(await extractUqload(url), embedReferer);
    if (resolved) return resolved;
  }

  // 2. Specific Inline Resolvers
  if (/hqq\.tv|netu|waaw/i.test(host)) {
    const resolved = await validateAndReturn(await resolveHqqUrl(url, referer), embedReferer);
    if (resolved) return resolved;
  }

  if (/vidhide/i.test(host)) {
    const resolved = await validateAndReturn(await resolveVidhideUrl(url, referer), embedReferer);
    if (resolved) return resolved;
  }

  if (/mixdrop|mxdrop|mxcontent|mxdcontent/i.test(host)) {
    const resolved = await validateAndReturn(await resolveMixdropUrl(url, referer), embedReferer);
    if (resolved) return resolved;
  }

  if (/dood|dstream|ds2play|doods|playmogo|d0000d|d000d/i.test(host)) {
    const resolved = await validateAndReturn(await resolveDoodstreamUrl(url, referer), embedReferer);
    if (resolved) return resolved;
  }

  if (/dropload|dr0pstream|drop\.download/i.test(host)) {
    const resolved = await validateAndReturn(await resolveDroploadUrl(url, referer), embedReferer);
    if (resolved) return resolved;
  }

  if (/mp4upload/i.test(host)) {
    debugLog("resolveEmbed", "Using MP4Upload resolver", null);
    if (!pathname.includes("embed") && !pathname.endsWith(".html")) {
      const slug = pathname.split("/").filter(Boolean).pop();
      if (slug) {
        url = `https://www.mp4upload.com/embed-${slug}.html`;
        debugLog("resolveEmbed", `Converted MP4Upload download URL to embed: ${url}`, null);
      }
    }
    const resolved = await resolveEmbedWithPuppeteer(url, referer);
    if (resolved) return resolved;
    throw new Error("No se pudo resolver enlace directo en MP4Upload");
  }

  // 2.5. yt-dlp High-Speed Resolver (as fallback before Puppeteer)
  if (ytdlpResolver.isAvailable) {
    const ytdlpResolved = await validateAndReturn(await ytdlpResolver.extractWithYtdlp(url, referer), embedReferer);
    if (ytdlpResolved) return ytdlpResolved;
  }

  // 3. Puppeteer Protected Fallback
  const isProtectedSite = /wish|playnix|medix|niramirus|kravaxxa|davioad|haxlopp|tryzendm|dumbalag|dhcplay|hglink|vidhide|voe|mixdrop|dood|dropload/i.test(host);
  if (isProtectedSite) {
    debugLog("resolveEmbed", "Using Puppeteer for protected site", null);
    const resolved = await resolveEmbedWithPuppeteer(url, referer);
    if (resolved) return resolved;
  }

  // Fallback: try Puppeteer for any embed
  debugLog("resolveEmbed", "Trying Puppeteer fallback", null);
  const puppeteerResolved = await resolveEmbedWithPuppeteer(url, referer);
  if (puppeteerResolved) {
    return puppeteerResolved;
  }

  return url;
}

module.exports = {
  resolveStreamwishUrl: extractStreamwish,
  resolveStreamtapeUrl: extractStreamtape,
  resolveVoeUrl: extractVoe,
  resolveUqloadUrl: extractUqload,
  resolveVidhideUrl,
  resolveHqqUrl,
  resolveMixdropUrl,
  resolveDoodstreamUrl,
  resolveDroploadUrl,
  resolveEmbedWithPuppeteer,
  resolveEmbedUrl,
};
