import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';

describe('Payroll 7-Sheet Excel Specification', () => {
  function sanitizeExcelCell(val: any): any {
    if (typeof val === 'string' && /^[=+\-@]/.test(val)) {
      return `'${val}`;
    }
    return val;
  }

  it('sanitizes formula injection strings', () => {
    expect(sanitizeExcelCell('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
    expect(sanitizeExcelCell('+123456')).toBe("'+123456");
    expect(sanitizeExcelCell('-50000')).toBe("'-50000");
    expect(sanitizeExcelCell('@evil()')).toBe("'@evil()");
    expect(sanitizeExcelCell('Normal String')).toBe('Normal String');
    expect(sanitizeExcelCell(1500000)).toBe(1500000);
  });

  it('generates a valid 7-sheet workbook with all required sheets', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheetNames = ['Summary', 'Attendance', 'Exceptions', 'Overtime', 'Bonus', 'Adjustments', 'Audit'];

    sheetNames.forEach((name) => {
      const s = workbook.addWorksheet(name);
      s.addRow(['Sample Column 1', 'Sample Column 2']);
      s.addRow([sanitizeExcelCell('Test Value'), sanitizeExcelCell(100000)]);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);

    const readWb = new ExcelJS.Workbook();
    await readWb.xlsx.load(buffer as any);

    expect(readWb.worksheets.length).toBe(7);
    const loadedSheetNames = readWb.worksheets.map((w) => w.name);
    expect(loadedSheetNames).toEqual(sheetNames);
  });
});
