// Desempaqueta JavaScript ofuscado con "Dean Edwards' packer" (P.A.C.K.E.R.):
//   eval(function(p,a,c,k,e,d){...}('payload',base,count,'a|b|c'.split('|'),0,{}))
// Hosts como Mixdrop y Dropload entregan así el player (donde viene la URL del video),
// así que buscar la URL directamente en el HTML crudo no la encuentra.

const PACKED_RE = /\}\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\.split\(\s*'\|'\s*\)/g;

function toBase(n, radix) {
  return (n < radix ? '' : toBase(Math.floor(n / radix), radix))
    + ((n = n % radix) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
}

function unescapeJsString(s) {
  return s.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');
}

/** Devuelve el código de cada bloque empaquetado encontrado en `html` (lista vacía si no hay). */
function unpackAll(html) {
  const out = [];
  if (typeof html !== 'string') return out;
  PACKED_RE.lastIndex = 0;
  let m;
  while ((m = PACKED_RE.exec(html)) !== null) {
    const radix = Number(m[2]);
    let count = Number(m[3]);
    const dict = unescapeJsString(m[4]).split('|');
    let payload = unescapeJsString(m[1]);
    if (!radix || radix > 62) continue;
    while (count--) {
      if (dict[count]) {
        payload = payload.replace(new RegExp('\\b' + toBase(count, radix) + '\\b', 'g'), dict[count]);
      }
    }
    out.push(payload);
  }
  return out;
}

module.exports = { unpackAll };
