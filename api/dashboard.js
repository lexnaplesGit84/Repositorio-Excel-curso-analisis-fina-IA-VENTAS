// api/dashboard.js
// Función serverless de Vercel (Node.js) que sincroniza los datos de ventas
// publicados como CSV desde Google Sheets.
//
// La URL es pública (Google Sheets "Publicar en la web" -> CSV), por lo que
// no requiere token ni variable de entorno: se puede dejar escrita en el
// código sin riesgo de seguridad.

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQklAxsP2NbuqLZx7n0VgW9R-0uePefC7cNz-JByqfvLmOS7L_vJBn3xypVyxsZg5R83CjzU05q6sEb/pub?output=csv";

/**
 * Parser de CSV estándar (RFC 4180) hecho a mano, sin dependencias externas.
 * Soporta:
 *  - Campos entre comillas dobles que contienen comas.
 *  - Comillas dobles escapadas como "" dentro de un campo entrecomillado.
 *  - Saltos de línea \r\n, \r o \n.
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++; // saltar la segunda comilla del par escapado
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // se ignora; el fin de fila real lo marca \n
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  // Última fila si el archivo no termina con salto de línea.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Descarta filas completamente vacías.
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

/**
 * Convierte un monto en formato numérico latino ("1.250,00" o "45,50")
 * a un Number de JavaScript (1250.00 / 45.50). También admite montos
 * que ya vengan en formato estándar ("1250.00").
 */
function parseMonto(raw) {
  if (raw === undefined || raw === null) return 0;
  let s = String(raw).trim();
  if (s === "") return 0;

  s = s.replace(/[^0-9.,-]/g, ""); // quita símbolos de moneda o espacios

  const tieneComa = s.includes(",");
  const tienePunto = s.includes(".");

  if (tieneComa && tienePunto) {
    // Formato latino: punto = miles, coma = decimales -> "1.250,00"
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (tieneComa && !tienePunto) {
    // Solo coma -> es el separador decimal -> "45,50"
    s = s.replace(",", ".");
  }
  // Si solo tiene punto, se asume que ya es formato estándar (1250.00).

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convierte una fecha en formato D/M/YYYY (o DD/MM/YYYY) a un string
 * ISO 8601 (YYYY-MM-DD), que es el formato recomendado para transportar
 * fechas en JSON.
 */
function parseFecha(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const partes = s.split(/[\/\-]/);

  if (partes.length === 3) {
    let [d, m, y] = partes;
    d = d.padStart(2, "0");
    m = m.padStart(2, "0");
    if (y.length === 2) y = `20${y}`;

    const iso = `${y}-${m}-${d}`;
    const fecha = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(fecha.getTime())) {
      return iso;
    }
  }

  return s; // valor original si no se pudo interpretar
}

function normalizarEncabezado(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita tildes: "región" -> "region"
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ success: false, error: "Método no permitido." });
    return;
  }

  try {
    const respuesta = await fetch(CSV_URL, { cache: "no-store" });

    if (!respuesta.ok) {
      throw new Error(
        `No se pudo descargar el CSV (HTTP ${respuesta.status}).`
      );
    }

    const csvTexto = await respuesta.text();
    const filas = parseCSV(csvTexto);

    if (filas.length < 2) {
      throw new Error("El CSV publicado no contiene filas de datos.");
    }

    const encabezado = filas[0].map(normalizarEncabezado);
    const idxFecha = encabezado.indexOf("fecha");
    const idxVendedor = encabezado.indexOf("vendedor");
    const idxProducto = encabezado.indexOf("producto");
    const idxMonto = encabezado.indexOf("monto");
    const idxRegion = encabezado.indexOf("region");

    if (
      idxFecha === -1 ||
      idxVendedor === -1 ||
      idxProducto === -1 ||
      idxMonto === -1 ||
      idxRegion === -1
    ) {
      throw new Error(
        "El CSV no tiene las columnas esperadas: Fecha, Vendedor, Producto, Monto, Región."
      );
    }

    const ventas = filas
      .slice(1)
      .map((fila, i) => ({
        id: i + 1,
        fecha: parseFecha(fila[idxFecha]),
        vendedor: String(fila[idxVendedor] || "").trim(),
        producto: String(fila[idxProducto] || "").trim(),
        monto: parseMonto(fila[idxMonto]),
        region: String(fila[idxRegion] || "").trim(),
      }))
      .filter((v) => v.vendedor !== "" || v.producto !== "");

    res.status(200).json({
      success: true,
      syncedAt: new Date().toISOString(),
      total: ventas.length,
      ventas,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || "Error desconocido al sincronizar los datos.",
    });
  }
};
