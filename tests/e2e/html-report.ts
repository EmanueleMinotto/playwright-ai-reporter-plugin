import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZIP_LOCAL_HEADER = 'PK\x03\x04';

/**
 * Extracts the report data embedded in an HTML report.
 *
 * Playwright inlines the whole report as a base64 zip inside `index.html`, so
 * searching the file as text finds nothing — the entries have to be inflated first.
 */
export function readHtmlReport(outputFolder: string): string {
  const html = fs.readFileSync(path.join(outputFolder, 'index.html'), 'utf-8');
  const match = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(html);
  if (!match) throw new Error(`no embedded report found in ${outputFolder}/index.html`);

  const zip = Buffer.from(match[1]!, 'base64');
  const entries: string[] = [];

  let cursor = zip.indexOf(ZIP_LOCAL_HEADER, 0, 'binary');
  while (cursor !== -1) {
    const method = zip.readUInt16LE(cursor + 8);
    const compressedSize = zip.readUInt32LE(cursor + 18);
    const nameLength = zip.readUInt16LE(cursor + 26);
    const extraLength = zip.readUInt16LE(cursor + 28);
    const start = cursor + 30 + nameLength + extraLength;
    const data = zip.subarray(start, start + compressedSize);

    try {
      entries.push((method === 8 ? zlib.inflateRawSync(data) : data).toString('utf-8'));
    } catch {
      // A binary entry (screenshot, trace) is of no interest here.
    }

    cursor = zip.indexOf(ZIP_LOCAL_HEADER, start + compressedSize, 'binary');
  }

  return entries.join('\n');
}
