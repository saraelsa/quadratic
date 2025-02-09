import { SheetPos } from '@/gridGL/types/size';
import { multiplayer } from '@/multiplayer/multiplayer';
import { JsCodeResult } from '@/quadratic-core/quadratic_core';
import { TransactionSummary } from '@/quadratic-core/types';
import mixpanel from 'mixpanel-browser';
import { grid, pointsToRect } from '../../grid/controller/Grid';
import { PythonMessage, PythonReturnType } from './pythonTypes';

const IS_TEST = process.env.NODE_ENV === 'test';

interface PythonCode {
  transactionId: string;
  sheetPos: SheetPos;
  code: string;
}

function isEmpty(value: string | null | undefined) {
  return value == null || (typeof value === 'string' && value.trim().length === 0);
}

class PythonWebWorker {
  private worker?: Worker;
  private loaded = false;
  private running = false;
  private executionStack: PythonCode[] = [];

  private expectWorker() {
    if (!this.worker) throw new Error('Expected worker to be defined in python.ts');
  }

  private calculationComplete() {
    this.running = false;
    this.executionStack.shift();
    this.next(true);
  }

  private getTransactionId() {
    if (this.executionStack.length === 0) throw new Error('Expected executionStack to have at least 1 element');

    return this.executionStack[0].transactionId;
  }

  init() {
    this.worker = new Worker(new URL('./python.worker.ts', import.meta.url), {
      /* @vite-ignore */ type: !IS_TEST ? 'classic' : 'module',
    });

    this.worker.onmessage = async (e: MessageEvent<PythonMessage>) => {
      const event = e.data;

      switch (event.type) {
        case 'results': {
          const transactionId = this.getTransactionId();
          const pythonResult = event.results;
          const nothingReturned = pythonResult.output_type === 'NoneType' && isEmpty(pythonResult.output);

          if (!pythonResult) throw new Error('Expected results to be defined in python.ts');

          if (nothingReturned) {
            pythonResult.array_output = undefined;
            pythonResult.output = ['', 'blank'];
          } else {
            if (pythonResult.array_output && pythonResult.array_output.length) {
              if (!Array.isArray(pythonResult.array_output[0][0])) {
                pythonResult.array_output = pythonResult.array_output.map((row: any) => [row]);
              }
            }
          }

          if (!pythonResult.success) {
            pythonResult.error_msg = pythonResult.input_python_stack_trace;
          }

          // this is used in testing
          if (IS_TEST) {
            window.dispatchEvent(new CustomEvent('python-results', { detail: pythonResult }));
            break;
          }

          let outputType = pythonResult.output_type;

          if (pythonResult.output_size) {
            outputType = `${pythonResult.output_size[0]}x${pythonResult.output_size[1]} ${outputType}`;
          }

          const result = new JsCodeResult(
            transactionId,
            pythonResult.success,
            pythonResult.error_msg,
            pythonResult.std_out,
            pythonResult.output,
            JSON.stringify(pythonResult.array_output),
            pythonResult.lineno,
            outputType,
            pythonResult.cancel_compute
          );
          grid.calculationComplete(result);
          this.calculationComplete();

          break;
        }

        case 'get-cells': {
          const transactionId = this.getTransactionId();
          const range = event.range;

          if (!range) throw new Error('Expected range to be defined in get-cells');

          try {
            const cells = grid.calculationGetCells(
              transactionId,
              pointsToRect(range.x0, range.y0, range.x1 - range.x0, range.y1 - range.y0),
              range.sheet !== undefined ? range.sheet.toString() : undefined,
              event.range?.lineNumber
            );

            // cells will be undefined if there was a problem getting the cells. In this case, the python execution is done.
            if (cells) {
              this.worker!.postMessage({ type: 'get-cells', cells });
            } else {
              this.calculationComplete();
            }
          } catch (e) {
            console.warn('Error in get-cells', e);
            this.calculationComplete();
            grid.transactionResponse(e as TransactionSummary);
          }

          break;
        }

        case 'python-loaded': {
          window.dispatchEvent(new CustomEvent('python-loaded'));
          this.loaded = true;
          this.next(false);
          break;
        }

        case 'python-error': {
          window.dispatchEvent(new CustomEvent('python-error'));
          break;
        }

        case 'not-loaded': {
          window.dispatchEvent(new CustomEvent('python-loading'));
          break;
        }

        default: {
          throw new Error(`Unhandled pythonWebWorker.type ${event.type}`);
        }
      }
    };
  }

  getRunningCells(sheetId: string): SheetPos[] {
    return this.executionStack.filter((cell) => cell.sheetPos.sheetId === sheetId).map((cell) => cell.sheetPos);
  }

  runPython(transactionId: string, x: number, y: number, sheetId: string, code: string) {
    this.expectWorker();
    this.executionStack.push({ transactionId, sheetPos: { x, y, sheetId }, code });
    this.next(false);
  }

  getCodeRunning(): SheetPos[] {
    return this.executionStack.map((cell) => cell.sheetPos);
  }

  private showChange() {
    window.dispatchEvent(new CustomEvent('python-change'));
    multiplayer.sendCodeRunning(this.getCodeRunning());
  }

  next(complete: boolean) {
    if (complete) {
      this.running = false;
    }

    if (!this.worker || !this.loaded || this.running) {
      this.showChange();
      return;
    }

    if (this.executionStack.length) {
      const first = this.executionStack[0];
      if (first) {
        if (!this.running) {
          this.running = true;
          window.dispatchEvent(new CustomEvent('python-computation-started'));
        }
        this.worker.postMessage({ type: 'execute', python: first.code, pos: first.sheetPos });
      }
    } else if (complete) {
      window.dispatchEvent(new CustomEvent('python-computation-finished'));
    }

    this.showChange();
  }

  stop() {
    if (this.worker) {
      this.worker.terminate();
    }
  }

  restart() {
    this.stop();
    this.init();
  }

  restartFromUser() {
    mixpanel.track('[PythonWebWorker].restartFromUser');
    const transactionId = this.getTransactionId();

    this.restart();

    const result = new JsCodeResult(
      transactionId,
      false,
      'Python execution cancelled by user',
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      true
    );

    grid.calculationComplete(result);
    this.calculationComplete();
  }

  getCells(cells: string) {
    if (!this.worker) throw new Error('Expected worker to be defined in python.ts');
    this.worker.postMessage({ type: 'get-cells', cells: JSON.parse(cells) });
  }

  changeOutput(_: Record<string, PythonReturnType>): void {}
}

export const pythonWebWorker = new PythonWebWorker();

// need to bind to window because rustCallbacks.ts cannot include any TS imports; see https://rustwasm.github.io/wasm-bindgen/reference/js-snippets.html#caveats
window.runPython = pythonWebWorker.runPython.bind(pythonWebWorker);
