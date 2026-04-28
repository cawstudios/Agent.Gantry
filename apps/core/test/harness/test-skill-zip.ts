export function makeSkillZip(
  files: Record<string, Buffer | string>,
  options: { symlinks?: Set<string> } = {},
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, rawContent] of Object.entries(files)) {
    const content =
      typeof rawContent === 'string'
        ? Buffer.from(rawContent, 'utf-8')
        : rawContent;
    const nameBytes = Buffer.from(name, 'utf-8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(content.byteLength, 18);
    local.writeUInt32LE(content.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(content.byteLength, 20);
    central.writeUInt32LE(content.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(
      options.symlinks?.has(name) ? 0o120000 * 0x10000 : 0,
      38,
    );
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.byteLength + nameBytes.byteLength + content.byteLength;
  }

  const locals = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  const fileCount = Object.keys(files).length;
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileCount, 8);
  eocd.writeUInt16LE(fileCount, 10);
  eocd.writeUInt32LE(central.byteLength, 12);
  eocd.writeUInt32LE(locals.byteLength, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([locals, central, eocd]);
}
