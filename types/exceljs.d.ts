declare module 'exceljs' {
  export interface Font {
    name?: string;
    size?: number;
    bold?: boolean;
    color?: { argb?: string };
  }

  export interface Cell {
    value: unknown;
    font?: Font;
  }

  export interface Row {
    getCell(index: number): Cell;
  }

  export interface Worksheet {
    rowCount: number;
    getRow(index: number): Row;
  }

  export class Workbook {
    worksheets: Worksheet[];
    xlsx: {
      load(buffer: ArrayBuffer): Promise<void>;
      writeBuffer(): Promise<ArrayBuffer>;
    };
  }

  const ExcelJS: {
    Workbook: typeof Workbook;
  };

  export default ExcelJS;
}
