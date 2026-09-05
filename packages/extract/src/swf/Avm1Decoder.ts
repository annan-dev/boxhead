/**
 * A partial AVM1 (ActionScript 2 bytecode) interpreter, just complete enough to
 * rebuild the literal data structures Boxhead stores in its action blocks.
 *
 * The game's art database is not sprites -- it is ~93k InitArray and ~24k
 * InitObject opcodes building a nested object graph of triangle meshes,
 * materials and animation keyframes. Running the stack machine reconstructs it
 * exactly; there is no shape-tag parsing involved.
 *
 * Control flow (jumps, functions, arithmetic on unknowns) is deliberately NOT
 * implemented. The data blocks are straight-line literal construction, and
 * anything else is reported through `warnings` rather than silently guessed.
 */

export type Avm1Object = { [key: string]: Avm1Value };
export type Avm1Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | Avm1Value[]
  | Avm1Object;

export interface Avm1Result {
  /** Variables defined with DefineLocal / SetVariable, in definition order. */
  locals: Map<string, Avm1Value>;
  /** Anything left on the stack when the block ended. */
  stack: Avm1Value[];
  /** Values passed to .push(...) on an array, in call order. */
  pushed: Avm1Value[];
  constantPool: string[];
  warnings: Map<string, number>;
}

const Op = {
  End: 0x00,
  Pop: 0x17,
  Add2: 0x47,
  GetVariable: 0x1c,
  SetVariable: 0x1d,
  DefineLocal: 0x3c,
  DefineLocal2: 0x41,
  NewObject: 0x40,
  InitArray: 0x42,
  InitObject: 0x43,
  GetMember: 0x4e,
  SetMember: 0x4f,
  CallMethod: 0x52,
  PushDuplicate: 0x4c,
  StackSwap: 0x4d,
  ConstantPool: 0x88,
  Push: 0x96,
  StoreRegister: 0x87,
  DefineFunction: 0x9b,
  DefineFunction2: 0x8e,
} as const;

/**
 * AVM1 stores doubles as two 32-bit words in reversed order, so the halves must
 * be swapped before reading. Getting this wrong yields values around 1e300 --
 * a useful smoke test that the decode is sound.
 */
function readAvm1Double(buf: Buffer, off: number): number {
  const swapped = Buffer.allocUnsafe(8);
  buf.copy(swapped, 0, off + 4, off + 8);
  buf.copy(swapped, 4, off, off + 4);
  return swapped.readDoubleLE(0);
}

