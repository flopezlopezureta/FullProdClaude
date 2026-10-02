// Genera un PDF A4 horizontal a partir de una lista de "hojas" (HTML de tamaño fijo), renderizando
// UNA hoja a la vez con html2pdf (ya cargado por CDN en index.html). Renderizar todo en un solo
// canvas, como hace html2pdf por defecto, falla con documentos largos (el canvas tiene un tope de
// alto en el navegador) — por hoja aguanta cualquier cantidad y la memoria se libera en cada paso.
declare const html2pdf: any;

// Medidas internas de html2pdf para A4 horizontal (floor de 297mm x 210mm a 96dpi). Cada hoja debe
// medir exactamente esto: si mide más se parte en dos páginas, si mide menos queda un borde en blanco.
export const PAGE_W = 1122;
export const PAGE_H = 793;
const MM_W = 297;
const MM_H = 210;

// Cada hoja puede ser el HTML ya armado o una función que lo arma al momento de renderizar (así no
// se mantienen en memoria cientos de gráficos/imágenes cuando el informe es de toda la flota).
export async function renderPagesToPdf(
  pages: (string | (() => string))[],
  opts: { fileName: string; scale?: number; quality?: number; onProgress?: (done: number, total: number) => void }
): Promise<void> {
  if (typeof html2pdf === 'undefined') {
    throw new Error('El generador de PDF no está disponible (no cargó html2pdf). Recarga la página e inténtalo de nuevo.');
  }
  const scale = opts.scale ?? 2;
  const quality = opts.quality ?? 0.92;

  // El host (que NO se clona) se saca de pantalla; cada hoja queda sin estilos de posición.
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${PAGE_W}px;pointer-events:none`;
  document.body.appendChild(host);

  let pdf: any = null;
  try {
    for (let i = 0; i < pages.length; i++) {
      const el = document.createElement('div');
      el.style.cssText = `width:${PAGE_W}px;background:#fff`;
      const page = pages[i];
      el.innerHTML = typeof page === 'function' ? page() : page;
      host.appendChild(el);

      const worker = html2pdf().set({
        margin: 0,
        image: { type: 'jpeg', quality },
        html2canvas: { scale, useCORS: true, logging: false, backgroundColor: '#ffffff', windowWidth: PAGE_W },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
        pagebreak: { mode: ['css'] },
      }).from(el);

      if (i === 0) {
        pdf = await worker.toPdf().get('pdf'); // crea el PDF con la primera hoja
      } else {
        const canvas = await worker.toCanvas().get('canvas');
        pdf.addPage();
        pdf.addImage(canvas.toDataURL('image/jpeg', quality), 'JPEG', 0, 0, MM_W, MM_H);
      }

      host.removeChild(el);
      opts.onProgress?.(i + 1, pages.length);
      await new Promise(r => setTimeout(r, 0)); // cede el hilo para que se pinte el avance
    }
    pdf.save(opts.fileName);
  } finally {
    host.remove();
  }
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
