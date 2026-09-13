import fs from "fs";
import path from "path";

// Writes that survive the power going out.
//
// `fs.writeFileSync` returns once the bytes are in the page cache, not once they
// are on the disk — up to ~30s of "written" data can still be lost. The usual
// write-then-rename fixes a different problem (a reader never sees a half file)
// and on ext4's default data=ordered it can make this one worse: the rename is
// journalled, the data is not, so a crash can leave a file that exists, is named
// correctly, and is empty.
//
// A run measured in hours, whose whole point is to be resumable, cannot be built
// on "probably written". Every function here flushes before it returns. The cost
// is one disk flush per completed session, against ~90s of GPU work to produce it.

const ensureDir = (file: string) => fs.mkdirSync(path.dirname(file), { recursive: true });

// Add one line to the end of a file. Nothing already in the file is rewritten, so
// a crash can cost at most the line being appended — and a reader that skips an
// unparseable last line loses that one record instead of the whole file.
export function appendLineDurable(file: string, line: string): void {
  ensureDir(file);
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, line.endsWith("\n") ? line : `${line}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Create or overwrite a whole file. For content written once and never extended —
// a summary, a snapshot — where there is nothing to append to.
export function writeFileDurable(file: string, data: string): void {
  ensureDir(file);
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Replace a file's contents atomically: a reader sees the old file or the new one.
// The directory itself is flushed too — otherwise the rename can be lost even
// though the data it points at was safely on disk, which restores the old name.
export function replaceFileDurable(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileDurable(tmp, data);
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(dir);
  } catch {
    // Flushing a directory fd is not permitted on every filesystem; the rename is
    // still atomic there, only its durability is the kernel's business.
  } finally {
    fs.closeSync(dir);
  }
}
