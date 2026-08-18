/**
 * A deliberately tiny PDF writer.
 *
 * The template is nothing but filled rectangles, one dashed outline and a few
 * lines of Helvetica, so a full PDF library would be a large dependency for no
 * benefit. Input coordinates are millimetres with a top-left origin (matching
 * the SVG); this module flips them into PDF's bottom-left point space.
 */

const MM_TO_PT = 72 / 25.4;

export type PdfOp =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; gray: number }
  | {
      kind: 'dashedRect';
      x: number;
      y: number;
      w: number;
      h: number;
      gray: number;
      lineWidth: number;
      dash: [number, number];
    }
  | {
      kind: 'text';
      x: number;
      y: number;
      size: number;
      text: string;
      align: 'left' | 'center';
      gray: number;
      bold?: boolean;
    };

export interface PdfDocument {
  widthMm: number;
  heightMm: number;
  ops: PdfOp[];
  title?: string;
}

const pt = (mm: number): string => (mm * MM_TO_PT).toFixed(3);

/** Rough Helvetica advance width, good enough to centre short labels. */
const textWidthMm = (text: string, sizeMm: number, bold: boolean): number =>
  text.length * sizeMm * (bold ? 0.58 : 0.52);

function escapePdfText(text: string): string {
  // Standard-14 Helvetica is a single-byte encoding; drop anything non-ASCII
  // rather than emit mojibake on someone's printer.
  return text
    .replace(/[^\x20-\x7e]/g, '-')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function contentStream(doc: PdfDocument): string {
  const flipY = (yMm: number): number => doc.heightMm - yMm;
  const out: string[] = [];

  for (const op of doc.ops) {
    if (op.kind === 'rect') {
      out.push(`${op.gray.toFixed(3)} g`);
      out.push(`${pt(op.x)} ${pt(flipY(op.y + op.h))} ${pt(op.w)} ${pt(op.h)} re f`);
    } else if (op.kind === 'dashedRect') {
      out.push(`${op.gray.toFixed(3)} G`);
      out.push(`${pt(op.lineWidth)} w`);
      out.push(`[${pt(op.dash[0])} ${pt(op.dash[1])}] 0 d`);
      out.push(`${pt(op.x)} ${pt(flipY(op.y + op.h))} ${pt(op.w)} ${pt(op.h)} re S`);
      out.push('[] 0 d');
    } else {
      const font = op.bold ? '/F2' : '/F1';
      const x =
        op.align === 'center' ? op.x - textWidthMm(op.text, op.size, op.bold === true) / 2 : op.x;
      out.push(`${op.gray.toFixed(3)} g`);
      out.push('BT');
      out.push(`${font} ${pt(op.size)} Tf`);
      out.push(`${pt(x)} ${pt(flipY(op.y))} Td`);
      out.push(`(${escapePdfText(op.text)}) Tj`);
      out.push('ET');
    }
  }
  return out.join('\n');
}

/** Serializes a single-page PDF. Returns raw bytes ready to write to disk. */
export function buildPdf(doc: PdfDocument): Uint8Array {
  const stream = contentStream(doc);
  const streamBytes = Buffer.byteLength(stream, 'latin1');
  const title = escapePdfText(doc.title ?? 'Dino Dudes template');

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(doc.widthMm)} ${pt(doc.heightMm)}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${title}) /Producer (dino-dudes template generator v1) >>`,
  ];

  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
