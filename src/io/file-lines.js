import fs from "node:fs";

const CHUNK_BYTES = 256 * 1024;

// Snapshot the file length at open and retain at most one record plus a chunk.
// Yield bytes so callers can skip large tool records without decoding them.
// Closing the iterator early also closes its file descriptor.
export function* readFileLines(filePath, { reverse = false, start = 0, end } = {}) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = Math.min(end ?? Infinity, fs.fstatSync(fd).size);
    let position = reverse ? size : start;
    let fragments = [];
    let length = 0;
    while (reverse ? position > start : position < size) {
      const count = Math.min(CHUNK_BYTES, reverse ? position - start : size - position);
      const offset = reverse ? position - count : position;
      const chunk = Buffer.allocUnsafe(count);
      let read = 0;
      while (read < count) {
        const n = fs.readSync(fd, chunk, read, count - read, offset + read);
        if (n === 0) throw new Error("File changed while reading lines.");
        read += n;
      }
      position = reverse ? offset : offset + count;
      if (reverse) {
        let boundary = chunk.length;
        for (let newline = chunk.lastIndexOf(10); newline >= 0;
          newline = newline > 0 ? chunk.lastIndexOf(10, newline - 1) : -1) {
          const part = chunk.subarray(newline + 1, boundary);
          yield fragments.length
            ? Buffer.concat([part, ...fragments.reverse()], part.length + length)
            : part;
          fragments = [];
          length = 0;
          boundary = newline;
        }
        if (boundary > 0) {
          const part = chunk.subarray(0, boundary);
          fragments.push(part);
          length += part.length;
        }
      } else {
        let boundary = 0;
        for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, newline + 1)) {
          const part = chunk.subarray(boundary, newline);
          yield fragments.length
            ? Buffer.concat([...fragments, part], length + part.length)
            : part;
          fragments = [];
          length = 0;
          boundary = newline + 1;
        }
        if (boundary < chunk.length) {
          const part = chunk.subarray(boundary);
          fragments.push(part);
          length += part.length;
        }
      }
    }
    if (fragments.length) yield Buffer.concat(reverse ? fragments.reverse() : fragments, length);
  } finally {
    fs.closeSync(fd);
  }
}
