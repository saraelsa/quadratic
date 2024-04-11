import { CellRef, Span } from './formulaNotation';

const SIMPLE_CELL_FNS = ['cell', 'c', 'getCell'];
const SIMPLE_CELL_RR_FNS = ['rel_cell', 'rc'];
const MULTICURSOR_CELL_FNS = ['cells', 'getCells'];

const CELL = /\(\s*(-?\d+\s*,\s*-?\d+\s*)\)/;
const BOUNDARY = /(?<=^|[\s;.+\-*/()[\]<>=!&|^%])/;
const SIMPLE_CELL = new RegExp(`${BOUNDARY.source}(${[...SIMPLE_CELL_FNS, ...SIMPLE_CELL_RR_FNS].join('|')})${CELL.source}`, 'g');
const MULTICURSOR_CELL = new RegExp(`${BOUNDARY.source}(${MULTICURSOR_CELL_FNS.join('|')})${CELL.source}`, 'g');

export type ParsePythonReturnType = {
  parse_error_msg: string | undefined;
  parse_error_span: { start: number | null; end: number | null } | undefined;
  cell_refs: {
    cell_ref: CellRef;
    cell_ref_pos_is_relative: boolean;
    span: Span;
  }[];
};

export function parsePython(modelContent: string) {
  let matches: RegExpExecArray | null;

  let parsedEditorContent: ParsePythonReturnType = {
    // could be improved to check for errors within the editor content
    parse_error_msg: undefined,
    parse_error_span: undefined,
    cell_refs: [],
  };

  while ((matches = SIMPLE_CELL.exec(modelContent)) !== null) {
    const match = matches[0];
    const fn = matches[1];
    const group = matches[2];
    const [x, y] = group.split(',');
    const isRelativeReference = SIMPLE_CELL_RR_FNS.includes(fn);
    const startIndex = matches.index;
    const matchLength = match.length;

    parsedEditorContent.cell_refs.push({
      cell_ref: {
        type: 'Cell',
        pos: { x: { type: 'Relative', coord: parseInt(x) }, y: { type: 'Relative', coord: parseInt(y) } },
      },
      cell_ref_pos_is_relative: isRelativeReference,
      span: { start: startIndex, end: startIndex + matchLength },
    });
  }

  while ((matches = MULTICURSOR_CELL.exec(modelContent)) !== null) {
    const match = matches[0];
    const startCell = matches[1];
    const endCell = matches[2];
    const [startX, startY] = startCell.split(',');
    const [endX, endY] = endCell.split(',');
    const startIndex = matches.index;
    const matchLength = match.length;

    parsedEditorContent.cell_refs.push({
      cell_ref: {
        type: 'CellRange',
        start: { x: { type: 'Relative', coord: parseInt(startX) }, y: { type: 'Relative', coord: parseInt(startY) } },
        end: { x: { type: 'Relative', coord: parseInt(endX) }, y: { type: 'Relative', coord: parseInt(endY) } },
      },
      cell_ref_pos_is_relative: false,
      span: { start: startIndex, end: startIndex + matchLength },
    });
  }
  return parsedEditorContent;
}
