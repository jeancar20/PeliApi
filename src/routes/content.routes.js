const express = require("express");
const { dailyRateLimit } = require("../middlewares/rate-limit");
const pelisplusService = require("../services/pelisplus.service");
const cuevanaService = require("../services/cuevana.service");
const repelishdService = require("../services/repelishd.service");
const downloadService = require("../services/download.service");
const { resolveEmbedUrl } = require("../utils/resolvers");
const { ApiError } = require("../utils/api-error");

const router = express.Router();

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

// Aplicar middlewares globales de límites de tráfico (sin requerimiento de API Key)
router.use(dailyRateLimit);

/**
 * Buscar contenido (películas, series, anime)
 * GET /search?s=avatar o GET /search?q=avatar
 */
router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const query = req.query.s || req.query.q || "";

    if (!query) {
      throw new ApiError(400, "El parametro de busqueda 's' o 'q' es requerido");
    }

    let data = [];
    let source = "aggregate";

    // Buscamos en los 3 proveedores en paralelo — antes Cuevana3 (Puppeteer,
    // más lento) solo se consultaba si PelisPlus+RePelisHD devolvían vacío,
    // lo que en la práctica limitaba mucho el pool de hosts de embed
    // disponible por título (cada proveedor tiene su propio ecosistema de
    // servidores). Promise.all no suma latencias, así que el costo es solo
    // el del más lento de los tres, no la suma.
    try {
      const [ppData, rpData, cuData] = await Promise.all([
        pelisplusService.searchContent(query).catch(err => {
          console.error("Error buscando en PelisPlus:", err.message);
          return [];
        }),
        repelishdService.searchContent(query).catch(err => {
          console.error("Error buscando en RePelisHD:", err.message);
          return [];
        }),
        cuevanaService.searchContent(query).catch(err => {
          console.error("Error buscando en Cuevana3:", err.message);
          return [];
        })
      ]);

      const ppMapped = (ppData || []).map(item => ({ ...item, provider: "pelisplus" }));
      const rpMapped = (rpData || []).map(item => ({ ...item, provider: "repelishd" }));
      const cuMapped = (cuData || []).map(item => ({ ...item, provider: "cuevana3" }));

      data = [...rpMapped, ...ppMapped, ...cuMapped];

      // Ordenar inteligentemente los resultados combinados para poner las coincidencias más cercanas al query al principio
      const lowerQuery = query.toLowerCase().trim();
      data.sort((a, b) => {
        const aTitle = a.title.toLowerCase();
        const bTitle = b.title.toLowerCase();

        // Coincidencia exacta de título
        const aExact = aTitle === lowerQuery || aTitle === `[${lowerQuery}]`;
        const bExact = bTitle === lowerQuery || bTitle === `[${lowerQuery}]`;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;

        // Comienza con el query
        const aStarts = aTitle.startsWith(lowerQuery) || aTitle.startsWith(`[${lowerQuery}`);
        const bStarts = bTitle.startsWith(lowerQuery) || bTitle.startsWith(`[${lowerQuery}`);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;

        // Contiene el query
        const aIncludes = aTitle.includes(lowerQuery);
        const bIncludes = bTitle.includes(lowerQuery);
        if (aIncludes && !bIncludes) return -1;
        if (!aIncludes && bIncludes) return 1;

        return 0;
      });

      if (data.length > 0) {
        source = rpMapped.length > 0 ? "repelishd" : (ppMapped.length > 0 ? "pelisplus" : "cuevana3");
      }
    } catch (error) {
      console.error("Error en búsqueda paralela:", error.message);
    }

    res.status(200).json({
      success: true,
      data,
      source,
    });
  })
);

/**
 * Obtener catálogo filtrado por tipo, género y página
 * GET /catalog?type=movie&genre=accion&page=1
 */
