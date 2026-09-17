import fs from 'fs';

function parseXmlStrings(xml) {
  const strings = [];
  const re = /<si>(.*?)<\/si>/gs;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const textMatches = [...match[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(m => m[1]);
    strings.push(textMatches.join(''));
  }
  return strings;
}

function parseSheetXml(xml, sharedStrings) {
  const rows = [];
  const rowMatches = xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/gs);

  for (const rMatch of rowMatches) {
    const rowNum = parseInt(rMatch[1], 10);
    const cells = [];
    const cellMatches = rMatch[2].matchAll(/<c\s+([^>]*?)>(?:<v>([^<]*)<\/v>)?<\/c>/gs);

    for (const cMatch of cellMatches) {
      const attrs = cMatch[1];
      const val = cMatch[2];
      const colMatch = attrs.match(/r="([A-Z]+)\d+"/);
      const typeMatch = attrs.match(/t="([^"]+)"/);
      
      if (!colMatch) continue;
      const col = colMatch[1];
      const type = typeMatch ? typeMatch[1] : null;

      let resolved = val;
      if (type === 's' && val !== undefined) {
        resolved = sharedStrings[parseInt(val, 10)];
      }
      cells.push({ col, value: resolved });
    }
    if (cells.length > 0) {
      rows.push({ rowNum, cells });
    }
  }
  return rows;
}

const stringsXml = fs.readFileSync('xlsx_unpacked/xl/sharedStrings.xml', 'utf8');
const sharedStrings = parseXmlStrings(stringsXml);

const sheet3Xml = fs.readFileSync('xlsx_unpacked/xl/worksheets/sheet3.xml', 'utf8');
const rows = parseSheetXml(sheet3Xml, sharedStrings);

console.log(`Header row 1:`);
console.log(rows[0].cells.map(c => `${c.col}: "${c.value}"`).join(' | '));

console.log(`\nSample rows:`);
for (let i = 1; i < Math.min(25, rows.length); i++) {
  const rowObj = {};
  rows[i].cells.forEach(c => rowObj[c.col] = c.value);
  console.log(`Row ${rows[i].rowNum}: Ship="${rowObj.A}" | Points="${rowObj.B}" | Role/Class="${rowObj.C}" | F="${rowObj.F}" | G="${rowObj.G}"`);
}

// Dump all rows to parsed_sheet3.json
fs.writeFileSync('parsed_sheet3.json', JSON.stringify(rows, null, 2));