export function decodeAvm1(code: Buffer): Avm1Result {
  const stack: Avm1Value[] = [];
  const registers: Avm1Value[] = [];
  const locals = new Map<string, Avm1Value>();
  const pushed: Avm1Value[] = [];
  const warnings = new Map<string, number>();
  let pool: string[] = [];

  const warn = (key: string): void => {
    warnings.set(key, (warnings.get(key) ?? 0) + 1);
  };
  const popN = (count: number): Avm1Value[] => {
    const out: Avm1Value[] = [];
    for (let k = 0; k < count && stack.length > 0; k++) out.push(stack.pop());
    return out;
  };

  let i = 0;
  const n = code.length;

  while (i < n) {
    const op = code[i]!;
    i += 1;
    if (op === Op.End) break;

    // Opcodes below 0x80 take no payload.
    if (op < 0x80) {
      switch (op) {
        case Op.InitArray: {
          const count = Number(stack.pop());
          if (!Number.isFinite(count) || count < 0 || count > stack.length) {
            warn('initArrayBadCount');
            break;
          }
          // Elements were pushed in order, so they come off reversed.
          stack.push(popN(count).reverse());
          break;
        }
        case Op.InitObject: {
          const count = Number(stack.pop());
          if (!Number.isFinite(count) || count < 0 || count * 2 > stack.length) {
            warn('initObjectBadCount');
            break;
          }
          // Pairs pop last-first; reverse so key order matches the source,
          // which the renderer relies on for part draw order.
          const pairs: Array<[string, Avm1Value]> = [];
          for (let k = 0; k < count; k++) {
            const value = stack.pop();
            const key = String(stack.pop());
            pairs.push([key, value]);
          }
          const obj: Avm1Object = {};
          for (const [key, value] of pairs.reverse()) obj[key] = value;
          stack.push(obj);
          break;
        }
        case Op.DefineLocal: {
          const value = stack.pop();
          const name = String(stack.pop());
          locals.set(name, value);
          break;
        }
        case Op.DefineLocal2: {
          const name = String(stack.pop());
          if (!locals.has(name)) locals.set(name, undefined);
          break;
        }
        case Op.SetVariable: {
          const value = stack.pop();
          const name = String(stack.pop());
          locals.set(name, value);
          break;
        }
        case Op.GetVariable: {
          const name = String(stack.pop());
          stack.push(locals.has(name) ? locals.get(name)! : { __unresolved__: name });
          break;
        }
        case Op.SetMember: {
          const value = stack.pop();
          const key = String(stack.pop());
          const target = stack.pop();
          if (target && typeof target === 'object' && !Array.isArray(target)) {
            (target as Avm1Object)[key] = value;
          } else {
            warn('setMemberOnNonObject');
          }
          break;
        }
        case Op.GetMember: {
          const key = String(stack.pop());
          const target = stack.pop();
          if (target && typeof target === 'object' && !Array.isArray(target)) {
            stack.push((target as Avm1Object)[key]);
          } else {
            stack.push(undefined);
          }
          break;
        }
        case Op.CallMethod: {
          const method = String(stack.pop());
          const target = stack.pop();
          const argc = Number(stack.pop());
          const args = Number.isFinite(argc) && argc >= 0 ? popN(argc) : [];
          if (method === 'push' && Array.isArray(target)) {
            // Arguments pop in reverse; restore call order before appending.
            const inOrder = args.slice().reverse();
            target.push(...inOrder);
            pushed.push(...inOrder);
            stack.push(target.length);
          } else {
            warn('callMethod:' + (method || '(anonymous)'));
            stack.push(undefined);
          }
          break;
        }
        case Op.NewObject: {
          const name = String(stack.pop());
          const argc = Number(stack.pop());
          const args = Number.isFinite(argc) && argc >= 0 ? popN(argc) : [];
          if (name === 'Array') {
            // new Array(n) preallocates; new Array(a, b) is a literal list.
            const preallocated = args.length === 1 && typeof args[0] === 'number';
            stack.push(preallocated ? [] : args.reverse());
          } else {
            warn('newObject:' + name);
            stack.push({});
          }
          break;
        }
        case Op.Add2: {
          const b = stack.pop();
          const a = stack.pop();
          if (typeof a === 'number' && typeof b === 'number') stack.push(a + b);
          else stack.push(String(a) + String(b));
          break;
        }
        case Op.PushDuplicate:
          if (stack.length > 0) stack.push(stack[stack.length - 1]!);
          break;
        case Op.StackSwap:
          if (stack.length >= 2) {
            const a = stack.pop()!;
            const b = stack.pop()!;
            stack.push(a, b);
          }
          break;
        case Op.Pop:
          stack.pop();
          break;
        default:
          warn('op:0x' + op.toString(16).padStart(2, '0'));
      }
      continue;
    }

    // Opcodes at 0x80 and above carry a 16-bit payload length.
    if (i + 2 > n) break;
    const len = code.readUInt16LE(i);
    i += 2;
    const data = code.subarray(i, i + len);
    i += len;

    switch (op) {
      case Op.ConstantPool: {
        pool = [];
        if (data.length < 2) break;
        const count = data.readUInt16LE(0);
        let p = 2;
        for (let k = 0; k < count; k++) {
          const end = data.indexOf(0, p);
          if (end < 0) break;
          pool.push(data.toString('latin1', p, end));
          p = end + 1;
        }
        break;
      }
      case Op.StoreRegister: {
        const reg = data[0] ?? 0;
        registers[reg] = stack[stack.length - 1];
        break;
      }
      case Op.DefineFunction:
      case Op.DefineFunction2: {
        // The body follows the payload and must be skipped, not executed.
        const bodyLen = data.length >= 2 ? data.readUInt16LE(data.length - 2) : 0;
        i += bodyLen;
        warn('defineFunctionSkipped');
        break;
      }
      case Op.Push: {
        let p = 0;
        while (p < data.length) {
          const type = data[p]!;
          p += 1;
          if (type === 0) {
            const end = data.indexOf(0, p);
            if (end < 0) {
              p = data.length;
            } else {
              stack.push(data.toString('latin1', p, end));
              p = end + 1;
            }
          } else if (type === 1) {
            stack.push(data.readFloatLE(p));
            p += 4;
          } else if (type === 2) {
            stack.push(null);
          } else if (type === 3) {
            stack.push(undefined);
          } else if (type === 4) {
            stack.push(registers[data[p]!]);
            p += 1;
          } else if (type === 5) {
            stack.push(data[p] !== 0);
            p += 1;
          } else if (type === 6) {
            stack.push(readAvm1Double(data, p));
            p += 8;
          } else if (type === 7) {
            stack.push(data.readInt32LE(p));
            p += 4;
          } else if (type === 8) {
            stack.push(pool[data[p]!] ?? null);
            p += 1;
          } else if (type === 9) {
            stack.push(pool[data.readUInt16LE(p)] ?? null);
            p += 2;
          } else {
            warn('pushType:' + type);
            p = data.length;
          }
        }
        break;
      }
      default:
        warn('op:0x' + op.toString(16).padStart(2, '0') + '(payload)');
    }
  }

  return { locals, stack, pushed, constantPool: pool, warnings };
}