router.get(
  "/catalog",
  asyncHandler(async (req, res) => {
    const type = req.query.type || "movie"; // movie, series, anime
    const genre = req.query.genre || "";
    const page = Number(req.query.page || 1);

    // El catálogo se sirve de PelisPlus porque Cuevana3 no tiene endpoints estructurados
    const data = await pelisplusService.getCatalog(type, genre, page);
    if (data && data.items) {
      data.items = data.items.map(item => ({ ...item, provider: "pelisplus" }));
    }
    
    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Obtener géneros disponibles
 * GET /genres
 */
router.get(
  "/genres",
  asyncHandler(async (req, res) => {
    // Los géneros se obtienen de PelisPlus
    const data = await pelisplusService.getGenres();
    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Obtener detalles y servidores de reproducción de una película o serie
 * GET /info/:slug?type=movie
 */
router.get(
  "/info/*",
  asyncHandler(async (req, res) => {
    const slug = req.params[0];
    const type = req.query.type || "movie"; // movie, series, anime
    let provider = req.query.provider;

    // Auto-detectar si el slug contiene "/" o tiene el patrón de RePelisHD
    if (!provider) {
      if (slug.includes("/") && !slug.startsWith("pelicula/") && !slug.startsWith("serie/") && !slug.startsWith("anime/")) {
        provider = "cuevana3";
      } else if (slug.includes("-online-espanol")) {
        provider = "repelishd";
      } else {
        provider = "pelisplus";
      }
    }

    let data;
    let source = provider;

    try {
      let service;
      if (provider === "cuevana3") service = cuevanaService;
      else if (provider === "repelishd") service = repelishdService;
      else service = pelisplusService;

      data = await service.getContentInfo(slug, type);
    } catch (error) {
      // Si falló y estábamos intentando con PelisPlus, intentamos en cascada
      if (provider === "pelisplus") {
        try {
          console.log(`Cascading info request to RePelisHD for slug: ${slug}`);
          data = await repelishdService.getContentInfo(slug, type);
          source = "repelishd";
        } catch (repelisError) {
          try {
            console.log(`Cascading info request to Cuevana3 for slug: ${slug}`);
            data = await cuevanaService.getContentInfo(slug, type);
            source = "cuevana3";
          } catch (cascadeError) {
            console.error("Cuevana3 cascade failed too:", cascadeError.message);
            throw error; // lanzamos el error original de pelisplus
          }
        }
      } else {
        throw error;
      }
    }

    // Agregar provider al resultado para consistencia
    if (data) {
      data.provider = source;
    }

    res.status(200).json({
      success: true,
      data,
      source,
    });
  })
);

/**
 * Obtener servidores de reproducción para un capítulo de una serie o anime
 * GET /servers?slug=breaking-bad&season=1&episode=1
 */
router.get(
  "/servers",
  asyncHandler(async (req, res) => {
    const slug = req.query.slug || req.query.serieSlug;
    const season = Number(req.query.season || 1);
    const episode = Number(req.query.episode || 1);
    let provider = req.query.provider;

    if (!slug) {
      throw new ApiError(400, "El parametro 'slug' de la serie es requerido");
    }

    // Auto-detectar si el slug contiene "/" o tiene el patrón de RePelisHD
    if (!provider) {
      if (slug.includes("/")) {
        provider = "cuevana3";
      } else if (slug.includes("-online-espanol")) {
        provider = "repelishd";
      } else {
        provider = "pelisplus";
      }
    }

    let data;
    let source = provider;

    try {
      let service;
      if (provider === "cuevana3") service = cuevanaService;
      else if (provider === "repelishd") service = repelishdService;
      else service = pelisplusService;

      data = await service.getEpisodeServers(slug, season, episode);
    } catch (error) {
      if (provider === "pelisplus") {
        try {
          console.log(`Cascading servers request to RePelisHD for slug: ${slug}`);
          data = await repelishdService.getEpisodeServers(slug, season, episode);
          source = "repelishd";
        } catch (repelisError) {
          try {
            console.log(`Cascading servers request to Cuevana3 for slug: ${slug}`);
            data = await cuevanaService.getEpisodeServers(slug, season, episode);
            source = "cuevana3";
          } catch (cascadeError) {
            console.error("Cuevana3 cascade failed too:", cascadeError.message);
            throw error;
          }
        }
      } else {
        throw error;
      }
    }

    res.status(200).json({
      success: true,
      data,
      source,
    });
  })
);

/**
 * Resolver una URL de embed a enlace directo de video (.mp4, .m3u8)
 * GET /resolve?url=https://streamwish.to/e/xxx
 */
router.get(
  "/resolve",
  asyncHandler(async (req, res) => {
    const embedUrl = req.query.url;
    const parentUrl = req.query.parentUrl || null;
    if (!embedUrl) {
      throw new ApiError(400, "Se requiere el parametro 'url' del embed");
    }

    const directUrl = await resolveEmbedUrl(embedUrl, parentUrl);
    res.status(200).json({
      success: true,
      data: {
        embedUrl,
        directUrl,
      },
      source: "pelisplus",
    });
  })
);

/**
 * Iniciar la descarga de una película o capítulo de serie
 * POST /download
 * Body: { url: "https://www.pelisplushd.la/pelicula/xxx", variant: "Latino", preferredServer: "streamwish" }
 */
router.post(
  "/download",
  asyncHandler(async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const data = downloadService.createDownload(req.body || {}, baseUrl);

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Obtener estado de una descarga específica
 * GET /download/:id
 */
router.get(
  "/download/:id",
  asyncHandler(async (req, res) => {
    const data = downloadService.getDownload(req.params.id);

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Iniciar descargas en lote (batch) para múltiples capítulos de una serie
 * POST /batch
 * Body: { mediaUrl: "https://www.pelisplushd.la/serie/xxx", season: 1, episodes: [1, 2, 3], variant: "Latino" }
 */
router.post(
  "/batch",
  asyncHandler(async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const data = downloadService.createBatch(req.body || {}, baseUrl);

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Obtener estado de una descarga en lote específica
 * GET /batch/:id
 */
router.get(
  "/batch/:id",
  asyncHandler(async (req, res) => {
    const data = downloadService.getBatch(req.params.id);

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

module.exports = router;
