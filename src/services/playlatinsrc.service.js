const axios = require("axios");

// Player que usa RePelisHD (y que sirve cualquier titulo por su id de IMDb). Su pagina trae un
// token firmado; con el se pide POST /api/embed-links, que devuelve la lista de servidores.
// Es lo mismo que hace el navegador al pulsar play (sin JS ni cookies).
const PLAYER_DOMAIN = process.env.REPELISHD_PLAYER_DOMAIN || "https://playlatinsrc.co";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PLAYER_LANGUAGES = { latino: "Latino", castellano: "Castellano", subtitulado: "Subtitulado" };

function playerServerKey(name, url) {
  const base = String(name || "").toLowerCase().split(".")[0].replace(/[^a-z0-9]/g, "");
  if (base) return base;
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  } catch (_e) {
    return "unknown";
  }
}

/**
 * Servidores de una pelicula por su id de IMDb (tt1234567). `referer` es la pagina desde la
 * que se "abre" el player (por defecto, el propio dominio del player).
 */
async function fetchServersByImdb(imdb, referer = "") {
  if (!/^tt\d{6,10}$/.test(String(imdb))) return [];

  const playerUrl = `${PLAYER_DOMAIN}/movie/${imdb}`;
  const page = await axios.get(playerUrl, {
    timeout: 15000,
    headers: { "User-Agent": BROWSER_UA, ...(referer ? { Referer: referer } : {}) },
  });
  const token = (String(page.data).match(/token:\s*["']([A-Za-z0-9._-]+)["']/) || [])[1];
  if (!token) return [];

  const cookie = (page.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  const res = await axios.post(
    `${PLAYER_DOMAIN}/api/embed-links`,
    { type: "movie", id: imdb, token },
    {
      timeout: 15000,
      headers: {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/json",
        Origin: PLAYER_DOMAIN,
        Referer: playerUrl,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }
  );

  const sources = Array.isArray(res.data && res.data.sources) ? res.data.sources : [];
  return sources
    .filter((src) => src && src.url)
    .map((src) => {
      const key = playerServerKey(src.name, src.url);
      return {
        name: key.charAt(0).toUpperCase() + key.slice(1),
        server: key,
        language: PLAYER_LANGUAGES[src.version] || src.version || "Latino",
        embedUrl: String(src.url).startsWith("//") ? `https:${src.url}` : src.url,
      };
    });
}

module.exports = { fetchServersByImdb, PLAYER_DOMAIN };
