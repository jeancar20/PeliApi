const { axiosGet } = require('../resolver-helpers');
const { unpack, detect } = require('unpacker');

// uqload.com/uqload.vc: sin ninguna proteccion tipo Cloudflare confirmada en
// pruebas manuales (200 directo, sin reto). Usa el mismo empaquetado JWPlayer
// "eval(function(p,a,c,k,e,d)..." que streamwish, pero sin el paso extra de
// redireccion a un dominio espejo — el sources[0].file resuelto sirve
// directo, sin mas indireccion.
async function extractUqload(pageUrl) {
  console.log(`[UQ RESOLVER] Resolviendo: ${pageUrl}`);
  try {
    let html;
    try {
      const res = await axiosGet(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': pageUrl,
        },
      });
      html = res.data;
    } catch (e) {
      console.error('[UQ RESOLVER] Error descargando página:', e.message);
      return null;
    }

    const scriptMatch = html.match(
      /<script[^>]*type=['"]text\/javascript['"][^>]*>\s*(eval\(function\(p,a,c,k,e,d\)[\s\S]*?)<\/script>/i
    );
    if (!scriptMatch) {
      console.log('[UQ RESOLVER] Script empaquetado no encontrado');
      return null;
    }

    const packedJs = scriptMatch[1];
    if (!detect(packedJs)) {
      console.log('[UQ RESOLVER] Script no parece estar empaquetado con Packer');
      return null;
    }

    const unpacked = unpack(packedJs);
    const fileMatch = unpacked.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i);
    if (!fileMatch) {
      console.log('[UQ RESOLVER] No se encontró sources[0].file en el script desempaquetado');
      return null;
    }

    const directUrl = fileMatch[1];
    console.log('[UQ RESOLVER] URL resuelta exitosamente:', directUrl);
    return directUrl;
  } catch (err) {
    console.error('[UQ RESOLVER] Error:', err.message);
    return null;
  }
}

module.exports = { extractUqload };
